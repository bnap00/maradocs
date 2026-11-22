#!/usr/bin/env node
// One-command deploy of MaraDocs to your Cloudflare account.
//
//   npm run setup                         # interactive: login, deploy, create your account, connect the CLI
//   npm run setup -- --yes                # accept every default, no questions
//   npm run setup -- --no-cli             # deploy only (create the account in the dashboard)
//   npm run setup -- --dry-run            # print the commands without running anything
//   npm run setup -- --help
//
// With pnpm, pass flags without the `--` (`pnpm cf:deploy --no-cli`); a stray
// leading `--` is ignored either way.
//
// Node 22+ and built-in modules only: this file must run in a fresh copy of
// apps/cloudflare (the "Deploy to Cloudflare" button copies only that folder).
//
// MaraDocs uses email + password accounts. The Worker needs no secrets: the
// first account created (REGISTRATION=first, the default) owns the
// deployment. Setup creates that account (or signs in to an existing one),
// mints an API key and saves it for the `maradocs` CLI and agent skill.
//
// Security notes:
// - Passwords are read without echo (or from MARADOCS_PASSWORD /
//   MARADOCS_CLAIM_PASSWORD), sent only to the deployment over HTTPS, and
//   never printed, logged or passed in argv to another process.
// - The session used to mint the API key is revoked right after; the key is
//   stored in ~/.maradocs/config.json (mode 0600), where the CLI reads it.
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";

const APP_DIR = path.resolve(import.meta.dirname, "..");
const IS_WINDOWS = process.platform === "win32";
const DEFAULT_WORKER_NAME = readWorkerNameFromConfig() ?? "maradocs";
const HEALTH_TIMEOUT_MS = 120_000;
/** Account password limits (the Worker enforces the same). */
const MIN_PASSWORD_LENGTH = 12;
const MAX_PASSWORD_LENGTH = 1024;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const WORKER_NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
/** The Worker's createKeySchema allows key names up to 100 characters. */
const MAX_KEY_NAME_LENGTH = 100;
const CONFIG_FILE = path.join(APP_DIR, "wrangler.jsonc");
/** Where the `maradocs` CLI keeps its server URL and API key. */
const CLI_CONFIG_FILE = path.join(os.homedir(), ".maradocs", "config.json");

const HELP = `
MaraDocs on Cloudflare — one-command setup

Usage:
  npm run setup [-- options]
  pnpm cf:deploy [options]          (from the monorepo root; no \`--\` needed)
  node scripts/setup.mjs [options]

What it does:
  1. Checks you are logged in to Cloudflare (runs \`wrangler login\` if not).
  2. Deploys the Worker. D1 and R2 are created automatically on first deploy.
  3. Waits for /health.
  4. Creates your MaraDocs account (the first account owns the deployment) or
     signs in to an existing one, mints an API key and saves it to
     ${CLI_CONFIG_FILE} for the \`maradocs\` CLI and the agent skill.

Options:
  --email <email>      Account email (or MARADOCS_EMAIL; asked if omitted).
  --password <value>   Account password, at least ${MIN_PASSWORD_LENGTH} characters. Prefer
                       MARADOCS_PASSWORD, which keeps it out of your shell
                       history; asked without echo if omitted.
  --claim-password <value>
                       Claim password, needed only to create the first account
                       on a deployment whose ADMIN_PASSWORD secret is set (e.g.
                       upgraded from the single-admin version, where it was the
                       admin password). Prefer MARADOCS_CLAIM_PASSWORD.
  --name <worker>      Worker name (default: "${DEFAULT_WORKER_NAME}" from wrangler.jsonc).
                       D1 and R2 are created per Worker (<worker>-db, <worker>-bucket)
                       unless wrangler.jsonc names them explicitly.
  --url <origin>       Use this public URL instead of the one Wrangler reports
                       (e.g. a custom domain).
  -y, --yes            Never ask; accept defaults. The account step then needs
                       MARADOCS_EMAIL and MARADOCS_PASSWORD (or the flags).
  --no-cli             Deploy only; create your account in the dashboard.
  --dry-run            Print the commands that would run, then exit.
  -h, --help           Show this help.

Environment:
  MARADOCS_EMAIL            Same as --email.
  MARADOCS_PASSWORD         Same as --password.
  MARADOCS_CLAIM_PASSWORD   Same as --claim-password (MARADOCS_ADMIN_PASSWORD,
                            from older versions, is accepted as the claim password).
  CLOUDFLARE_API_TOKEN      Non-interactive Cloudflare auth (CI); skips \`wrangler login\`.
  CLOUDFLARE_ACCOUNT_ID     Pick an account when your login can see several.

Examples:
  npm run setup
  MARADOCS_EMAIL=you@example.com MARADOCS_PASSWORD='a-long-passphrase' npm run setup -- --yes
  npm run setup -- --no-cli
  pnpm cf:deploy --dry-run
`;

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

const useColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR && process.env.TERM !== "dumb";
const paint = (code) => (text) => (useColor ? `\x1b[${code}m${text}\x1b[0m` : String(text));
const c = {
  bold: paint("1"),
  dim: paint("2"),
  red: paint("31"),
  green: paint("32"),
  yellow: paint("33"),
  cyan: paint("36"),
};

const log = {
  step: (n, total, msg) => console.log(`\n${c.cyan(`[${n}/${total}]`)} ${c.bold(msg)}`),
  info: (msg) => console.log(`  ${msg}`),
  ok: (msg) => console.log(`  ${c.green("✓")} ${msg}`),
  warn: (msg) => console.warn(`  ${c.yellow("!")} ${msg}`),
  cmd: (display) => console.log(`  ${c.dim("$")} ${display}`),
};

/** An error with a message the user can act on; printed without a stack. */
class SetupError extends Error {
  constructor(message, hint) {
    super(message);
    this.hint = hint;
  }
}

class Interrupted extends Error {}

function stripAnsi(text) {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function box(title, rows) {
  const lines = [c.bold(title), "", ...rows];
  const width = Math.max(...lines.map((l) => [...stripAnsi(l)].length));
  const pad = (l) => l + " ".repeat(width - [...stripAnsi(l)].length);
  const out = [`╭${"─".repeat(width + 2)}╮`, ...lines.map((l) => `│ ${pad(l)} │`), `╰${"─".repeat(width + 2)}╯`];
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

export function parseCli(argv, env = process.env) {
  // pnpm (unlike npm) forwards a literal `--`: `pnpm run setup -- --dry-run`
  // arrives as ["--", "--dry-run"]. Strip one leading separator.
  const args = argv[0] === "--" ? argv.slice(1) : argv;
  let parsed;
  try {
    parsed = parseArgs({
      args,
      strict: true,
      allowPositionals: false,
      options: {
        email: { type: "string" },
        password: { type: "string" },
        "claim-password": { type: "string" },
        // Options of the single-admin version (see below).
        "skip-password": { type: "boolean", default: false },
        "rotate-password": { type: "boolean", default: false },
        "reset-dashboard-password": { type: "boolean", default: false },
        name: { type: "string" },
        url: { type: "string" },
        yes: { type: "boolean", short: "y", default: false },
        "no-cli": { type: "boolean", default: false },
        "dry-run": { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
    });
  } catch (err) {
    throw new SetupError(err.message, "Run `npm run setup -- --help` (or `pnpm cf:deploy --help`) for the list of options.");
  }
  const v = parsed.values;
  const nonEmpty = (value) => (typeof value === "string" && value !== "" ? value : null);
  const opts = {
    help: v.help,
    dryRun: v["dry-run"],
    yes: v.yes,
    cli: !v["no-cli"],
    email: nonEmpty(v.email) ?? nonEmpty(env.MARADOCS_EMAIL),
    password: nonEmpty(v.password) ?? nonEmpty(env.MARADOCS_PASSWORD),
    passwordFromFlag: v.password !== undefined,
    claimPassword: nonEmpty(v["claim-password"]) ?? nonEmpty(env.MARADOCS_CLAIM_PASSWORD) ?? nonEmpty(env.MARADOCS_ADMIN_PASSWORD),
    legacySkipPassword: v["skip-password"],
    name: v.name ?? null,
    url: null,
  };
  if (opts.help) return opts;

  const removed = ["rotate-password", "reset-dashboard-password"].filter((flag) => v[flag]);
  if (removed.length) {
    throw new SetupError(
      `--${removed[0]} was removed: MaraDocs now uses email + password accounts, so there is no admin password to rotate.`,
      "Change your password in the dashboard (Settings). Lost it? Another account, or the operator deleting your " +
        "account row in D1, is the way back (there is no email-based reset).",
    );
  }
  if (opts.email !== null) {
    opts.email = opts.email.trim().toLowerCase();
    validateEmail(opts.email);
  }
  if (opts.password !== null) validatePassword(opts.password, opts.passwordFromFlag ? "--password" : "MARADOCS_PASSWORD");
  if (opts.name !== null && !WORKER_NAME_RE.test(opts.name)) {
    throw new SetupError(
      `Invalid --name "${opts.name}".`,
      "Worker names use lowercase letters, digits and dashes (max 63 chars), and cannot start or end with a dash.",
    );
  }
  if (v.url !== undefined) opts.url = normaliseOrigin(v.url, "--url");
  return opts;
}

export function validateEmail(email) {
  if (email.length > 254 || !EMAIL_RE.test(email)) {
    throw new SetupError(`"${email}" is not a valid email address.`);
  }
}

export function validatePassword(password, label = "The password") {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new SetupError(`${label} must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    throw new SetupError(`${label} must be at most ${MAX_PASSWORD_LENGTH} characters.`);
  }
}

function normaliseOrigin(value, label) {
  let url;
  try {
    url = new URL(/^[a-z]+:\/\//i.test(value) ? value : `https://${value}`);
  } catch {
    throw new SetupError(`${label} "${value}" is not a valid URL.`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new SetupError(`${label} must be an http(s) URL.`);
  }
  return url.origin;
}

function readConfigText() {
  try {
    return fs.readFileSync(CONFIG_FILE, "utf8");
  } catch {
    return null;
  }
}

function readWorkerNameFromConfig() {
  const match = readConfigText()?.match(/^\s*"name"\s*:\s*"([^"]+)"/m);
  return match ? match[1] : null;
}

/** Explicit resource names in wrangler.jsonc (comments ignored); empty when wrangler auto-names them. */
export function configuredResourceNames(text) {
  const names = [];
  for (const line of (text ?? "").split("\n")) {
    const code = line.replace(/\/\/.*$/, "");
    const m = code.match(/"(database_name|bucket_name)"\s*:\s*"([^"]+)"/);
    if (m) names.push(`${m[1]} "${m[2]}"`);
  }
  return names;
}

/** The monorepo root (pnpm workspace) above apps/cloudflare, or null in a standalone copy. */
function findMonorepoRoot() {
  let dir = path.dirname(APP_DIR);
  for (;;) {
    if (fs.existsSync(path.join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// ---------------------------------------------------------------------------
// Processes
// ---------------------------------------------------------------------------

let activeChild = null;
let interrupted = false;

/**
 * Runs a command from apps/cloudflare.
 * - stdio "inherit": the user sees (and can answer) everything.
 * - capture: stdout/stderr are collected and returned.
 * - input: written to the child's stdin, which is then closed.
 */
function run(command, args, { capture = false, input = null, env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const stdin = input !== null ? "pipe" : "inherit";
    const childEnv = { ...process.env, ...env };
    // pnpm exports this for its own use; npm 11 then warns
    // `Unknown env config "verify-deps-before-run"` on every npx call.
    delete childEnv.npm_config_verify_deps_before_run;
    delete childEnv.NPM_CONFIG_VERIFY_DEPS_BEFORE_RUN;
    const child = spawn(command, args, {
      cwd: APP_DIR,
      env: childEnv,
      stdio: [stdin, capture ? "pipe" : "inherit", capture ? "pipe" : "inherit"],
      // npx / maradocs are .cmd shims on Windows, which require a shell. Every
      // argument passed here is either a constant or validated beforehand.
      shell: IS_WINDOWS,
      windowsHide: true,
    });
    activeChild = child;
    let stdout = "";
    let stderr = "";
    if (capture) {
      child.stdout.setEncoding("utf8").on("data", (d) => (stdout += d));
      child.stderr.setEncoding("utf8").on("data", (d) => (stderr += d));
    }
    if (input !== null) {
      child.stdin.on("error", () => {
        /* child exited before reading stdin; the exit code reports the failure */
      });
      child.stdin.end(input);
    }
    child.on("error", (err) => {
      activeChild = null;
      if (err.code === "ENOENT") {
        reject(new SetupError(`Could not run \`${command}\`: command not found.`, commandHint(command)));
      } else {
        reject(err);
      }
    });
    child.on("close", (code, signal) => {
      activeChild = null;
      if (interrupted || signal === "SIGINT") {
        reject(new Interrupted());
        return;
      }
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

function commandHint(command) {
  if (command.startsWith("npx")) return "Install Node.js 22+ (which includes npm/npx) and try again.";
  return undefined;
}

const NPX = IS_WINDOWS ? "npx.cmd" : "npx";
const NPM = IS_WINDOWS ? "npm.cmd" : "npm";
const wrangler = (args, options) => run(NPX, ["--no", "wrangler", ...args], options);
const wranglerDisplay = (args) => `npx wrangler ${args.join(" ")}`;

/** Finds node_modules/wrangler from apps/cloudflare upwards (works in the monorepo and standalone). */
function findLocalWrangler() {
  let dir = APP_DIR;
  for (;;) {
    const candidate = path.join(dir, "node_modules", "wrangler", "package.json");
    if (fs.existsSync(candidate)) {
      try {
        return JSON.parse(fs.readFileSync(candidate, "utf8")).version ?? "unknown";
      } catch {
        return "unknown";
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Finds an executable on PATH without spawning a shell. */
function findOnPath(name) {
  const exts = IS_WINDOWS ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext.toLowerCase());
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {
        /* not here */
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);

async function ask(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const onSigint = () => {
    interrupted = true;
    rl.close();
  };
  rl.on("SIGINT", onSigint);
  try {
    const answer = await rl.question(question);
    if (interrupted) throw new Interrupted();
    return answer.trim();
  } catch (err) {
    if (interrupted) throw new Interrupted();
    throw err;
  } finally {
    rl.close();
  }
}

async function confirm(question, defaultYes = true) {
  const answer = (await ask(`  ${question} ${defaultYes ? "[Y/n]" : "[y/N]"} `)).toLowerCase();
  if (!answer) return defaultYes;
  return answer === "y" || answer === "yes";
}

/** Reads a line without echoing it (TTY only). */
function askHidden(question) {
  return new Promise((resolve, reject) => {
    const input = process.stdin;
    let value = "";
    const wasRaw = input.isRaw;
    const cleanup = () => {
      input.off("data", onData);
      input.setRawMode(wasRaw);
      input.pause();
      process.stdout.write("\n");
    };
    const onData = (chunk) => {
      for (const ch of chunk.toString("utf8")) {
        if (ch === "\u0003") {
          cleanup();
          interrupted = true;
          reject(new Interrupted());
          return;
        }
        if (ch === "\u0004" || ch === "\r" || ch === "\n") {
          cleanup();
          resolve(value);
          return;
        }
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else if (ch >= " ") value += ch;
      }
    };
    process.stdout.write(question);
    input.setRawMode(true);
    input.resume();
    input.on("data", onData);
  });
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

async function ensureLoggedIn(opts) {
  const whoami = await wrangler(["whoami", "--json"], { capture: true });
  if (whoami.code === 0) {
    let who = "";
    try {
      const data = JSON.parse(whoami.stdout);
      who = data.email ?? data.user?.email ?? "";
    } catch {
      /* older/newer output shape; authentication still succeeded */
    }
    log.ok(`Logged in to Cloudflare${who ? ` as ${who}` : ""}.`);
    return;
  }
  if (process.env.CLOUDFLARE_API_TOKEN) {
    throw new SetupError(
      "CLOUDFLARE_API_TOKEN is set but Wrangler could not authenticate with it.",
      "Check the token is valid and has the \"Edit Cloudflare Workers\" permissions plus D1 and R2 edit access.",
    );
  }
  if (!interactive) {
    throw new SetupError(
      "Not logged in to Cloudflare and no terminal is available for `wrangler login`.",
      "Run `npx wrangler login` once in a terminal, or set CLOUDFLARE_API_TOKEN for non-interactive use.",
    );
  }
  if (!opts.yes && !(await confirm("You are not logged in to Cloudflare. Open the browser to log in now?"))) {
    throw new SetupError("Cloudflare login is required to deploy.", "Run `npx wrangler login`, then re-run setup.");
  }
  log.cmd(wranglerDisplay(["login"]));
  const login = await wrangler(["login"]);
  if (login.code !== 0) {
    throw new SetupError("`wrangler login` did not complete.", "Re-run setup and finish the login in your browser.");
  }
  const again = await wrangler(["whoami", "--json"], { capture: true });
  if (again.code !== 0) {
    throw new SetupError("Still not authenticated after `wrangler login`.", "Run `npx wrangler whoami` to see what is wrong.");
  }
  log.ok("Logged in to Cloudflare.");
}

export function readDeployTargets(outputFile) {
  let text;
  try {
    text = fs.readFileSync(outputFile, "utf8");
  } catch {
    return [];
  }
  const targets = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === "deploy" && Array.isArray(entry.targets)) targets.push(...entry.targets);
    } catch {
      /* ignore malformed lines */
    }
  }
  return targets;
}

/**
 * Picks the public origin from Wrangler's deploy targets. Custom domains win
 * over workers.dev; route patterns are used only when they name a plain host.
 */
export function pickOrigin(targets) {
  const custom = [];
  const workersDev = [];
  const routes = [];
  for (const raw of targets) {
    if (typeof raw !== "string") continue;
    const target = raw.trim();
    const host = target.split(/\s+/)[0];
    if (/\(custom domain/.test(target)) custom.push(host);
    else if (/^https:\/\/[^/\s]+\.workers\.dev\/?$/.test(host)) workersDev.push(host);
    else {
      const m = host.match(/^(?:https?:\/\/)?([a-z0-9.-]+\.[a-z]{2,})\/\*?$/i);
      if (m) routes.push(m[1]);
    }
  }
  const pick = custom[0] ?? routes[0] ?? workersDev[0];
  if (!pick) return null;
  try {
    return normaliseOrigin(pick, "deploy target");
  } catch {
    return null;
  }
}

async function deploy(nameArgs) {
  const outputFile = path.join(os.tmpdir(), `maradocs-setup-${process.pid}-${randomBytes(4).toString("hex")}.ndjson`);
  // In an interactive terminal, Wrangler writes the IDs of resources it just
  // provisioned (database_id, …) back into wrangler.jsonc. Deploys don't need
  // them (the Worker keeps its bindings), and keeping them would pin this
  // checkout to one account and switch `npm run dev` to a new, empty local
  // database. Put the file back exactly as it was.
  const configBefore = readConfigText();
  try {
    const res = await wrangler(["deploy", ...nameArgs], { env: { WRANGLER_OUTPUT_FILE_PATH: outputFile } });
    if (res.code !== 0) {
      throw new SetupError(
        "`wrangler deploy` failed (see the output above).",
        "Common fixes: run `npm install` in apps/cloudflare, check your account has D1 and R2 enabled " +
          "(R2 must be activated once in the dashboard), or set CLOUDFLARE_ACCOUNT_ID if you have several accounts.",
      );
    }
    return readDeployTargets(outputFile);
  } finally {
    fs.rmSync(outputFile, { force: true });
    restoreConfig(configBefore);
  }
}

function restoreConfig(before) {
  if (before === null) return;
  const after = readConfigText();
  if (after === null || after === before) return;
  try {
    fs.writeFileSync(CONFIG_FILE, before);
    log.info(c.dim("Restored wrangler.jsonc (Wrangler had written resource IDs into it; deploys don't need them)."));
  } catch (err) {
    log.warn(`Could not restore wrangler.jsonc (${err.message}). Discard the added database_id with \`git checkout wrangler.jsonc\`.`);
  }
}

async function waitForHealth(origin) {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  let last = "no response yet";
  while (Date.now() < deadline) {
    if (interrupted) throw new Interrupted();
    try {
      const res = await fetch(`${origin}/health`, {
        signal: AbortSignal.timeout(8000),
        headers: { accept: "application/json" },
        redirect: "follow",
      });
      if (res.ok) {
        const body = await res.json().catch(() => null);
        if (body && body.status === "ok") return { ok: true };
        last = "unexpected /health response";
      } else {
        last = `HTTP ${res.status}`;
      }
    } catch (err) {
      last = err?.cause?.code ?? err?.name ?? "network error";
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return { ok: false, last };
}

// ---------------------------------------------------------------------------
// Account and CLI connection
// ---------------------------------------------------------------------------

/** The CLI's saved connection ({ server, apiKey }), or null. */
export function readCliConfig(file = CLI_CONFIG_FILE) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!parsed || typeof parsed.server !== "string" || !parsed.server) return null;
    return { server: parsed.server, apiKey: typeof parsed.apiKey === "string" ? parsed.apiKey : null };
  } catch {
    return null;
  }
}

/** Save the CLI connection the way `maradocs auth bootstrap` does (directory 0700, file 0600). */
export function writeCliConfig(config, file = CLI_CONFIG_FILE) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify({ server: config.server, apiKey: config.apiKey }, null, 2), { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600); // `mode` only applies when the file is created
  } catch {
    /* best effort (e.g. filesystems without POSIX modes) */
  }
}

/**
 * Register or sign in? Registration is tried whenever the deployment allows
 * it (GET /api/v1/auth/config); an email that already has an account then
 * falls back to signing in.
 */
export function accountPlan(config, claimPassword) {
  if (!config || config.registration !== true) return { action: "login", needClaim: false };
  return { action: "register", needClaim: config.claimRequired === true && !claimPassword };
}

/**
 * JSON request to the deployment. Node's fetch sends no Origin or
 * Sec-Fetch-Site header, so the Worker treats it as a CLI and returns the
 * session token in the body.
 */
async function api(origin, method, pathname, { body, token } = {}) {
  const headers = { accept: "application/json" };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (token) headers.authorization = `Bearer ${token}`;
  let res;
  try {
    res = await fetch(`${origin}${pathname}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20_000),
      redirect: "error",
    });
  } catch (err) {
    return { status: 0, data: null, message: err?.cause?.code ?? err?.message ?? "network error" };
  }
  const text = await res.text().catch(() => "");
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* not JSON */
  }
  const message = typeof data?.message === "string" ? data.message : `HTTP ${res.status}`;
  return { status: res.status, data, message };
}

/** Same message the Worker uses for zod failures, reduced to the first issue. */
function apiFailure(res) {
  const issue = Array.isArray(res.data?.details) ? res.data.details[0] : null;
  if (res.data?.error === "validation_error" && issue?.message) {
    return `${Array.isArray(issue.path) && issue.path.length ? `${issue.path.join(".")}: ` : ""}${issue.message}`;
  }
  return res.message;
}

async function askEmail(opts) {
  if (opts.email) return opts.email;
  if (!interactive || opts.yes) return null;
  for (;;) {
    const answer = (await ask("  Account email (Enter to skip): ")).toLowerCase();
    if (!answer) return null;
    try {
      validateEmail(answer);
      return answer;
    } catch (err) {
      log.warn(err.message);
    }
  }
}

async function askPassword(opts, creating) {
  if (opts.password) return opts.password;
  if (!interactive || opts.yes) return null;
  for (;;) {
    const label = creating ? `  Choose a password (at least ${MIN_PASSWORD_LENGTH} characters, Enter to skip): ` : "  Password (Enter to skip): ";
    const password = await askHidden(label);
    if (!password) return null;
    try {
      validatePassword(password);
    } catch (err) {
      log.warn(err.message);
      continue;
    }
    if (creating && (await askHidden("  Repeat the password: ")) !== password) {
      log.warn("The passwords do not match.");
      continue;
    }
    return password;
  }
}

/**
 * Create the account (or sign in), mint an API key for the CLI, revoke the
 * session and save the key. Returns { status, detail, email?, registered?, config? }.
 */
export async function connectAccount(origin, opts) {
  if (!opts.cli) return { status: "skipped", detail: "--no-cli" };

  const saved = readCliConfig();
  if (saved?.apiKey && sameOrigin(saved.server, origin)) {
    const check = await api(origin, "GET", "/api/v1/repos", { token: saved.apiKey });
    if (check.status === 200) return { status: "connected", detail: `already connected (${CLI_CONFIG_FILE})` };
  } else if (saved?.server && !sameOrigin(saved.server, origin)) {
    if (opts.yes || !interactive) {
      return { status: "skipped", detail: `the CLI is connected to ${saved.server}; not replacing that without asking` };
    }
    if (!(await confirm(`The CLI is currently connected to ${saved.server}. Replace that with this deployment?`, false))) {
      return { status: "skipped", detail: `kept the connection to ${saved.server}` };
    }
  }

  const configRes = await api(origin, "GET", "/api/v1/auth/config");
  if (configRes.status !== 200 || !configRes.data) {
    return { status: "failed", detail: `GET /api/v1/auth/config answered ${configRes.message}` };
  }
  const config = configRes.data;
  const plan = accountPlan(config, opts.claimPassword);
  if (plan.action === "register") {
    log.info(
      config.claimRequired
        ? "No account exists yet. The first account owns this deployment; creating it needs the claim password."
        : "Create your account (or enter an existing one to sign in).",
    );
  } else {
    log.info("Sign in with your MaraDocs account (registration is closed on this deployment).");
  }

  const email = await askEmail(opts);
  if (!email) return { status: "skipped", detail: "no account email (pass --email or MARADOCS_EMAIL)", config };
  const password = await askPassword(opts, plan.action === "register");
  if (!password) return { status: "skipped", detail: "no password (pass MARADOCS_PASSWORD, or run interactively)", config };

  let session = null;
  let registered = false;
  if (plan.action === "register") {
    let claimPassword = opts.claimPassword;
    if (plan.needClaim && interactive && !opts.yes) {
      claimPassword = (await askHidden("  Claim password (the Worker's ADMIN_PASSWORD secret; Enter to skip): ")) || null;
    }
    if (config.claimRequired && !claimPassword) {
      return { status: "skipped", detail: "a claim password is required to create the first account (--claim-password)", config };
    }
    const res = await api(origin, "POST", "/api/v1/auth/register", {
      body: { email, password, ...(claimPassword ? { claimPassword } : {}) },
    });
    if (res.status === 201) {
      session = res.data;
      registered = true;
    } else if (res.status === 409 || res.data?.error === "registration_closed") {
      log.info(res.status === 409 ? `${email} already has an account; signing in.` : "Registration just closed; signing in.");
    } else {
      return { status: "failed", detail: `could not create the account: ${apiFailure(res)}`, config };
    }
  }
  if (!session) {
    const res = await api(origin, "POST", "/api/v1/auth/login", { body: { email, password } });
    if (res.status !== 200) return { status: "failed", detail: `could not sign in: ${apiFailure(res)}`, config };
    session = res.data;
  }
  const token = session?.token;
  if (typeof token !== "string" || !token) {
    return { status: "failed", detail: "the deployment returned no session token (does a proxy add an Origin header?)", config };
  }

  const keyName = `setup-${os.hostname()}`.replace(/[^\w.-]+/g, "-").slice(0, MAX_KEY_NAME_LENGTH) || "setup";
  const created = await api(origin, "POST", "/api/v1/auth/keys", { token, body: { name: keyName, scopes: ["publish"] } });
  // The session was only needed to mint the key: don't leave a 30-day credential behind.
  await api(origin, "POST", "/api/v1/auth/logout", { token });
  if (created.status !== 201 || typeof created.data?.key !== "string") {
    return { status: "failed", detail: `could not create an API key: ${apiFailure(created)}`, email, registered, config };
  }
  try {
    writeCliConfig({ server: origin, apiKey: created.data.key });
  } catch (err) {
    return { status: "failed", detail: `could not save ${CLI_CONFIG_FILE} (${err.message})`, email, registered, config };
  }
  return {
    status: "connected",
    detail: `key ${created.data.prefix ?? ""}… (publish) saved to ${CLI_CONFIG_FILE}`,
    email,
    registered,
    config,
  };
}

function sameOrigin(a, b) {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function dryRun(opts) {
  const nameArgs = opts.name ? ["--name", opts.name] : [];
  const worker = opts.name ?? DEFAULT_WORKER_NAME;
  const url = opts.url ?? "<deployed URL>";
  console.log(c.bold("\nMaraDocs setup — dry run (nothing is executed)\n"));
  console.log(`  Working directory: ${APP_DIR}`);
  console.log(`  Worker name:       ${worker}`);
  console.log(`  Local wrangler:    ${findLocalWrangler() ?? `NOT FOUND — ${installHint()}`}`);
  const named = configuredResourceNames(readConfigText());
  console.log(`  D1 / R2 names:     ${named.length ? named.join(", ") : `auto (${worker}-db, ${worker}-bucket on first deploy)`}`);
  if (opts.name && opts.name !== DEFAULT_WORKER_NAME && named.length) {
    console.log(`  ${c.yellow("!")} These names are fixed in wrangler.jsonc, so "${opts.name}" would share D1 and R2 with other deployments.`);
  }
  console.log("");
  const steps = [
    [wranglerDisplay(["whoami", "--json"]), "check Cloudflare login"],
    [wranglerDisplay(["login"]), "only if not logged in (and no CLOUDFLARE_API_TOKEN)"],
    [
      `WRANGLER_OUTPUT_FILE_PATH=<tmp file> ${wranglerDisplay(["deploy", ...nameArgs])}`,
      "build dashboard, deploy Worker, auto-provision D1 + R2; wrangler.jsonc is restored afterwards",
    ],
    [`GET ${url}/health`, `poll up to ${HEALTH_TIMEOUT_MS / 1000}s`],
  ];
  if (opts.cli) {
    steps.push(
      [`GET ${url}/api/v1/repos`, `only if ${CLI_CONFIG_FILE} already points here: is its key still valid?`],
      [`GET ${url}/api/v1/auth/config`, "may accounts be created, and does the first one need the claim password?"],
      [
        `POST ${url}/api/v1/auth/register  (or /login)`,
        `email: ${opts.email ?? "asked"}; password: ${opts.password ? "from " + (opts.passwordFromFlag ? "--password" : "MARADOCS_PASSWORD") : "asked without echo"}` +
          `${opts.claimPassword ? "; claim password supplied" : ""}`,
      ],
      [`POST ${url}/api/v1/auth/keys`, "mint a publish-scoped API key named setup-<host>"],
      [`POST ${url}/api/v1/auth/logout`, "revoke the session used to mint it"],
      [`write ${CLI_CONFIG_FILE}`, "server URL + API key for the maradocs CLI and agent skill (mode 0600)"],
    );
  }
  steps.forEach(([cmd, note], i) => {
    console.log(`  ${String(i + 1).padStart(2)}. ${c.dim("$")} ${cmd}`);
    console.log(`      ${c.dim(note)}`);
  });
  console.log("");
}

function installHint() {
  const root = findMonorepoRoot();
  return root ? `run \`pnpm install\` in ${root}` : `run \`npm install\` in ${APP_DIR}`;
}

/** Standalone copy without node_modules: offer to install instead of just failing. */
async function ensureDependencies(opts) {
  let version = findLocalWrangler();
  if (version) return version;
  const root = findMonorepoRoot();
  if (root) {
    throw new SetupError("Wrangler is not installed.", `This is the MaraDocs monorepo: run \`pnpm install\` in ${root}, then \`pnpm cf:deploy\`.`);
  }
  if (!opts.yes && !(interactive && (await confirm("Dependencies are not installed. Run `npm install` now?")))) {
    throw new SetupError("Wrangler is not installed in this project.", `Run \`npm install\` in ${APP_DIR}, then re-run \`npm run setup\`.`);
  }
  const hasLock = fs.existsSync(path.join(APP_DIR, "package-lock.json"));
  const args = hasLock ? ["ci"] : ["install"];
  log.cmd(`npm ${args.join(" ")}`);
  const res = await run(NPM, args);
  if (res.code !== 0) throw new SetupError(`\`npm ${args.join(" ")}\` failed (see the output above).`);
  version = findLocalWrangler();
  if (!version) throw new SetupError("Wrangler is still not installed after npm install.");
  return version;
}

/** --name with explicit D1/R2 names in wrangler.jsonc would share them with the main deployment. */
async function checkSharedResources(opts) {
  if (!opts.name || opts.name === DEFAULT_WORKER_NAME) return;
  const named = configuredResourceNames(readConfigText());
  if (!named.length) return;
  log.warn(
    `wrangler.jsonc names its resources explicitly (${named.join(", ")}), so Worker "${opts.name}" would share ` +
      "them — accounts, repositories, keys and sessions — with any other deployment using those names.",
  );
  log.warn("Remove database_name / bucket_name from wrangler.jsonc to get separate <worker>-db / <worker>-bucket resources.");
  if (opts.yes || !interactive) return;
  if (!(await confirm("Deploy anyway and share them?", false))) {
    throw new SetupError("Stopped before deploying.", "Edit wrangler.jsonc, then re-run setup.");
  }
}

async function main() {
  const opts = parseCli(process.argv.slice(2));
  if (opts.help) {
    console.log(HELP.trim());
    return;
  }

  const [major] = process.versions.node.split(".").map(Number);
  if (major < 22) {
    throw new SetupError(`Node ${process.versions.node} is too old.`, "MaraDocs setup needs Node.js 22 or newer.");
  }
  if (opts.legacySkipPassword) {
    log.warn("--skip-password is no longer needed (the Worker has no admin password secret) and is ignored.");
  }

  if (opts.dryRun) {
    dryRun(opts);
    return;
  }

  const total = 4;
  const nameArgs = opts.name ? ["--name", opts.name] : [];
  console.log(c.bold("\nMaraDocs on Cloudflare — setup"));

  log.step(1, total, "Checking prerequisites");
  const wranglerVersion = await ensureDependencies(opts);
  log.ok(`Node ${process.versions.node}, Wrangler ${wranglerVersion}.`);
  await ensureLoggedIn(opts);
  await checkSharedResources(opts);

  log.step(2, total, "Deploying the Worker (D1 and R2 are created on first deploy)");
  log.cmd(wranglerDisplay(["deploy", ...nameArgs]));
  const targets = await deploy(nameArgs);
  log.ok("Deployed.");

  log.step(3, total, "Waiting for the deployment to answer");
  let origin = opts.url ?? pickOrigin(targets);
  if (!origin) {
    log.warn("Could not read the deployed URL from Wrangler's output.");
    if (!interactive || opts.yes) {
      throw new SetupError(
        "The deployed URL is unknown.",
        "Re-run with `--url https://<worker>.<subdomain>.workers.dev` (shown in the Cloudflare dashboard under Workers & Pages).",
      );
    }
    for (;;) {
      const answer = await ask("  Enter the Worker URL (e.g. https://maradocs.you.workers.dev): ");
      try {
        origin = normaliseOrigin(answer, "URL");
        break;
      } catch (err) {
        log.warn(err.message);
      }
    }
  }
  log.info(`URL: ${origin}`);
  const health = await waitForHealth(origin);
  if (health.ok) log.ok("/health is OK.");
  else {
    log.warn(`No healthy response from ${origin}/health after ${HEALTH_TIMEOUT_MS / 1000}s (${health.last}).`);
    log.warn("A brand-new workers.dev subdomain can take a few minutes to resolve. Open the URL again shortly.");
  }

  log.step(4, total, "Your account and the maradocs CLI");
  let account;
  if (!health.ok) account = { status: "skipped", detail: "deployment not reachable yet" };
  else account = await connectAccount(origin, opts);
  if (account.status === "connected") {
    log.ok(account.email ? `${account.registered ? "Created the account" : "Signed in as"} ${account.email}; ${account.detail}.` : `CLI ${account.detail}.`);
  } else if (account.status === "failed") log.warn(`Account step failed: ${account.detail}`);
  else log.info(`Skipped (${account.detail}).`);

  // ----- Summary ------------------------------------------------------------
  const rows = [
    `${c.bold("URL")}        ${origin}`,
    `${c.bold("Dashboard")}  ${origin}/dashboard/`,
  ];
  if (account.email) {
    rows.push(`${c.bold("Account")}    ${account.email}${account.registered ? " (created now)" : ""}`);
  } else if (account.config?.registration && account.config?.claimRequired) {
    rows.push(`${c.bold("Account")}    none yet — create it in the dashboard (it asks for the claim password)`);
  } else if (account.config?.registration) {
    rows.push(`${c.bold("Account")}    ${c.yellow("create yours in the dashboard now")}: until an account exists,`);
    rows.push(c.dim("             whoever opens the dashboard first becomes the owner (REGISTRATION=first)."));
  } else {
    rows.push(`${c.bold("Account")}    sign in to the dashboard with your email and password`);
  }
  rows.push("");
  if (account.status === "connected") {
    rows.push(`${c.green("✓")} CLI connected. Try:  maradocs publish ./report --repo demo --doc hello`);
  } else {
    if (!findOnPath("maradocs")) rows.push("Install the CLI:     npm install -g @maradocs/cli");
    rows.push(`Connect the CLI:     maradocs auth bootstrap --server ${origin} --email you@example.com`);
  }
  rows.push("Agent skill:         npx skills add https://github.com/bnap00/maradocs --skill maradocs-publish");
  rows.push(`Redeploy later:      npm run setup${opts.name ? ` -- --name ${opts.name}` : ""}`);
  console.log(`\n${box("MaraDocs is deployed", rows)}\n`);
}

process.on("SIGINT", () => {
  // Ctrl-C reaches the child too (same process group); make sure it is gone.
  interrupted = true;
  if (activeChild && activeChild.exitCode === null) activeChild.kill("SIGINT");
  else finishInterrupted();
});

function finishInterrupted() {
  console.error(`\n${c.yellow("Interrupted.")} Nothing else was changed.`);
  console.error("Re-run `npm run setup` at any time — it is safe to repeat.");
  process.exit(130);
}

const isEntrypoint = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename);
if (isEntrypoint) {
  main().catch((err) => {
    if (err instanceof Interrupted || interrupted) finishInterrupted();
    if (err instanceof SetupError) {
      console.error(`\n${c.red("✗")} ${err.message}`);
      if (err.hint) console.error(`  ${err.hint}`);
    } else {
      console.error(`\n${c.red("✗")} Unexpected error: ${err?.message ?? err}`);
      console.error("  Please re-run with the same options; if it keeps failing, open an issue with the output above.");
    }
    process.exit(1);
  });
}
