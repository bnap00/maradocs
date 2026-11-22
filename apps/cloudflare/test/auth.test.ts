import { describe, expect, it } from "vitest";
import { sha256Hex } from "../src/crypto";
import {
  ORIGIN,
  OWNER_EMAIL,
  PASSWORD,
  auditEvents,
  bearer,
  browser,
  createApiKey,
  env,
  fetchApp,
  freshIp,
  json,
  login,
  loginRequest,
  register,
  uniqueSlug,
  waitFor,
} from "./helpers";

async function auditRows(event: string): Promise<{ user_id: string | null; actor_label: string | null }[]> {
  const { results } = await env.DB.prepare(`SELECT user_id, actor_label FROM audit_log WHERE event = ? ORDER BY created_at, id`)
    .bind(event)
    .all<{ user_id: string | null; actor_label: string | null }>();
  return results;
}

describe("login", () => {
  it("returns the user and a token, and sets an HttpOnly session cookie", async () => {
    const owner = await login();
    const res = await loginRequest(OWNER_EMAIL, PASSWORD);
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.user).toEqual({ id: owner.userId, email: OWNER_EMAIL, createdAt: expect.any(String) });
    expect(body.token).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`maradocs_session=${body.token}`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("Max-Age=2592000");

    // Sessions are stored hashed, never in plain text, with the user agent.
    expect(await env.DB.prepare(`SELECT 1 FROM sessions WHERE token_hash = ?`).bind(body.token).first()).toBeNull();
    const row = await env.DB.prepare(`SELECT user_id, expires_at FROM sessions WHERE token_hash = ?`)
      .bind(await sha256Hex(body.token))
      .first<{ user_id: string; expires_at: string }>();
    expect(row?.user_id).toBe(owner.userId);
    expect(Date.parse(row!.expires_at) - Date.now()).toBeGreaterThan(29 * 24 * 3600 * 1000);
  });

  it("normalises the email (case and whitespace)", async () => {
    await login();
    expect((await loginRequest(`  ${OWNER_EMAIL.toUpperCase()} `, PASSWORD)).status).toBe(200);
  });

  it("answers a wrong password and an unknown email identically, and audits both", async () => {
    const owner = await login();
    const wrong = await loginRequest(OWNER_EMAIL, "wrong-password-123");
    const unknown = await loginRequest("nobody@maradocs.test", PASSWORD);
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    const a = await json(wrong);
    const b = await json(unknown);
    expect(a).toMatchObject({ error: "unauthorized", message: "Invalid email or password" });
    expect(b).toEqual(a);
    // Failed-login audits are written off the request path; user_id is set only for a known email.
    const rows = await waitFor(async () => {
      const list = await auditRows("auth.login_failed");
      return list.length >= 2 ? list : null;
    });
    expect(rows.map((r) => r.user_id)).toEqual(expect.arrayContaining([owner.userId, null]));
    const ok = await auditRows("auth.login");
    expect(ok.some((r) => r.user_id === owner.userId && r.actor_label === OWNER_EMAIL)).toBe(true);
  });

  it("rate limits to 5 attempts per 15 minutes per IP", async () => {
    await login();
    const ip = freshIp();
    for (let i = 0; i < 5; i += 1) {
      expect((await loginRequest(OWNER_EMAIL, "nope-nope-nope", ip)).status).toBe(401);
    }
    const limited = await loginRequest(OWNER_EMAIL, PASSWORD, ip);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toMatch(/^\d+$/);
    expect(await json(limited)).toMatchObject({ error: "rate_limited" });
    // Another IP is unaffected.
    expect((await loginRequest(OWNER_EMAIL, PASSWORD, freshIp())).status).toBe(200);
  });

  it("validates the body and rejects the old password-only login", async () => {
    const res = await fetchApp("/api/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": freshIp() },
      body: "{not json",
    });
    expect(res.status).toBe(400);
    expect((await json(res)).error).toBe("bad_request");
    const legacy = await fetchApp("/api/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": freshIp() },
      body: JSON.stringify({ password: PASSWORD }),
    });
    expect(legacy.status).toBe(400);
    const body = await json(legacy);
    expect(body.error).toBe("validation_error");
    expect(Array.isArray(body.details)).toBe(true);
  });

  it("blocks cross-site login attempts", async () => {
    await login();
    const res = await loginRequest(OWNER_EMAIL, PASSWORD, freshIp(), { origin: "https://evil.example" });
    expect(res.status).toBe(403);
  });

  it("logs out (204), clears the cookie and invalidates the session", async () => {
    const { token } = await login();
    const res = await fetchApp("/api/v1/auth/logout", { method: "POST", headers: bearer(token) });
    expect(res.status).toBe(204);
    expect(res.headers.get("set-cookie")).toContain("Max-Age=0");
    expect((await fetchApp("/api/v1/auth/me", { headers: bearer(token) })).status).toBe(401);
    expect(await auditEvents({ event: "auth.logout" })).not.toHaveLength(0);
  });
});

describe("sessions", () => {
  it("accepts the session cookie and Bearer token, rejects others", async () => {
    const { token, cookie, userId } = await login();
    expect((await fetchApp("/api/v1/auth/me", { headers: { cookie } })).status).toBe(200);
    const me = await json(await fetchApp("/api/v1/auth/me", { headers: bearer(token) }));
    expect(me).toEqual({ user: { id: userId, email: OWNER_EMAIL, createdAt: expect.any(String) } });
    const dash = await json(await fetchApp("/api/v1/dashboard/me", { headers: bearer(token) }));
    expect(dash.user).toEqual(me.user);
    expect(typeof dash.session.expiresAt).toBe("string");
    expect((await fetchApp("/api/v1/auth/me")).status).toBe(401);
    expect((await fetchApp("/api/v1/auth/me", { headers: bearer("bogus") })).status).toBe(401);
  });

  it("rejects API keys on session endpoints", async () => {
    const { token } = await login();
    const key = await createApiKey(token, ["admin"]);
    expect((await fetchApp("/api/v1/dashboard/me", { headers: bearer(key) })).status).toBe(401);
    expect((await fetchApp("/api/v1/auth/me", { headers: bearer(key) })).status).toBe(401);
  });

  it("rejects expired sessions and deletes them", async () => {
    const { token } = await login();
    const hash = await sha256Hex(token);
    await env.DB.prepare(`UPDATE sessions SET expires_at = ? WHERE token_hash = ?`).bind("2000-01-01T00:00:00.000Z", hash).run();
    expect((await fetchApp("/api/v1/auth/me", { headers: bearer(token) })).status).toBe(401);
    await waitFor(async () => !(await env.DB.prepare(`SELECT 1 FROM sessions WHERE token_hash = ?`).bind(hash).first()));
  });

  it("slides: activity more than an hour after the last refresh extends the expiry to 30 days", async () => {
    const { token, cookie } = await login();
    const hash = await sha256Hex(token);
    const soon = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
    const stale = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
    await env.DB.prepare(`UPDATE sessions SET expires_at = ?, last_seen = ? WHERE token_hash = ?`).bind(soon, stale, hash).run();

    const res = await fetchApp("/api/v1/auth/me", { headers: { cookie } });
    expect(res.status).toBe(200);
    // The browser's cookie is renewed too.
    expect(res.headers.get("set-cookie")).toContain("Max-Age=2592000");
    const row = await env.DB.prepare(`SELECT expires_at, last_seen FROM sessions WHERE token_hash = ?`)
      .bind(hash)
      .first<{ expires_at: string; last_seen: string }>();
    expect(Date.parse(row!.expires_at) - Date.now()).toBeGreaterThan(29 * 24 * 3600 * 1000);
    expect(Date.parse(row!.last_seen)).toBeGreaterThan(Date.now() - 60_000);

    // Within the hour nothing is written.
    await env.DB.prepare(`UPDATE sessions SET expires_at = ? WHERE token_hash = ?`).bind(soon, hash).run();
    const again = await fetchApp("/api/v1/auth/me", { headers: { cookie } });
    expect(again.headers.get("set-cookie")).toBeNull();
    const unchanged = await env.DB.prepare(`SELECT expires_at FROM sessions WHERE token_hash = ?`).bind(hash).first<{ expires_at: string }>();
    expect(unchanged?.expires_at).toBe(soon);
  });
});

describe("CSRF protection", () => {
  const body = () => JSON.stringify({ slug: uniqueSlug("csrf"), access: "public" });

  it("rejects cookie-authenticated writes without a same-origin Origin", async () => {
    const { cookie } = await login();
    const noOrigin = await fetchApp("/api/v1/dashboard/repos", {
      method: "POST",
      headers: { cookie, "x-maradocs": "1", "content-type": "application/json" },
      body: body(),
    });
    expect(noOrigin.status).toBe(403);
    const evil = await fetchApp("/api/v1/dashboard/repos", {
      method: "POST",
      headers: { cookie, origin: "https://evil.example", "x-maradocs": "1", "content-type": "application/json" },
      body: body(),
    });
    expect(evil.status).toBe(403);
    expect((await json(evil)).error).toBe("forbidden");
  });

  it("requires the x-maradocs header on cookie-authenticated writes", async () => {
    const { cookie } = await login();
    for (const value of [undefined, "0", "yes"]) {
      const res = await fetchApp("/api/v1/dashboard/repos", {
        method: "POST",
        headers: { cookie, origin: ORIGIN, "content-type": "application/json", ...(value ? { "x-maradocs": value } : {}) },
        body: body(),
      });
      expect(res.status, String(value)).toBe(403);
    }
    const logout = await fetchApp("/api/v1/auth/logout", { method: "POST", headers: { cookie, origin: ORIGIN } });
    expect(logout.status).toBe(403);
  });

  it("allows same-origin cookie writes with the header (Origin or Sec-Fetch-Site)", async () => {
    const { cookie } = await login();
    const ok = await fetchApp("/api/v1/dashboard/repos", {
      method: "POST",
      headers: browser(cookie, { "content-type": "application/json" }),
      body: body(),
    });
    expect(ok.status).toBe(201);
    const fetchMeta = await fetchApp("/api/v1/dashboard/repos", {
      method: "POST",
      headers: { cookie, "sec-fetch-site": "same-origin", "x-maradocs": "1", "content-type": "application/json" },
      body: body(),
    });
    expect(fetchMeta.status).toBe(201);
    const crossSite = await fetchApp("/api/v1/dashboard/repos", {
      method: "POST",
      headers: { cookie, "sec-fetch-site": "cross-site", "x-maradocs": "1", "content-type": "application/json" },
      body: body(),
    });
    expect(crossSite.status).toBe(403);
  });

  it("exempts Bearer-authenticated requests", async () => {
    const { token } = await login();
    const res = await fetchApp("/api/v1/dashboard/repos", {
      method: "POST",
      headers: bearer(token, { "content-type": "application/json", origin: "https://elsewhere.example" }),
      body: body(),
    });
    expect(res.status).toBe(201);
  });

  it("allows cookie reads without Origin or the header", async () => {
    const { cookie } = await login();
    expect((await fetchApp("/api/v1/dashboard/repos", { headers: { cookie } })).status).toBe(200);
  });

  it("checks Origin against the request origin exactly", async () => {
    const { cookie } = await login();
    const res = await fetchApp("/api/v1/auth/logout", {
      method: "POST",
      headers: { cookie, origin: ORIGIN.replace("https", "http"), "x-maradocs": "1" },
    });
    expect(res.status).toBe(403);
  });
});

describe("API keys", () => {
  it("creates keys (shown once), lists them without hashes, and revokes them", async () => {
    const { token } = await login();
    const created = await fetchApp("/api/v1/auth/keys", {
      method: "POST",
      headers: bearer(token, { "content-type": "application/json" }),
      body: JSON.stringify({ name: "ci-bot", scopes: ["read", "publish", "read"] }),
    });
    expect(created.status).toBe(201);
    const key = await json(created);
    expect(key.key).toMatch(/^mdo_[A-Za-z0-9_-]{43}$/);
    expect(key.prefix).toBe(key.key.slice(0, 12));
    expect(key.scopes).toEqual(["read", "publish"]);
    expect(key.name).toBe("ci-bot");
    expect(key.id).toMatch(/^akey_/);

    const list = await json(await fetchApp("/api/v1/auth/keys", { headers: bearer(token) }));
    const listed = list.keys.find((k: { id: string }) => k.id === key.id);
    expect(listed).toMatchObject({ id: key.id, name: "ci-bot", prefix: key.prefix, scopes: ["read", "publish"] });
    expect(listed.keyHash).toBeUndefined();
    expect(listed.key).toBeUndefined();
    expect(JSON.stringify(list)).not.toContain(key.key);

    // Key works on the machine API, then stops working once revoked.
    expect((await fetchApp("/api/v1/repos", { headers: bearer(key.key) })).status).toBe(200);
    const revoked = await fetchApp(`/api/v1/auth/keys/${key.id}`, { method: "DELETE", headers: bearer(token) });
    expect(revoked.status).toBe(204);
    expect((await fetchApp("/api/v1/repos", { headers: bearer(key.key) })).status).toBe(401);
    const again = await fetchApp(`/api/v1/auth/keys/${key.id}`, { method: "DELETE", headers: bearer(token) });
    expect(again.status).toBe(404);

    const events = await auditEvents();
    expect(events).toContain("key.create");
    expect(events).toContain("key.revoke");
  });

  it("lists and revokes only the caller's own keys", async () => {
    const owner = await login();
    const other = await register();
    const ownerKey = await json(
      await fetchApp("/api/v1/auth/keys", {
        method: "POST",
        headers: bearer(owner.token, { "content-type": "application/json" }),
        body: JSON.stringify({ name: "owner-only" }),
      }),
    );
    const theirs = await json(await fetchApp("/api/v1/auth/keys", { headers: bearer(other.token) }));
    expect(theirs.keys.some((k: { id: string }) => k.id === ownerKey.id)).toBe(false);
    const steal = await fetchApp(`/api/v1/auth/keys/${ownerKey.id}`, { method: "DELETE", headers: bearer(other.token) });
    expect(steal.status).toBe(404);
    expect((await fetchApp("/api/v1/repos", { headers: bearer(ownerKey.key) })).status).toBe(200);
  });

  it("defaults scopes to publish and validates input", async () => {
    const { token } = await login();
    const res = await fetchApp("/api/v1/auth/keys", {
      method: "POST",
      headers: bearer(token, { "content-type": "application/json" }),
      body: JSON.stringify({ name: "default" }),
    });
    expect((await json(res)).scopes).toEqual(["publish"]);
    const bad = await fetchApp("/api/v1/auth/keys", {
      method: "POST",
      headers: bearer(token, { "content-type": "application/json" }),
      body: JSON.stringify({ name: "x", scopes: ["root"] }),
    });
    expect(bad.status).toBe(400);
    expect((await json(bad)).error).toBe("validation_error");
  });

  it("requires a session for key management", async () => {
    expect((await fetchApp("/api/v1/auth/keys")).status).toBe(401);
    const { token } = await login();
    const key = await createApiKey(token, ["admin"]);
    expect((await fetchApp("/api/v1/auth/keys", { headers: bearer(key) })).status).toBe(401);
  });

  it("accepts a bare key without the Bearer prefix (like the Node server)", async () => {
    const { token } = await login();
    const key = await createApiKey(token);
    expect((await fetchApp("/api/v1/repos", { headers: { authorization: key } })).status).toBe(200);
  });

  it("records machine usage in the background, and forgets the machine when its key is revoked", async () => {
    const { token } = await login();
    const created = await json(
      await fetchApp("/api/v1/auth/keys", {
        method: "POST",
        headers: bearer(token, { "content-type": "application/json" }),
        body: JSON.stringify({ name: "usage-probe", scopes: ["read"] }),
      }),
    );
    await fetchApp("/api/v1/repos", { headers: bearer(created.key) });
    const machine = await waitFor(() =>
      env.DB.prepare(
        `SELECT m.name, k.last_used_at FROM machines m JOIN api_keys k ON k.id = m.key_id
         WHERE m.name = 'usage-probe' AND k.last_used_at IS NOT NULL`,
      ).first<{ name: string; last_used_at: string }>(),
    );
    expect(machine.last_used_at).toBeTruthy();
    const list = await json(await fetchApp("/api/v1/dashboard/machines", { headers: bearer(token) }));
    expect(list.machines.some((m: { name: string; scopes: string[] }) => m.name === "usage-probe" && m.scopes[0] === "read")).toBe(true);

    expect((await fetchApp(`/api/v1/auth/keys/${created.id}`, { method: "DELETE", headers: bearer(token) })).status).toBe(204);
    expect(await env.DB.prepare(`SELECT 1 FROM machines WHERE key_id = ?`).bind(created.id).first()).toBeNull();
  });
});
