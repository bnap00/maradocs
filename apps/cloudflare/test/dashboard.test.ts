import { beforeAll, describe, expect, it } from "vitest";
import {
  OWNER_EMAIL,
  PASSWORD,
  bearer,
  browser,
  createApiKey,
  env,
  fetchApp,
  freshIp,
  json,
  login,
  makeZip,
  publish,
  publishRaw,
  register,
  signIn,
  uniqueSlug,
  type Account,
} from "./helpers";

let session: Account;

beforeAll(async () => {
  session = await login();
});

function dash(method: string, path: string, body?: unknown, auth: Record<string, string> = browser(session.cookie)) {
  return fetchApp(`/api/v1/dashboard${path}`, {
    method,
    headers: { ...auth, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

describe("overview", () => {
  it("returns counts, stored bytes, recent publishes and audit", async () => {
    const key = await createApiKey(session.token);
    const repo = uniqueSlug("ov");
    expect((await dash("POST", "/repos", { slug: repo, access: "public" })).status).toBe(201);
    await publish(key, repo, "doc", { "index.html": "12345" }, { title: "Overview doc" });
    const res = await dash("GET", "/overview");
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.counts.repos).toBeGreaterThanOrEqual(1);
    expect(body.counts.docs).toBeGreaterThanOrEqual(1);
    expect(body.counts.versions).toBeGreaterThanOrEqual(1);
    expect(body.counts.apiKeys).toBeGreaterThanOrEqual(1);
    expect(body.storedBytes).toBeGreaterThanOrEqual(5);
    expect(body.recentPublishes.length).toBeLessThanOrEqual(10);
    expect(body.recentPublishes[0]).toMatchObject({
      repo,
      doc: "doc",
      title: "Overview doc",
      versionNumber: 1,
      sizeBytes: 5,
      isLatest: true,
      url: `https://maradocs.test/r/${repo}/doc/`,
    });
    expect(body.recentAudit.length).toBeGreaterThan(0);
    expect(body.recentAudit.length).toBeLessThanOrEqual(10);
  });
});

describe("repositories", () => {
  it("creates, reads, updates and deletes repositories (with docs and blobs)", async () => {
    const slug = uniqueSlug("drepo");
    const created = await dash("POST", "/repos", { slug, name: "Dash repo", access: "public", indexEnabled: true });
    expect(created.status).toBe(201);
    expect((await json(created)).repo).toMatchObject({ slug, name: "Dash repo", docCount: 0 });

    const key = await createApiKey(session.token);
    await publish(key, slug, "one", { "index.html": "1" });
    await publish(key, slug, "two", { "index.html": "2" });
    await publish(key, slug, "two", { "index.html": "2b" }, { replace: true });

    const list = await json(await dash("GET", "/repos"));
    expect(list.repos.find((r: { slug: string }) => r.slug === slug).docCount).toBe(2);
    expect((await json(await dash("GET", `/repos/${slug}`))).repo.docCount).toBe(2);

    const patched = await dash("PATCH", `/repos/${slug}`, { description: "updated", indexEnabled: false });
    expect(patched.status).toBe(200);
    expect((await json(patched)).repo).toMatchObject({ description: "updated", indexEnabled: false, docCount: 2 });

    const keys = (
      await env.DB.prepare(
        `SELECT v.storage_path FROM document_versions v JOIN documents d ON d.id = v.document_id
         JOIN repositories r ON r.id = d.repository_id WHERE r.slug = ?`,
      )
        .bind(slug)
        .all<{ storage_path: string }>()
    ).results.map((r) => r.storage_path);
    expect(keys).toHaveLength(3);

    const deleted = await dash("DELETE", `/repos/${slug}`);
    expect(deleted.status).toBe(200);
    expect(await json(deleted)).toEqual({ deleted: true });
    for (const k of keys) expect(await env.BUCKET.head(k)).toBeNull();
    const leftovers = await env.DB.prepare(
      `SELECT (SELECT COUNT(*) FROM documents d WHERE NOT EXISTS (SELECT 1 FROM repositories r WHERE r.id = d.repository_id)) +
              (SELECT COUNT(*) FROM document_versions v WHERE NOT EXISTS (SELECT 1 FROM documents d WHERE d.id = v.document_id)) AS n`,
    ).first<{ n: number }>();
    expect(leftovers?.n).toBe(0);
    expect((await dash("GET", `/repos/${slug}`)).status).toBe(404);
    expect((await fetchApp(`/r/${slug}/one/`)).status).toBe(404);

    const events = (await json(await dash("GET", `/audit?repo=${slug}&limit=50`))).audit.map((a: { event: string }) => a.event);
    expect(events).toContain("repo.delete");
    expect(events).toContain("repo.update");
    expect(events).toContain("repo.create");
  });

  it("validates slugs in route params", async () => {
    expect((await dash("GET", "/repos/Not_Valid")).status).toBe(404);
    expect((await dash("DELETE", "/repos/Not_Valid")).status).toBe(404);
  });
});

describe("documents", () => {
  let repo: string;
  let key: string;
  beforeAll(async () => {
    repo = uniqueSlug("ddoc");
    key = await createApiKey(session.token);
    await dash("POST", "/repos", { slug: repo, access: "public" });
  });

  it("uploads from the browser (multipart, cookie + same origin) and replaces", async () => {
    const zip = makeZip({ "index.html": "<h1>browser</h1>" });
    const res = await publishRaw(browser(session.cookie), repo, "upload", zip, { apiBase: "/api/v1/dashboard", title: "Uploaded" });
    expect(res.status).toBe(201);
    const result = await json(res);
    expect(result).toMatchObject({ repo, doc: "upload", versionNumber: 1 });
    const replaced = await publishRaw(browser(session.cookie), repo, "upload", makeZip({ "index.html": "v2" }), {
      apiBase: "/api/v1/dashboard",
      replace: true,
    });
    expect(replaced.status).toBe(200);
    expect((await json(replaced)).versionNumber).toBe(2);
    const { versions } = await json(await dash("GET", `/repos/${repo}/docs/upload/versions`));
    expect(versions[0]).toMatchObject({ versionNumber: 2, publishedByType: "user", publishedByLabel: OWNER_EMAIL });

    const crossSite = await publishRaw({ cookie: session.cookie, origin: "https://evil.example", "x-maradocs": "1" }, repo, "evil", zip, {
      apiBase: "/api/v1/dashboard",
    });
    expect(crossSite.status).toBe(403);
    // Same origin but without the dashboard's CSRF header.
    const noHeader = await publishRaw({ cookie: session.cookie, origin: "https://maradocs.test" }, repo, "evil", zip, {
      apiBase: "/api/v1/dashboard",
    });
    expect(noHeader.status).toBe(403);
  });

  it("lists docs with stats and returns a single doc", async () => {
    await publish(key, repo, "stats", { "index.html": "abc", "b.txt": "de" });
    const { docs } = await json(await dash("GET", `/repos/${repo}/docs`));
    const doc = docs.find((d: { slug: string }) => d.slug === "stats");
    expect(doc).toMatchObject({ versionCount: 1, latestSizeBytes: 5, latestFileCount: 2, latestVersionNumber: 1 });
    expect(typeof doc.latestPublishedAt).toBe("string");
    const single = await json(await dash("GET", `/repos/${repo}/docs/stats`));
    expect(single.doc).toMatchObject({ slug: "stats", versionCount: 1 });
    expect((await dash("GET", `/repos/${repo}/docs/missing`)).status).toBe(404);
  });

  it("patches title, access override (null = inherit) and password", async () => {
    await publish(key, repo, "patchme", { "index.html": "patched" });
    const title = await dash("PATCH", `/repos/${repo}/docs/patchme`, { title: "New title" });
    expect(title.status).toBe(200);
    expect((await json(title)).doc).toMatchObject({ title: "New title", access: "public", accessOverride: null });

    const noPw = await dash("PATCH", `/repos/${repo}/docs/patchme`, { access: "password" });
    expect(noPw.status).toBe(400);

    const pw = await dash("PATCH", `/repos/${repo}/docs/patchme`, { access: "password", password: "letmein1" });
    expect((await json(pw)).doc).toMatchObject({
      access: "password",
      accessOverride: "password",
      hasPassword: true,
      hasOwnPassword: true,
    });
    expect((await fetchApp(`/r/${repo}/patchme/`)).status).toBe(401);

    const priv = await dash("PATCH", `/repos/${repo}/docs/patchme`, { access: "private" });
    expect((await json(priv)).doc.access).toBe("private");
    expect((await fetchApp(`/r/${repo}/patchme/`)).status).toBe(401);

    const inherit = await dash("PATCH", `/repos/${repo}/docs/patchme`, { access: null, password: null });
    expect((await json(inherit)).doc).toMatchObject({
      access: "public",
      accessOverride: null,
      hasPassword: false,
      hasOwnPassword: false,
    });
    expect((await fetchApp(`/r/${repo}/patchme/`)).status).toBe(200);

    const bad = await dash("PATCH", `/repos/${repo}/docs/patchme`, { password: "abc" });
    expect(bad.status).toBe(400);
    expect((await json(bad)).error).toBe("validation_error");

    const events = (await json(await dash("GET", `/audit?repo=${repo}&event=access.change`))).audit;
    expect(events.length).toBeGreaterThanOrEqual(3);
    const updates = (await json(await dash("GET", `/audit?repo=${repo}&event=doc.update`))).audit;
    expect(updates.length).toBe(1);
  });

  it("distinguishes a document's own password from the repository fallback", async () => {
    const pwRepo = uniqueSlug("pwrepo");
    const created = await dash("POST", "/repos", { slug: pwRepo, access: "password", password: "repo-secret" });
    expect(created.status).toBe(201);
    await publish(key, pwRepo, "inherits", { "index.html": "x" });
    const inherited = (await json(await dash("GET", `/repos/${pwRepo}/docs/inherits`))).doc;
    // hasPassword is the effective value (machine shape); hasOwnPassword is the doc's own.
    expect(inherited).toMatchObject({ access: "password", hasPassword: true, hasOwnPassword: false });
    const own = await dash("PATCH", `/repos/${pwRepo}/docs/inherits`, { password: "doc-secret" });
    expect((await json(own)).doc).toMatchObject({ hasPassword: true, hasOwnPassword: true });
    const listed = (await json(await dash("GET", `/repos/${pwRepo}/docs`))).docs[0];
    expect(listed).toMatchObject({ slug: "inherits", hasOwnPassword: true });
  });

  it("downloads bundles, rolls back and deletes via the dashboard API", async () => {
    await publish(key, repo, "ops", { "index.html": "one" });
    await publish(key, repo, "ops", { "index.html": "two" }, { replace: true });
    const bundle = await dash("GET", `/repos/${repo}/docs/ops/bundle?version=1`);
    expect(bundle.status).toBe(200);
    expect(bundle.headers.get("x-maradocs-version-number")).toBe("1");
    await bundle.arrayBuffer();
    const rb = await dash("POST", `/repos/${repo}/docs/ops/rollback`, { version: 1 });
    expect((await json(rb)).doc.latestVersionNumber).toBe(1);
    const del = await dash("DELETE", `/repos/${repo}/docs/ops`);
    expect(await json(del)).toEqual({ deleted: true });
  });
});

describe("audit log", () => {
  it("paginates with a cursor and filters by repo and event", async () => {
    const repo = uniqueSlug("aud");
    await dash("POST", "/repos", { slug: repo, access: "public" });
    for (let i = 0; i < 5; i += 1) await dash("PATCH", `/repos/${repo}`, { description: `d${i}` });

    const first = await json(await dash("GET", `/audit?repo=${repo}&limit=2`));
    expect(first.audit).toHaveLength(2);
    expect(first.nextCursor).toBeTruthy();
    const second = await json(await dash("GET", `/audit?repo=${repo}&limit=2&before=${encodeURIComponent(first.nextCursor)}`));
    const third = await json(await dash("GET", `/audit?repo=${repo}&limit=2&before=${encodeURIComponent(second.nextCursor)}`));
    expect(third.nextCursor).toBeNull();
    const all = [...first.audit, ...second.audit, ...third.audit];
    expect(all).toHaveLength(6);
    expect(new Set(all.map((a: { id: string }) => a.id)).size).toBe(6);
    expect(all[all.length - 1].event).toBe("repo.create");
    for (let i = 1; i < all.length; i += 1) expect(all[i - 1].createdAt >= all[i].createdAt).toBe(true);
    expect(all[0]).toMatchObject({ actorType: "user", actorLabel: OWNER_EMAIL, repositorySlug: repo });

    const updates = await json(await dash("GET", `/audit?repo=${repo}&event=repo.update`));
    expect(updates.audit).toHaveLength(5);
    const prefix = await json(await dash("GET", `/audit?repo=${repo}&event=repo.*`));
    expect(prefix.audit).toHaveLength(6);

    // A bare createdAt cursor also works.
    const bare = await json(await dash("GET", `/audit?repo=${repo}&before=${encodeURIComponent(all[0].createdAt)}`));
    expect(bare.audit.every((a: { createdAt: string }) => a.createdAt < all[0].createdAt)).toBe(true);

    expect((await dash("GET", "/audit?limit=0")).status).toBe(400);
    expect((await dash("GET", "/audit?repo=Bad_Slug")).status).toBe(400);
    expect((await dash("GET", "/audit?event=DROP%20TABLE")).status).toBe(400);
  });
});

describe("settings", () => {
  it("reads and updates the default repository access (per account)", async () => {
    const res = await dash("GET", "/settings");
    expect(await json(res)).toMatchObject({
      defaultRepoAccess: "private",
      maxUploadMb: 2,
      publicBaseUrl: null,
      registration: "open",
      serverUrl: "https://maradocs.test",
    });
    const patched = await dash("PATCH", "/settings", { defaultRepoAccess: "public" });
    expect((await json(patched)).defaultRepoAccess).toBe("public");

    // New repositories without explicit access pick up the setting.
    const slug = uniqueSlug("setacc");
    const created = await json(await dash("POST", "/repos", { slug }));
    expect(created.repo.defaultAccess).toBe("public");

    // Other accounts keep the deployment default.
    const other = await register();
    const theirs = await json(await dash("GET", "/settings", undefined, { cookie: other.cookie }));
    expect(theirs.defaultRepoAccess).toBe("private");
    const theirRepo = await json(await dash("POST", "/repos", { slug: uniqueSlug("setacc") }, browser(other.cookie)));
    expect(theirRepo.repo.defaultAccess).toBe("private");

    expect((await dash("PATCH", "/settings", { defaultRepoAccess: "open" })).status).toBe(400);
    const events = (await json(await dash("GET", "/audit?event=settings.update"))).audit;
    expect(events[0].detail).toContain("private -> public");
    await dash("PATCH", "/settings", { defaultRepoAccess: "private" });
  });
});

describe("account password and sessions (dashboard aliases)", () => {
  it("changes the password, revokes other sessions and keeps the current one", async () => {
    const current = await register();
    const other = await signIn(current.email);

    const tooShort = await dash("POST", "/password", { currentPassword: PASSWORD, newPassword: "short" }, browser(current.cookie));
    expect(tooShort.status).toBe(400);
    const wrong = await dash("POST", "/password", { currentPassword: "wrong", newPassword: "a-brand-new-password" }, browser(current.cookie));
    expect(wrong.status).toBe(401);

    const ok = await dash("POST", "/password", { currentPassword: PASSWORD, newPassword: "a-brand-new-password" }, browser(current.cookie));
    expect(ok.status).toBe(200);
    expect((await json(ok)).user).toMatchObject({ id: current.userId, email: current.email });

    expect((await dash("GET", "/me", undefined, { cookie: current.cookie })).status).toBe(200);
    expect((await dash("GET", "/me", undefined, bearer(other.token))).status).toBe(401);

    const oldLogin = await fetchApp("/api/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": freshIp() },
      body: JSON.stringify({ email: current.email, password: PASSWORD }),
    });
    expect(oldLogin.status).toBe(401);
    await signIn(current.email, "a-brand-new-password");

    const stored = await env.DB.prepare(`SELECT password_hash FROM users WHERE id = ?`).bind(current.userId).first<{ password_hash: string }>();
    expect(stored?.password_hash).toMatch(/^pbkdf2\$sha256\$/);
    expect(stored?.password_hash).not.toContain("a-brand-new-password");

    const events = (await json(await dash("GET", "/audit?event=password.change", undefined, { cookie: current.cookie }))).audit;
    expect(events).toHaveLength(1);
  });

  it("revoke-all signs out the account's other sessions only", async () => {
    const a = await register();
    const b = await signIn(a.email);
    const res = await dash("POST", "/sessions/revoke-all", undefined, browser(a.cookie));
    expect(res.status).toBe(200);
    expect((await json(res)).revoked).toBe(1);
    expect((await dash("GET", "/me", undefined, { cookie: a.cookie })).status).toBe(200);
    expect((await dash("GET", "/me", undefined, bearer(b.token))).status).toBe(401);
    // Other accounts (and the file's owner) are untouched.
    expect((await dash("GET", "/me")).status).toBe(200);
    expect((await json(await dash("GET", "/audit?event=auth.logout_others", undefined, { cookie: a.cookie }))).audit.length).toBe(1);
  });
});
