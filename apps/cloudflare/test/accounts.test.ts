// Accounts: registration modes, the claim password, adoption of data from
// before accounts, account deletion, and per-account isolation of every API.
// Storage is isolated per test file, so this file starts with no accounts.
import { describe, expect, it } from "vitest";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { app } from "../src/app";
import { hashPassword, newId, sha256Hex } from "../src/crypto";
import { getCookieSecret } from "../src/db/settings";
import { migrate } from "../src/schema";
import { mintReportToken } from "../src/services/reportToken";
import {
  CLAIM_PASSWORD,
  ORIGIN,
  PASSWORD,
  bearer,
  browser,
  createApiKey,
  createRepo,
  env,
  fetchApp,
  freshIp,
  json,
  machineJson,
  publish,
  register,
  registerRequest,
  signIn,
  uniqueEmail,
  uniqueSlug,
  type Account,
} from "./helpers";

const NAV = { "sec-fetch-mode": "navigate", "sec-fetch-dest": "document", "sec-fetch-site": "none" };
const STYLE = { "sec-fetch-mode": "no-cors", "sec-fetch-dest": "style", "sec-fetch-site": "cross-site" };

/** Call the app with overridden bindings (REGISTRATION, ADMIN_PASSWORD). */
async function callWith(overrides: Record<string, string>, path: string, init: RequestInit = {}): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await app.fetch(new Request(`${ORIGIN}${path}`, { redirect: "manual", ...init }), { ...env, ...overrides }, ctx);
  const body = await res.arrayBuffer();
  await waitOnExecutionContext(ctx);
  return new Response(res.status === 204 ? null : body, res);
}

function registerInit(body: Record<string, unknown>, extra: Record<string, string> = {}): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": freshIp(), ...extra },
    body: JSON.stringify(body),
  };
}

const LEGACY_DASHBOARD_PASSWORD = "legacy-dashboard-password";

describe("the first account", () => {
  let legacyKey: string;
  let legacyRepo: string;

  it("is claimable only with the claim password, and adopts data from before accounts", async () => {
    await migrate(env.DB);
    // A deployment upgraded from the single-admin version: data without an owner.
    legacyRepo = uniqueSlug("legacy");
    legacyKey = `mdo_${crypto.randomUUID().replace(/-/g, "")}legacykey00`;
    const now = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO repositories (id, slug, name, default_access, index_enabled, created_at, updated_at)
         VALUES (?, ?, ?, 'private', 0, ?, ?)`,
      ).bind(newId("repo"), legacyRepo, legacyRepo, now, now),
      env.DB.prepare(`INSERT INTO api_keys (id, name, key_hash, prefix, scopes, created_at) VALUES (?, 'legacy', ?, ?, '["admin"]', ?)`).bind(
        newId("apikey"),
        await sha256Hex(legacyKey),
        legacyKey.slice(0, 12),
        now,
      ),
      env.DB.prepare(
        `INSERT INTO audit_log (id, event, actor_type, actor_id, actor_label, detail, created_at) VALUES (?, 'repo.create', 'user', 'admin', 'admin', 'legacy', ?)`,
      ).bind(newId("audit"), now),
      env.DB.prepare(`INSERT INTO settings (key, value) VALUES ('default_repo_access', 'public')`),
      env.DB.prepare(`INSERT INTO settings (key, value) VALUES ('admin_password_hash', ?)`).bind(
        await hashPassword(LEGACY_DASHBOARD_PASSWORD, 10_000),
      ),
    ]);

    // Keys from before accounts don't work until an account adopts them.
    const early = await fetchApp("/api/v1/repos", { headers: bearer(legacyKey) });
    expect(early.status).toBe(401);
    expect((await json(early)).message).toContain("predates user accounts");

    const first = { REGISTRATION: "first" };
    const config = await json(await callWith(first, "/api/v1/auth/config"));
    expect(config).toEqual({ registration: true, claimRequired: true, firstAccount: true, minPasswordLength: 12 });

    const email = uniqueEmail("first");
    const missing = await callWith(first, "/api/v1/auth/register", registerInit({ email, password: PASSWORD }));
    expect(missing.status).toBe(403);
    expect((await json(missing)).error).toBe("claim_required");
    const wrong = await callWith(first, "/api/v1/auth/register", registerInit({ email, password: PASSWORD, claimPassword: "not-it-at-all" }));
    expect(wrong.status).toBe(403);
    expect((await json(wrong)).error).toBe("claim_required");

    // The legacy dashboard-set password works as a claim password too (here
    // without any ADMIN_PASSWORD secret).
    const noSecret = { REGISTRATION: "first", ADMIN_PASSWORD: "" };
    expect((await json(await callWith(noSecret, "/api/v1/auth/config"))).claimRequired).toBe(true);
    const res = await callWith(
      noSecret,
      "/api/v1/auth/register",
      registerInit({ email: `  ${email.toUpperCase()} `, password: PASSWORD, claimPassword: LEGACY_DASHBOARD_PASSWORD }),
    );
    expect(res.status, await res.clone().text()).toBe(201);
    const body = await json(res);
    expect(body.user).toEqual({ id: expect.stringMatching(/^usr_[0-9a-f]{24}$/), email, createdAt: expect.any(String) });
    expect(typeof body.token).toBe("string");
    const userId = body.user.id as string;

    // Adoption: repositories, keys, audit, the default-access setting.
    const owner = await env.DB.prepare(`SELECT owner_id FROM repositories WHERE slug = ?`).bind(legacyRepo).first<{ owner_id: string }>();
    expect(owner?.owner_id).toBe(userId);
    expect((await env.DB.prepare(`SELECT COUNT(*) AS n FROM api_keys WHERE user_id IS NULL`).first<{ n: number }>())?.n).toBe(0);
    expect((await env.DB.prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE detail = 'legacy' AND user_id = ?`).bind(userId).first<{ n: number }>())?.n).toBe(1);
    const settings = await env.DB.prepare(`SELECT key, value FROM settings WHERE key LIKE 'default_repo_access%' OR key = 'admin_password_hash'`).all<{
      key: string;
      value: string;
    }>();
    expect(settings.results).toEqual([{ key: `default_repo_access:${userId}`, value: "public" }]);

    // The adopted key works and sees the adopted repository.
    const repos = await json(await fetchApp("/api/v1/repos", { headers: bearer(legacyKey) }));
    expect(repos.repos.map((r: { slug: string }) => r.slug)).toContain(legacyRepo);
    const me = await json(await fetchApp("/api/v1/auth/me", { headers: bearer(body.token) }));
    expect(me.user.id).toBe(userId);

    // Registration is now closed in "first" mode, and the claim no longer matters.
    expect(await json(await callWith(first, "/api/v1/auth/config"))).toEqual({
      registration: false,
      claimRequired: false,
      firstAccount: false,
      minPasswordLength: 12,
    });
    const second = await callWith(first, "/api/v1/auth/register", registerInit({ email: uniqueEmail(), password: PASSWORD, claimPassword: CLAIM_PASSWORD }));
    expect(second.status).toBe(403);
    expect((await json(second)).error).toBe("registration_closed");
  });

  it("closed mode refuses everyone; open mode needs no claim once accounts exist", async () => {
    const closed = await callWith({ REGISTRATION: "closed" }, "/api/v1/auth/register", registerInit({ email: uniqueEmail(), password: PASSWORD }));
    expect(closed.status).toBe(403);
    expect((await json(closed)).error).toBe("registration_closed");
    expect((await json(await callWith({ REGISTRATION: "closed" }, "/api/v1/auth/config"))).registration).toBe(false);

    const open = await callWith({ REGISTRATION: "open" }, "/api/v1/auth/register", registerInit({ email: uniqueEmail(), password: PASSWORD }));
    expect(open.status).toBe(201);
    expect((await json(await callWith({ REGISTRATION: "open" }, "/api/v1/auth/config"))).registration).toBe(true);
  });

  it("later accounts adopt nothing", async () => {
    const later = await register();
    const repos = await json(await fetchApp("/api/v1/dashboard/repos", { headers: bearer(later.token) }));
    expect(repos.repos).toEqual([]);
    const keys = await json(await fetchApp("/api/v1/auth/keys", { headers: bearer(later.token) }));
    expect(keys.keys).toEqual([]);
  });
});

describe("registration", () => {
  it("rejects a taken email (case-insensitively) with 409", async () => {
    const a = await register();
    const dup = await registerRequest({ email: a.email.toUpperCase(), password: PASSWORD });
    expect(dup.status).toBe(409);
    expect((await json(dup)).error).toBe("conflict");
  });

  it("validates email and password", async () => {
    for (const body of [
      { email: "not-an-email", password: PASSWORD },
      { email: uniqueEmail(), password: "short" },
      { email: uniqueEmail(), password: "x".repeat(1025) },
      { email: `${"a".repeat(250)}@x.io`, password: PASSWORD },
      { password: PASSWORD },
    ]) {
      const res = await registerRequest(body);
      expect(res.status, JSON.stringify(body).slice(0, 60)).toBe(400);
      expect((await json(res)).error).toBe("validation_error");
    }
  });

  it("rate limits sign-ups to 5 per hour per network", async () => {
    const ip = freshIp();
    for (let i = 0; i < 5; i += 1) {
      expect((await registerRequest({ email: uniqueEmail(), password: PASSWORD }, { "cf-connecting-ip": ip })).status).toBe(201);
    }
    const limited = await registerRequest({ email: uniqueEmail(), password: PASSWORD }, { "cf-connecting-ip": ip });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toMatch(/^\d+$/);
  });

  it("gives browsers only the cookie and blocks cross-site sign-ups", async () => {
    const res = await registerRequest({ email: uniqueEmail(), password: PASSWORD }, { origin: ORIGIN });
    expect(res.status).toBe(201);
    const body = await json(res);
    expect(body.token).toBeUndefined();
    const cookie = res.headers.get("set-cookie")!.split(";")[0]!;
    expect(cookie).toMatch(/^maradocs_session=/);
    expect((await fetchApp("/api/v1/auth/me", { headers: { cookie } })).status).toBe(200);
    expect((await registerRequest({ email: uniqueEmail(), password: PASSWORD }, { origin: "https://evil.example" })).status).toBe(403);
  });
});

describe("isolation between accounts", () => {
  let alice: Account;
  let bob: Account;
  let aliceKey: string;
  let bobKey: string;
  let repo: string;

  it("sets up two accounts", async () => {
    alice = await register(uniqueEmail("alice"));
    bob = await register(uniqueEmail("bob"));
    aliceKey = await createApiKey(alice.token, ["admin"], "alice-key");
    bobKey = await createApiKey(bob.token, ["admin"], "bob-key");
    repo = uniqueSlug("alice");
    await createRepo(aliceKey, repo, { access: "private" });
    await publish(aliceKey, repo, "doc", { "index.html": "alice's secret", "a.css": "a{}" });
    await publish(aliceKey, repo, "pw", { "index.html": "pw doc" }, { access: "password", password: "doc-pass-1" });
  });

  it("hides another account's repositories on the machine API", async () => {
    const list = await json(await machineJson(bobKey, "GET", "/repos"));
    expect(list.repos.map((r: { slug: string }) => r.slug)).not.toContain(repo);
    for (const [method, path, body] of [
      ["GET", `/repos/${repo}/docs`],
      ["PATCH", `/repos/${repo}`, { description: "pwned" }],
      ["GET", `/repos/${repo}/docs/doc/versions`],
      ["GET", `/repos/${repo}/docs/doc/bundle`],
      ["POST", `/repos/${repo}/docs/doc/rollback`, { version: 1 }],
      ["DELETE", `/repos/${repo}/docs/doc`],
    ] as const) {
      const res = await machineJson(bobKey, method, path, body);
      expect(res.status, `${method} ${path}`).toBe(404);
    }
    const { publishRaw, makeZip } = await import("./helpers");
    expect((await publishRaw(bearer(bobKey), repo, "intruder", makeZip({ "index.html": "x" }))).status).toBe(404);
    expect((await publishRaw(bearer(bobKey), repo, "doc", makeZip({ "index.html": "x" }), { replace: true })).status).toBe(404);
    // Alice's data is intact.
    const docs = await json(await machineJson(aliceKey, "GET", `/repos/${repo}/docs`));
    expect(docs.docs.map((d: { slug: string }) => d.slug).sort()).toEqual(["doc", "pw"]);
  });

  it("hides another account's repositories on the dashboard API", async () => {
    const dash = (method: string, path: string, body?: unknown) =>
      fetchApp(`/api/v1/dashboard${path}`, {
        method,
        headers: browser(bob.cookie, body !== undefined ? { "content-type": "application/json" } : {}),
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    expect((await json(await dash("GET", "/repos"))).repos).toEqual([]);
    for (const [method, path, body] of [
      ["GET", `/repos/${repo}`],
      ["PATCH", `/repos/${repo}`, { name: "pwned" }],
      ["DELETE", `/repos/${repo}`],
      ["GET", `/repos/${repo}/docs`],
      ["GET", `/repos/${repo}/docs/doc`],
      ["PATCH", `/repos/${repo}/docs/doc`, { title: "pwned" }],
      ["DELETE", `/repos/${repo}/docs/doc`],
      ["GET", `/repos/${repo}/docs/doc/versions`],
      ["GET", `/repos/${repo}/docs/doc/bundle`],
    ] as const) {
      expect((await dash(method, path, body)).status, `${method} ${path}`).toBe(404);
    }
  });

  it("scopes overview, audit, machines and keys to the account", async () => {
    // Make Bob's key show up as a machine.
    await machineJson(bobKey, "GET", "/repos");
    await machineJson(aliceKey, "GET", "/repos");
    const { waitFor } = await import("./helpers");
    await waitFor(() => env.DB.prepare(`SELECT 1 FROM machines WHERE name = 'bob-key'`).first());
    await waitFor(() => env.DB.prepare(`SELECT 1 FROM machines WHERE name = 'alice-key'`).first());

    const overview = await json(await fetchApp("/api/v1/dashboard/overview", { headers: bearer(bob.token) }));
    expect(overview.counts).toEqual({ repos: 0, docs: 0, versions: 0, apiKeys: 1, machines: 1 });
    expect(overview.storedBytes).toBe(0);
    expect(overview.recentPublishes).toEqual([]);
    expect(overview.recentAudit.every((a: { repositorySlug: string | null }) => a.repositorySlug !== repo)).toBe(true);
    const aliceOverview = await json(await fetchApp("/api/v1/dashboard/overview", { headers: bearer(alice.token) }));
    expect(aliceOverview.counts).toMatchObject({ repos: 1, docs: 2, versions: 2, apiKeys: 1, machines: 1 });

    const audit = await json(await fetchApp(`/api/v1/dashboard/audit?repo=${repo}`, { headers: bearer(bob.token) }));
    expect(audit.audit).toEqual([]);
    const aliceAudit = await json(await fetchApp(`/api/v1/dashboard/audit?repo=${repo}`, { headers: bearer(alice.token) }));
    expect(aliceAudit.audit.map((a: { event: string }) => a.event)).toEqual(expect.arrayContaining(["repo.create", "doc.publish"]));
    expect(aliceAudit.audit.find((a: { event: string }) => a.event === "doc.publish").actorLabel).toBe("alice-key");

    const machines = await json(await fetchApp("/api/v1/dashboard/machines", { headers: bearer(bob.token) }));
    expect(machines.machines.map((m: { name: string }) => m.name)).toEqual(["bob-key"]);
    const keys = await json(await fetchApp("/api/v1/auth/keys", { headers: bearer(bob.token) }));
    expect(keys.keys.map((k: { name: string }) => k.name)).toEqual(["bob-key"]);
  });

  it("keeps slugs globally unique: another account's slug is 409 'already taken'", async () => {
    const taken = await machineJson(bobKey, "POST", "/repos", { slug: repo });
    expect(taken.status).toBe(409);
    expect((await json(taken)).message).toBe(`Repository slug '${repo}' is already taken`);
    const viaDashboard = await fetchApp("/api/v1/dashboard/repos", {
      method: "POST",
      headers: browser(bob.cookie, { "content-type": "application/json" }),
      body: JSON.stringify({ slug: repo }),
    });
    expect(viaDashboard.status).toBe(409);
    const own = await machineJson(aliceKey, "POST", "/repos", { slug: repo });
    expect(own.status).toBe(409);
    expect((await json(own)).message).toBe(`Repository '${repo}' already exists`);
  });

  it("opens private reports only for the owner's session or keys", async () => {
    // Owner: session (cookie navigation is redirected to a token URL) and key.
    const ownerNav = await fetchApp(`/r/${repo}/doc/`, { headers: { cookie: alice.cookie, ...NAV } });
    expect(ownerNav.status).toBe(302);
    expect((await fetchApp(`/r/${repo}/doc/`, { headers: bearer(aliceKey) })).status).toBe(200);
    expect((await fetchApp(`/r/${repo}/doc/`, { headers: bearer(alice.token) })).status).toBe(200);

    // Another signed-in account gets exactly what an anonymous visitor gets.
    const anon = await fetchApp(`/r/${repo}/doc/`, { headers: NAV });
    const other = await fetchApp(`/r/${repo}/doc/`, { headers: { cookie: bob.cookie, ...NAV } });
    expect(anon.status).toBe(401);
    expect(other.status).toBe(401);
    expect(other.headers.get("location")).toBeNull();
    expect(other.headers.get("set-cookie")).toBeNull();
    expect(await other.text()).toBe(await anon.text());
    expect((await fetchApp(`/r/${repo}/doc/`, { headers: bearer(bobKey) })).status).toBe(401);
    expect((await fetchApp(`/r/${repo}/doc/`, { headers: bearer(bob.token) })).status).toBe(401);

    // Password-protected: the owner skips the gate, others see it.
    expect((await fetchApp(`/r/${repo}/pw/`, { headers: bearer(alice.token) })).status).toBe(200);
    const gate = await fetchApp(`/r/${repo}/pw/`, { headers: { cookie: bob.cookie, ...NAV } });
    expect(gate.status).toBe(401);
    expect(await gate.text()).toContain("__unlock");
  });

  it("refuses ~s. tokens bound to a non-owner's session", async () => {
    const doc = await env.DB.prepare(
      `SELECT d.id FROM documents d JOIN repositories r ON r.id = d.repository_id WHERE r.slug = ? AND d.slug = 'doc'`,
    )
      .bind(repo)
      .first<{ id: string }>();
    const secret = await getCookieSecret(env);
    const ctx = (binding: string) => ({ docId: doc!.id, repo, doc: "doc", scope: "latest", binding });
    // Correctly signed tokens (as the server would mint them), bound to each account's live session.
    const forBob = await mintReportToken(secret, "s", ctx(await sha256Hex(bob.token)));
    const forAlice = await mintReportToken(secret, "s", ctx(await sha256Hex(alice.token)));
    expect((await fetchApp(`/r/${repo}/doc/${forAlice}/a.css`, { headers: STYLE })).status).toBe(200);
    expect((await fetchApp(`/r/${repo}/doc/${forBob}/a.css`, { headers: STYLE })).status).toBe(401);
    // Same for the view cookie.
    const view = await mintReportToken(secret, "s", { ...ctx(await sha256Hex(bob.token)), scope: "cookie" });
    const res = await fetchApp(`/r/${repo}/doc/a.css`, { headers: { cookie: `maradocs_view_${repo}__doc=${view}`, ...STYLE } });
    expect(res.status).toBe(401);
  });
});

describe("account deletion", () => {
  it("needs the password, then removes the account with all its data and stored files", async () => {
    const victim = await register();
    const survivor = await register();
    const key = await createApiKey(victim.token, ["publish"]);
    const survivorKey = await createApiKey(survivor.token, ["publish"]);
    const repo = uniqueSlug("doomed");
    const kept = uniqueSlug("kept");
    await createRepo(key, repo);
    await createRepo(survivorKey, kept);
    await publish(key, repo, "a", { "index.html": "one" });
    await publish(key, repo, "a", { "index.html": "two" }, { replace: true });
    await publish(key, repo, "b", { "index.html": "three" });
    await publish(survivorKey, kept, "s", { "index.html": "survives" });
    await signIn(victim.email); // a second session
    const blobs = (
      await env.DB.prepare(
        `SELECT v.storage_path FROM document_versions v JOIN documents d ON d.id = v.document_id
         JOIN repositories r ON r.id = d.repository_id WHERE r.slug = ?`,
      )
        .bind(repo)
        .all<{ storage_path: string }>()
    ).results.map((r) => r.storage_path);
    expect(blobs).toHaveLength(3);
    for (const blob of blobs) expect(await env.BUCKET.head(blob)).not.toBeNull();

    const del = (headers: Record<string, string>, password: string) =>
      fetchApp("/api/v1/auth/account", {
        method: "DELETE",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ password }),
      });
    expect((await del(browser(victim.cookie), "wrong-password-1")).status).toBe(401);
    expect((await del({ cookie: victim.cookie, origin: ORIGIN }, victim.password)).status).toBe(403); // CSRF header
    const ok = await del(browser(victim.cookie), victim.password);
    expect(ok.status).toBe(204);
    expect(ok.headers.get("set-cookie")).toContain("Max-Age=0");

    for (const blob of blobs) expect(await env.BUCKET.head(blob)).toBeNull();
    const count = async (sql: string, ...params: unknown[]) =>
      (await env.DB.prepare(sql).bind(...params).first<{ n: number }>())!.n;
    expect(await count(`SELECT COUNT(*) AS n FROM users WHERE id = ?`, victim.userId)).toBe(0);
    expect(await count(`SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?`, victim.userId)).toBe(0);
    expect(await count(`SELECT COUNT(*) AS n FROM api_keys WHERE user_id = ?`, victim.userId)).toBe(0);
    expect(await count(`SELECT COUNT(*) AS n FROM machines WHERE user_id = ?`, victim.userId)).toBe(0);
    expect(await count(`SELECT COUNT(*) AS n FROM audit_log WHERE user_id = ?`, victim.userId)).toBe(0);
    expect(await count(`SELECT COUNT(*) AS n FROM repositories WHERE slug = ?`, repo)).toBe(0);
    expect(await count(`SELECT COUNT(*) AS n FROM documents d LEFT JOIN repositories r ON r.id = d.repository_id WHERE r.id IS NULL`)).toBe(0);

    expect((await fetchApp("/api/v1/auth/me", { headers: { cookie: victim.cookie } })).status).toBe(401);
    expect((await fetchApp("/api/v1/repos", { headers: bearer(key) })).status).toBe(401);
    expect((await fetchApp(`/r/${repo}/a/`)).status).toBe(404);
    expect((await signInStatus(victim.email, victim.password))).toBe(401);

    // Other accounts are untouched, and the slug is free again.
    expect(await (await fetchApp(`/r/${kept}/s/`)).text()).toBe("survives");
    expect((await machineJson(survivorKey, "POST", "/repos", { slug: repo })).status).toBe(201);
  });
});

async function signInStatus(email: string, password: string): Promise<number> {
  const res = await fetchApp("/api/v1/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": freshIp() },
    body: JSON.stringify({ email, password }),
  });
  await res.arrayBuffer();
  return res.status;
}
