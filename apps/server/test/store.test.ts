import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { Store } from "../src/db/store.js";

let store: Store;
let dataDir: string;
let userId: string;

before(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "maradocs-store-test-"));
  store = new Store(path.join(dataDir, "test.db"));
  userId = store.createUser({ email: "u@example.com", passwordHash: "x" }).id;
});

after(() => {
  store.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("api_keys: create, getByHash, list, touch, delete (scoped to owner)", () => {
  const key = store.createApiKey({ userId, name: "ci", keyHash: "abc123", prefix: "mdo_abc123", scopes: ["read"] });
  assert.equal(key.name, "ci");
  assert.equal(key.userId, userId);
  assert.deepEqual(key.scopes, ["read"]);
  assert.equal(key.lastUsedAt, null);

  const found = store.getApiKeyByHash("abc123");
  assert.ok(found);
  assert.equal(found.id, key.id);
  assert.equal(store.getApiKeyByHash("wrong"), null);

  store.touchApiKey(key.id);
  assert.ok(store.getApiKeyByHash("abc123")!.lastUsedAt);

  assert.equal(store.listApiKeys(userId).length, 1);
  assert.equal(store.listApiKeys("usr_other").length, 0);

  assert.equal(store.deleteApiKey(key.id, "usr_other"), false);
  assert.equal(store.deleteApiKey(key.id, userId), true);
  assert.equal(store.getApiKeyByHash("abc123"), null);
  assert.equal(store.listApiKeys(userId).length, 0);
});

test("sessions: create, getByHash, touch, delete, deleteOtherSessions", () => {
  const future = new Date(Date.now() + 60_000).toISOString();
  const session = store.createSession({ tokenHash: "tok123", userId, expiresAt: future, userAgent: "x".repeat(300) });
  assert.equal(session.tokenHash, "tok123");
  assert.equal(session.userAgent!.length, 200);
  assert.ok(store.getSessionByHash("tok123"));

  store.createSession({ tokenHash: "tok456", userId, expiresAt: future });
  store.createSession({ tokenHash: "tok789", userId, expiresAt: future });
  assert.equal(store.deleteOtherSessions(userId, "tok123"), 2);
  assert.equal(store.getSessionByHash("tok456"), null);

  const later = new Date(Date.now() + 120_000).toISOString();
  store.touchSession("tok123", later, later);
  assert.equal(store.getSessionByHash("tok123")!.expiresAt, later);

  const past = new Date(Date.now() - 60_000).toISOString();
  store.createSession({ tokenHash: "expired", userId, expiresAt: past });
  store.purgeExpiredSessions();
  assert.equal(store.getSessionByHash("expired"), null);

  store.deleteSession("tok123");
  assert.equal(store.getSessionByHash("tok123"), null);
});

test("machines: upsertMachine uses key_id, listMachines is scoped via the key owner", () => {
  const key = store.createApiKey({ userId, name: "runner", keyHash: "mkey", prefix: "mdo_mkey", scopes: ["publish"] });
  const m = store.upsertMachine({ keyId: key.id, name: "CI runner", scopes: ["publish"], subject: null });
  assert.equal(m.keyId, key.id);

  assert.ok(store.listMachines(userId).find((x) => x.keyId === key.id));
  assert.equal(store.listMachines("usr_other").length, 0);

  store.upsertMachine({ keyId: key.id, name: "CI runner v2", scopes: [], subject: null });
  assert.equal(store.listMachines(userId).find((x) => x.keyId === key.id)!.name, "CI runner v2");

  store.deleteApiKey(key.id, userId);
  assert.equal(store.listMachines(userId).length, 0);
});

test("settings: getOrCreateSetting keeps the first value", () => {
  assert.equal(store.getSetting("k"), null);
  assert.equal(store.getOrCreateSetting("k", () => "one"), "one");
  assert.equal(store.getOrCreateSetting("k", () => "two"), "one");
});

test("migrates a pre-accounts database: owner columns added, admin_sessions dropped", () => {
  const dbPath = path.join(dataDir, "legacy.db");
  const legacy = new Database(dbPath);
  legacy.exec(`
    CREATE TABLE repositories (id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
      description TEXT, default_access TEXT NOT NULL DEFAULT 'private', index_enabled INTEGER NOT NULL DEFAULT 0,
      password_hash TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE api_keys (id TEXT PRIMARY KEY, name TEXT NOT NULL, key_hash TEXT NOT NULL UNIQUE,
      prefix TEXT NOT NULL, created_at TEXT NOT NULL, last_used_at TEXT);
    CREATE TABLE audit_log (id TEXT PRIMARY KEY, event TEXT NOT NULL, actor_type TEXT NOT NULL, actor_id TEXT,
      actor_label TEXT, repository_slug TEXT, document_slug TEXT, detail TEXT, created_at TEXT NOT NULL);
    CREATE TABLE admin_sessions (token_hash TEXT PRIMARY KEY, created_at TEXT NOT NULL, expires_at TEXT NOT NULL);
    INSERT INTO repositories VALUES ('repo_1','old','Old',NULL,'private',0,NULL,'2024-01-01','2024-01-01');
    INSERT INTO api_keys VALUES ('akey_1','old','h1','mdo_h1','2024-01-01',NULL);
    INSERT INTO audit_log VALUES ('aud_1','repo.create','machine','akey_1','old','old',NULL,NULL,'2024-01-01');
  `);
  legacy.close();

  const migrated = new Store(dbPath);
  try {
    assert.equal(migrated.getRepo("old")!.ownerId, null);
    assert.deepEqual(migrated.getApiKeyByHash("h1")!.scopes, ["publish"]);
    const raw = new Database(dbPath, { readonly: true });
    const tables = (raw.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as { name: string }[]).map((r) => r.name);
    raw.close();
    assert.ok(!tables.includes("admin_sessions"));
    assert.ok(tables.includes("users") && tables.includes("sessions") && tables.includes("settings"));

    const first = migrated.createUser({ email: "first@example.com", passwordHash: "x" });
    assert.equal(migrated.getRepo("old")!.ownerId, first.id);
    assert.equal(migrated.getApiKeyByHash("h1")!.userId, first.id);
    assert.equal(migrated.listAudit(first.id).length, 1);

    const second = migrated.createUser({ email: "second@example.com", passwordHash: "x" });
    assert.equal(migrated.listRepos(second.id).length, 0);
  } finally {
    migrated.close();
  }
});
