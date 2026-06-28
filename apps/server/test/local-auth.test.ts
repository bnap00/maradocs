import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { Store } from "../src/db/store.js";
import { LocalAuth, hashPassword } from "../src/auth/local.js";

let store: Store;
let auth: LocalAuth;
let dataDir: string;
const TEST_PASSWORD = "test-secret-123";

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "maradocs-auth-test-"));
  store = new Store(path.join(dataDir, "test.db"));
  const passwordHash = await hashPassword(TEST_PASSWORD, 4); // rounds=4 for test speed
  auth = new LocalAuth(store, passwordHash);
});

after(() => {
  store.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("verifyApiKey: returns null for unknown key", async () => {
  const result = await auth.verifyApiKey("mdo_unknown");
  assert.equal(result, null);
});

test("verifyApiKey: returns identity and touches last_used_at for known key", async () => {
  const rawKey = "mdo_testkey1234567890";
  const keyHash = sha256(rawKey);
  store.createApiKey({ name: "test key", keyHash, prefix: rawKey.slice(0, 12), scopes: ["publish"] });

  const result = await auth.verifyApiKey(rawKey);
  assert.ok(result);
  assert.equal(result.type, "machine");
  assert.equal(result.name, "test key");
  assert.deepEqual(result.scopes, ["publish"]);

  const stored = store.getApiKeyByHash(keyHash);
  assert.ok(stored!.lastUsedAt, "last_used_at should be set after verify");
});

test("verifySession: returns null for expired session", async () => {
  const past = new Date(Date.now() - 1000).toISOString();
  store.createSession({ tokenHash: sha256("expired-tok"), expiresAt: past });
  assert.equal(await auth.verifySession("expired-tok"), null);
});

test("verifySession: returns admin identity for valid session", async () => {
  const rawToken = "valid-session-token";
  const future = new Date(Date.now() + 60_000).toISOString();
  store.createSession({ tokenHash: sha256(rawToken), expiresAt: future });

  const result = await auth.verifySession(rawToken);
  assert.ok(result);
  assert.equal(result.type, "user");
  assert.equal(result.admin, true);
  assert.equal(result.userId, "admin");
});

test("checkAdminPassword: correct password returns true", async () => {
  assert.equal(await auth.checkAdminPassword(TEST_PASSWORD), true);
});

test("checkAdminPassword: wrong password returns false", async () => {
  assert.equal(await auth.checkAdminPassword("wrong-password"), false);
});
