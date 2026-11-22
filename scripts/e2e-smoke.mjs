import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "maradocs-e2e-"));
const report = path.join(tmp, "report");
const port = String(18000 + Math.floor(Math.random() * 1000));
const baseUrl = `http://127.0.0.1:${port}`;

fs.mkdirSync(report);
fs.writeFileSync(
  path.join(report, "index.html"),
  "<!doctype html><html><body><h1>E2E MaraDocs Smoke</h1></body></html>",
);

const email = "e2e@example.com";
const password = "e2e-test-password-123";
// Don't let a developer's real ADMIN_PASSWORD / COOKIE_SECRET leak into the test server.
const parentEnv = { ...process.env };
delete parentEnv.ADMIN_PASSWORD;
delete parentEnv.COOKIE_SECRET;

const server = spawn(process.execPath, ["apps/server/dist/index.js"], {
  cwd: root,
  stdio: ["ignore", "pipe", "pipe"],
  env: {
    ...parentEnv,
    PORT: port,
    HOST: "127.0.0.1",
    DATA_DIR: path.join(tmp, "data"),
    PUBLIC_BASE_URL: baseUrl,
    // No secrets: the instance secret is generated and persisted on first
    // use, and the first visitor registers the owner account.
    REGISTRATION: "first",
    NODE_ENV: "production",
    NO_PRETTY_LOG: "1",
  },
});

let serverOutput = "";
server.stdout.on("data", (chunk) => {
  serverOutput += chunk.toString();
});
server.stderr.on("data", (chunk) => {
  serverOutput += chunk.toString();
});

async function waitForHealth() {
  for (let i = 0; i < 100; i += 1) {
    try {
      const res = await fetch(`${baseUrl}/health`);
      if (res.ok) return;
    } catch {
      // Server not ready yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`server did not become healthy:\n${serverOutput}`);
}

async function requestJson(url, options) {
  const res = await fetch(url, options);
  const text = await res.text();
  if (!res.ok) throw new Error(`${url} failed with ${res.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

function runCli(args, env, { capture = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["packages/cli/dist/index.js", ...args], {
      cwd: root,
      stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
      env: { ...process.env, ...env },
    });
    let stdout = "";
    if (capture) child.stdout.on("data", (chunk) => (stdout += chunk));
    child.on("exit", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`CLI exited with ${code}`));
    });
  });
}

async function cliJson(args, env) {
  const out = await runCli([...args, "--json"], env, { capture: true });
  try {
    return JSON.parse(out);
  } catch {
    throw new Error(`maradocs ${args.join(" ")} did not print JSON: ${out}`);
  }
}

try {
  await waitForHealth();
  const config = await requestJson(`${baseUrl}/api/v1/auth/config`);
  if (config.registration !== true || config.claimRequired !== false) {
    throw new Error(`fresh server should allow first registration: ${JSON.stringify(config)}`);
  }
  // Register the first account and mint a key through the CLI itself
  // (password via env, not argv).
  const authEnv = { MARADOCS_PASSWORD: password };
  const registered = await cliJson(
    ["auth", "bootstrap", "--server", baseUrl, "--email", email, "--register", "--name", "e2e-cli", "--no-save"],
    authEnv,
  );
  if (!registered.key?.startsWith("mdo_") || registered.user?.email !== email) {
    throw new Error(`auth bootstrap --register returned ${JSON.stringify(registered)}`);
  }
  const closed = await requestJson(`${baseUrl}/api/v1/auth/config`);
  if (closed.registration !== false) {
    throw new Error(`REGISTRATION=first should close after the first account: ${JSON.stringify(closed)}`);
  }
  // Signing in again (no --register) mints a second key for the same account.
  const signedIn = await cliJson(
    ["auth", "bootstrap", "--server", baseUrl, "--email", email, "--name", "e2e-cli-2", "--no-save"],
    authEnv,
  );
  if (!signedIn.key?.startsWith("mdo_") || signedIn.key === registered.key) {
    throw new Error(`auth bootstrap (login) returned ${JSON.stringify(signedIn)}`);
  }
  const key = registered.key;
  const env = { MARADOCS_SERVER_URL: baseUrl, MARADOCS_API_KEY: key };
  await runCli(["repo", "create", "e2e", "--access", "public"], env);
  await runCli(["publish", report, "--repo", "e2e", "--doc", "smoke", "--title", "Smoke Test"], env);
  const doc = await fetch(`${baseUrl}/r/e2e/smoke/`);
  const html = await doc.text();
  if (!doc.ok || !html.includes("E2E MaraDocs Smoke")) {
    throw new Error(`published document check failed with ${doc.status}: ${html}`);
  }

  // Regression: `--version <n>` on subcommands must reach the subcommand, not
  // print the CLI version (commander's program-level -V/--version).
  fs.writeFileSync(path.join(report, "index.html"), "<!doctype html><html><body><h1>E2E v2</h1></body></html>");
  await runCli(["publish", report, "--repo", "e2e", "--doc", "smoke"], env);
  const outDir = path.join(tmp, "download-v1");
  const dl = await cliJson(["doc", "download", "e2e/smoke", "--version", "1", "--out", outDir], env);
  if (dl.versionNumber !== 1 || !fs.readFileSync(path.join(outDir, "index.html"), "utf8").includes("E2E MaraDocs Smoke")) {
    throw new Error(`doc download --version 1 returned ${JSON.stringify(dl)}`);
  }
  const rolled = await cliJson(["doc", "rollback", "e2e/smoke", "--version", "1"], env);
  if (rolled.latestVersionNumber !== 1) {
    throw new Error(`doc rollback --version 1 returned ${JSON.stringify(rolled)}`);
  }
  console.log("E2E smoke passed");
} finally {
  server.kill();
  fs.rmSync(tmp, { recursive: true, force: true });
}
