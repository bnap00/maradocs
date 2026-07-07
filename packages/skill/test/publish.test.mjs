import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { root, runScript, scriptEnv, tmpdir } from "./helpers.mjs";

const scriptPath = path.join(root, "skill/scripts/publish.sh");

function reportDir() {
  const dir = tmpdir("maradocs-skill-report-");
  fs.writeFileSync(path.join(dir, "index.html"), "<h1>hello</h1>\n");
  return dir;
}

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

test("publish succeeds in a single request when the repo and doc are new", async () => {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    req.resume();
    if (req.method === "POST" && req.url === "/api/v1/repos/demo/docs") {
      res.writeHead(201, { "content-type": "application/json" }).end(
        '{"repo":"demo","doc":"hello","versionNumber":1,"url":"http://127.0.0.1/r/demo/hello/"}',
      );
      return;
    }
    res.writeHead(500).end();
  });
  const port = await listen(server);
  const dir = reportDir();
  try {
    const result = await runScript("publish.sh", scriptEnv({
      MARADOCS_SERVER_URL: `http://127.0.0.1:${port}`,
      MARADOCS_API_KEY: "mdo_test",
      report_path: dir,
      repo: "demo",
      doc: "hello",
    }));
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(requests, ["POST /api/v1/repos/demo/docs"]);
    // stdout is exactly one JSON object.
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.versionNumber, 1);
    assert.match(result.stderr, /published: /);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    await new Promise((resolve) => server.close(resolve));
  }
});

test("publish creates the repository on 404 and retries", async () => {
  const requests = [];
  let repoCreated = false;
  const server = http.createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    req.resume();
    if (req.method === "POST" && req.url === "/api/v1/repos") {
      repoCreated = true;
      res.writeHead(201).end("{}");
      return;
    }
    if (req.method === "POST" && req.url === "/api/v1/repos/newrepo/docs") {
      if (!repoCreated) {
        res.writeHead(404, { "content-type": "application/json" })
          .end('{"error":"not_found","message":"Repository not found"}');
        return;
      }
      res.writeHead(201, { "content-type": "application/json" })
        .end('{"repo":"newrepo","doc":"hello","versionNumber":1,"url":"http://x/r/newrepo/hello/"}');
      return;
    }
    res.writeHead(500).end();
  });
  const port = await listen(server);
  const dir = reportDir();
  try {
    const result = await runScript("publish.sh", scriptEnv({
      MARADOCS_SERVER_URL: `http://127.0.0.1:${port}`,
      MARADOCS_API_KEY: "mdo_test",
      report_path: dir,
      repo: "newrepo",
      doc: "hello",
      access: "public",
    }));
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(requests, [
      "POST /api/v1/repos/newrepo/docs",
      "POST /api/v1/repos",
      "POST /api/v1/repos/newrepo/docs",
    ]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    await new Promise((resolve) => server.close(resolve));
  }
});

test("publish retries an existing document with PUT", async () => {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    req.resume();
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
    res.writeHead(500).end();
  });
  const port = await listen(server);
  const dir = reportDir();
  try {
    const result = await runScript("publish.sh", scriptEnv({
      MARADOCS_SERVER_URL: `http://127.0.0.1:${port}`,
      MARADOCS_API_KEY: "mdo_test",
      report_path: dir,
      repo: "demo",
      doc: "hello",
      access: "public",
    }));
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /"versionNumber":2/);
    assert.deepEqual(requests, [
      "POST /api/v1/repos/demo/docs",
      "PUT /api/v1/repos/demo/docs/hello",
    ]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    await new Promise((resolve) => server.close(resolve));
  }
});

test("publish forwards title and entrypoint fields", async () => {
  let body = "";
  const server = http.createServer((req, res) => {
    req.on("data", (chunk) => {
      body += chunk.toString("latin1");
    });
    req.on("end", () => {
      res.writeHead(201, { "content-type": "application/json" })
        .end('{"repo":"demo","doc":"hello","versionNumber":1,"url":"http://x/r/demo/hello/"}');
    });
  });
  const port = await listen(server);
  const dir = reportDir();
  fs.writeFileSync(path.join(dir, "main.html"), "<h1>main</h1>\n");
  try {
    const result = await runScript("publish.sh", scriptEnv({
      MARADOCS_SERVER_URL: `http://127.0.0.1:${port}`,
      MARADOCS_API_KEY: "mdo_test",
      report_path: dir,
      repo: "demo",
      doc: "hello",
      title: "My Report",
      entrypoint: "main.html",
    }));
    assert.equal(result.code, 0, result.stderr);
    assert.match(body, /name="title"\r\n\r\nMy Report/);
    assert.match(body, /name="entrypoint"\r\n\r\nmain\.html/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    await new Promise((resolve) => server.close(resolve));
  }
});

test("publish surfaces server errors on stderr and exits non-zero", async () => {
  const server = http.createServer((req, res) => {
    req.resume();
    res.writeHead(400, { "content-type": "application/json" })
      .end('{"error":"validation_error","message":"invalid slug"}');
  });
  const port = await listen(server);
  const dir = reportDir();
  try {
    const result = await runScript("publish.sh", scriptEnv({
      MARADOCS_SERVER_URL: `http://127.0.0.1:${port}`,
      MARADOCS_API_KEY: "mdo_test",
      report_path: dir,
      repo: "demo",
      doc: "hello",
    }));
    assert.equal(result.code, 1);
    assert.match(result.stderr, /400.*invalid slug/);
    assert.equal(result.stdout.trim(), "", "stdout must stay clean on failure");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    await new Promise((resolve) => server.close(resolve));
  }
});

test("publish falls back to saved CLI config", async () => {
  let authorization = null;
  const server = http.createServer((req, res) => {
    authorization = req.headers.authorization ?? null;
    req.resume();
    if (req.method === "POST" && req.url === "/api/v1/repos/config-demo/docs") {
      res.writeHead(201, { "content-type": "application/json" }).end(
        '{"repo":"config-demo","doc":"hello","versionNumber":1,"url":"http://127.0.0.1/r/config-demo/hello/"}',
      );
      return;
    }
    res.writeHead(500).end();
  });
  const port = await listen(server);
  const dir = reportDir();
  const home = tmpdir("maradocs-skill-home-");
  try {
    fs.mkdirSync(path.join(home, ".maradocs"));
    fs.writeFileSync(
      path.join(home, ".maradocs/config.json"),
      JSON.stringify({ server: `http://127.0.0.1:${port}`, apiKey: "mdo_from_config" }),
    );
    const result = await runScript("publish.sh", scriptEnv({
      HOME: home,
      MARADOCS_SERVER_URL: undefined,
      MARADOCS_API_KEY: undefined,
      report_path: dir,
      repo: "config-demo",
      doc: "hello",
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
