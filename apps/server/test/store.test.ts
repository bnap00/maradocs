import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/db/store.js";

let store: Store;
let dataDir: string;

before(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "maradocs-store-test-"));
  store = new Store(path.join(dataDir, "test.db"));
});

after(() => {
  store.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("api_keys: create, getByHash, list, touch, delete", () => {
  const key = store.createApiKey({ name: "ci", keyHash: "abc123", prefix: "mdo_abc123", scopes: ["read"] });
  assert.equal(key.name, "ci");
  assert.equal(key.keyHash, "abc123");
  assert.equal(key.prefix, "mdo_abc123");
  assert.deepEqual(key.scopes, ["read"]);
  assert.equal(key.lastUsedAt, null);

  const found = store.getApiKeyByHash("abc123");
  assert.ok(found);
  assert.equal(found.id, key.id);
  assert.deepEqual(found.scopes, ["read"]);

  assert.equal(store.getApiKeyByHash("wrong"), null);

  store.touchApiKey(key.id);
  const touched = store.getApiKeyByHash("abc123");
  assert.ok(touched!.lastUsedAt);

  assert.equal(store.listApiKeys().length, 1);

  store.deleteApiKey(key.id);
  assert.equal(store.getApiKeyByHash("abc123"), null);
  assert.equal(store.listApiKeys().length, 0);
});

test("admin_sessions: create, getByHash, delete, expiry", () => {
  const future = new Date(Date.now() + 60_000).toISOString();
  const session = store.createSession({ tokenHash: "tok123", expiresAt: future });
  assert.equal(session.tokenHash, "tok123");

  const found = store.getSessionByHash("tok123");
  assert.ok(found);

  const past = new Date(Date.now() - 60_000).toISOString();
  store.createSession({ tokenHash: "expired", expiresAt: past });
  assert.equal(store.getSessionByHash("expired"), null);

  store.deleteSession("tok123");
  assert.equal(store.getSessionByHash("tok123"), null);
});

test("machines: upsertMachine uses key_id, listMachines returns keyId", () => {
  const m = store.upsertMachine({ keyId: "akey_test123", name: "CI runner", scopes: ["publish"], subject: null });
  assert.equal(m.keyId, "akey_test123");
  assert.equal(m.name, "CI runner");

  const list = store.listMachines();
  const found = list.find((x) => x.keyId === "akey_test123");
  assert.ok(found);

  // upsert again (update)
  store.upsertMachine({ keyId: "akey_test123", name: "CI runner v2", scopes: [], subject: null });
  const updated = store.listMachines().find((x) => x.keyId === "akey_test123");
  assert.equal(updated!.name, "CI runner v2");
});
