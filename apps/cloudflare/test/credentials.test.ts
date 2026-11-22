// Account credential lifecycle: token delivery, password changes, signing
// out other sessions, brute-force limits, password hash upkeep and config.
import { describe, expect, it } from "vitest";
import { hashPassword, passwordBinding, passwordHashIterations, rehashPassword, sha256Hex } from "../src/crypto";
import { MAX_UPLOAD_MB_CAP, claimSecret, loadConfig } from "../src/env";
import { rateLimitClientKey } from "../src/services/ratelimit";
import {
  ORIGIN,
  PASSWORD,
  auditEvents,
  bearer,
  browser,
  env,
  fetchApp,
  freshIp,
  json,
  login,
  loginRequest,
  register,
  signIn,
  waitFor,
} from "./helpers";

const NEW_PASSWORD = "a-brand-new-password";

function auth(path: string, method: string, headers: Record<string, string>, body?: unknown) {
  return fetchApp(`/api/v1/auth${path}`, {
    method,
    headers: { ...headers, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

describe("token delivery", () => {
  it("returns the session token only to non-browser clients", async () => {
    const { email } = await register();
    const cli = await loginRequest(email, PASSWORD, freshIp(), { "sec-fetch-mode": "cors" });
    expect(cli.status).toBe(200);
    expect((await json(cli)).token).toMatch(/^[A-Za-z0-9_-]{40,}$/);

    const dashboard = await loginRequest(email, PASSWORD, freshIp(), { origin: ORIGIN });
    expect(dashboard.status).toBe(200);
    const body = await json(dashboard);
    expect(body.token).toBeUndefined();
    expect(body.user.email).toBe(email);
    const cookie = dashboard.headers.get("set-cookie")!.split(";")[0]!;
    expect((await fetchApp("/api/v1/dashboard/me", { headers: { cookie } })).status).toBe(200);

    const fetchMeta = await loginRequest(email, PASSWORD, freshIp(), { "sec-fetch-site": "same-origin" });
    expect((await json(fetchMeta)).token).toBeUndefined();
  });
});

describe("change password", () => {
  it("changes the password, signs out other sessions and keeps the current one", async () => {
    const current = await register();
    const other = await signIn(current.email);
    const bystander = await register();

    expect((await auth("/change-password", "POST", bearer(current.token), { currentPassword: PASSWORD, newPassword: "short" })).status).toBe(400);
    const wrong = await auth("/change-password", "POST", bearer(current.token), { currentPassword: "wrong", newPassword: NEW_PASSWORD });
    expect(wrong.status).toBe(401);
    expect((await json(wrong)).message).toContain("incorrect");

    const ok = await auth("/change-password", "POST", browser(current.cookie), { currentPassword: PASSWORD, newPassword: NEW_PASSWORD });
    expect(ok.status).toBe(200);
    expect((await json(ok)).user).toMatchObject({ id: current.userId, email: current.email });

    expect((await auth("/me", "GET", { cookie: current.cookie })).status).toBe(200);
    expect((await auth("/me", "GET", bearer(other.token))).status).toBe(401);
    // Other accounts keep their sessions.
    expect((await auth("/me", "GET", bearer(bystander.token))).status).toBe(200);

    expect((await loginRequest(current.email, PASSWORD)).status).toBe(401);
    await signIn(current.email, NEW_PASSWORD);
    expect(await auditEvents({ event: "password.change" })).toHaveLength(1);
  });

  it("needs the CSRF header when cookie-authenticated", async () => {
    const a = await register();
    const res = await auth("/change-password", "POST", { cookie: a.cookie, origin: ORIGIN }, { currentPassword: PASSWORD, newPassword: NEW_PASSWORD });
    expect(res.status).toBe(403);
  });

  it("limits password guesses to 10 per hour per account, across networks", async () => {
    const s = await register();
    for (let i = 0; i < 10; i += 1) {
      const res = await auth(
        "/change-password",
        "POST",
        browser(s.cookie, { "cf-connecting-ip": freshIp() }),
        { currentPassword: `wrong-${i}`, newPassword: NEW_PASSWORD },
      );
      expect(res.status).toBe(401);
    }
    const limited = await auth(
      "/change-password",
      "POST",
      browser(s.cookie, { "cf-connecting-ip": freshIp() }),
      { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
    );
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toMatch(/^\d+$/);
    // Another account is unaffected.
    const other = await register();
    expect((await auth("/change-password", "POST", bearer(other.token), { currentPassword: PASSWORD, newPassword: NEW_PASSWORD })).status).toBe(200);
    const events = await waitFor(async () => {
      const list = await auditEvents();
      return list.filter((e) => e === "password.change_failed").length >= 10 && list.includes("auth.rate_limited") ? list : null;
    });
    expect(events.filter((e) => e === "password.change_failed").length).toBeGreaterThanOrEqual(10);
  });
});

describe("logout-others", () => {
  it("signs out every other session of the account and reports how many", async () => {
    const a = await register();
    const b = await signIn(a.email);
    const c = await signIn(a.email);
    const someoneElse = await register();
    const res = await auth("/logout-others", "POST", browser(a.cookie));
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ revoked: 2 });
    expect((await auth("/me", "GET", { cookie: a.cookie })).status).toBe(200);
    expect((await auth("/me", "GET", bearer(b.token))).status).toBe(401);
    expect((await auth("/me", "GET", bearer(c.token))).status).toBe(401);
    expect((await auth("/me", "GET", bearer(someoneElse.token))).status).toBe(200);
    expect(await auditEvents({ event: "auth.logout_others" })).toHaveLength(1);
  });
});

describe("password hashes", () => {
  it("stores PBKDF2 hashes and moves them to the configured cost on login (same salt)", async () => {
    const { userId, email } = await register();
    const stored = await env.DB.prepare(`SELECT password_hash FROM users WHERE id = ?`).bind(userId).first<{ password_hash: string }>();
    expect(stored?.password_hash).toMatch(/^pbkdf2\$sha256\$10000\$/);
    expect(stored?.password_hash).not.toContain(PASSWORD);

    const original = await hashPassword(PASSWORD, 10_000);
    const costly = await rehashPassword(PASSWORD, original, 20_000);
    await env.DB.prepare(`UPDATE users SET password_hash = ? WHERE id = ?`).bind(costly, userId).run();
    const { token } = await signIn(email);
    const after = (await env.DB.prepare(`SELECT password_hash FROM users WHERE id = ?`).bind(userId).first<{ password_hash: string }>())!
      .password_hash;
    expect(passwordHashIterations(after)).toBe(10_000);
    expect(passwordBinding(after)).toBe(passwordBinding(costly));
    expect((await auth("/me", "GET", bearer(token))).status).toBe(200);
  });
});

describe("brute-force limits", () => {
  it("treats a whole IPv6 /64 as one client for login", async () => {
    const { email } = await login();
    const prefix = `2001:db8:${Math.floor(Math.random() * 0xffff).toString(16)}:7`;
    for (let i = 1; i <= 5; i += 1) {
      expect((await loginRequest(email, "nope-nope-nope", `${prefix}::${i}`)).status).toBe(401);
    }
    expect((await loginRequest(email, PASSWORD, `${prefix}:dead:beef:1:2`)).status).toBe(429);
  });

  it("normalises client addresses", () => {
    expect(rateLimitClientKey("203.0.113.9")).toBe("203.0.113.9");
    expect(rateLimitClientKey("2001:db8:1:2:3:4:5:6")).toBe("2001:db8:1:2::/64");
    expect(rateLimitClientKey("2001:DB8:1:2::9")).toBe("2001:db8:1:2::/64");
    expect(rateLimitClientKey("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(rateLimitClientKey("::ffff:198.51.100.7")).toBe("198.51.100.7");
    expect(rateLimitClientKey("fe80::1%eth0")).toBe("fe80:0:0:0::/64");
    expect(rateLimitClientKey("")).toBe("unknown");
  });

  it("stops all logins once too many failures arrive from every network combined", async () => {
    const { email } = await login();
    await env.DB.prepare(`DELETE FROM rate_limits WHERE key = 'login:global'`).run();
    expect((await loginRequest(email, "wrong-wrong-wrong")).status).toBe(401);
    // Unknown emails count as failures too.
    expect((await loginRequest("ghost@maradocs.test", "wrong-wrong-wrong")).status).toBe(401);
    const count = await waitFor(async () => {
      const row = await env.DB.prepare(`SELECT count FROM rate_limits WHERE key = 'login:global'`).first<{ count: number }>();
      return row && row.count >= 2 ? row.count : null;
    });
    expect(count).toBe(2);
    // Successful logins don't count.
    await login();
    expect((await env.DB.prepare(`SELECT count FROM rate_limits WHERE key = 'login:global'`).first<{ count: number }>())?.count).toBe(2);

    await env.DB.prepare(`UPDATE rate_limits SET count = 100 WHERE key = 'login:global'`).run();
    const blocked = await loginRequest(email, PASSWORD);
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toMatch(/^\d+$/);
    await env.DB.prepare(`DELETE FROM rate_limits WHERE key = 'login:global'`).run();
  });

  it("audits the first rate-limited login", async () => {
    const { email } = await login();
    const ip = freshIp();
    for (let i = 0; i < 8; i += 1) await loginRequest(email, "nope-nope-nope", ip);
    const limited = await waitFor(async () => {
      const rows = await env.DB.prepare(`SELECT detail FROM audit_log WHERE event = 'auth.rate_limited' AND detail LIKE ?`)
        .bind(`%${ip}%`)
        .all<{ detail: string }>();
      return rows.results.length ? rows.results : null;
    });
    expect(limited).toHaveLength(1);
  });

  it("purges expired sessions on login", async () => {
    const { token, email } = await register();
    const hash = await sha256Hex(token);
    await env.DB.prepare(`UPDATE sessions SET expires_at = ? WHERE token_hash = ?`).bind("2000-01-01T00:00:00.000Z", hash).run();
    await signIn(email);
    await waitFor(async () => !(await env.DB.prepare(`SELECT 1 FROM sessions WHERE token_hash = ?`).bind(hash).first()));
  });
});

describe("configuration", () => {
  const base = { DB: env.DB, BUCKET: env.BUCKET };

  it("caps MAX_UPLOAD_MB and defaults PBKDF2 to a Free-plan-friendly cost", () => {
    expect(loadConfig({ ...base, MAX_UPLOAD_MB: "100" }).maxUploadBytes).toBe(MAX_UPLOAD_MB_CAP * 1024 * 1024);
    expect(loadConfig({ ...base, MAX_UPLOAD_MB: "10" }).maxUploadBytes).toBe(10 * 1024 * 1024);
    expect(loadConfig(base).pbkdf2Iterations).toBe(10_000);
    expect(loadConfig({ ...base, PBKDF2_ITERATIONS: "50000" }).pbkdf2Iterations).toBe(50_000);
    expect(loadConfig({ ...base, PBKDF2_ITERATIONS: "999999" }).pbkdf2Iterations).toBe(100_000);
    // Below the minimum is clamped up, not reset to the default.
    expect(loadConfig({ ...base, PBKDF2_ITERATIONS: "5000" }).pbkdf2Iterations).toBe(10_000);
    expect(loadConfig({ ...base, PBKDF2_ITERATIONS: "12345.7" }).pbkdf2Iterations).toBe(12_345);
    expect(loadConfig({ ...base, PBKDF2_ITERATIONS: "lots" }).pbkdf2Iterations).toBe(10_000);
  });

  it("parses REGISTRATION (default first) and treats placeholder claim passwords as unset", () => {
    expect(loadConfig(base).registration).toBe("first");
    expect(loadConfig({ ...base, REGISTRATION: " Open " }).registration).toBe("open");
    expect(loadConfig({ ...base, REGISTRATION: "closed" }).registration).toBe("closed");
    expect(loadConfig({ ...base, REGISTRATION: "sometimes" }).registration).toBe("first");
    expect(claimSecret({ ...base })).toBeNull();
    expect(claimSecret({ ...base, ADMIN_PASSWORD: "change-me" })).toBeNull();
    expect(claimSecret({ ...base, ADMIN_PASSWORD: " a-real-claim-pw " })).toBe("a-real-claim-pw");
  });
});
