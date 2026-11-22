// Capability path tokens for protected reports (services/reportToken.ts):
// cookie-authenticated document navigations are redirected to a URL carrying
// a short-lived token, which then authorises the report's subresource
// requests (which browsers send without cookies from the sandboxed,
// opaque-origin report) — but never a document navigation.
import { beforeAll, describe, expect, it } from "vitest";
import { passwordBinding } from "../src/crypto";
import { REPORT_TOKEN_TTL_SECONDS, mintReportToken } from "../src/services/reportToken";
import {
  bearer,
  browser,
  createApiKey,
  createRepo,
  env,
  fetchApp,
  freshIp,
  login,
  machineJson,
  publish,
  uniqueSlug,
} from "./helpers";

const NAV = { "sec-fetch-mode": "navigate", "sec-fetch-dest": "document", "sec-fetch-site": "none", "sec-fetch-user": "?1" };
const IFRAME = { "sec-fetch-mode": "navigate", "sec-fetch-dest": "iframe", "sec-fetch-site": "same-origin" };
const STYLE = { "sec-fetch-mode": "no-cors", "sec-fetch-dest": "style", "sec-fetch-site": "cross-site" };
const IMAGE = { "sec-fetch-mode": "no-cors", "sec-fetch-dest": "image", "sec-fetch-site": "cross-site" };
const MODULE = { "sec-fetch-mode": "cors", "sec-fetch-dest": "script", "sec-fetch-site": "cross-site" };
const FETCH = { "sec-fetch-mode": "cors", "sec-fetch-dest": "empty", "sec-fetch-site": "cross-site" };

const FILES = {
  "index.html": '<link rel="stylesheet" href="css/site.css"><script type="module" src="js/app.js"></script>',
  "css/site.css": "body{color:teal}",
  "js/app.js": "fetch('data.json')",
  "data.json": "[1,2,3]",
  "sub/index.html": '<link rel="stylesheet" href="../css/site.css">',
  "sub/page.html": "page",
};

let session: { token: string; cookie: string };
let key: string;

beforeAll(async () => {
  session = await login();
  key = await createApiKey(session.token, ["publish"]);
});

async function unlockCookie(repo: string, doc: string, password: string): Promise<string> {
  const res = await fetchApp(`/r/${repo}/${doc}/__unlock`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": freshIp() },
    body: new URLSearchParams({ password }),
  });
  expect(res.status).toBe(303);
  return res.headers.get("set-cookie")!.split(";")[0]!;
}

/** Follow a mint redirect: returns the token URL path (with trailing path and query). */
async function mint(path: string, headers: Record<string, string>): Promise<string> {
  const res = await fetchApp(path, { headers });
  expect(res.status, await res.clone().text()).toBe(302);
  expect(res.headers.get("cache-control")).toBe("no-store");
  expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  return res.headers.get("location")!;
}

function tokenOf(location: string): string {
  const match = /\/(~[ps]\.[^/]+)\//.exec(location);
  expect(match, location).not.toBeNull();
  return match![1]!;
}

async function cookieSecret(): Promise<string> {
  const row = await env.DB.prepare(`SELECT value FROM settings WHERE key = 'cookie_secret'`).first<{ value: string }>();
  return row!.value;
}

async function docRow(repo: string, doc: string): Promise<{ id: string; hash: string | null }> {
  const row = await env.DB.prepare(
    `SELECT d.id, COALESCE(d.password_hash, r.password_hash) AS hash FROM documents d
     JOIN repositories r ON r.id = d.repository_id WHERE r.slug = ? AND d.slug = ?`,
  )
    .bind(repo, doc)
    .first<{ id: string; hash: string | null }>();
  return row!;
}

describe("password reports: minting and using ~p tokens", () => {
  let repo: string;
  let cookie: string;
  beforeAll(async () => {
    repo = uniqueSlug("tok");
    await createRepo(key, repo);
    await publish(key, repo, "locked", FILES, { access: "password", password: "token-pass-1" });
    cookie = await unlockCookie(repo, "locked", "token-pass-1");
  });

  it("redirects a cookie-authenticated document navigation to a token URL (path and query kept)", async () => {
    const location = await mint(`/r/${repo}/locked/sub/page.html?x=1&y=%2F`, { cookie, ...NAV });
    expect(location).toMatch(new RegExp(`^/r/${repo}/locked/~p\\.[0-9a-z]{1,8}\\.[A-Za-z0-9_-]{22}/sub/page\\.html\\?x=1&y=%2F$`));
    // Iframes (the dashboard preview) are minted the same way.
    const framed = await mint(`/r/${repo}/locked/`, { cookie, ...IFRAME });
    expect(framed).toMatch(new RegExp(`^/r/${repo}/locked/~p\\.`));
    // HEAD navigations too.
    const head = await fetchApp(`/r/${repo}/locked/`, { method: "HEAD", headers: { cookie, ...NAV } });
    expect(head.status).toBe(302);
  });

  it("serves the token URL to the cookie holder without minting again", async () => {
    const location = await mint(`/r/${repo}/locked/`, { cookie, ...NAV });
    const page = await fetchApp(location, { headers: { cookie, ...NAV } });
    expect(page.status).toBe(200);
    expect(await page.text()).toBe(FILES["index.html"]);
    expect(page.headers.get("cache-control")).toBe("private, no-store");
    expect(page.headers.get("referrer-policy")).toBe("no-referrer");
    expect(page.headers.get("vary")).toBe("cookie, authorization");
    expect(page.headers.get("content-security-policy")).toContain("sandbox");
  });

  it("authorises subresource requests without any cookie, and relative URLs resolve under the token", async () => {
    const location = await mint(`/r/${repo}/locked/`, { cookie, ...NAV });
    const base = `https://maradocs.test${location}`;
    const cases: [string, Record<string, string>, string][] = [
      ["css/site.css", STYLE, FILES["css/site.css"]],
      ["js/app.js", MODULE, FILES["js/app.js"]],
      ["data.json", FETCH, FILES["data.json"]],
    ];
    for (const [rel, headers, body] of cases) {
      const target = new URL(rel, base);
      expect(target.pathname.startsWith(location)).toBe(true);
      const res = await fetchApp(target.pathname, { headers });
      expect(res.status, rel).toBe(200);
      expect(await res.text(), rel).toBe(body);
      expect(res.headers.get("access-control-allow-origin"), rel).toBe("*");
      expect(res.headers.get("access-control-allow-credentials"), rel).toBeNull();
      expect(res.headers.get("cache-control"), rel).toBe("private, no-store");
    }
    // "../" from a nested page stays inside the token prefix.
    const nested = new URL("../css/site.css", `${base}sub/index.html`);
    expect(nested.pathname).toBe(`${location}css/site.css`);
    expect((await fetchApp(nested.pathname, { headers: STYLE })).status).toBe(200);
  });

  it("ignores the token for document navigations (gate page with a token-free next)", async () => {
    const location = await mint(`/r/${repo}/locked/sub/page.html`, { cookie, ...NAV });
    for (const headers of [NAV, IFRAME, { "sec-fetch-mode": "navigate", "sec-fetch-dest": "embed" }]) {
      const res = await fetchApp(location, { headers });
      expect(res.status).toBe(401);
      const html = await res.text();
      expect(html).toContain(`action="/r/${repo}/locked/__unlock"`);
      expect(html).toContain(`value="/r/${repo}/locked/sub/page.html"`);
      expect(html).not.toContain("~p.");
    }
    // A user-activated request counts as a navigation even if it claims another destination.
    expect((await fetchApp(location, { headers: { ...STYLE, "sec-fetch-user": "?1" } })).status).toBe(401);
  });

  it("treats requests without Sec-Fetch metadata as navigations (token not accepted)", async () => {
    const location = await mint(`/r/${repo}/locked/`, { cookie, ...NAV });
    const res = await fetchApp(`${location}css/site.css`);
    expect(res.status).toBe(401);
    // Partial metadata is not enough either.
    expect((await fetchApp(`${location}css/site.css`, { headers: { "sec-fetch-mode": "no-cors" } })).status).toBe(401);
  });

  it("answers unauthorised subresource requests with a plain 401", async () => {
    const res = await fetchApp(`/r/${repo}/locked/css/site.css`, { headers: STYLE });
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.text()).not.toContain("<html");
  });

  it("rejects forged tokens and tokens of another document", async () => {
    const location = await mint(`/r/${repo}/locked/`, { cookie, ...NAV });
    const token = tokenOf(location);
    const forged = token.slice(0, -2) + (token.endsWith("AA") ? "BB" : "AA");
    expect((await fetchApp(`/r/${repo}/locked/${forged}/css/site.css`, { headers: STYLE })).status).toBe(401);
    await publish(key, repo, "sibling", FILES, { access: "password", password: "token-pass-1" });
    expect((await fetchApp(`/r/${repo}/sibling/${token}/css/site.css`, { headers: STYLE })).status).toBe(401);
  });

  it("re-mints an expired token on navigation and rejects it for subresources", async () => {
    const { id, hash } = await docRow(repo, "locked");
    const secret = await cookieSecret();
    const now = Math.floor(Date.now() / 1000);
    const ctx = { docId: id, repo, doc: "locked", scope: "latest", binding: passwordBinding(hash!) };
    const expired = await mintReportToken(secret, "p", ctx, now - REPORT_TOKEN_TTL_SECONDS - 5);
    expect((await fetchApp(`/r/${repo}/locked/${expired}/css/site.css`, { headers: STYLE })).status).toBe(401);
    const location = await mint(`/r/${repo}/locked/${expired}/sub/page.html`, { cookie, ...NAV });
    expect(tokenOf(location)).not.toBe(expired);
    expect(location.endsWith("/sub/page.html")).toBe(true);
    expect((await fetchApp(location.replace("sub/page.html", "css/site.css"), { headers: STYLE })).status).toBe(200);

    // A valid token past half its lifetime still works for subresources but is refreshed on navigation.
    const stale = await mintReportToken(secret, "p", ctx, now - REPORT_TOKEN_TTL_SECONDS * 0.75);
    expect((await fetchApp(`/r/${repo}/locked/${stale}/css/site.css`, { headers: STYLE })).status).toBe(200);
    expect(tokenOf(await mint(`/r/${repo}/locked/${stale}/`, { cookie, ...NAV }))).not.toBe(stale);

    // Expiry too far in the future (beyond TTL + skew) is rejected.
    const future = await mintReportToken(secret, "p", ctx, now + 3600);
    expect((await fetchApp(`/r/${repo}/locked/${future}/css/site.css`, { headers: STYLE })).status).toBe(401);
  });

  it("returns 404 for non-GET methods on token paths", async () => {
    const location = await mint(`/r/${repo}/locked/`, { cookie, ...NAV });
    const res = await fetchApp(`${location}css/site.css`, { method: "POST", headers: STYLE, body: "x" });
    expect(res.status).toBe(404);
    const put = await fetchApp(`${location}css/site.css`, { method: "PUT", headers: STYLE, body: "x" });
    expect(put.status).toBe(404);
  });

  it("redirects a bare token path to its slash form", async () => {
    const location = await mint(`/r/${repo}/locked/`, { cookie, ...NAV });
    const token = tokenOf(location);
    const res = await fetchApp(`/r/${repo}/locked/${token}`, { headers: STYLE });
    expect(res.status).toBe(308);
    expect(res.headers.get("location")).toBe(`/r/${repo}/locked/${token}/`);
  });

  it("keeps the token when redirecting a directory path", async () => {
    const location = await mint(`/r/${repo}/locked/`, { cookie, ...NAV });
    const res = await fetchApp(`${location}sub`, { headers: STYLE });
    expect(res.status).toBe(308);
    expect(res.headers.get("location")).toBe(`${location}sub/`);
    // A navigation to a directory with only the cookie mints and adds the slash in one hop.
    const nav = await mint(`/r/${repo}/locked/sub?z=1`, { cookie, ...NAV });
    expect(nav).toMatch(new RegExp(`/~p\\.[^/]+/sub/\\?z=1$`));
  });

  it("strips tokens from the post-unlock redirect target", async () => {
    const location = await mint(`/r/${repo}/locked/sub/page.html`, { cookie, ...NAV });
    const res = await fetchApp(`/r/${repo}/locked/__unlock`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": freshIp() },
      body: new URLSearchParams({ password: "token-pass-1", next: location }),
    });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/r/${repo}/locked/sub/page.html`);
  });
});

describe("token scope: latest vs pinned versions", () => {
  it("binds tokens to the version scope they were minted for", async () => {
    const repo = uniqueSlug("tokv");
    await createRepo(key, repo);
    await publish(key, repo, "doc", { "index.html": "v1", "a.css": "one" }, { access: "password", password: "token-pass-2" });
    await publish(key, repo, "doc", { "index.html": "v2", "a.css": "two" }, { replace: true });
    const cookie = await unlockCookie(repo, "doc", "token-pass-2");

    const latest = await mint(`/r/${repo}/doc/`, { cookie, ...NAV });
    const pinned = await mint(`/r/${repo}/doc/v/1/`, { cookie, ...NAV });
    expect(pinned).toMatch(new RegExp(`^/r/${repo}/doc/v/1/~p\\.`));
    expect(await (await fetchApp(`${pinned}a.css`, { headers: STYLE })).text()).toBe("one");
    expect(await (await fetchApp(`${latest}a.css`, { headers: STYLE })).text()).toBe("two");

    // A latest-scope token under /v/2/ (and a v1 token under /v/2/ or latest) is rejected.
    const latestToken = tokenOf(latest);
    const v1Token = tokenOf(pinned);
    expect((await fetchApp(`/r/${repo}/doc/v/2/${latestToken}/a.css`, { headers: STYLE })).status).toBe(401);
    expect((await fetchApp(`/r/${repo}/doc/v/2/${v1Token}/a.css`, { headers: STYLE })).status).toBe(401);
    expect((await fetchApp(`/r/${repo}/doc/${v1Token}/a.css`, { headers: STYLE })).status).toBe(401);
  });
});

describe("token revocation", () => {
  async function setup(password = "token-pass-3") {
    const repo = uniqueSlug("tokr");
    await createRepo(key, repo);
    await publish(key, repo, "doc", FILES, { access: "password", password });
    const cookie = await unlockCookie(repo, "doc", password);
    const location = await mint(`/r/${repo}/doc/`, { cookie, ...NAV });
    const asset = `${location}css/site.css`;
    expect((await fetchApp(asset, { headers: STYLE })).status).toBe(200);
    return { repo, asset, location };
  }

  it("dies when the password rotates", async () => {
    const { repo, asset } = await setup();
    await publish(key, repo, "doc", FILES, { replace: true, password: "token-pass-rotated" });
    expect((await fetchApp(asset, { headers: STYLE })).status).toBe(401);
  });

  it("dies when access changes to private", async () => {
    const { repo, asset } = await setup();
    const res = await fetchApp(`/api/v1/dashboard/repos/${repo}/docs/doc`, {
      method: "PATCH",
      headers: browser(session.cookie, { "content-type": "application/json" }),
      body: JSON.stringify({ access: "private" }),
    });
    expect(res.status).toBe(200);
    expect((await fetchApp(asset, { headers: STYLE })).status).toBe(401);
  });

  it("dies when the document is deleted and recreated", async () => {
    const { repo, asset } = await setup();
    expect((await machineJson(key, "DELETE", `/repos/${repo}/docs/doc`)).status).toBe(200);
    await publish(key, repo, "doc", FILES, { access: "password", password: "token-pass-3" });
    expect((await fetchApp(asset, { headers: STYLE })).status).toBe(401);
  });

  it("survives a password rehash at a new iteration count (same salt)", async () => {
    const { repo, asset } = await setup();
    const { id, hash } = await docRow(repo, "doc");
    const { rehashPassword } = await import("../src/crypto");
    await env.DB.prepare(`UPDATE documents SET password_hash = ? WHERE id = ?`)
      .bind(await rehashPassword("token-pass-3", hash!, 20_000), id)
      .run();
    expect((await fetchApp(asset, { headers: STYLE })).status).toBe(200);
  });
});

describe("private reports: ~s tokens and the view cookie", () => {
  let repo: string;
  beforeAll(async () => {
    repo = uniqueSlug("toks");
    await createRepo(key, repo, { access: "private" });
    await publish(key, repo, "doc", FILES);
    await publish(key, repo, "doc", { ...FILES, "css/site.css": "v2" }, { replace: true });
  });

  it("mints session tokens that work for subresources until logout", async () => {
    const s = await login();
    const location = await mint(`/r/${repo}/doc/`, { cookie: s.cookie, ...NAV });
    expect(location).toMatch(new RegExp(`^/r/${repo}/doc/~s\\.[0-9a-z]{1,8}\\.[0-9a-f]{16}\\.[A-Za-z0-9_-]{22}/$`));
    expect(await (await fetchApp(`${location}css/site.css`, { headers: STYLE })).text()).toBe("v2");
    expect((await fetchApp(`${location}css/site.css`, { headers: IMAGE })).status).toBe(200);
    // Pinned versions get their own scope.
    const pinned = await mint(`/r/${repo}/doc/v/1/`, { cookie: s.cookie, ...NAV });
    expect(await (await fetchApp(`${pinned}css/site.css`, { headers: STYLE })).text()).toBe(FILES["css/site.css"]);
    // Navigations with the token alone get the sign-in page.
    const nav = await fetchApp(location, { headers: NAV });
    expect(nav.status).toBe(401);
    expect(await nav.text()).toContain(`/dashboard/login?next=${encodeURIComponent(`/r/${repo}/doc/`)}`);

    const out = await fetchApp("/api/v1/auth/logout", { method: "POST", headers: bearer(s.token) });
    expect(out.status).toBe(204);
    expect((await fetchApp(`${location}css/site.css`, { headers: STYLE })).status).toBe(401);
    expect((await fetchApp(`${pinned}css/site.css`, { headers: STYLE })).status).toBe(401);
  });

  it("dies when its session is deleted", async () => {
    const s = await login();
    const location = await mint(`/r/${repo}/doc/`, { cookie: s.cookie, ...NAV });
    expect((await fetchApp(`${location}css/site.css`, { headers: STYLE })).status).toBe(200);
    await env.DB.prepare(`DELETE FROM sessions WHERE token_hash >= ? AND token_hash < ?`)
      .bind(tokenOf(location).split(".")[2], `${tokenOf(location).split(".")[2]}g`)
      .run();
    expect((await fetchApp(`${location}css/site.css`, { headers: STYLE })).status).toBe(401);
  });

  it("sets a SameSite=None view cookie that serves absolute-path assets to the session viewer", async () => {
    const s = await login();
    const res = await fetchApp(`/r/${repo}/doc/`, { headers: { cookie: s.cookie, ...NAV } });
    expect(res.status).toBe(302);
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain(`maradocs_view_${repo}__doc=`);
    expect(setCookie).toContain(`Path=/r/${repo}/doc`);
    expect(setCookie).toContain("SameSite=None");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("HttpOnly");
    const view = setCookie.split(";")[0]!;
    // Without the (Lax) session cookie, e.g. a cross-site subresource request:
    const asset = await fetchApp(`/r/${repo}/doc/css/site.css`, { headers: { cookie: view, ...STYLE } });
    expect(asset.status).toBe(200);
    expect((await fetchApp(`/r/${repo}/doc/v/1/css/site.css`, { headers: { cookie: view, ...STYLE } })).status).toBe(200);
    // The view cookie is bound to the document.
    const other = view.replace(`__doc=`, `__other=`);
    expect((await fetchApp(`/r/${repo}/doc/css/site.css`, { headers: { cookie: other, ...STYLE } })).status).toBe(401);
    // ...and to the session.
    await fetchApp("/api/v1/auth/logout", { method: "POST", headers: bearer(s.token) });
    expect((await fetchApp(`/r/${repo}/doc/css/site.css`, { headers: { cookie: view, ...STYLE } })).status).toBe(401);
  });

  it("ignores tokens once a document becomes public (served as public content)", async () => {
    const s = await login();
    const doc = uniqueSlug("flip");
    await publish(key, repo, doc, FILES);
    const location = await mint(`/r/${repo}/${doc}/`, { cookie: s.cookie, ...NAV });
    await machineJson(key, "PATCH", `/repos/${repo}`, { access: "private" });
    const patched = await fetchApp(`/api/v1/dashboard/repos/${repo}/docs/${doc}`, {
      method: "PATCH",
      headers: browser(s.cookie, { "content-type": "application/json" }),
      body: JSON.stringify({ access: "public" }),
    });
    expect(patched.status).toBe(200);
    const res = await fetchApp(`${location}css/site.css`, { headers: STYLE });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=60");
  });
});

describe("requests that never mint", () => {
  it("leaves public documents on canonical, cacheable URLs", async () => {
    const repo = uniqueSlug("tokpub");
    await createRepo(key, repo);
    await publish(key, repo, "doc", FILES);
    const res = await fetchApp(`/r/${repo}/doc/`, { headers: { cookie: session.cookie, ...NAV } });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=60");
    expect(res.headers.get("set-cookie")).toBeNull();
    // A token-shaped segment on a public document is stripped and ignored.
    const bogus = `~p.zzzz.${"A".repeat(22)}`;
    expect(await (await fetchApp(`/r/${repo}/doc/${bogus}/css/site.css`, { headers: STYLE })).text()).toBe(FILES["css/site.css"]);
  });

  it("never redirects Authorization-header requests", async () => {
    const repo = uniqueSlug("tokhdr");
    await createRepo(key, repo, { access: "private" });
    await publish(key, repo, "doc", FILES);
    expect((await fetchApp(`/r/${repo}/doc/`, { headers: bearer(key, NAV) })).status).toBe(200);
    expect((await fetchApp(`/r/${repo}/doc/`, { headers: bearer(session.token, NAV) })).status).toBe(200);
  });

  it("does not mint for subresource requests or clients without Sec-Fetch metadata", async () => {
    const repo = uniqueSlug("toknm");
    await createRepo(key, repo, { access: "private" });
    await publish(key, repo, "doc", FILES);
    expect((await fetchApp(`/r/${repo}/doc/css/site.css`, { headers: { cookie: session.cookie, ...STYLE } })).status).toBe(200);
    expect((await fetchApp(`/r/${repo}/doc/`, { headers: { cookie: session.cookie } })).status).toBe(200);
  });
});
