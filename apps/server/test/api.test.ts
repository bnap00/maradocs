import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import AdmZip from "adm-zip";
import type { FastifyInstance } from "fastify";
import { loadConfig } from "../src/config.js";
import { buildApp } from "../src/app.js";
import {
  createKey,
  login,
  makeApp,
  multipart,
  register,
  sha256hex,
  type TestApp,
} from "./helpers.js";

let t: TestApp;
let app: FastifyInstance;
let auth: { authorization: string };
let unscopedAuth: { authorization: string };

function bundle(): Buffer {
  const zip = new AdmZip();
  zip.addFile("index.html", Buffer.from("<h1>hi</h1>"));
  zip.addFile("style.css", Buffer.from("body{color:red}"));
  return zip.toBuffer();
}

function duplicatePathBundle(): Buffer {
  const entries = [
    { name: "index.html", data: Buffer.from("first") },
    { name: "index.html", data: Buffer.from("second") },
  ];
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const crc = crc32(entry.data);
    const local = Buffer.alloc(30 + name.length + entry.data.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(entry.data.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    entry.data.copy(local, 30 + name.length);
    locals.push(local);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(entry.data.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    centrals.push(central);

    offset += local.length;
  }

  const centralSize = centrals.reduce((sum, b) => sum + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let i = 0; i < 8; i += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

before(async () => {
  t = await makeApp();
  app = t.app;
  const owner = await register(app, "owner@example.com");
  auth = (await createKey(app, owner, ["publish", "admin"])).auth;
  // Keys can't be created without scopes through the API; insert one directly.
  const unscopedKey = "mdo_test-unscoped-key";
  t.ctx.store.createApiKey({
    userId: owner.id,
    name: "Test unscoped API key",
    keyHash: sha256hex(unscopedKey),
    prefix: unscopedKey.slice(0, 12),
    scopes: [],
  });
  unscopedAuth = { authorization: `Bearer ${unscopedKey}` };
});

after(async () => {
  await t.close();
});


test("health is ok", async () => {
  const res = await app.inject({ method: "GET", url: "/health" });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().status, "ok");
});

test("rejects unauthenticated API calls", async () => {
  const res = await app.inject({ method: "GET", url: "/api/v1/repos" });
  assert.equal(res.statusCode, 401);
});

test("rejects dashboard access without a valid session", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "maradocs-no-dev-"));
  const built = await buildApp(
    loadConfig({
      NODE_ENV: "development",
      DATA_DIR: dir,
      BCRYPT_ROUNDS: "4",
      NO_PRETTY_LOG: "1",
    }),
  );
  try {
    await built.app.ready();
    const res = await built.app.inject({
      method: "GET",
      url: "/api/v1/dashboard/repos",
      headers: { authorization: "Bearer anything" },
    });
    assert.equal(res.statusCode, 401);
  } finally {
    await built.app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("validates a configured production cookie secret and requires public base URL", () => {
  assert.throws(
    () =>
      loadConfig({
        NODE_ENV: "production",
        COOKIE_SECRET: "short",
        PUBLIC_BASE_URL: "https://example.com",
      }),
    /COOKIE_SECRET/,
  );
  assert.throws(
    () =>
      loadConfig({
        NODE_ENV: "production",
        COOKIE_SECRET: "x".repeat(32),
      }),
    /PUBLIC_BASE_URL/,
  );
  // Neither COOKIE_SECRET nor ADMIN_PASSWORD is required any more.
  const config = loadConfig({ NODE_ENV: "production", PUBLIC_BASE_URL: "https://example.com" });
  assert.equal(config.cookieSecret, null);
  assert.equal(config.adminPassword, null);
});

test("creates a repo and publishes a document", async () => {
  const create = await app.inject({
    method: "POST",
    url: "/api/v1/repos",
    headers: auth,
    payload: { slug: "demo", access: "public", name: "Demo" },
  });
  assert.equal(create.statusCode, 201);

  const mp = multipart({ doc: "hello" }, bundle());
  const pub = await app.inject({
    method: "POST",
    url: "/api/v1/repos/demo/docs",
    headers: { ...auth, ...mp.headers },
    payload: mp.body,
  });
  assert.equal(pub.statusCode, 201);
  const body = pub.json();
  assert.equal(body.versionNumber, 1);
  assert.equal(body.access, "public");
  assert.match(body.url, /\/r\/demo\/hello\/$/);
});

test("rejects unscoped API keys for publish operations", async () => {
  const create = await app.inject({
    method: "POST",
    url: "/api/v1/repos",
    headers: unscopedAuth,
    payload: { slug: "unscoped", access: "public", name: "Unscoped" },
  });
  assert.equal(create.statusCode, 403);
});

test("serves the published entrypoint and assets", async () => {
  const index = await app.inject({ method: "GET", url: "/r/demo/hello/" });
  assert.equal(index.statusCode, 200);
  assert.match(index.body, /<h1>hi<\/h1>/);
  assert.match(index.headers["content-security-policy"] as string, /sandbox/);

  const css = await app.inject({ method: "GET", url: "/r/demo/hello/style.css" });
  assert.equal(css.statusCode, 200);
  assert.match(css.headers["content-type"] as string, /text\/css/);
});

test("downloads a version bundle as a zip", async () => {
  const res = await app.inject({
    method: "GET",
    url: "/api/v1/repos/demo/docs/hello/bundle",
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  assert.match(res.headers["content-type"] as string, /application\/zip/);
  assert.equal(res.headers["x-maradocs-version-number"], "1");
  assert.ok(res.headers["x-maradocs-checksum"]);

  const zip = new AdmZip(res.rawPayload);
  const names = zip.getEntries().map((e) => e.entryName).sort();
  assert.deepEqual(names, ["index.html", "style.css"]);
  assert.equal(zip.readAsText("index.html"), "<h1>hi</h1>");

  // Pinned version works the same way.
  const pinned = await app.inject({
    method: "GET",
    url: "/api/v1/repos/demo/docs/hello/bundle?version=1",
    headers: auth,
  });
  assert.equal(pinned.statusCode, 200);

  // Unknown versions and unscoped keys are rejected.
  const missing = await app.inject({
    method: "GET",
    url: "/api/v1/repos/demo/docs/hello/bundle?version=99",
    headers: auth,
  });
  assert.equal(missing.statusCode, 404);

  const unscoped = await app.inject({
    method: "GET",
    url: "/api/v1/repos/demo/docs/hello/bundle",
    headers: unscopedAuth,
  });
  assert.equal(unscoped.statusCode, 403);
});

test("repository index escapes metadata and only lists public documents", async () => {
  await app.inject({
    method: "POST",
    url: "/api/v1/repos",
    headers: auth,
    payload: {
      slug: "indexed",
      access: "public",
      name: "<script>alert(1)</script>",
      description: "<img src=x onerror=alert(1)>",
      indexEnabled: true,
    },
  });

  const pub = multipart({ doc: "shown", title: "<b>shown</b>" }, bundle());
  await app.inject({
    method: "POST",
    url: "/api/v1/repos/indexed/docs",
    headers: { ...auth, ...pub.headers },
    payload: pub.body,
  });

  const priv = multipart({ doc: "hidden", title: "Hidden", access: "private" }, bundle());
  await app.inject({
    method: "POST",
    url: "/api/v1/repos/indexed/docs",
    headers: { ...auth, ...priv.headers },
    payload: priv.body,
  });

  const res = await app.inject({ method: "GET", url: "/r/indexed/" });
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(res.body, /&lt;b&gt;shown&lt;\/b&gt;/);
  assert.doesNotMatch(res.body, /<script>|<img|hidden/);
});

test("POST publish rejects an existing document slug", async () => {
  await app.inject({
    method: "POST",
    url: "/api/v1/repos",
    headers: auth,
    payload: { slug: "create-only", access: "public" },
  });
  const first = multipart({ doc: "same" }, bundle());
  await app.inject({
    method: "POST",
    url: "/api/v1/repos/create-only/docs",
    headers: { ...auth, ...first.headers },
    payload: first.body,
  });
  const second = multipart({ doc: "same" }, bundle());
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/repos/create-only/docs",
    headers: { ...auth, ...second.headers },
    payload: second.body,
  });
  assert.equal(res.statusCode, 409);
});

test("rejects duplicate paths in uploaded bundles", async () => {
  await app.inject({
    method: "POST",
    url: "/api/v1/repos",
    headers: auth,
    payload: { slug: "dups", access: "public" },
  });
  const mp = multipart({ doc: "bad" }, duplicatePathBundle());
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/repos/dups/docs",
    headers: { ...auth, ...mp.headers },
    payload: mp.body,
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.body, /Duplicate path/);
});

test("blocks path traversal", async () => {
  const res = await app.inject({
    method: "GET",
    url: "/r/demo/hello/..%2f..%2f..%2fetc%2fpasswd",
  });
  assert.equal(res.statusCode, 404);
});

test("private documents require the owner's session or key", async () => {
  await app.inject({
    method: "POST",
    url: "/api/v1/repos",
    headers: auth,
    payload: { slug: "secret", access: "private" },
  });
  const mp = multipart({ doc: "topsecret" }, bundle());
  await app.inject({
    method: "POST",
    url: "/api/v1/repos/secret/docs",
    headers: { ...auth, ...mp.headers },
    payload: mp.body,
  });

  const anon = await app.inject({ method: "GET", url: "/r/secret/topsecret/" });
  assert.equal(anon.statusCode, 401);

  const signIn = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { email: "owner@example.com", password: "correct-horse-battery" },
  });
  assert.equal(signIn.statusCode, 200);
  const setCookie = signIn.headers["set-cookie"];
  assert.ok(setCookie);
  const sessionCookie = Array.isArray(setCookie) ? setCookie[0] : setCookie;

  const authed = await app.inject({
    method: "GET",
    url: "/r/secret/topsecret/",
    headers: { cookie: sessionCookie!.split(";")[0] },
  });
  assert.equal(authed.statusCode, 200);
  assert.match(authed.body, /<h1>hi<\/h1>/);

  const machine = await app.inject({
    method: "GET",
    url: "/r/secret/topsecret/",
    headers: auth,
  });
  assert.equal(machine.statusCode, 200);
  assert.match(machine.body, /<h1>hi<\/h1>/);

  const bearerSession = await app.inject({
    method: "GET",
    url: "/r/secret/topsecret/",
    headers: { authorization: `Bearer ${await login(app, "owner@example.com")}` },
  });
  assert.equal(bearerSession.statusCode, 200);
});

test("password documents unlock from the browser form", async () => {
  await app.inject({
    method: "POST",
    url: "/api/v1/repos",
    headers: auth,
    payload: { slug: "passworded", access: "public" },
  });
  const mp = multipart({ doc: "protected", access: "password", password: "test-password" }, bundle());
  await app.inject({
    method: "POST",
    url: "/api/v1/repos/passworded/docs",
    headers: { ...auth, ...mp.headers },
    payload: mp.body,
  });

  const gated = await app.inject({ method: "GET", url: "/r/passworded/protected/" });
  assert.equal(gated.statusCode, 401);
  assert.match(gated.body, /This report is protected/);

  const unlock = await app.inject({
    method: "POST",
    url: "/r/passworded/protected/__unlock",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    payload: "password=test-password",
  });
  assert.equal(unlock.statusCode, 303);
  const cookie = unlock.headers["set-cookie"];
  assert.ok(cookie);

  const cookieHeader = Array.isArray(cookie) ? cookie[0] : cookie;
  const unlocked = await app.inject({
    method: "GET",
    url: "/r/passworded/protected/",
    headers: { cookie: cookieHeader!.split(";")[0] },
  });
  assert.equal(unlocked.statusCode, 200);
  assert.match(unlocked.body, /<h1>hi<\/h1>/);
});

test("versions and rollback", async () => {
  const mp = multipart({ doc: "hello" }, bundle());
  await app.inject({
    method: "PUT",
    url: "/api/v1/repos/demo/docs/hello",
    headers: { ...auth, ...mp.headers },
    payload: mp.body,
  });

  const versions = await app.inject({
    method: "GET",
    url: "/api/v1/repos/demo/docs/hello/versions",
    headers: auth,
  });
  assert.equal(versions.statusCode, 200);
  assert.equal(versions.json().versions.length, 2);

  const rollback = await app.inject({
    method: "POST",
    url: "/api/v1/repos/demo/docs/hello/rollback",
    headers: auth,
    payload: { version: 1 },
  });
  assert.equal(rollback.statusCode, 200);
  assert.equal(rollback.json().doc.latestVersionNumber, 1);
});
