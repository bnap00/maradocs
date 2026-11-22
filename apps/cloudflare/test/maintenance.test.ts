// Schema migrations, the orphan-blob sweep, write throttling, audit integrity
// under races, data invariants and the served OpenAPI document.
import { beforeAll, describe, expect, it } from "vitest";
import worker from "../src/index";
import { MIGRATIONS, SCHEMA_VERSION, ensureSchema, migrate, resetSchemaCache } from "../src/schema";
import { ORPHAN_MIN_AGE_MS, sweepOrphanBlobs } from "../src/services/gc";
import { TOUCH_INTERVAL_MS } from "../src/services/auth";
import {
  auditEvents,
  bearer,
  browser,
  createApiKey,
  createRepo,
  env,
  fetchApp,
  json,
  login,
  machineJson,
  publish,
  uniqueSlug,
  waitFor,
  type Account,
} from "./helpers";

let session: Account;
let key: string;

beforeAll(async () => {
  session = await login();
  key = await createApiKey(session.token, ["publish"]);
});

async function columns(table: string): Promise<string[]> {
  const { results } = await env.DB.prepare(`SELECT name FROM pragma_table_info(?)`).bind(table).all<{ name: string }>();
  return results.map((r) => r.name);
}

describe("schema migrations", () => {
  const OWNED = [
    ["repositories", "owner_id", "idx_repos_owner"],
    ["api_keys", "user_id", "idx_api_keys_user"],
    ["machines", "user_id", "idx_machines_user"],
    ["audit_log", "user_id", "idx_audit_user_created"],
  ] as const;

  /** Turn this database back into a v3 one (single-admin sessions, no owners). */
  async function downgradeToV3(): Promise<void> {
    for (const [table, column, index] of OWNED) {
      await env.DB.prepare(`DROP INDEX IF EXISTS ${index}`).run();
      await env.DB.prepare(`ALTER TABLE ${table} DROP COLUMN ${column}`).run();
    }
    await env.DB.prepare(
      `CREATE TABLE admin_sessions (token_hash TEXT PRIMARY KEY, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, cred_fp TEXT)`,
    ).run();
    await env.DB.prepare(`UPDATE settings SET value = '3' WHERE key = 'schema_version'`).run();
  }

  /** The downgrade dropped ownership; give this file's rows back to its owner. */
  async function restoreOwnership(): Promise<void> {
    for (const [table, column] of OWNED) {
      await env.DB.prepare(`UPDATE ${table} SET ${column} = ? WHERE ${column} IS NULL`).bind(session.userId).run();
    }
  }

  it("adds account tables and owner columns to databases created by an earlier schema version", async () => {
    expect(SCHEMA_VERSION).toBe(MIGRATIONS[MIGRATIONS.length - 1]!.version);
    await downgradeToV3();
    expect(await columns("repositories")).not.toContain("owner_id");
    resetSchemaCache();
    await ensureSchema(env.DB);
    for (const [table, column] of OWNED) expect(await columns(table)).toContain(column);
    expect(await columns("sessions")).toEqual(
      expect.arrayContaining(["token_hash", "user_id", "created_at", "expires_at", "last_seen", "user_agent"]),
    );
    expect(await columns("admin_sessions")).toEqual([]);
    const version = await env.DB.prepare(`SELECT value FROM settings WHERE key = 'schema_version'`).first<{ value: string }>();
    expect(Number(version?.value)).toBe(SCHEMA_VERSION);
    await restoreOwnership();
  });

  it("tolerates a migration that another isolate already applied (duplicate column)", async () => {
    await env.DB.prepare(`UPDATE settings SET value = '3' WHERE key = 'schema_version'`).run();
    expect(await migrate(env.DB)).toBe(SCHEMA_VERSION);
    expect(await columns("repositories")).toContain("owner_id");
    // The owner's session survived (only admin_sessions are dropped).
    expect((await fetchApp("/api/v1/auth/me", { headers: bearer(session.token) })).status).toBe(200);
  });

  it("never moves the recorded version backwards", async () => {
    await env.DB.prepare(`UPDATE settings SET value = '99' WHERE key = 'schema_version'`).run();
    expect(await migrate(env.DB)).toBe(99);
    const row = await env.DB.prepare(`SELECT value FROM settings WHERE key = 'schema_version'`).first<{ value: string }>();
    expect(row?.value).toBe("99");
    await env.DB.prepare(`UPDATE settings SET value = ? WHERE key = 'schema_version'`).bind(String(SCHEMA_VERSION)).run();
  });
});

describe("orphan blob sweep", () => {
  it("removes old unreferenced blobs and keeps referenced or recent ones", async () => {
    const repo = uniqueSlug("gc");
    await createRepo(key, repo);
    await publish(key, repo, "doc", { "index.html": "kept" });
    const referenced = (await env.DB.prepare(
      `SELECT v.storage_path FROM document_versions v JOIN documents d ON d.id = v.document_id
       JOIN repositories r ON r.id = d.repository_id WHERE r.slug = ?`,
    )
      .bind(repo)
      .first<{ storage_path: string }>())!.storage_path;
    const orphan = `versions/ver_orphan_${crypto.randomUUID()}.bin`;
    await env.BUCKET.put(orphan, "lost");

    // Recent orphans are left alone (their publish may still be committing).
    const early = await sweepOrphanBlobs(env);
    expect(early.deleted).not.toContain(orphan);

    const later = await sweepOrphanBlobs(env, { now: Date.now() + ORPHAN_MIN_AGE_MS + 60_000 });
    expect(later.deleted).toContain(orphan);
    expect(later.deleted).not.toContain(referenced);
    expect(await env.BUCKET.head(orphan)).toBeNull();
    expect(await env.BUCKET.head(referenced)).not.toBeNull();
    expect(await (await fetchApp(`/r/${repo}/doc/`)).text()).toBe("kept");
  });

  it("is wired to the cron trigger", async () => {
    const orphan = `versions/ver_cron_${crypto.randomUUID()}.bin`;
    await env.BUCKET.put(orphan, "lost");
    const pending: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p), passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
    await worker.scheduled!({ cron: "17 3 * * *", scheduledTime: Date.now(), noRetry() {} } as ScheduledController, env, ctx);
    await Promise.all(pending);
    // Too recent to be swept by a real run; the handler ran without error.
    expect(await env.BUCKET.head(orphan)).not.toBeNull();
  });
});

describe("API key usage tracking", () => {
  it("records usage at most once per interval", async () => {
    const probe = await createApiKey(session.token, ["read"], "throttle-probe");
    await fetchApp("/api/v1/repos", { headers: bearer(probe) });
    const first = await waitFor(async () => {
      const row = await env.DB.prepare(`SELECT last_used_at FROM api_keys WHERE name = 'throttle-probe'`).first<{ last_used_at: string | null }>();
      return row?.last_used_at;
    });
    await fetchApp("/api/v1/repos", { headers: bearer(probe) });
    await new Promise((r) => setTimeout(r, 100));
    const second = await env.DB.prepare(`SELECT last_used_at FROM api_keys WHERE name = 'throttle-probe'`).first<{ last_used_at: string }>();
    expect(second?.last_used_at).toBe(first);

    // Once the interval has passed, the next request records again.
    const stale = new Date(Date.now() - TOUCH_INTERVAL_MS - 1000).toISOString();
    await env.DB.batch([
      env.DB.prepare(`UPDATE api_keys SET last_used_at = ? WHERE name = 'throttle-probe'`).bind(stale),
      env.DB.prepare(`UPDATE machines SET last_used_at = ? WHERE name = 'throttle-probe'`).bind(stale),
    ]);
    await fetchApp("/api/v1/repos", { headers: bearer(probe) });
    const third = await waitFor(async () => {
      const row = await env.DB.prepare(`SELECT last_used_at FROM api_keys WHERE name = 'throttle-probe'`).first<{ last_used_at: string }>();
      return row && row.last_used_at !== stale ? row.last_used_at : null;
    });
    expect(third > stale).toBe(true);
  });
});

describe("audit integrity", () => {
  it("audits a delete once even when two requests race", async () => {
    const repo = uniqueSlug("race-del");
    await createRepo(key, repo);
    await publish(key, repo, "doc", { "index.html": "x" });
    const results = await Promise.all([
      machineJson(key, "DELETE", `/repos/${repo}/docs/doc`),
      machineJson(key, "DELETE", `/repos/${repo}/docs/doc`),
    ]);
    const statuses = results.map((r) => r.status).sort();
    expect(statuses.filter((s) => s === 200)).toHaveLength(1);
    expect(await auditEvents({ repo, event: "doc.delete" })).toHaveLength(1);
  });

  it("audits repository deletes once and removes their blobs", async () => {
    const repo = uniqueSlug("race-repo");
    await createRepo(key, repo);
    await publish(key, repo, "doc", { "index.html": "x" });
    const path = (await env.DB.prepare(
      `SELECT v.storage_path FROM document_versions v JOIN documents d ON d.id = v.document_id
       JOIN repositories r ON r.id = d.repository_id WHERE r.slug = ?`,
    )
      .bind(repo)
      .first<{ storage_path: string }>())!.storage_path;
    const results = await Promise.all([
      fetchApp(`/api/v1/dashboard/repos/${repo}`, { method: "DELETE", headers: browser(session.cookie) }),
      fetchApp(`/api/v1/dashboard/repos/${repo}`, { method: "DELETE", headers: browser(session.cookie) }),
    ]);
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(await auditEvents({ repo, event: "repo.delete" })).toHaveLength(1);
    expect(await env.BUCKET.head(path)).toBeNull();
  });

  it("does not audit a rollback that lost its target", async () => {
    const repo = uniqueSlug("rb-gone");
    await createRepo(key, repo);
    await publish(key, repo, "doc", { "index.html": "1" });
    await publish(key, repo, "doc", { "index.html": "2" }, { replace: true });
    // Version 1 vanishes between the lookup and the update (simulated by deleting it first).
    await env.DB.prepare(
      `DELETE FROM document_versions WHERE version_number = 1 AND document_id =
         (SELECT d.id FROM documents d JOIN repositories r ON r.id = d.repository_id WHERE r.slug = ? AND d.slug = 'doc')`,
    )
      .bind(repo)
      .run();
    const res = await machineJson(key, "POST", `/repos/${repo}/docs/doc/rollback`, { version: 1 });
    expect(res.status).toBe(404);
    expect(await auditEvents({ repo, event: "doc.rollback" })).toHaveLength(0);
  });

  it("revokes API keys and writes the audit entry atomically", async () => {
    const res = await fetchApp("/api/v1/auth/keys", {
      method: "POST",
      headers: bearer(session.token, { "content-type": "application/json" }),
      body: JSON.stringify({ name: "atomic-revoke" }),
    });
    const created = await json(res);
    expect((await fetchApp(`/api/v1/auth/keys/${created.id}`, { method: "DELETE", headers: bearer(session.token) })).status).toBe(204);
    const rows = await env.DB.prepare(`SELECT detail FROM audit_log WHERE event = 'key.revoke' AND detail LIKE 'atomic-revoke%'`).all<{ detail: string }>();
    expect(rows.results).toHaveLength(1);
    expect(rows.results[0]!.detail).toBe(`atomic-revoke (${created.prefix}…)`);
    expect((await fetchApp(`/api/v1/auth/keys/${created.id}`, { method: "DELETE", headers: bearer(session.token) })).status).toBe(404);
    const after = await env.DB.prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE event = 'key.revoke' AND detail LIKE 'atomic-revoke%'`).first<{ n: number }>();
    expect(after?.n).toBe(1);
  });
});

describe("repository password invariants", () => {
  it("refuses to clear a repository password that documents depend on", async () => {
    const repo = uniqueSlug("strand");
    await createRepo(key, repo, { access: "private", password: "repopass" });
    await publish(key, repo, "d", { "index.html": "x" }, { access: "password" });
    const res = await machineJson(key, "PATCH", `/repos/${repo}`, { password: null });
    expect(res.status).toBe(400);
    const body = await json(res);
    expect(body.message).toContain("d");
    expect(body.details).toEqual({ documents: ["d"] });
    expect(await auditEvents({ repo, event: "access.change" })).toHaveLength(0);
    // Still gated by the password, not stranded.
    const gate = await fetchApp(`/r/${repo}/d/`);
    expect(gate.status).toBe(401);
    expect(await gate.text()).toContain("__unlock");

    // Once the document has its own password, the repository password can go.
    const patched = await fetchApp(`/api/v1/dashboard/repos/${repo}/docs/d`, {
      method: "PATCH",
      headers: browser(session.cookie, { "content-type": "application/json" }),
      body: JSON.stringify({ password: "docpass1" }),
    });
    expect(patched.status).toBe(200);
    expect((await machineJson(key, "PATCH", `/repos/${repo}`, { password: null })).status).toBe(200);
  });

  it("also covers documents inheriting 'password' access when the repo access changes", async () => {
    const repo = uniqueSlug("strand2");
    await createRepo(key, repo, { access: "password", password: "repopass" });
    await publish(key, repo, "inherits", { "index.html": "x" });
    expect((await machineJson(key, "PATCH", `/repos/${repo}`, { password: null })).status).toBe(400);
    expect((await machineJson(key, "PATCH", `/repos/${repo}`, { access: "private", password: null })).status).toBe(200);
  });
});

describe("OpenAPI document", () => {
  it("describes the Cloudflare responses", async () => {
    const spec = await json(await fetchApp("/api/v1/openapi.json"));
    const health = spec.paths["/health"].get.responses["200"].content["application/json"].schema.properties;
    expect(health.runtime).toBeDefined();
    expect(health.configured).toBeDefined();
    const pub = spec.paths["/api/v1/public-config"].get.responses["200"].content["application/json"].schema.properties;
    expect(Object.keys(pub)).toEqual(expect.arrayContaining(["defaultRepoAccess", "configured", "version"]));
    const login = spec.paths["/api/v1/auth/login"].post.responses;
    expect(Object.keys(login)).toEqual(expect.arrayContaining(["200", "400", "401", "403", "429"]));
    expect(login["429"].headers["Retry-After"]).toBeDefined();
    expect(spec.paths["/api/v1/auth/login"].post.requestBody.content["application/json"].schema.required).toEqual(["email", "password"]);
    for (const path of ["config", "register", "me", "logout", "logout-others", "change-password", "account"]) {
      expect(spec.paths[`/api/v1/auth/${path}`], path).toBeDefined();
    }
    expect(spec.paths["/api/v1/auth/register"].post.responses["409"]).toBeDefined();
    expect(spec.paths["/api/v1/auth/keys/{id}"].delete.responses["404"]).toBeDefined();
    expect(spec.paths["/api/v1/repos/{repo}/docs"].post.responses["411"]).toBeDefined();
    expect(spec.paths["/api/v1/repos/{repo}/docs/{doc}/bundle"].get.responses["200"].headers["x-maradocs-entrypoint-encoded"]).toBeDefined();
  });
});
