import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { Store } from "../src/db/store.js";
import { LocalAuth, SESSION_TTL_MS, hashPassword } from "../src/auth/local.js";

let store: Store;
let auth: LocalAuth;
let dataDir: string;
let userId: string;
const TEST_PASSWORD = "test-secret-123";

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "maradocs-auth-test-"));
  store = new Store(path.join(dataDir, "test.db"));
  auth = new LocalAuth(store, 4); // rounds=4 for test speed
  const user = store.createUser({
    email: "user@example.com",
    passwordHash: await hashPassword(TEST_PASSWORD, 4),
  });
  userId = user.id;
});

after(() => {
  store.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("verifyApiKey: returns null for unknown key", async () => {
  assert.equal(await auth.verifyApiKey("mdo_unknown"), null);
});

test("verifyApiKey: returns identity with owner and touches last_used_at", async () => {
  const rawKey = "mdo_testkey1234567890";
  const keyHash = sha256(rawKey);
  store.createApiKey({ userId, name: "test key", keyHash, prefix: rawKey.slice(0, 12), scopes: ["publish"] });

  const result = await auth.verifyApiKey(rawKey);
  assert.ok(result);
  assert.equal(result.type, "machine");
  assert.equal(result.userId, userId);
  assert.equal(result.name, "test key");
  assert.deepEqual(result.scopes, ["publish"]);
  assert.ok(store.getApiKeyByHash(keyHash)!.lastUsedAt, "last_used_at should be set after verify");
});

test("verifySession: returns null and deletes an expired session", async () => {
  const past = new Date(Date.now() - 1000).toISOString();
  store.createSession({ tokenHash: sha256("expired-tok"), userId, expiresAt: past });
  assert.equal(await auth.verifySession("expired-tok"), null);
  assert.equal(store.getSessionByHash(sha256("expired-tok")), null);
});

test("verifySession: returns the user identity for a valid session", async () => {
  const token = auth.createSession(userId, "test-agent");
  const result = await auth.verifySession(token);
  assert.ok(result);
  assert.equal(result.type, "user");
  assert.equal(result.userId, userId);
  assert.equal(result.email, "user@example.com");
  assert.equal(result.sessionTokenHash, sha256(token));
  assert.equal(result.sessionRefreshed, false);
  const session = store.getSessionByHash(sha256(token))!;
  assert.equal(session.userAgent, "test-agent");
  const ttl = Date.parse(session.expiresAt) - Date.now();
  assert.ok(ttl > SESSION_TTL_MS - 60_000 && ttl <= SESSION_TTL_MS);
});

test("verifySession: API keys are never sessions", async () => {
  assert.equal(await auth.verifySession("mdo_testkey1234567890"), null);
});

test("checkCredentials: right password, wrong password, unknown email", async () => {
  const ok = await auth.checkCredentials("user@example.com", TEST_PASSWORD);
  assert.equal(ok.ok, true);
  assert.equal(ok.user?.id, userId);
  const wrong = await auth.checkCredentials("user@example.com", "wrong-password");
  assert.equal(wrong.ok, false);
  assert.ok(wrong.user);
  const unknown = await auth.checkCredentials("nobody@example.com", TEST_PASSWORD);
  assert.deepEqual(unknown, { user: null, ok: false });
});
