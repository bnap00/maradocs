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

const server = spawn(process.execPath, ["apps/server/dist/index.js"], {
  cwd: root,
  stdio: ["ignore", "pipe", "pipe"],
  env: {
    ...process.env,
    PORT: port,
    HOST: "127.0.0.1",
    DATA_DIR: path.join(tmp, "data"),
    PUBLIC_BASE_URL: baseUrl,
    COOKIE_SECRET: "0123456789abcdef0123456789abcdef",
    ADMIN_PASSWORD: "test-password",
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

function runCli(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["packages/cli/dist/index.js", ...args], {
      cwd: root,
      stdio: "inherit",
      env: { ...process.env, ...env },
    });
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`CLI exited with ${code}`));
    });
  });
}

try {
  await waitForHealth();
  const { token } = await requestJson(`${baseUrl}/api/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "test-password" }),
  });
  const { key } = await requestJson(`${baseUrl}/api/v1/auth/keys`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ name: "e2e-cli" }),
  });
  const env = { MARADOCS_SERVER_URL: baseUrl, MARADOCS_API_KEY: key };
  await runCli(["repo", "create", "e2e", "--access", "public"], env);
  await runCli(["publish", report, "--repo", "e2e", "--doc", "smoke", "--title", "Smoke Test"], env);
  const doc = await fetch(`${baseUrl}/r/e2e/smoke/`);
  const html = await doc.text();
  if (!doc.ok || !html.includes("E2E MaraDocs Smoke")) {
    throw new Error(`published document check failed with ${doc.status}: ${html}`);
  }
  console.log("E2E smoke passed");
} finally {
  server.kill();
  fs.rmSync(tmp, { recursive: true, force: true });
}
