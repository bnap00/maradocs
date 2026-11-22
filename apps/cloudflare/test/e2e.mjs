#!/usr/bin/env node
// End-to-end test: runs the Worker under `wrangler dev` (local D1 + R2 in a
// temp --persist-to dir, a generated claim password) and drives the REAL
// MaraDocs CLI (packages/cli) — and, when bash/zip/curl are available, the
// skill scripts (packages/skill) — against it, unchanged.
//
// Needs the monorepo (it builds/uses packages/cli), so it is not part of the
// Deploy-button build. Usage: npm run e2e   (from apps/cloudflare)

import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(appDir, "../..");
const cliEntry = path.join(repoRoot, "packages/cli/dist/index.js");
const skillScripts = path.join(repoRoot, "packages/skill/skill/scripts");
const require = createRequire(path.join(appDir, "package.json"));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "maradocs-cf-e2e-"));
const home = path.join(tmp, "home"); // isolated HOME so ~/.maradocs is never touched
const work = path.join(tmp, "work");
const configDir = path.join(tmp, "config");
for (const dir of [home, work, configDir]) fs.mkdirSync(dir, { recursive: true });

// ADMIN_PASSWORD is only the claim password for the first account.
const claimPassword = `e2e-${randomBytes(18).toString("base64url")}`;
const email = "e2e@maradocs.test";
const accountPassword = `e2e-account-${randomBytes(12).toString("base64url")}`;
let checks = 0;
let wrangler = null;
let wranglerLog = "";

function log(msg) {
  process.stdout.write(`${msg}\n`);
}

function check(condition, message, detail) {
  if (!condition) {
    throw new Error(`Check failed: ${message}${detail !== undefined ? `\n${typeof detail === "string" ? detail : JSON.stringify(detail, null, 2)}` : ""}`);
  }
  checks += 1;
  log(`  ok - ${message}`);
}

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts });
  return { code: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "", error: res.error };
}

function hasCommand(name) {
  return run("sh", ["-c", `command -v ${name}`]).code === 0;
}

// ---- Prerequisites ------------------------------------------------------------

function ensureCli() {
  if (fs.existsSync(cliEntry)) return;
  log("Building @maradocs/shared and @maradocs/cli …");
  for (const pkg of ["@maradocs/shared", "@maradocs/cli"]) {
    const res = run("pnpm", ["--filter", pkg, "build"], { cwd: repoRoot, stdio: "inherit" });
    if (res.code !== 0) throw new Error(`Failed to build ${pkg} (is pnpm installed?)`);
  }
  if (!fs.existsSync(cliEntry)) throw new Error(`CLI build did not produce ${cliEntry}`);
}

/** Minimal JSONC → JSON (comments outside strings, trailing commas). */
function parseJsonc(text) {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];
    if (inString) {
      out += ch;
      if (ch === "\\") {
        out += next ?? "";
        i += 1;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
    } else if (ch === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i += 1;
      out += "\n";
    } else if (ch === "/" && next === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i += 1;
      i += 1;
    } else {
      out += ch;
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

/**
 * wrangler.jsonc runs `npm run build` (the dashboard) before dev. The e2e run
 * doesn't need a fresh dashboard build, so it uses a temp config without the
 * build step (absolute paths), plus a temp .dev.vars holding the claim password.
 */
function writeConfig() {
  const config = parseJsonc(fs.readFileSync(path.join(appDir, "wrangler.jsonc"), "utf8"));
  delete config.build;
  delete config.$schema;
  config.main = path.join(appDir, config.main);
  const publicDir = path.join(appDir, config.assets?.directory ?? "public");
  fs.mkdirSync(publicDir, { recursive: true });
  config.assets = { ...config.assets, directory: publicDir };
  const configPath = path.join(configDir, "wrangler.json");
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  fs.writeFileSync(path.join(configDir, ".dev.vars"), `ADMIN_PASSWORD=${claimPassword}\n`, { mode: 0o600 });
  return { configPath, dashboardBuilt: fs.existsSync(path.join(publicDir, "dashboard/index.html")) };
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function startWrangler(configPath, port) {
  const wranglerBin = path.join(path.dirname(require.resolve("wrangler/package.json")), "bin/wrangler.js");
  wrangler = spawn(
    process.execPath,
    [
      wranglerBin,
      "dev",
      "--config",
      configPath,
      "--ip",
      "127.0.0.1",
      "--port",
      String(port),
      "--persist-to",
      path.join(tmp, "state"),
      "--show-interactive-dev-session=false",
      "--log-level",
      "warn",
    ],
    {
      cwd: configDir,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1", NO_COLOR: "1" },
    },
  );
  wrangler.stdout.on("data", (chunk) => (wranglerLog += chunk));
  wrangler.stderr.on("data", (chunk) => (wranglerLog += chunk));
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (wrangler.exitCode !== null) throw new Error(`wrangler dev exited early:\n${wranglerLog}`);
    try {
      const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return base;
    } catch {
      /* not ready yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`wrangler dev did not become healthy:\n${wranglerLog}`);
}

function stopWrangler() {
  if (!wrangler || wrangler.exitCode !== null) return;
  try {
    process.kill(-wrangler.pid, "SIGTERM");
  } catch {
    wrangler.kill("SIGTERM");
  }
}

// ---- CLI / skill drivers ------------------------------------------------------------

function cliEnv() {
  // The CLI prefers MARADOCS_* env vars over the saved config; make sure only the saved config is used.
  const env = { ...process.env, HOME: home, USERPROFILE: home, NO_COLOR: "1" };
  delete env.MARADOCS_SERVER_URL;
  delete env.MARADOCS_API_KEY;
  return env;
}

function cli(args, { expectFail = false } = {}) {
  const res = run(process.execPath, [cliEntry, ...args], { cwd: work, env: cliEnv() });
  if (!expectFail && res.code !== 0) {
    throw new Error(`maradocs ${args.join(" ")} exited ${res.code}\nstdout: ${res.stdout}\nstderr: ${res.stderr}`);
  }
  return res;
}

function cliJson(args) {
  const res = cli([...args, "--json"]);
  try {
    return JSON.parse(res.stdout);
  } catch {
    throw new Error(`maradocs ${args.join(" ")} did not print JSON:\n${res.stdout}\n${res.stderr}`);
  }
}

function skill(script, env) {
  return run("bash", [path.join(skillScripts, script)], {
    cwd: work,
    env: { ...process.env, HOME: home, ...env },
  });
}

function writeReport(dir, files) {
  fs.rmSync(dir, { recursive: true, force: true });
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(dir, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
}

// ---- Scenario ------------------------------------------------------------------

async function main() {
  ensureCli();

  const { configPath, dashboardBuilt } = writeConfig();
  const port = await freePort();
  log(`Starting wrangler dev on port ${port} (persist: ${path.join(tmp, "state")}) …`);
  const base = await startWrangler(configPath, port);
  log(`Worker ready at ${base}`);

  // System
  const health = await (await fetch(`${base}/health`)).json();
  check(health.status === "ok" && health.runtime === "cloudflare" && health.configured === true, "health reports a configured Cloudflare runtime", health);
  const dash = await fetch(`${base}/dashboard/`);
  check(
    (dashboardBuilt ? dash.status === 200 : dash.status === 503) &&
      (dash.headers.get("content-security-policy") ?? "").includes("frame-ancestors 'none'"),
    `dashboard ${dashboardBuilt ? "is served" : "build hint is shown"} with a strict CSP`,
    { status: dash.status },
  );
  const dashHtml = await dash.text();
  if (dashboardBuilt) {
    const spa = await fetch(`${base}/dashboard/repos/anything`);
    check(spa.status === 200 && (spa.headers.get("content-type") ?? "").includes("text/html"), "SPA routes fall back to index.html");
    await spa.arrayBuffer();
    const script = /src="(\/dashboard\/assets\/[^"]+\.js)"/.exec(dashHtml)?.[1];
    const asset = script ? await fetch(`${base}${script}`) : null;
    check(
      asset?.status === 200 &&
        (asset.headers.get("content-type") ?? "").includes("javascript") &&
        asset.headers.get("cache-control") === "public, max-age=31536000, immutable" &&
        (asset.headers.get("content-security-policy") ?? "").includes("script-src 'self'"),
      "hashed dashboard assets are immutable and carry the dashboard CSP",
      { script, status: asset?.status, cacheControl: asset?.headers.get("cache-control") },
    );
    await asset?.arrayBuffer();
  }

  // Auth: bootstrap creates the first account (with the claim password), mints a key and saves it.
  const boot = cliJson([
    "auth", "bootstrap", "--server", base, "--email", email, "--password", accountPassword, "--register",
    "--claim-password", claimPassword, "--name", "e2e-cli", "--scopes", "read,publish",
  ]);
  check(/^mdo_/.test(boot.key) && boot.saved === true && boot.scopes.join(",") === "read,publish", "auth bootstrap mints and saves an API key", boot);
  const savedConfig = JSON.parse(fs.readFileSync(path.join(home, ".maradocs/config.json"), "utf8"));
  check(savedConfig.server === base && savedConfig.apiKey === boot.key, "credentials saved to the isolated HOME");
  const badBoot = cli(
    ["auth", "bootstrap", "--server", base, "--email", email, "--password", "wrong-password-123", "--no-save", "--json"],
    { expectFail: true },
  );
  check(badBoot.code !== 0 && /Invalid email or password/.test(badBoot.stderr), "bootstrap with a wrong password fails cleanly", badBoot.stderr);

  const login = cli(["auth", "login", "--server", base, "--api-key", boot.key]);
  check(/API key verified/.test(login.stdout + login.stderr), "auth login verifies the key", login.stdout + login.stderr);
  const status = cliJson(["auth", "status"]);
  check(status.loggedIn && status.serverReachable && status.apiKey === "set", "auth status reports a reachable server", status);

  // Repos
  const repo = cliJson(["repo", "create", "e2e", "--access", "public", "--name", "E2E Reports", "--index"]);
  check(repo.slug === "e2e" && repo.defaultAccess === "public" && repo.indexEnabled === true, "repo create", repo);
  const repos = cliJson(["repo", "list"]);
  check(Array.isArray(repos) && repos.some((r) => r.slug === "e2e"), "repo list includes the new repo");

  // Publish v1
  const reportDir = path.join(work, "report");
  writeReport(reportDir, {
    "index.html": "<!doctype html><title>E2E</title><h1>Cloudflare E2E v1</h1><link rel=stylesheet href=css/site.css>",
    "css/site.css": "h1{color:rebeccapurple}",
    "data/numbers.json": "[1,2,3]",
  });
  const v1 = cliJson(["publish", reportDir, "--repo", "e2e", "--doc", "smoke", "--title", "Smoke Test"]);
  check(v1.versionNumber === 1 && v1.fileCount === 3 && v1.url === `${base}/r/e2e/smoke/`, "publish creates v1", v1);

  let page = await fetch(v1.url);
  let html = await page.text();
  check(page.status === 200 && html.includes("Cloudflare E2E v1"), "published report is served at its URL");
  check(page.headers.get("content-security-policy") === "sandbox allow-downloads allow-forms allow-popups allow-scripts", "report responses carry the sandbox CSP");
  const css = await fetch(`${base}/r/e2e/smoke/css/site.css`);
  check(css.headers.get("content-type") === "text/css; charset=utf-8" && (await css.text()).includes("rebeccapurple"), "report assets are served with correct content types");

  // Republish → v2 (CLI gets 409 on POST and retries with PUT)
  fs.writeFileSync(path.join(reportDir, "index.html"), "<!doctype html><h1>Cloudflare E2E v2</h1>");
  const v2 = cliJson(["publish", reportDir, "--repo", "e2e", "--doc", "smoke"]);
  check(v2.versionNumber === 2 && v2.versionUrl === `${base}/r/e2e/smoke/v/2/`, "republish creates v2", v2);
  html = await (await fetch(v2.url)).text();
  check(html.includes("v2"), "latest URL now serves v2");
  html = await (await fetch(v1.versionUrl)).text();
  check(html.includes("v1"), "pinned v1 URL still serves v1");

  const replace = cliJson(["publish", reportDir, "--repo", "e2e", "--doc", "smoke", "--replace", "--title", "Smoke Test (replaced)"]);
  check(replace.versionNumber === 3, "publish --replace creates v3", replace);

  // List / versions
  const docs = cliJson(["doc", "list", "e2e"]);
  const smoke = docs.find((d) => d.slug === "smoke");
  check(smoke && smoke.latestVersionNumber === 3 && smoke.title === "Smoke Test (replaced)" && smoke.access === "public", "doc list shows the latest version", docs);
  const versions = cliJson(["doc", "versions", "e2e/smoke"]);
  check(versions.length === 3 && versions[0].isLatest && versions.map((v) => v.versionNumber).join() === "3,2,1", "doc versions lists all versions newest first", versions);
  check(versions[2].checksum === v1.checksum && versions[2].publishedByLabel === "e2e-cli", "version metadata matches the publish result");

  // Download
  const outDir = path.join(work, "download-v1");
  // The long `--version` form must reach the subcommand (not print the CLI version).
  const dl = cliJson(["doc", "download", "e2e/smoke", "--version", "1", "--out", outDir]);
  check(dl.versionNumber === 1 && dl.checksum === v1.checksum && dl.fileCount === 3 && dl.entrypoint === "index.html", "doc download fetches v1 with its checksum", dl);
  check(fs.readFileSync(path.join(outDir, "index.html"), "utf8").includes("Cloudflare E2E v1"), "downloaded files have v1 content");
  check(fs.readFileSync(path.join(outDir, "css/site.css"), "utf8") === "h1{color:rebeccapurple}", "downloaded nested files are intact");
  const zipPath = path.join(work, "latest.zip");
  const dlZip = cliJson(["doc", "download", "e2e/smoke", "--zip", zipPath]);
  check(dlZip.versionNumber === 3 && fs.statSync(zipPath).size > 0, "doc download --zip saves the latest bundle", dlZip);

  // Round trip: republishing the downloaded v1 reproduces v1's checksum.
  const rt = cliJson(["publish", outDir, "--repo", "e2e", "--doc", "roundtrip"]);
  check(rt.checksum === v1.checksum, "republishing a downloaded bundle yields an identical checksum");

  // Rollback
  const rb = cliJson(["doc", "rollback", "e2e/smoke", "--version", "1"]);
  check(rb.latestVersionNumber === 1, "doc rollback --version promotes v1", rb);
  const cliVersion = cli(["--version"]);
  check(/^\d+\.\d+\.\d+/.test(cliVersion.stdout.trim()), "maradocs --version still prints the CLI version", cliVersion.stdout);
  html = await (await fetch(`${base}/r/e2e/smoke/`)).text();
  check(html.includes("v1"), "latest URL serves v1 after rollback");

  // Repo index lists public docs.
  html = await (await fetch(`${base}/r/e2e/`)).text();
  check(html.includes("/r/e2e/smoke/") && html.includes("E2E Reports"), "repository index lists public documents");

  // Missing repo is auto-created by publish; private access is enforced.
  const priv = cliJson(["publish", reportDir, "--repo", "e2e-private", "--doc", "secret", "--access", "private"]);
  check(priv.access === "private" && priv.versionNumber === 1, "publish auto-creates a missing repo", priv);
  page = await fetch(priv.url);
  check(page.status === 401 && (await page.text()).includes("/dashboard/login?next="), "private report shows the sign-in page to anonymous visitors");
  page = await fetch(priv.url, { headers: { authorization: `Bearer ${boot.key}` } });
  check(page.status === 200, "private report is readable with an API key");
  await page.arrayBuffer();

  // Password access + unlock cookie.
  const pw = cliJson(["publish", reportDir, "--repo", "e2e", "--doc", "locked", "--access", "password", "--password", "e2e-unlock-pass"]);
  check(pw.access === "password", "publish with password access", pw);
  page = await fetch(pw.url);
  check(page.status === 401 && (await page.text()).includes("__unlock"), "password report shows the gate page");
  const wrong = await fetch(`${base}/r/e2e/locked/__unlock`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "password=nope",
  });
  check(wrong.status === 401, "wrong unlock password is rejected");
  await wrong.arrayBuffer();
  const unlock = await fetch(`${base}/r/e2e/locked/__unlock`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "password=e2e-unlock-pass",
  });
  const cookie = (unlock.headers.get("set-cookie") ?? "").split(";")[0];
  check(unlock.status === 303 && cookie.startsWith("maradocs_pw_e2e__locked="), "correct password sets the unlock cookie", unlock.status);
  page = await fetch(pw.url, { headers: { cookie } });
  check(page.status === 200 && (await page.text()).includes("v2"), "unlock cookie grants access");
  check(/SameSite=None/.test(unlock.headers.get("set-cookie") ?? ""), "unlock cookie is SameSite=None (sandboxed report subresources are cross-site)");

  // Capability tokens: a browser navigation with the cookie is redirected to a
  // token URL whose subresources load without any cookie (as from the
  // sandboxed, opaque-origin report in browsers blocking third-party cookies).
  const nav = { "sec-fetch-mode": "navigate", "sec-fetch-dest": "document", "sec-fetch-site": "none" };
  const minted = await fetch(pw.url, { redirect: "manual", headers: { cookie, ...nav } });
  const tokenPath = minted.headers.get("location") ?? "";
  check(minted.status === 302 && /^\/r\/e2e\/locked\/~p\.[0-9a-z]+\.[A-Za-z0-9_-]{22}\/$/.test(tokenPath), "document navigation is redirected to a token URL", { status: minted.status, tokenPath });
  await minted.arrayBuffer();
  const tokenCss = await fetch(`${base}${tokenPath}css/site.css`, {
    headers: { "sec-fetch-mode": "no-cors", "sec-fetch-dest": "style", "sec-fetch-site": "cross-site" },
  });
  check(tokenCss.status === 200 && (await tokenCss.text()).includes("rebeccapurple"), "token URL serves subresources without cookies");
  check(tokenCss.headers.get("access-control-allow-origin") === "*" && !tokenCss.headers.has("access-control-allow-credentials"), "report files allow opaque-origin CORS reads without credentials");
  const tokenNav = await fetch(`${base}${tokenPath}`, { redirect: "manual", headers: nav });
  check(tokenNav.status === 401 && !(await tokenNav.text()).includes("~p."), "token alone does not open the document in a browser");
  const tokenCurl = await fetch(`${base}${tokenPath}css/site.css`);
  check(tokenCurl.status === 401, "token is not accepted without Sec-Fetch metadata");
  await tokenCurl.arrayBuffer();
  const preflight = await fetch(`${base}/r/e2e/locked/css/site.css`, {
    method: "OPTIONS",
    headers: { origin: "null", "access-control-request-method": "GET" },
  });
  check(preflight.status === 204 && preflight.headers.get("access-control-allow-methods") === "GET, HEAD", "CORS preflight is answered on report paths");
  const ranged = await fetch(`${base}${tokenPath}css/site.css`, {
    headers: { range: "bytes=0-1", "sec-fetch-mode": "no-cors", "sec-fetch-dest": "video", "sec-fetch-site": "cross-site" },
  });
  check(ranged.status === 206 && ranged.headers.get("content-range")?.startsWith("bytes 0-1/") && (await ranged.text()) === "h1", "byte ranges are served with 206");

  // Skill scripts (bash + curl + zip) against the same deployment.
  if (hasCommand("bash") && hasCommand("curl") && hasCommand("zip") && hasCommand("unzip")) {
    const skillEnv = { MARADOCS_SERVER_URL: base, MARADOCS_API_KEY: boot.key };
    const pub = skill("publish.sh", { ...skillEnv, report_path: reportDir, repo: "e2e-skill", doc: "via-skill", access: "public", title: "Skill" });
    check(pub.code === 0, "skill publish.sh succeeds (auto-creating the repo)", pub.stderr);
    const result = JSON.parse(pub.stdout);
    check(result.versionNumber === 1 && result.url === `${base}/r/e2e-skill/via-skill/`, "skill publish.sh prints the publish result", result);
    const again = JSON.parse(skill("publish.sh", { ...skillEnv, report_path: reportDir, repo: "e2e-skill", doc: "via-skill" }).stdout);
    check(again.versionNumber === 2, "skill publish.sh republishes as a new version", again);
    const skillOut = path.join(work, "skill-download");
    const down = skill("download.sh", { ...skillEnv, repo: "e2e-skill", doc: "via-skill", version: "1", out_dir: skillOut });
    check(down.code === 0, "skill download.sh succeeds", down.stderr);
    const downJson = JSON.parse(down.stdout);
    check(downJson.versionNumber === 1 && downJson.checksum === result.checksum && downJson.fileCount === 3, "skill download.sh reports version, checksum and files", downJson);
  } else {
    log("  skip - skill scripts (bash/curl/zip/unzip not all available)");
  }

  // Delete
  const del = cliJson(["doc", "delete", "e2e/smoke", "--yes"]);
  check(del.deleted === true, "doc delete", del);
  page = await fetch(`${base}/r/e2e/smoke/`);
  check(page.status === 404, "deleted report is gone");
  await page.arrayBuffer();
  const afterDelete = cliJson(["doc", "list", "e2e"]);
  check(!afterDelete.some((d) => d.slug === "smoke"), "doc list no longer shows the deleted doc");
  const missing = cli(["doc", "versions", "e2e/smoke", "--json"], { expectFail: true });
  check(missing.code !== 0 && /not found/.test(missing.stderr), "CLI surfaces 404 errors from the API", missing.stderr);

  log(`\nE2E passed: ${checks} checks`);
}

let exitCode = 0;
try {
  await main();
} catch (err) {
  exitCode = 1;
  console.error(`\nE2E FAILED: ${err instanceof Error ? err.message : err}`);
  if (wranglerLog) console.error(`\n--- wrangler output ---\n${wranglerLog.slice(-8000)}`);
} finally {
  stopWrangler();
  await new Promise((r) => setTimeout(r, 300));
  fs.rmSync(tmp, { recursive: true, force: true });
}
process.exit(exitCode);
