import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import AdmZip from "adm-zip";
import type { FastifyInstance } from "fastify";
import {
  PASSWORD,
  createKey,
  freshIp,
  makeApp,
  multipart,
  register,
  sha256hex,
} from "./helpers.js";

function bundle(html = "<h1>hi</h1>"): Buffer {
  const zip = new AdmZip();
  zip.addFile("index.html", Buffer.from(html));
  return zip.toBuffer();
}

async function registerRaw(app: FastifyInstance, payload: Record<string, unknown>) {
  return app.inject({
    method: "POST",
    url: "/api/v1/auth/register",
    remoteAddress: freshIp(),
    payload,
  });
}

async function getConfig(app: FastifyInstance) {
  return (await app.inject({ method: "GET", url: "/api/v1/auth/config" })).json();
}

async function publish(
  app: FastifyInstance,
  auth: { authorization: string },
  repo: string,
  doc: string,
  fields: Record<string, string> = {},
) {
  const mp = multipart({ doc, ...fields }, bundle());
  return app.inject({
    method: "POST",
    url: `/api/v1/repos/${repo}/docs`,
    headers: { ...auth, ...mp.headers },
    payload: mp.body,
  });
}

test("REGISTRATION=first allows only the first account", async () => {
  const t = await makeApp();
  try {
    assert.deepEqual(await getConfig(t.app), {
      registration: true,
      claimRequired: false,
      firstAccount: true,
      minPasswordLength: 12,
    });
    await register(t.app, "first@example.com");
    assert.equal((await getConfig(t.app)).registration, false);
    assert.equal((await getConfig(t.app)).firstAccount, false);
    const second = await registerRaw(t.app, { email: "second@example.com", password: PASSWORD });
    assert.equal(second.statusCode, 403);
    assert.equal(second.json().error, "registration_closed");
  } finally {
    await t.close();
  }
});

test("REGISTRATION=open allows anyone; closed allows nobody", async () => {
  const open = await makeApp({ REGISTRATION: "open" });
  try {
    await register(open.app, "a@example.com");
    await register(open.app, "b@example.com");
    assert.equal((await getConfig(open.app)).registration, true);
  } finally {
    await open.close();
  }

  const closed = await makeApp({ REGISTRATION: "closed" });
  try {
    assert.equal((await getConfig(closed.app)).registration, false);
    const res = await registerRaw(closed.app, { email: "a@example.com", password: PASSWORD });
    assert.equal(res.statusCode, 403);
    assert.equal(res.json().error, "registration_closed");
  } finally {
    await closed.close();
  }
});

test("invalid REGISTRATION values are rejected at startup", async () => {
  await assert.rejects(makeApp({ REGISTRATION: "maybe" }), /REGISTRATION/);
});

test("ADMIN_PASSWORD acts as the claim password for the first account only", async () => {
  const t = await makeApp({ ADMIN_PASSWORD: "legacy-admin-pw", REGISTRATION: "open" });
  try {
    assert.equal((await getConfig(t.app)).claimRequired, true);

    const missing = await registerRaw(t.app, { email: "a@example.com", password: PASSWORD });
    assert.equal(missing.statusCode, 403);
    assert.equal(missing.json().error, "claim_required");

    const wrong = await registerRaw(t.app, {
      email: "a@example.com",
      password: PASSWORD,
      claimPassword: "nope",
    });
    assert.equal(wrong.statusCode, 403);

    await register(t.app, "a@example.com", PASSWORD, { claimPassword: "legacy-admin-pw" });
    assert.equal((await getConfig(t.app)).claimRequired, false);

    // Once an account exists the claim password is ignored.
    await register(t.app, "b@example.com");

    // It is not a login either.
    const legacy = await t.app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      remoteAddress: freshIp(),
      payload: { email: "a@example.com", password: "legacy-admin-pw" },
    });
    assert.equal(legacy.statusCode, 401);
  } finally {
    await t.close();
  }
});

test("the first account adopts legacy ownerless repositories, keys and audit rows", async () => {
  const t = await makeApp({ REGISTRATION: "open" });
  try {
    // Simulate pre-accounts data: an ownerless key that publishes a repo.
    const legacyKey = "mdo_legacy-key-from-before-accounts";
    t.ctx.store.createApiKey({
      userId: null,
      name: "legacy",
      keyHash: sha256hex(legacyKey),
      prefix: legacyKey.slice(0, 12),
      scopes: ["admin"],
    });
    const legacyAuth = { authorization: `Bearer ${legacyKey}` };
    const create = await t.app.inject({
      method: "POST",
      url: "/api/v1/repos",
      headers: legacyAuth,
      payload: { slug: "legacy", access: "private" },
    });
    assert.equal(create.statusCode, 201);
    assert.equal((await publish(t.app, legacyAuth, "legacy", "report")).statusCode, 201);

    const first = await register(t.app, "first@example.com");
    const second = await register(t.app, "second@example.com");

    const firstRepos = await t.app.inject({
      method: "GET",
      url: "/api/v1/dashboard/repos",
      headers: first.auth,
    });
    assert.deepEqual(
      firstRepos.json<{ repos: { slug: string }[] }>().repos.map((r) => r.slug),
      ["legacy"],
    );
    const firstKeys = await t.app.inject({
      method: "GET",
      url: "/api/v1/auth/keys",
      headers: first.auth,
    });
    assert.equal(firstKeys.json().keys.length, 1);
    const firstAudit = await t.app.inject({
      method: "GET",
      url: "/api/v1/dashboard/audit",
      headers: first.auth,
    });
    const events = firstAudit.json<{ audit: { event: string }[] }>().audit.map((e) => e.event);
    assert.ok(events.includes("repo.create") && events.includes("doc.publish"));

    const secondRepos = await t.app.inject({
      method: "GET",
      url: "/api/v1/dashboard/repos",
      headers: second.auth,
    });
    assert.equal(secondRepos.json().repos.length, 0);

    // The adopted key keeps working, now on behalf of the first account.
    const viaKey = await t.app.inject({ method: "GET", url: "/api/v1/repos", headers: legacyAuth });
    assert.equal(viaKey.json().repos.length, 1);
  } finally {
    await t.close();
  }
});

test("users are isolated across machine API, dashboard API, reader, machines and audit", async () => {
  const t = await makeApp({ REGISTRATION: "open" });
  const app = t.app;
  try {
    const alice = await register(app, "alice@example.com");
    const bob = await register(app, "bob@example.com");
    const aliceKey = await createKey(app, alice, ["admin"]);
    const bobKey = await createKey(app, bob, ["admin"]);

    const create = await app.inject({
      method: "POST",
      url: "/api/v1/repos",
      headers: aliceKey.auth,
      payload: { slug: "alice-repo", access: "private" },
    });
    assert.equal(create.statusCode, 201);
    assert.equal((await publish(app, aliceKey.auth, "alice-repo", "secret")).statusCode, 201);

    // Slug collision with another user's repo: 409 with the contract message.
    for (const [url, headers] of [
      ["/api/v1/repos", bobKey.auth],
      ["/api/v1/dashboard/repos", bob.auth],
    ] as const) {
      const clash = await app.inject({
        method: "POST",
        url,
        headers,
        payload: { slug: "alice-repo" },
      });
      assert.equal(clash.statusCode, 409);
      assert.equal(clash.json().message, "Repository slug 'alice-repo' is already taken");
    }

    // Bob can't see Alice's repo anywhere.
    const bobList = await app.inject({ method: "GET", url: "/api/v1/repos", headers: bobKey.auth });
    assert.equal(bobList.json().repos.length, 0);
    const bobDashList = await app.inject({
      method: "GET",
      url: "/api/v1/dashboard/repos",
      headers: bob.auth,
    });
    assert.equal(bobDashList.json().repos.length, 0);

    const notFoundCases: { method: "GET" | "PATCH" | "DELETE" | "POST"; url: string; payload?: object; headers: object }[] = [
      { method: "GET", url: "/api/v1/repos/alice-repo/docs", headers: bobKey.auth },
      { method: "PATCH", url: "/api/v1/repos/alice-repo", headers: bobKey.auth, payload: { access: "public" } },
      { method: "GET", url: "/api/v1/repos/alice-repo/docs/secret/versions", headers: bobKey.auth },
      { method: "GET", url: "/api/v1/repos/alice-repo/docs/secret/bundle", headers: bobKey.auth },
      { method: "POST", url: "/api/v1/repos/alice-repo/docs/secret/rollback", headers: bobKey.auth, payload: { version: 1 } },
      { method: "DELETE", url: "/api/v1/repos/alice-repo/docs/secret", headers: bobKey.auth },
      { method: "GET", url: "/api/v1/dashboard/repos/alice-repo/docs", headers: bob.auth },
      { method: "PATCH", url: "/api/v1/dashboard/repos/alice-repo", headers: bob.auth, payload: { access: "public" } },
      { method: "GET", url: "/api/v1/dashboard/repos/alice-repo/docs/secret/versions", headers: bob.auth },
      { method: "POST", url: "/api/v1/dashboard/repos/alice-repo/docs/secret/rollback", headers: bob.auth, payload: { version: 1 } },
      { method: "DELETE", url: "/api/v1/dashboard/repos/alice-repo/docs/secret", headers: bob.auth },
    ];
    for (const c of notFoundCases) {
      const res = await app.inject({
        method: c.method,
        url: c.url,
        headers: c.headers as Record<string, string>,
        payload: c.payload,
      });
      assert.equal(res.statusCode, 404, `${c.method} ${c.url} -> ${res.statusCode}`);
    }

    // Bob can't publish into Alice's repo either.
    assert.equal((await publish(app, bobKey.auth, "alice-repo", "intruder")).statusCode, 404);
    const put = multipart({ doc: "secret" }, bundle("<h1>pwned</h1>"));
    const replace = await app.inject({
      method: "PUT",
      url: "/api/v1/repos/alice-repo/docs/secret",
      headers: { ...bobKey.auth, ...put.headers },
      payload: put.body,
    });
    assert.equal(replace.statusCode, 404);

    // Alice's doc is untouched and still private.
    const versions = await app.inject({
      method: "GET",
      url: "/api/v1/repos/alice-repo/docs/secret/versions",
      headers: aliceKey.auth,
    });
    assert.equal(versions.json().versions.length, 1);

    // Reader: only Alice (session or key) reads the private doc. Bob gets the anonymous response.
    const anon = await app.inject({ method: "GET", url: "/r/alice-repo/secret/" });
    assert.equal(anon.statusCode, 401);
    for (const headers of [
      bob.auth,
      bobKey.auth,
      { cookie: `maradocs_session=${bob.token}` },
    ]) {
      const res = await app.inject({ method: "GET", url: "/r/alice-repo/secret/", headers });
      assert.equal(res.statusCode, 401);
      assert.equal(res.body, anon.body);
    }
    for (const headers of [
      alice.auth,
      aliceKey.auth,
      { cookie: `maradocs_session=${alice.token}` },
    ]) {
      const res = await app.inject({ method: "GET", url: "/r/alice-repo/secret/", headers });
      assert.equal(res.statusCode, 200);
    }

    // Machines and audit are per user.
    const bobMachines = await app.inject({
      method: "GET",
      url: "/api/v1/dashboard/machines",
      headers: bob.auth,
    });
    const bobMachineKeys = bobMachines.json<{ machines: { keyId: string }[] }>().machines.map((m) => m.keyId);
    assert.deepEqual(bobMachineKeys, [bobKey.id]);
    const aliceMachines = await app.inject({
      method: "GET",
      url: "/api/v1/dashboard/machines",
      headers: alice.auth,
    });
    assert.deepEqual(
      aliceMachines.json<{ machines: { keyId: string }[] }>().machines.map((m) => m.keyId),
      [aliceKey.id],
    );
    const bobAudit = await app.inject({
      method: "GET",
      url: "/api/v1/dashboard/audit",
      headers: bob.auth,
    });
    const bobEntries = bobAudit.json<{ audit: { repositorySlug: string | null }[] }>().audit;
    assert.ok(bobEntries.every((e) => e.repositorySlug !== "alice-repo"));

    // Keys: Bob can neither list nor delete Alice's key.
    const bobKeys = await app.inject({ method: "GET", url: "/api/v1/auth/keys", headers: bob.auth });
    assert.deepEqual(bobKeys.json<{ keys: { id: string }[] }>().keys.map((k) => k.id), [bobKey.id]);
    const delAlice = await app.inject({
      method: "DELETE",
      url: `/api/v1/auth/keys/${aliceKey.id}`,
      headers: bob.auth,
    });
    assert.equal(delAlice.statusCode, 404);
    const stillWorks = await app.inject({ method: "GET", url: "/api/v1/repos", headers: aliceKey.auth });
    assert.equal(stillWorks.statusCode, 200);

    // Deleting a key removes its machines row too.
    const delOwn = await app.inject({
      method: "DELETE",
      url: `/api/v1/auth/keys/${bobKey.id}`,
      headers: bob.auth,
    });
    assert.equal(delOwn.statusCode, 204);
    const afterDel = await app.inject({
      method: "GET",
      url: "/api/v1/dashboard/machines",
      headers: bob.auth,
    });
    assert.equal(afterDel.json().machines.length, 0);
  } finally {
    await t.close();
  }
});

test("DELETE /account removes the user and everything they own", async () => {
  const t = await makeApp({ REGISTRATION: "open" });
  const app = t.app;
  try {
    const alice = await register(app, "alice@example.com");
    const bob = await register(app, "bob@example.com");
    const aliceKey = await createKey(app, alice, ["admin"]);
    const bobKey = await createKey(app, bob, ["admin"]);
    for (const [auth, slug] of [
      [aliceKey.auth, "alice-repo"],
      [bobKey.auth, "bob-repo"],
    ] as const) {
      await app.inject({
        method: "POST",
        url: "/api/v1/repos",
        headers: auth,
        payload: { slug, access: "public" },
      });
      assert.equal((await publish(app, auth, slug, "doc")).statusCode, 201);
    }
    const aliceDir = t.ctx.storage.repoDir("alice-repo");
    assert.ok(fs.existsSync(aliceDir));

    const wrong = await app.inject({
      method: "DELETE",
      url: "/api/v1/auth/account",
      headers: alice.auth,
      payload: { password: "not-my-password" },
    });
    assert.equal(wrong.statusCode, 401);

    const del = await app.inject({
      method: "DELETE",
      url: "/api/v1/auth/account",
      headers: { cookie: `maradocs_session=${alice.token}`, "x-maradocs": "1" },
      payload: { password: PASSWORD },
    });
    assert.equal(del.statusCode, 204);
    assert.match(String(del.headers["set-cookie"]), /maradocs_session=;/);

    // Sessions, keys, repos, docs and files are gone.
    const me = await app.inject({ method: "GET", url: "/api/v1/auth/me", headers: alice.auth });
    assert.equal(me.statusCode, 401);
    const viaKey = await app.inject({ method: "GET", url: "/api/v1/repos", headers: aliceKey.auth });
    assert.equal(viaKey.statusCode, 401);
    assert.equal(t.ctx.store.getRepo("alice-repo"), null);
    assert.equal(fs.existsSync(aliceDir), false);
    const reader = await app.inject({ method: "GET", url: "/r/alice-repo/doc/" });
    assert.equal(reader.statusCode, 404);
    assert.equal(t.ctx.store.getUserByEmail("alice@example.com"), null);

    // The slug is free again and Bob's data is untouched.
    const reuse = await app.inject({
      method: "POST",
      url: "/api/v1/repos",
      headers: bobKey.auth,
      payload: { slug: "alice-repo" },
    });
    assert.equal(reuse.statusCode, 201);
    const bobDoc = await app.inject({ method: "GET", url: "/r/bob-repo/doc/" });
    assert.equal(bobDoc.statusCode, 200);

    // The email can register again.
    await register(app, "alice@example.com");
  } finally {
    await t.close();
  }
});

test("cookie secret is generated once and persisted when COOKIE_SECRET is unset", async () => {
  const t = await makeApp();
  try {
    const secret = t.ctx.cookieSecret;
    assert.match(secret, /^[0-9a-f]{64}$/);
    assert.equal(t.ctx.store.getSetting("cookie_secret"), secret);
  } finally {
    await t.close();
  }
  const configured = await makeApp({ COOKIE_SECRET: "y".repeat(40) });
  try {
    assert.equal(configured.ctx.cookieSecret, "y".repeat(40));
  } finally {
    await configured.close();
  }
});
