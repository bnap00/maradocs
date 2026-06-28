import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = path.join(root, "skill/scripts/publish.sh");

function runPublish(env) {
  return new Promise((resolve) => {
    const child = spawn("bash", [scriptPath], {
      cwd: root,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function publishEnv(env) {
  const next = { ...process.env, ...env };
  for (const key of Object.keys(next)) {
    if (next[key] === undefined) delete next[key];
  }
  return next;
}

test("publish script retries an existing document with PUT", async () => {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ method: req.method, url: req.url });
    req.resume();

    if (req.method === "POST" && req.url === "/api/v1/repos") {
      res.writeHead(201).end("{}");
      return;
    }
    if (req.method === "POST" && req.url === "/api/v1/repos/demo/docs") {
      res.writeHead(409, { "content-type": "application/json" }).end('{"error":"conflict"}');
      return;
    }
    if (req.method === "PUT" && req.url === "/api/v1/repos/demo/docs/hello") {
      res.writeHead(200, { "content-type": "application/json" }).end(
        '{"repo":"demo","doc":"hello","versionNumber":2,"url":"http://127.0.0.1/r/demo/hello/"}',
      );
      return;
    }

    res.writeHead(404).end();
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "maradocs-skill-report-"));
  try {
    fs.writeFileSync(path.join(dir, "index.html"), "<h1>hello</h1>\n");
    const result = await runPublish(publishEnv({
      MARADOCS_SERVER_URL: `http://127.0.0.1:${address.port}`,
      MARADOCS_API_KEY: "mdo_test",
      report_path: dir,
      repo: "demo",
      doc: "hello",
      access: "public",
    }));

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /"versionNumber":2/);
    assert.deepEqual(
      requests.map((request) => `${request.method} ${request.url}`),
      [
        "POST /api/v1/repos",
        "POST /api/v1/repos/demo/docs",
        "PUT /api/v1/repos/demo/docs/hello",
      ],
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    await new Promise((resolve) => server.close(resolve));
  }
});

test("publish script falls back to saved CLI config", async () => {
  let authorization = null;
  const server = http.createServer((req, res) => {
    authorization = req.headers.authorization ?? null;
    req.resume();

    if (req.method === "POST" && req.url === "/api/v1/repos") {
      res.writeHead(201).end("{}");
      return;
    }
    if (req.method === "POST" && req.url === "/api/v1/repos/config-demo/docs") {
      res.writeHead(201, { "content-type": "application/json" }).end(
        '{"repo":"config-demo","doc":"hello","versionNumber":1,"url":"http://127.0.0.1/r/config-demo/hello/"}',
      );
      return;
    }

    res.writeHead(404).end();
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "maradocs-skill-report-"));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "maradocs-skill-home-"));
  try {
    fs.writeFileSync(path.join(dir, "index.html"), "<h1>hello</h1>\n");
    fs.mkdirSync(path.join(home, ".maradocs"));
    fs.writeFileSync(
      path.join(home, ".maradocs/config.json"),
      JSON.stringify({ server: `http://127.0.0.1:${address.port}`, apiKey: "mdo_from_config" }),
    );

    const result = await runPublish(publishEnv({
      HOME: home,
      MARADOCS_SERVER_URL: undefined,
      MARADOCS_API_KEY: undefined,
      report_path: dir,
      repo: "config-demo",
      doc: "hello",
      access: "public",
    }));

    assert.equal(result.code, 0, result.stderr);
    assert.equal(authorization, "Bearer mdo_from_config");
    assert.match(result.stdout, /"versionNumber":1/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
    await new Promise((resolve) => server.close(resolve));
  }
});

test("publish script is executable when packed", () => {
  const mode = fs.statSync(scriptPath).mode & 0o111;
  assert.notEqual(mode, 0, "publish.sh should have at least one executable bit set");
});
