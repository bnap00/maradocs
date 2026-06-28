import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { loadConfig } from "../src/config.js";
import { buildApp } from "../src/app.js";

let app: FastifyInstance;
let dataDir: string;
const PASSWORD = "admin-test-pw";

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "maradocs-auth-routes-"));
  const config = loadConfig({
    NODE_ENV: "development",
    DATA_DIR: dataDir,
    PORT: "0",
    ADMIN_PASSWORD: PASSWORD,
    BCRYPT_ROUNDS: "4",
    NO_PRETTY_LOG: "1",
  } as NodeJS.ProcessEnv);
  const built = await buildApp(config);
  app = built.app;
  await app.ready();
});

after(async () => {
  await app.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("login rejects wrong password", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { password: "wrong" },
  });
  assert.equal(res.statusCode, 401);
});

test("login with correct password returns a bearer token", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { password: PASSWORD },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.ok(typeof body.token === "string" && body.token.length > 10);
  assert.ok(res.headers["set-cookie"], "login should also set a browser session cookie");
});

test("read-only API keys cannot publish", async () => {
  const login = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { password: PASSWORD },
  });
  const { token } = login.json<{ token: string }>();
  const auth = { authorization: `Bearer ${token}` };

  const create = await app.inject({
    method: "POST",
    url: "/api/v1/auth/keys",
    headers: auth,
    payload: { name: "read-only", scopes: ["read"] },
  });
  assert.equal(create.statusCode, 201);
  const { key, id } = create.json<{ key: string; id: string }>();

  const denied = await app.inject({
    method: "POST",
    url: "/api/v1/repos",
    headers: { authorization: `Bearer ${key}` },
    payload: { slug: "read-only-denied" },
  });
  assert.equal(denied.statusCode, 403);

  await app.inject({ method: "DELETE", url: `/api/v1/auth/keys/${id}`, headers: auth });
});

test("GET /keys requires auth", async () => {
  const res = await app.inject({ method: "GET", url: "/api/v1/auth/keys" });
  assert.equal(res.statusCode, 401);
});

test("full key lifecycle: login → create → list → delete", async () => {
  // Login
  const login = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { password: PASSWORD },
  });
  const { token } = login.json<{ token: string }>();
  const auth = { authorization: `Bearer ${token}` };

  // Create key
  const create = await app.inject({
    method: "POST",
    url: "/api/v1/auth/keys",
    headers: auth,
    payload: { name: "ci-key" },
  });
  assert.equal(create.statusCode, 201);
  const { key, id, prefix } = create.json<{ key: string; id: string; name: string; prefix: string }>();
  assert.ok(key.startsWith("mdo_"), "key must start with mdo_");
  assert.ok(prefix.startsWith("mdo_"), "prefix must start with mdo_");
  assert.equal(prefix, key.slice(0, 12));

  // List keys
  const list = await app.inject({ method: "GET", url: "/api/v1/auth/keys", headers: auth });
  assert.equal(list.statusCode, 200);
  const keys = list.json<{ keys: unknown[] }>().keys;
  assert.equal(keys.length, 1);

  // Delete key
  const del = await app.inject({ method: "DELETE", url: `/api/v1/auth/keys/${id}`, headers: auth });
  assert.equal(del.statusCode, 204);

  const afterDel = await app.inject({ method: "GET", url: "/api/v1/auth/keys", headers: auth });
  assert.equal(afterDel.json<{ keys: unknown[] }>().keys.length, 0);
});

test("logout invalidates the session", async () => {
  const login = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { password: PASSWORD },
  });
  const { token } = login.json<{ token: string }>();
  const auth = { authorization: `Bearer ${token}` };

  const logout = await app.inject({ method: "POST", url: "/api/v1/auth/logout", headers: auth });
  assert.equal(logout.statusCode, 204);

  // Token no longer works
  const after = await app.inject({ method: "GET", url: "/api/v1/auth/keys", headers: auth });
  assert.equal(after.statusCode, 401);
});
