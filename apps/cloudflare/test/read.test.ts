import { beforeAll, describe, expect, it } from "vitest";
import { passwordBinding, passwordHashIterations, rehashPassword, sha256Hex } from "../src/crypto";
import { safeNext } from "../src/routes/read";
import {
  auditEvents,
  env,
  waitFor,
  bearer,
  createApiKey,
  createRepo,
  fetchApp,
  freshIp,
  json,
  login,
  machineJson,
  publish,
  uniqueSlug,
} from "./helpers";

let session: { token: string; cookie: string };
let key: string;

beforeAll(async () => {
  session = await login();
  key = await createApiKey(session.token, ["publish"]);
});

const REPORT_CSP = "sandbox allow-downloads allow-forms allow-popups allow-scripts";

function unlock(repo: string, doc: string, password: string, ip = freshIp(), next?: string) {
  const body = new URLSearchParams({ password });
  if (next) body.set("next", next);
  return fetchApp(`/r/${repo}/${doc}/__unlock`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": ip },
    body,
  });
}

describe("public reports", () => {
  let repo: string;
  beforeAll(async () => {
    repo = uniqueSlug("pubread");
    await createRepo(key, repo);
    await publish(key, repo, "site", {
      "index.html": "<h1>home</h1>",
      "docs/index.html": "<h1>docs</h1>",
      "docs/guide.html": "<h1>guide</h1>",
      "assets/app.js": "console.log(1)",
      "assets/style.css": "body{}",
      "img/logo.svg": "<svg/>",
      "data/values.json": "[1,2]",
      "my file.html": "spaced",
      "empty.txt": "",
      "blob.unknownext": "?",
    });
  });

  it("serves the entrypoint with isolation headers", async () => {
    const res = await fetchApp(`/r/${repo}/site/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("<h1>home</h1>");
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("content-security-policy")).toBe(REPORT_CSP);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("cache-control")).toBe("public, max-age=60");
    expect(res.headers.get("etag")).toMatch(/^"ver_/);
  });

  it("applies the server's path rules", async () => {
    const cases: [string, number, string?][] = [
      ["docs/", 200, "<h1>docs</h1>"],
      ["docs/guide.html", 200, "<h1>guide</h1>"],
      ["my%20file.html", 200, "spaced"],
      ["nope.html", 404],
      ["%E0%A4%A", 404],
      ["docs%00.html", 404],
      ["..%2F..%2Fetc%2Fpasswd", 404],
      ["%2E%2E/index.html", 404],
      ["assets%2F..%2Findex.html", 404],
    ];
    for (const [path, status, body] of cases) {
      const res = await fetchApp(`/r/${repo}/site/${path}`);
      expect(res.status, path).toBe(status);
      const text = await res.text();
      if (body) expect(text, path).toBe(body);
    }
  });

  it("redirects a directory path to its slash form so relative URLs resolve inside it", async () => {
    const res = await fetchApp(`/r/${repo}/site/docs?q=1`);
    expect(res.status).toBe(308);
    expect(res.headers.get("location")).toBe(`/r/${repo}/site/docs/?q=1`);
    const pinned = await fetchApp(`/r/${repo}/site/v/1/docs`);
    expect(pinned.status).toBe(308);
    expect(pinned.headers.get("location")).toBe(`/r/${repo}/site/v/1/docs/`);
    // A real file with that name is still served directly.
    expect((await fetchApp(`/r/${repo}/site/docs/guide.html`)).status).toBe(200);
  });

  it("sets content types per extension", async () => {
    const types: Record<string, string> = {
      "assets/app.js": "text/javascript; charset=utf-8",
      "assets/style.css": "text/css; charset=utf-8",
      "img/logo.svg": "image/svg+xml",
      "data/values.json": "application/json; charset=utf-8",
      "blob.unknownext": "application/octet-stream",
    };
    for (const [path, type] of Object.entries(types)) {
      const res = await fetchApp(`/r/${repo}/site/${path}`);
      expect(res.headers.get("content-type"), path).toBe(type);
      expect(res.headers.get("content-security-policy"), path).toBe(REPORT_CSP);
      await res.arrayBuffer();
    }
  });

  it("serves zero-length files and HEAD requests", async () => {
    const empty = await fetchApp(`/r/${repo}/site/empty.txt`);
    expect(empty.status).toBe(200);
    expect(await empty.text()).toBe("");
    const head = await fetchApp(`/r/${repo}/site/index.html`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe(String("<h1>home</h1>".length));
  });

  it("answers conditional requests with 304", async () => {
    const first = await fetchApp(`/r/${repo}/site/assets/style.css`);
    const etag = first.headers.get("etag")!;
    await first.arrayBuffer();
    const second = await fetchApp(`/r/${repo}/site/assets/style.css`, { headers: { "if-none-match": etag } });
    expect(second.status).toBe(304);
  });

  it("redirects bare document and version URLs to their slash form", async () => {
    const doc = await fetchApp(`/r/${repo}/site?x=1`);
    expect(doc.status).toBe(308);
    expect(doc.headers.get("location")).toBe(`/r/${repo}/site/?x=1`);
    const version = await fetchApp(`/r/${repo}/site/v/1`);
    expect(version.status).toBe(308);
    expect(version.headers.get("location")).toBe(`/r/${repo}/site/v/1/`);
    const repoRedirect = await fetchApp(`/r/${repo}`);
    expect(repoRedirect.status).toBe(308);
  });

  it("returns HTML 404s for unknown repos/docs, invalid slugs and versions", async () => {
    for (const path of [
      `/r/${uniqueSlug("missing")}/doc/`,
      `/r/${repo}/missing/`,
      `/r/BAD/doc/`,
      `/r/${repo}/Bad_Doc/`,
      `/r/${repo}/site/v/abc/`,
      `/r/${repo}/site/v/0/`,
      `/r/${repo}/site/v/99/`,
    ]) {
      const res = await fetchApp(path);
      expect(res.status, path).toBe(404);
      expect(res.headers.get("content-type"), path).toContain("text/html");
      await res.arrayBuffer();
    }
  });

  it("rejects non-GET methods on report files", async () => {
    const res = await fetchApp(`/r/${repo}/site/index.html`, { method: "PUT", body: "x" });
    expect(res.status).toBe(405);
  });
});

describe("pinned versions", () => {
  it("serves immutable pinned versions alongside the latest", async () => {
    const repo = uniqueSlug("pin");
    await createRepo(key, repo);
    await publish(key, repo, "doc", { "index.html": "one", "old.html": "only in v1" });
    await publish(key, repo, "doc", { "index.html": "two" }, { replace: true });
    expect(await (await fetchApp(`/r/${repo}/doc/`)).text()).toBe("two");
    const v1 = await fetchApp(`/r/${repo}/doc/v/1/`);
    expect(await v1.text()).toBe("one");
    // Pinned versions are immutable, but access to them is not: keep caching short.
    expect(v1.headers.get("cache-control")).toBe("public, max-age=60");
    expect(await (await fetchApp(`/r/${repo}/doc/v/1/old.html`)).text()).toBe("only in v1");
    expect((await fetchApp(`/r/${repo}/doc/old.html`)).status).toBe(404);
    expect(await (await fetchApp(`/r/${repo}/doc/v/2/index.html`)).text()).toBe("two");
  });
});

describe("password-protected reports", () => {
  let repo: string;
  beforeAll(async () => {
    repo = uniqueSlug("pw");
    await createRepo(key, repo);
    await publish(key, repo, "secret", { "index.html": "classified", "a/b.html": "deep" }, { access: "password", password: "open-sesame" });
    await publish(key, repo, "other", { "index.html": "other secret" }, { access: "password", password: "open-sesame" });
  });

  it("shows a gate page (401) without the unlock cookie", async () => {
    const res = await fetchApp(`/r/${repo}/secret/`);
    expect(res.status).toBe(401);
    const html = await res.text();
    expect(html).toContain(`action="/r/${repo}/secret/__unlock"`);
    expect(html).toContain('name="next"');
    expect(html).not.toContain("classified");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });

  it("unlocks with the right password and sets a scoped, signed cookie", async () => {
    const wrong = await unlock(repo, "secret", "nope");
    expect(wrong.status).toBe(401);
    expect(await wrong.text()).toContain("Incorrect password");

    const ok = await unlock(repo, "secret", "open-sesame", freshIp(), `/r/${repo}/secret/a/b.html`);
    expect(ok.status).toBe(303);
    expect(ok.headers.get("location")).toBe(`/r/${repo}/secret/a/b.html`);
    const setCookie = ok.headers.get("set-cookie")!;
    expect(setCookie).toContain(`maradocs_pw_${repo}__secret=`);
    expect(setCookie).toContain(`Path=/r/${repo}/secret`);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure");
    // None: the sandboxed report's own subresource requests are cross-site.
    expect(setCookie).toContain("SameSite=None");
    const cookie = setCookie.split(";")[0]!;

    const page = await fetchApp(`/r/${repo}/secret/a/b.html`, { headers: { cookie } });
    expect(page.status).toBe(200);
    expect(await page.text()).toBe("deep");
    expect(page.headers.get("cache-control")).toBe("private, no-store");
    expect(page.headers.get("content-security-policy")).toBe(REPORT_CSP);

    // The cookie is bound to this document: same password, different doc → still gated.
    const forged = cookie.replace(`__secret=`, `__other=`);
    expect((await fetchApp(`/r/${repo}/other/`, { headers: { cookie: forged } })).status).toBe(401);
  });

  it("normalises post-unlock targets (unit)", () => {
    const p = "/r/a/b/";
    expect(safeNext("/r/a/b/x.html", "a", "b")).toBe("/r/a/b/x.html");
    expect(safeNext(`/r/a/b/~p.abc.${"A".repeat(22)}/x.html`, "a", "b")).toBe("/r/a/b/x.html");
    expect(safeNext(`/r/a/b/v/2/~s.abc.${"0".repeat(16)}.${"A".repeat(22)}/`, "a", "b")).toBe("/r/a/b/v/2/");
    expect(safeNext(`/r/a/b/~p.abc.${"A".repeat(22)}`, "a", "b")).toBe(p);
    expect(safeNext("/r/a/b/~notes/x.html", "a", "b")).toBe("/r/a/b/~notes/x.html");
    expect(safeNext("/r/a/c/", "a", "b")).toBe(p);
  });

  it("ignores unsafe redirect targets after unlocking", async () => {
    for (const next of ["https://evil.example/", "//evil.example/", `/r/${repo}/other/`, "/dashboard/"]) {
      const res = await unlock(repo, "secret", "open-sesame", freshIp(), next);
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe(`/r/${repo}/secret/`);
    }
  });

  it("invalidates unlock cookies when the password rotates", async () => {
    const ok = await unlock(repo, "secret", "open-sesame");
    const cookie = ok.headers.get("set-cookie")!.split(";")[0]!;
    expect((await fetchApp(`/r/${repo}/secret/`, { headers: { cookie } })).status).toBe(200);
    await publish(key, repo, "secret", { "index.html": "classified v2" }, { replace: true, password: "new-password" });
    expect((await fetchApp(`/r/${repo}/secret/`, { headers: { cookie } })).status).toBe(401);
    const fresh = await unlock(repo, "secret", "new-password");
    const newCookie = fresh.headers.get("set-cookie")!.split(";")[0]!;
    expect(await (await fetchApp(`/r/${repo}/secret/`, { headers: { cookie: newCookie } })).text()).toBe("classified v2");
  });

  it("rejects tampered cookies", async () => {
    const res = await fetchApp(`/r/${repo}/secret/`, { headers: { cookie: `maradocs_pw_${repo}__secret=${"0".repeat(64)}` } });
    expect(res.status).toBe(401);
  });

  it("rate limits unlock attempts to 10 per 15 minutes per client and password", async () => {
    const ip = freshIp();
    for (let i = 0; i < 10; i += 1) expect((await unlock(repo, "other", "bad", ip)).status).toBe(401);
    const limited = await unlock(repo, "other", "open-sesame", ip);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toMatch(/^\d+$/);
    expect(await limited.text()).toContain("Too many attempts");
    // A document with its own password is a different secret, so it has its own budget.
    expect((await unlock(repo, "secret", "bad", ip)).status).toBe(401);
  });

  it("shares one budget across every document guarded by the same repository password", async () => {
    const shared = uniqueSlug("sharedpw");
    await createRepo(key, shared, { access: "password", password: "1234" });
    await publish(key, shared, "a", { "index.html": "a" });
    await publish(key, shared, "b", { "index.html": "b" });
    const ip = freshIp();
    for (let i = 0; i < 10; i += 1) expect((await unlock(shared, "a", "wrong", ip)).status).toBe(401);
    expect((await unlock(shared, "a", "wrong", ip)).status).toBe(429);
    expect((await unlock(shared, "b", "wrong", ip)).status).toBe(429);
    expect((await unlock(shared, "b", "1234", ip)).status).toBe(429);
  });

  it("treats a whole IPv6 /64 as one client", async () => {
    const pwRepo = uniqueSlug("v6");
    await createRepo(key, pwRepo, { access: "password", password: "v6-pass" });
    await publish(key, pwRepo, "doc", { "index.html": "x" });
    const prefix = `2001:db8:${Math.floor(Math.random() * 0xffff).toString(16)}:1`;
    for (let i = 1; i <= 10; i += 1) expect((await unlock(pwRepo, "doc", "wrong", `${prefix}::${i.toString(16)}`)).status).toBe(401);
    expect((await unlock(pwRepo, "doc", "wrong", `${prefix}:0:0:0:ffff`)).status).toBe(429);
    // Another /64 is another client.
    expect((await unlock(pwRepo, "doc", "wrong", `${prefix.replace(/:1$/, ":2")}::1`)).status).toBe(401);
  });

  it("enforces a failure ceiling per password across all networks", async () => {
    const pwRepo = uniqueSlug("glob");
    await createRepo(key, pwRepo, { access: "password", password: "global-pass" });
    await publish(key, pwRepo, "doc", { "index.html": "x" });
    const row = await env.DB.prepare(`SELECT password_hash FROM repositories WHERE slug = ?`).bind(pwRepo).first<{ password_hash: string }>();
    const secretId = (await sha256Hex(passwordBinding(row!.password_hash))).slice(0, 24);
    await env.DB.prepare(`INSERT INTO rate_limits (key, count, reset_at) VALUES (?, 100, ?)`)
      .bind(`unlock:global:${secretId}`, Date.now() + 60_000)
      .run();
    const res = await unlock(pwRepo, "doc", "global-pass", freshIp());
    expect(res.status).toBe(429);
  });

  it("audits unlock successes, failures and the first rate-limited attempt", async () => {
    const pwRepo = uniqueSlug("audpw");
    await createRepo(key, pwRepo, { access: "password", password: "audit-pass" });
    await publish(key, pwRepo, "doc", { "index.html": "x" });
    const ip = freshIp();
    for (let i = 0; i < 12; i += 1) await unlock(pwRepo, "doc", "nope", ip);
    expect((await unlock(pwRepo, "doc", "audit-pass")).status).toBe(303);
    const events = await waitFor(async () => {
      const list = await auditEvents({ repo: pwRepo });
      return list.includes("report.unlock") && list.filter((e) => e === "report.unlock_failed").length === 10 ? list : null;
    });
    expect(events.filter((e) => e === "report.unlock_failed")).toHaveLength(10);
    expect(events.filter((e) => e === "auth.rate_limited")).toHaveLength(1);
    expect(events.filter((e) => e === "report.unlock")).toHaveLength(1);
  });

  it("moves a stored password to the configured cost on unlock without invalidating cookies", async () => {
    const pwRepo = uniqueSlug("rehash");
    await createRepo(key, pwRepo);
    await publish(key, pwRepo, "doc", { "index.html": "rehashed" }, { access: "password", password: "rehash-pass" });
    const before = await env.DB.prepare(
      `SELECT d.id, d.password_hash FROM documents d JOIN repositories r ON r.id = d.repository_id WHERE r.slug = ?`,
    )
      .bind(pwRepo)
      .first<{ id: string; password_hash: string }>();
    const old = await rehashPassword("rehash-pass", before!.password_hash, 20_000);
    await env.DB.prepare(`UPDATE documents SET password_hash = ? WHERE id = ?`).bind(old, before!.id).run();
    const ok = await unlock(pwRepo, "doc", "rehash-pass");
    expect(ok.status).toBe(303);
    const cookie = ok.headers.get("set-cookie")!.split(";")[0]!;
    const after = await waitFor(async () => {
      const row = await env.DB.prepare(`SELECT password_hash FROM documents WHERE id = ?`).bind(before!.id).first<{ password_hash: string }>();
      return row && passwordHashIterations(row.password_hash) === 10_000 ? row.password_hash : null;
    });
    expect(passwordBinding(after)).toBe(passwordBinding(old));
    expect(await (await fetchApp(`/r/${pwRepo}/doc/`, { headers: { cookie } })).text()).toBe("rehashed");
  });

  it("lets admins and API keys through without unlocking", async () => {
    expect((await fetchApp(`/r/${repo}/other/`, { headers: { cookie: session.cookie } })).status).toBe(200);
    expect((await fetchApp(`/r/${repo}/other/`, { headers: bearer(key) })).status).toBe(200);
  });

  it("uses the repository password when the doc has none", async () => {
    const pwRepo = uniqueSlug("repopw");
    await createRepo(key, pwRepo, { access: "password", password: "repo-pass" });
    await publish(key, pwRepo, "doc", { "index.html": "inherited" });
    expect((await fetchApp(`/r/${pwRepo}/doc/`)).status).toBe(401);
    const ok = await unlock(pwRepo, "doc", "repo-pass");
    expect(ok.status).toBe(303);
    const cookie = ok.headers.get("set-cookie")!.split(";")[0]!;
    expect(await (await fetchApp(`/r/${pwRepo}/doc/`, { headers: { cookie } })).text()).toBe("inherited");
  });
});

describe("private reports", () => {
  let repo: string;
  beforeAll(async () => {
    repo = uniqueSlug("priv");
    await createRepo(key, repo, { access: "private" });
    await publish(key, repo, "doc", { "index.html": "private stuff" });
  });

  it("shows a sign-in page (401) linking to the dashboard login with next", async () => {
    const res = await fetchApp(`/r/${repo}/doc/`);
    expect(res.status).toBe(401);
    const html = await res.text();
    expect(html).toContain(`/dashboard/login?next=${encodeURIComponent(`/r/${repo}/doc/`)}`);
    expect(html).not.toContain("private stuff");
  });

  it("serves to admin sessions via cookie or Bearer", async () => {
    const viaCookie = await fetchApp(`/r/${repo}/doc/`, { headers: { cookie: session.cookie } });
    expect(viaCookie.status).toBe(200);
    expect(await viaCookie.text()).toBe("private stuff");
    expect(viaCookie.headers.get("cache-control")).toBe("private, no-store");
    expect((await fetchApp(`/r/${repo}/doc/`, { headers: bearer(session.token) })).status).toBe(200);
  });

  it("serves to API keys with read, publish or admin scope", async () => {
    for (const scopes of [["read"], ["publish"], ["admin"]]) {
      const k = await createApiKey(session.token, scopes);
      const res = await fetchApp(`/r/${repo}/doc/`, { headers: bearer(k) });
      expect(res.status, scopes.join()).toBe(200);
      await res.arrayBuffer();
    }
  });

  it("rejects invalid credentials", async () => {
    expect((await fetchApp(`/r/${repo}/doc/`, { headers: bearer("mdo_invalid") })).status).toBe(401);
    expect((await fetchApp(`/r/${repo}/doc/`, { headers: { cookie: "maradocs_session=forged" } })).status).toBe(401);
  });

  it("does not leak existence of files to anonymous users", async () => {
    expect((await fetchApp(`/r/${repo}/doc/missing.html`)).status).toBe(401);
  });

  it("follows access changes immediately (doc override over repo default)", async () => {
    const doc = uniqueSlug("flip");
    await publish(key, repo, doc, { "index.html": "now public" }, { access: "public" });
    expect((await fetchApp(`/r/${repo}/${doc}/`)).status).toBe(200);
    await machineJson(key, "PATCH", `/repos/${repo}`, { access: "public" });
    await machineJson(key, "PATCH", `/repos/${repo}`, { access: "private" });
    expect((await fetchApp(`/r/${repo}/${doc}/`)).status).toBe(200);
    expect((await fetchApp(`/r/${repo}/doc/`)).status).toBe(401);
  });
});

describe("repository index", () => {
  it("lists only public documents when enabled", async () => {
    const repo = uniqueSlug("idx");
    await createRepo(key, repo, { indexEnabled: true, name: "My <Reports>", description: "All the things" });
    await publish(key, repo, "visible", { "index.html": "v" }, { title: "Visible Doc" });
    await publish(key, repo, "hidden", { "index.html": "h" }, { title: "Hidden Doc", access: "private" });
    const res = await fetchApp(`/r/${repo}/`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Visible Doc");
    expect(html).toContain(`/r/${repo}/visible/`);
    expect(html).not.toContain("Hidden Doc");
    expect(html).toContain("My &lt;Reports&gt;");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
  });

  it("is a 404 when disabled", async () => {
    const repo = uniqueSlug("noidx");
    await createRepo(key, repo);
    expect((await fetchApp(`/r/${repo}/`)).status).toBe(404);
  });
});

describe("documents without versions", () => {
  it("returns JSON errors on the API and HTML on the read surface", async () => {
    const repo = uniqueSlug("err");
    await createRepo(key, repo);
    const api = await machineJson(key, "GET", `/repos/${repo}/docs/none/versions`);
    expect(api.status).toBe(404);
    expect(await json(api)).toMatchObject({ error: "not_found", message: `Document '${repo}/none' not found` });
  });
});
