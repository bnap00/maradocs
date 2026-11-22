import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  PASSWORD,
  cookieFrom,
  createKey,
  freshIp,
  login,
  makeApp,
  register,
  sha256hex,
  type Account,
  type TestApp,
} from "./helpers.js";

let t: TestApp;
let owner: Account;

before(async () => {
  t = await makeApp({ REGISTRATION: "open" });
  owner = await register(t.app, "Owner@Example.com ");
});

after(async () => {
  await t.close();
});

test("register normalises the email and returns { user, token } to non-browser clients", () => {
  assert.equal(owner.email, "owner@example.com");
  assert.match(owner.id, /^usr_/);
  assert.ok(owner.token.length > 20);
});

test("register rejects short passwords, bad emails and duplicate emails", async () => {
  const short = await t.app.inject({
    method: "POST",
    url: "/api/v1/auth/register",
    remoteAddress: freshIp(),
    payload: { email: "short@example.com", password: "elevenchars" },
  });
  assert.equal(short.statusCode, 400);

  const badEmail = await t.app.inject({
    method: "POST",
    url: "/api/v1/auth/register",
    remoteAddress: freshIp(),
    payload: { email: "not-an-email", password: PASSWORD },
  });
  assert.equal(badEmail.statusCode, 400);

  const dup = await t.app.inject({
    method: "POST",
    url: "/api/v1/auth/register",
    remoteAddress: freshIp(),
    payload: { email: "OWNER@example.com", password: PASSWORD },
  });
  assert.equal(dup.statusCode, 409);
});

test("register is rate limited to 5 per hour per IP", async () => {
  const ip = freshIp();
  const codes: number[] = [];
  for (let i = 0; i < 6; i += 1) {
    const res = await t.app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      remoteAddress: ip,
      payload: { email: `burst${i}@example.com`, password: PASSWORD },
    });
    codes.push(res.statusCode);
  }
  assert.deepEqual(codes, [201, 201, 201, 201, 201, 429]);
});

test("browser requests get only the cookie; cross-site origins are rejected", async () => {
  const res = await t.app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    remoteAddress: freshIp(),
    headers: { origin: "http://localhost:80", host: "localhost:80" },
    payload: { email: owner.email, password: PASSWORD },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.user.email, owner.email);
  assert.equal(body.token, undefined);
  const cookie = res.headers["set-cookie"] as string;
  assert.match(String(cookie), /maradocs_session=/);
  assert.match(String(cookie), /HttpOnly/);
  assert.match(String(cookie), /SameSite=Lax/);

  const cross = await t.app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    remoteAddress: freshIp(),
    headers: { origin: "https://evil.example", host: "localhost:80" },
    payload: { email: owner.email, password: PASSWORD },
  });
  assert.equal(cross.statusCode, 403);
});

test("login rejects wrong passwords and unknown emails with the same message", async () => {
  const wrong = await t.app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    remoteAddress: freshIp(),
    payload: { email: owner.email, password: "wrong-password-123" },
  });
  const unknown = await t.app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    remoteAddress: freshIp(),
    payload: { email: "nobody@example.com", password: "wrong-password-123" },
  });
  assert.equal(wrong.statusCode, 401);
  assert.equal(unknown.statusCode, 401);
  assert.equal(wrong.json().message, "Invalid email or password");
  assert.deepEqual(unknown.json(), wrong.json());

  // The failed attempt for an existing email lands in that account's audit log.
  const audit = await t.app.inject({
    method: "GET",
    url: "/api/v1/dashboard/audit",
    headers: owner.auth,
  });
  const events = audit.json<{ audit: { event: string }[] }>().audit.map((e) => e.event);
  assert.ok(events.includes("auth.login_failed"));
  assert.ok(events.includes("auth.register"));
});

test("login rate limit returns a 429 response", async () => {
  const ip = freshIp();
  for (let i = 0; i < 5; i += 1) {
    const res = await t.app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      remoteAddress: ip,
      payload: { email: owner.email, password: PASSWORD },
    });
    assert.equal(res.statusCode, 200);
  }
  const limited = await t.app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    remoteAddress: ip,
    payload: { email: owner.email, password: PASSWORD },
  });
  assert.equal(limited.statusCode, 429);
  assert.deepEqual(limited.json(), { error: "rate_limited", message: "Too many requests" });
});

test("GET /me returns the user for bearer and cookie sessions", async () => {
  const bearer = await t.app.inject({ method: "GET", url: "/api/v1/auth/me", headers: owner.auth });
  assert.equal(bearer.statusCode, 200);
  assert.deepEqual(Object.keys(bearer.json().user).sort(), ["createdAt", "email", "id"]);

  const viaCookie = await t.app.inject({
    method: "GET",
    url: "/api/v1/auth/me",
    headers: { cookie: `maradocs_session=${owner.token}` },
  });
  assert.equal(viaCookie.json().user.email, owner.email);

  const dashMe = await t.app.inject({
    method: "GET",
    url: "/api/v1/dashboard/me",
    headers: owner.auth,
  });
  assert.deepEqual(dashMe.json(), bearer.json());

  const anon = await t.app.inject({ method: "GET", url: "/api/v1/auth/me" });
  assert.equal(anon.statusCode, 401);
});

test("API keys are not sessions", async () => {
  const { auth } = await createKey(t.app, owner, ["admin"]);
  const res = await t.app.inject({ method: "GET", url: "/api/v1/auth/me", headers: auth });
  assert.equal(res.statusCode, 401);
});

test("cookie-authenticated writes require the x-maradocs header; bearer is exempt", async () => {
  const cookie = `maradocs_session=${await login(t.app, owner.email)}`;
  const noHeader = await t.app.inject({
    method: "POST",
    url: "/api/v1/auth/keys",
    headers: { cookie },
    payload: { name: "csrf" },
  });
  assert.equal(noHeader.statusCode, 403);
  assert.equal(noHeader.json().error, "csrf_failed");

  const dashWrite = await t.app.inject({
    method: "POST",
    url: "/api/v1/dashboard/repos",
    headers: { cookie },
    payload: { slug: "csrf-repo" },
  });
  assert.equal(dashWrite.statusCode, 403);

  const withHeader = await t.app.inject({
    method: "POST",
    url: "/api/v1/auth/keys",
    headers: { cookie, "x-maradocs": "1" },
    payload: { name: "csrf" },
  });
  assert.equal(withHeader.statusCode, 201);

  // Reads don't need the header.
  const read = await t.app.inject({ method: "GET", url: "/api/v1/auth/keys", headers: { cookie } });
  assert.equal(read.statusCode, 200);

  const bearer = await t.app.inject({
    method: "POST",
    url: "/api/v1/auth/keys",
    headers: owner.auth,
    payload: { name: "bearer" },
  });
  assert.equal(bearer.statusCode, 201);
});

test("sessions slide: an active session older than an hour is extended to 30 days", async () => {
  const token = await login(t.app, owner.email);
  const hash = sha256hex(token);
  const twoHoursAgo = new Date(Date.now() - 2 * 3600_000).toISOString();
  const soon = new Date(Date.now() + 60_000).toISOString();
  t.ctx.store.touchSession(hash, twoHoursAgo, soon);

  const res = await t.app.inject({
    method: "GET",
    url: "/api/v1/auth/me",
    headers: { cookie: `maradocs_session=${token}` },
  });
  assert.equal(res.statusCode, 200);
  const session = t.ctx.store.getSessionByHash(hash)!;
  const days = (Date.parse(session.expiresAt) - Date.now()) / 86_400_000;
  assert.ok(days > 29.9 && days <= 30, `expected ~30 days, got ${days}`);
  assert.ok(Date.parse(session.lastSeen) > Date.now() - 60_000);
  // The browser cookie is refreshed too.
  assert.ok(cookieFrom(res.headers["set-cookie"], "maradocs_session"));

  // Within the hour nothing is rewritten.
  const again = await t.app.inject({
    method: "GET",
    url: "/api/v1/auth/me",
    headers: { cookie: `maradocs_session=${token}` },
  });
  assert.equal(again.headers["set-cookie"], undefined);
});

test("expired sessions are rejected and deleted", async () => {
  const token = await login(t.app, owner.email);
  const hash = sha256hex(token);
  const past = new Date(Date.now() - 1000).toISOString();
  t.ctx.store.touchSession(hash, past, past);
  const res = await t.app.inject({
    method: "GET",
    url: "/api/v1/auth/me",
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(res.statusCode, 401);
  assert.equal(t.ctx.store.getSessionByHash(hash), null);
});

test("logout invalidates only this session and clears the cookie", async () => {
  const a = await login(t.app, owner.email);
  const b = await login(t.app, owner.email);
  const logout = await t.app.inject({
    method: "POST",
    url: "/api/v1/auth/logout",
    headers: { cookie: `maradocs_session=${a}`, "x-maradocs": "1" },
  });
  assert.equal(logout.statusCode, 204);
  assert.match(String(logout.headers["set-cookie"]), /maradocs_session=;/);

  const afterA = await t.app.inject({
    method: "GET",
    url: "/api/v1/auth/keys",
    headers: { authorization: `Bearer ${a}` },
  });
  assert.equal(afterA.statusCode, 401);
  const afterB = await t.app.inject({
    method: "GET",
    url: "/api/v1/auth/keys",
    headers: { authorization: `Bearer ${b}` },
  });
  assert.equal(afterB.statusCode, 200);
});

test("logout-others revokes every other session of the account", async () => {
  const acct = await register(t.app, "multi@example.com");
  const other1 = await login(t.app, acct.email);
  const other2 = await login(t.app, acct.email);
  const res = await t.app.inject({
    method: "POST",
    url: "/api/v1/auth/logout-others",
    headers: acct.auth,
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { revoked: 2 });
  for (const tok of [other1, other2]) {
    const r = await t.app.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: { authorization: `Bearer ${tok}` },
    });
    assert.equal(r.statusCode, 401);
  }
  const self = await t.app.inject({ method: "GET", url: "/api/v1/auth/me", headers: acct.auth });
  assert.equal(self.statusCode, 200);
  // Other accounts' sessions are untouched.
  const ownerMe = await t.app.inject({ method: "GET", url: "/api/v1/auth/me", headers: owner.auth });
  assert.equal(ownerMe.statusCode, 200);
});

test("change-password checks the current password and revokes other sessions", async () => {
  const acct = await register(t.app, "chpw@example.com");
  const other = await login(t.app, acct.email);

  const wrong = await t.app.inject({
    method: "POST",
    url: "/api/v1/auth/change-password",
    headers: acct.auth,
    payload: { currentPassword: "not-the-password", newPassword: "a-brand-new-password" },
  });
  assert.equal(wrong.statusCode, 401);

  const tooShort = await t.app.inject({
    method: "POST",
    url: "/api/v1/auth/change-password",
    headers: acct.auth,
    payload: { currentPassword: PASSWORD, newPassword: "short" },
  });
  assert.equal(tooShort.statusCode, 400);

  const ok = await t.app.inject({
    method: "POST",
    url: "/api/v1/auth/change-password",
    headers: acct.auth,
    payload: { currentPassword: PASSWORD, newPassword: "a-brand-new-password" },
  });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json().user.email, acct.email);

  const otherMe = await t.app.inject({
    method: "GET",
    url: "/api/v1/auth/me",
    headers: { authorization: `Bearer ${other}` },
  });
  assert.equal(otherMe.statusCode, 401);
  const selfMe = await t.app.inject({ method: "GET", url: "/api/v1/auth/me", headers: acct.auth });
  assert.equal(selfMe.statusCode, 200);

  await assert.rejects(login(t.app, acct.email, PASSWORD));
  assert.ok(await login(t.app, acct.email, "a-brand-new-password"));
});

test("change-password is rate limited per account", async () => {
  const acct = await register(t.app, "chpw-limit@example.com");
  const codes: number[] = [];
  for (let i = 0; i < 11; i += 1) {
    const res = await t.app.inject({
      method: "POST",
      url: "/api/v1/auth/change-password",
      headers: acct.auth,
      payload: { currentPassword: "wrong-password!", newPassword: "a-brand-new-password" },
    });
    codes.push(res.statusCode);
  }
  assert.deepEqual(codes.slice(0, 10), Array(10).fill(401));
  assert.equal(codes[10], 429);
});

test("key lifecycle: create → list → delete (only the caller's keys)", async () => {
  const acct = await register(t.app, "keys@example.com");
  const created = await createKey(t.app, acct, ["publish"], "ci-key");
  assert.ok(created.key.startsWith("mdo_"));

  const list = await t.app.inject({ method: "GET", url: "/api/v1/auth/keys", headers: acct.auth });
  const keys = list.json<{ keys: { id: string; prefix: string }[] }>().keys;
  assert.equal(keys.length, 1);
  assert.equal(keys[0]!.prefix, created.key.slice(0, 12));
  assert.equal((keys[0] as Record<string, unknown>).keyHash, undefined);

  const del = await t.app.inject({
    method: "DELETE",
    url: `/api/v1/auth/keys/${created.id}`,
    headers: acct.auth,
  });
  assert.equal(del.statusCode, 204);
  const again = await t.app.inject({
    method: "DELETE",
    url: `/api/v1/auth/keys/${created.id}`,
    headers: acct.auth,
  });
  assert.equal(again.statusCode, 404);
});

test("read-only API keys cannot publish", async () => {
  const { auth } = await createKey(t.app, owner, ["read"]);
  const denied = await t.app.inject({
    method: "POST",
    url: "/api/v1/repos",
    headers: auth,
    payload: { slug: "read-only-denied" },
  });
  assert.equal(denied.statusCode, 403);
});

test("the old password-only login body is rejected", async () => {
  const res = await t.app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    remoteAddress: freshIp(),
    payload: { password: PASSWORD },
  });
  assert.equal(res.statusCode, 400);
});
