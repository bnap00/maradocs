// Regression tests for the built CLI (dist/index.js) against a stub server.
// Run `pnpm --filter @maradocs/cli build` first.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "dist/index.js");
const { version: cliVersion } = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

const AUTH_ENV = [
  "MARADOCS_SERVER_URL",
  "MARADOCS_API_KEY",
  "MARADOCS_EMAIL",
  "MARADOCS_PASSWORD",
  "MARADOCS_CLAIM_PASSWORD",
];

function run(args, env = {}, { stdin, home: fixedHome } = {}) {
  const home = fixedHome ?? fs.mkdtempSync(path.join(os.tmpdir(), "maradocs-cli-test-"));
  const baseEnv = { ...process.env };
  for (const name of AUTH_ENV) delete baseEnv[name];
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], {
      env: { ...baseEnv, HOME: home, USERPROFILE: home, NO_COLOR: "1", ...env },
      stdio: [stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    if (stdin !== undefined) child.stdin.end(stdin);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("close", (code) => {
      if (!fixedHome) fs.rmSync(home, { recursive: true, force: true });
      resolve({ code, stdout, stderr });
    });
  });
}

/** Stub server recording requests; `handler` returns [status, headers, body]. */
async function stub(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const entry = { method: req.method, url: req.url, headers: req.headers, body };
      requests.push(entry);
      const [status, headers, payload] = handler(entry);
      res.writeHead(status, headers).end(payload);
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { url, requests, close: () => new Promise((r) => server.close(r)) };
}

const json = (status, value) => [status, { "content-type": "application/json" }, JSON.stringify(value)];

test("--version / -V print the CLI version", async () => {
  for (const flag of ["--version", "-V"]) {
    const res = await run([flag]);
    assert.equal(res.code, 0);
    assert.equal(res.stdout.trim(), cliVersion);
  }
});

test("doc rollback --version N reaches the subcommand (not the program --version)", async () => {
  const server = await stub((req) =>
    req.url === "/api/v1/repos/demo/docs/hello/rollback"
      ? json(200, { doc: { slug: "hello", latestVersionNumber: 2 } })
      : json(500, {}),
  );
  try {
    for (const args of [["--version", "2"], ["-v", "2"], ["--version=2"]]) {
      const res = await run(["doc", "rollback", "demo/hello", ...args, "--json"], {
        MARADOCS_SERVER_URL: server.url,
        MARADOCS_API_KEY: "mdo_test",
      });
      assert.equal(res.code, 0, res.stderr);
      assert.deepEqual(JSON.parse(res.stdout), { slug: "hello", latestVersionNumber: 2 });
    }
    assert.equal(server.requests.length, 3);
    for (const req of server.requests) {
      assert.equal(req.method, "POST");
      assert.deepEqual(JSON.parse(req.body), { version: 2 });
    }
    const bad = await run(["doc", "rollback", "demo/hello", "--version", "abc", "--json"], {
      MARADOCS_SERVER_URL: server.url,
      MARADOCS_API_KEY: "mdo_test",
    });
    assert.equal(bad.code, 1);
    assert.equal(server.requests.length, 3);
  } finally {
    await server.close();
  }
});

test("doc download --version N downloads that version and decodes a Unicode entrypoint", async () => {
  const server = await stub((req) =>
    req.url === "/api/v1/repos/demo/hello/bundle" || req.url.startsWith("/api/v1/repos/demo/docs/hello/bundle")
      ? [
          200,
          {
            "content-type": "application/zip",
            "x-maradocs-version-number": "3",
            "x-maradocs-checksum": "abc",
            "x-maradocs-entrypoint-encoded": encodeURIComponent("报告.html"),
          },
          "PK-not-really-a-zip",
        ]
      : json(500, {}),
  );
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "maradocs-cli-dl-"));
  try {
    const zip = path.join(dir, "out.zip");
    const res = await run(["doc", "download", "demo/hello", "--version", "3", "--zip", zip, "--json"], {
      MARADOCS_SERVER_URL: server.url,
      MARADOCS_API_KEY: "mdo_test",
    });
    assert.equal(res.code, 0, res.stderr);
    const out = JSON.parse(res.stdout);
    assert.equal(out.versionNumber, 3);
    assert.equal(out.entrypoint, "报告.html");
    assert.equal(server.requests[0].url, "/api/v1/repos/demo/docs/hello/bundle?version=3");
    assert.equal(fs.readFileSync(zip, "utf8"), "PK-not-really-a-zip");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    await server.close();
  }
});

const USER = { id: "usr_1", email: "me@example.com", createdAt: "2026-01-01T00:00:00.000Z" };
const KEY = { key: "mdo_new", id: "akey_1", name: "cli-bootstrap", prefix: "mdo_new", scopes: ["publish"] };

/** Stub implementing the account auth API; `config` is GET /api/v1/auth/config. */
function authStub(config = { registration: false, claimRequired: false, minPasswordLength: 12 }, overrides = {}) {
  return stub((req) => {
    const override = overrides[req.url];
    if (override) return override(req);
    if (req.url === "/api/v1/auth/config") return json(200, config);
    if (req.url === "/api/v1/auth/login") return json(200, { user: USER, token: "session-token-123" });
    if (req.url === "/api/v1/auth/register") return json(201, { user: USER, token: "session-token-123" });
    if (req.url === "/api/v1/auth/keys") return json(201, KEY);
    if (req.url === "/api/v1/auth/logout") return [204, {}, ""];
    return json(500, {});
  });
}

const routes = (server) => server.requests.map((r) => `${r.method} ${r.url}`);

test("auth bootstrap signs in with email + password and revokes the session it used", async () => {
  const server = await authStub();
  try {
    const res = await run([
      "auth", "bootstrap", "--server", server.url,
      "--email", "me@example.com", "--password", "correct horse battery", "--no-save", "--json",
    ]);
    assert.equal(res.code, 0, res.stderr);
    const out = JSON.parse(res.stdout);
    assert.equal(out.key, "mdo_new");
    assert.equal(out.user.email, "me@example.com");
    assert.equal(out.registered, false);
    assert.deepEqual(routes(server), ["POST /api/v1/auth/login", "POST /api/v1/auth/keys", "POST /api/v1/auth/logout"]);
    assert.deepEqual(JSON.parse(server.requests[0].body), { email: "me@example.com", password: "correct horse battery" });
    assert.equal(server.requests[0].headers.origin, undefined);
    assert.equal(server.requests[1].headers.authorization, "Bearer session-token-123");
    assert.equal(server.requests[2].headers.authorization, "Bearer session-token-123");
  } finally {
    await server.close();
  }
});

test("auth bootstrap reads the password from MARADOCS_PASSWORD, then from stdin", async () => {
  const server = await authStub();
  try {
    const fromEnv = await run(
      ["auth", "bootstrap", "-s", server.url, "-e", "me@example.com", "--no-save", "--json"],
      { MARADOCS_PASSWORD: "env-password-123" },
    );
    assert.equal(fromEnv.code, 0, fromEnv.stderr);
    assert.equal(JSON.parse(server.requests[0].body).password, "env-password-123");

    const fromStdin = await run(
      ["auth", "bootstrap", "-s", server.url, "-e", "me@example.com", "--no-save", "--json"],
      {},
      { stdin: "stdin-password-123\n" },
    );
    assert.equal(fromStdin.code, 0, fromStdin.stderr);
    assert.equal(JSON.parse(server.requests[3].body).password, "stdin-password-123");
  } finally {
    await server.close();
  }
});

test("auth bootstrap fails clearly without an email or password when not interactive", async () => {
  const server = await authStub();
  try {
    const noEmail = await run(["auth", "bootstrap", "-s", server.url, "--password", "x".repeat(12), "--no-save"]);
    assert.equal(noEmail.code, 1);
    assert.match(noEmail.stderr, /--email is required/);

    const noPassword = await run(["auth", "bootstrap", "-s", server.url, "-e", "me@example.com", "--no-save"]);
    assert.equal(noPassword.code, 1);
    assert.match(noPassword.stderr, /stdin closed/);
    assert.equal(server.requests.length, 0);
  } finally {
    await server.close();
  }
});

test("auth bootstrap still revokes the session when minting the key fails", async () => {
  const server = await authStub(undefined, {
    "/api/v1/auth/keys": () => json(400, { error: "validation_error", message: "bad scopes" }),
  });
  try {
    const res = await run([
      "auth", "bootstrap", "--server", server.url, "-e", "me@example.com", "-p", "pw-pw-pw-pw-pw", "--no-save", "--json",
    ]);
    assert.equal(res.code, 1);
    assert.ok(server.requests.some((r) => r.url === "/api/v1/auth/logout"));
  } finally {
    await server.close();
  }
});

test("auth bootstrap hints at --register on invalid credentials", async () => {
  const server = await authStub(undefined, {
    "/api/v1/auth/login": () => json(401, { error: "unauthorized", message: "Invalid email or password" }),
  });
  try {
    const res = await run(["auth", "bootstrap", "-s", server.url, "-e", "me@example.com", "-p", "nope-nope-nope", "--no-save"]);
    assert.equal(res.code, 1);
    assert.match(res.stderr, /Invalid email or password.*--register/);
    assert.deepEqual(routes(server), ["POST /api/v1/auth/login"]);
  } finally {
    await server.close();
  }
});

test("auth bootstrap --register creates the account, then mints and saves a key", async () => {
  const server = await authStub({ registration: true, claimRequired: false, minPasswordLength: 12 });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "maradocs-cli-home-"));
  try {
    // A pre-existing, world-readable config must end up 0600 after saving.
    fs.mkdirSync(path.join(home, ".maradocs"));
    const configFile = path.join(home, ".maradocs", "config.json");
    fs.writeFileSync(configFile, "{}", { mode: 0o644 });
    fs.chmodSync(configFile, 0o644);

    const res = await run(
      ["auth", "bootstrap", "-s", `${server.url}/`, "-e", "me@example.com", "-p", "a-long-password", "--register", "--json"],
      {},
      { home },
    );
    assert.equal(res.code, 0, res.stderr);
    assert.equal(JSON.parse(res.stdout).registered, true);
    assert.deepEqual(routes(server), [
      "GET /api/v1/auth/config",
      "POST /api/v1/auth/register",
      "POST /api/v1/auth/keys",
      "POST /api/v1/auth/logout",
    ]);
    assert.deepEqual(JSON.parse(server.requests[1].body), { email: "me@example.com", password: "a-long-password" });
    assert.deepEqual(JSON.parse(fs.readFileSync(configFile, "utf8")), { server: server.url, apiKey: "mdo_new" });
    if (process.platform !== "win32") assert.equal(fs.statSync(configFile).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    await server.close();
  }
});

test("auth register is an alias of bootstrap --register", async () => {
  const server = await authStub({ registration: true, claimRequired: false, minPasswordLength: 12 });
  try {
    const res = await run(["auth", "register", "-s", server.url, "-e", "me@example.com", "-p", "a-long-password", "--no-save", "--json"]);
    assert.equal(res.code, 0, res.stderr);
    assert.deepEqual(routes(server).slice(0, 2), ["GET /api/v1/auth/config", "POST /api/v1/auth/register"]);
  } finally {
    await server.close();
  }
});

test("auth bootstrap --register fails clearly when registration is closed", async () => {
  const server = await authStub({ registration: false, claimRequired: false, minPasswordLength: 12 });
  try {
    const res = await run(["auth", "bootstrap", "-s", server.url, "-e", "me@example.com", "-p", "a-long-password", "--register", "--no-save"]);
    assert.equal(res.code, 1);
    assert.match(res.stderr, /Registration is not allowed/);
    assert.deepEqual(routes(server), ["GET /api/v1/auth/config"]);
  } finally {
    await server.close();
  }
});

test("auth bootstrap --register rejects a too-short password before calling register", async () => {
  const server = await authStub({ registration: true, claimRequired: false, minPasswordLength: 12 });
  try {
    const res = await run(["auth", "bootstrap", "-s", server.url, "-e", "me@example.com", "-p", "short", "--register", "--no-save"]);
    assert.equal(res.code, 1);
    assert.match(res.stderr, /at least 12 characters/);
    assert.deepEqual(routes(server), ["GET /api/v1/auth/config"]);
  } finally {
    await server.close();
  }
});

test("auth bootstrap --register sends the claim password when the server requires one", async () => {
  const server = await authStub({ registration: true, claimRequired: true, minPasswordLength: 12 });
  try {
    const missing = await run(["auth", "bootstrap", "-s", server.url, "-e", "me@example.com", "-p", "a-long-password", "--register", "--no-save"]);
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /claim password/);
    assert.deepEqual(routes(server), ["GET /api/v1/auth/config"]);

    const flag = await run([
      "auth", "bootstrap", "-s", server.url, "-e", "me@example.com", "-p", "a-long-password",
      "--register", "--claim-password", "old-admin-pw", "--no-save", "--json",
    ]);
    assert.equal(flag.code, 0, flag.stderr);
    assert.deepEqual(JSON.parse(server.requests[2].body), {
      email: "me@example.com",
      password: "a-long-password",
      claimPassword: "old-admin-pw",
    });

    const env = await run(
      ["auth", "bootstrap", "-s", server.url, "-e", "me@example.com", "-p", "a-long-password", "--register", "--no-save", "--json"],
      { MARADOCS_CLAIM_PASSWORD: "env-claim-pw" },
    );
    assert.equal(env.code, 0, env.stderr);
    const registers = server.requests.filter((r) => r.url === "/api/v1/auth/register");
    assert.equal(JSON.parse(registers.at(-1).body).claimPassword, "env-claim-pw");
  } finally {
    await server.close();
  }
});

test("auth bootstrap --admin-password is rejected with a pointer to the new flags", async () => {
  const server = await authStub();
  try {
    const res = await run(["auth", "bootstrap", "--server", server.url, "--admin-password", "pw", "--no-save", "--json"]);
    assert.equal(res.code, 1);
    const err = JSON.parse(res.stderr.trim().split("\n").at(-1));
    assert.match(err.message, /--admin-password was removed/);
    assert.match(err.message, /--email/);
    assert.match(err.message, /--claim-password/);
    assert.equal(server.requests.length, 0);
    const help = await run(["auth", "bootstrap", "--help"]);
    assert.doesNotMatch(help.stdout, /admin-password/);
  } finally {
    await server.close();
  }
});

test("auth status respects MARADOCS_SERVER_URL / MARADOCS_API_KEY", async () => {
  const server = await stub((req) => (req.url === "/health" ? json(200, { status: "ok" }) : json(500, {})));
  try {
    const res = await run(["auth", "status", "--json"], { MARADOCS_SERVER_URL: server.url, MARADOCS_API_KEY: "mdo_env" });
    assert.equal(res.code, 0, res.stderr);
    assert.deepEqual(JSON.parse(res.stdout), {
      loggedIn: true,
      server: server.url,
      apiKey: "set",
      serverReachable: true,
    });
    const none = await run(["auth", "status", "--json"]);
    assert.deepEqual(JSON.parse(none.stdout), { loggedIn: false });
  } finally {
    await server.close();
  }
});
