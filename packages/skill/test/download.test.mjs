import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { runScript, scriptEnv, tmpdir, zipBuffer } from "./helpers.mjs";

const BUNDLE_HEADERS = {
  "content-type": "application/zip",
  "x-maradocs-version-number": "3",
  "x-maradocs-checksum": "abc123def456",
  "x-maradocs-entrypoint": "index.html",
};

function bundleServer(onRequest) {
  const zip = zipBuffer({
    "index.html": "<h1>from server</h1>\n",
    "assets/styles.css": "body{}\n",
  });
  return http.createServer((req, res) => {
    onRequest?.(req);
    req.resume();
    if (req.method === "GET" && req.url.startsWith("/api/v1/repos/demo/docs/hello/bundle")) {
      res.writeHead(200, BUNDLE_HEADERS).end(zip);
      return;
    }
    res.writeHead(404, { "content-type": "application/json" })
      .end('{"error":"not_found","message":"Document not found"}');
  });
}

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

test("download extracts a bundle and reports version metadata", async () => {
  const server = bundleServer();
  const port = await listen(server);
  const out = path.join(tmpdir("maradocs-skill-dl-"), "report");
  try {
    const result = await runScript("download.sh", scriptEnv({
      MARADOCS_SERVER_URL: `http://127.0.0.1:${port}`,
      MARADOCS_API_KEY: "mdo_test",
      repo: "demo",
      doc: "hello",
      out_dir: out,
    }));
    assert.equal(result.code, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.versionNumber, 3);
    assert.equal(parsed.checksum, "abc123def456");
    assert.equal(parsed.entrypoint, "index.html");
    assert.equal(parsed.fileCount, 2);
    assert.equal(
      fs.readFileSync(path.join(out, "index.html"), "utf8"),
      "<h1>from server</h1>\n",
    );
    assert.ok(fs.existsSync(path.join(out, "assets/styles.css")));
  } finally {
    fs.rmSync(path.dirname(out), { recursive: true, force: true });
    await new Promise((resolve) => server.close(resolve));
  }
});

test("download pins a version through the query string", async () => {
  let url = null;
  const server = bundleServer((req) => {
    url = req.url;
  });
  const port = await listen(server);
  const out = path.join(tmpdir("maradocs-skill-dl-"), "report");
  try {
    const result = await runScript("download.sh", scriptEnv({
      MARADOCS_SERVER_URL: `http://127.0.0.1:${port}`,
      MARADOCS_API_KEY: "mdo_test",
      repo: "demo",
      doc: "hello",
      version: "2",
      out_dir: out,
    }));
    assert.equal(result.code, 0, result.stderr);
    assert.equal(url, "/api/v1/repos/demo/docs/hello/bundle?version=2");
  } finally {
    fs.rmSync(path.dirname(out), { recursive: true, force: true });
    await new Promise((resolve) => server.close(resolve));
  }
});

test("download saves the raw zip with zip_path", async () => {
  const server = bundleServer();
  const port = await listen(server);
  const dir = tmpdir("maradocs-skill-dl-");
  const zipPath = path.join(dir, "bundle.zip");
  try {
    const result = await runScript("download.sh", scriptEnv({
      MARADOCS_SERVER_URL: `http://127.0.0.1:${port}`,
      MARADOCS_API_KEY: "mdo_test",
      repo: "demo",
      doc: "hello",
      zip_path: zipPath,
    }));
    assert.equal(result.code, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.zip, zipPath);
    // Zip magic bytes.
    const head = fs.readFileSync(zipPath).subarray(0, 2).toString("latin1");
    assert.equal(head, "PK");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    await new Promise((resolve) => server.close(resolve));
  }
});

test("download refuses a non-empty directory unless forced", async () => {
  const server = bundleServer();
  const port = await listen(server);
  const out = tmpdir("maradocs-skill-dl-");
  fs.writeFileSync(path.join(out, "existing.txt"), "keep me\n");
  try {
    const refused = await runScript("download.sh", scriptEnv({
      MARADOCS_SERVER_URL: `http://127.0.0.1:${port}`,
      MARADOCS_API_KEY: "mdo_test",
      repo: "demo",
      doc: "hello",
      out_dir: out,
    }));
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /not empty/);

    const forced = await runScript("download.sh", scriptEnv({
      MARADOCS_SERVER_URL: `http://127.0.0.1:${port}`,
      MARADOCS_API_KEY: "mdo_test",
      repo: "demo",
      doc: "hello",
      out_dir: out,
      force: "1",
    }));
    assert.equal(forced.code, 0, forced.stderr);
    assert.ok(fs.existsSync(path.join(out, "index.html")));
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
    await new Promise((resolve) => server.close(resolve));
  }
});

test("download surfaces server errors and exits non-zero", async () => {
  const server = http.createServer((req, res) => {
    req.resume();
    res.writeHead(404, { "content-type": "application/json" })
      .end('{"error":"not_found","message":"Document \'demo/missing\' not found"}');
  });
  const port = await listen(server);
  const out = path.join(tmpdir("maradocs-skill-dl-"), "report");
  try {
    const result = await runScript("download.sh", scriptEnv({
      MARADOCS_SERVER_URL: `http://127.0.0.1:${port}`,
      MARADOCS_API_KEY: "mdo_test",
      repo: "demo",
      doc: "missing",
      out_dir: out,
    }));
    assert.equal(result.code, 1);
    assert.match(result.stderr, /404/);
    assert.equal(result.stdout.trim(), "");
    assert.ok(!fs.existsSync(out), "no output directory on failure");
  } finally {
    fs.rmSync(path.dirname(out), { recursive: true, force: true });
    await new Promise((resolve) => server.close(resolve));
  }
});

test("download rejects a non-numeric version before any request", async () => {
  const result = await runScript("download.sh", scriptEnv({
    MARADOCS_SERVER_URL: "http://127.0.0.1:1",
    MARADOCS_API_KEY: "mdo_test",
    repo: "demo",
    doc: "hello",
    version: "latest",
  }));
  assert.equal(result.code, 1);
  assert.match(result.stderr, /version must be a positive integer/);
});
