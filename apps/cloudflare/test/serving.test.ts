// HTTP semantics of the report read surface: CORS for opaque-origin reports,
// ranges, conditional requests, PDFs, and what anonymous callers can learn.
import { beforeAll, describe, expect, it } from "vitest";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { app } from "../src/app";
import { etagMatches, parseRange } from "../src/routes/read";
import { ORIGIN, bearer, createApiKey, createRepo, env, fetchApp, login, machineJson, publish, uniqueSlug } from "./helpers";

let session: { token: string; cookie: string };
let key: string;
let repo: string;
const VIDEO = new Uint8Array(1000).map((_, i) => i % 251);

beforeAll(async () => {
  session = await login();
  key = await createApiKey(session.token, ["publish"]);
  repo = uniqueSlug("serve");
  await createRepo(key, repo);
  await publish(key, repo, "site", {
    "index.html": "<h1>home</h1>",
    "media/clip.mp4": VIDEO,
    "fonts/a.woff2": "font",
    "report.pdf": "%PDF-1.4 test",
    "empty.txt": "",
  });
});

describe("CORS for sandboxed (opaque-origin) reports", () => {
  it("allows any origin to read public report files, never with credentials", async () => {
    for (const path of ["index.html", "fonts/a.woff2", "media/clip.mp4"]) {
      const res = await fetchApp(`/r/${repo}/site/${path}`, { headers: { origin: "null" } });
      expect(res.status, path).toBe(200);
      expect(res.headers.get("access-control-allow-origin"), path).toBe("*");
      expect(res.headers.get("access-control-allow-credentials"), path).toBeNull();
      await res.arrayBuffer();
    }
    const head = await fetchApp(`/r/${repo}/site/index.html`, { method: "HEAD" });
    expect(head.headers.get("access-control-allow-origin")).toBe("*");
    const etag = head.headers.get("etag")!;
    const notModified = await fetchApp(`/r/${repo}/site/index.html`, { headers: { "if-none-match": etag } });
    expect(notModified.status).toBe(304);
    expect(notModified.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("answers preflight requests on report paths", async () => {
    const res = await fetchApp(`/r/${repo}/site/fonts/a.woff2`, {
      method: "OPTIONS",
      headers: { origin: "null", "access-control-request-method": "GET", "access-control-request-headers": "range" },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-allow-methods")).toBe("GET, HEAD");
    expect(res.headers.get("access-control-allow-headers")).toContain("range");
    expect(res.headers.get("access-control-max-age")).toBe("600");
    expect(res.headers.get("access-control-allow-credentials")).toBeNull();
  });

  it("does not let cookie-authorised private content be read cross-origin", async () => {
    // ACAO is "*" without Allow-Credentials: browsers refuse credentialed reads of such responses.
    const priv = uniqueSlug("cors-priv");
    await createRepo(key, priv, { access: "private" });
    await publish(key, priv, "doc", { "index.html": "secret" });
    const res = await fetchApp(`/r/${priv}/doc/`, { headers: { cookie: session.cookie, origin: "null" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-allow-credentials")).toBeNull();
    expect(res.headers.get("vary")).toBe("cookie, authorization");
  });
});

describe("range requests", () => {
  it("serves single byte ranges with 206 and Content-Range", async () => {
    const url = `/r/${repo}/site/media/clip.mp4`;
    const full = await fetchApp(url);
    expect(full.headers.get("accept-ranges")).toBe("bytes");
    await full.arrayBuffer();
    const cases: [string, number, number][] = [
      ["bytes=0-1", 0, 1],
      ["bytes=10-19", 10, 19],
      ["bytes=990-", 990, 999],
      ["bytes=-5", 995, 999],
      ["bytes=995-5000", 995, 999],
    ];
    for (const [range, start, end] of cases) {
      const res = await fetchApp(url, { headers: { range } });
      expect(res.status, range).toBe(206);
      expect(res.headers.get("content-range"), range).toBe(`bytes ${start}-${end}/1000`);
      expect(res.headers.get("content-length"), range).toBe(String(end - start + 1));
      expect(res.headers.get("content-security-policy"), range).toContain("sandbox");
      expect(new Uint8Array(await res.arrayBuffer()), range).toEqual(VIDEO.slice(start, end + 1));
    }
  });

  it("returns 416 for unsatisfiable ranges and ignores multi-range or malformed headers", async () => {
    const url = `/r/${repo}/site/media/clip.mp4`;
    const bad = await fetchApp(url, { headers: { range: "bytes=1000-1001" } });
    expect(bad.status).toBe(416);
    expect(bad.headers.get("content-range")).toBe("bytes */1000");
    for (const range of ["bytes=0-1,5-6", "items=0-1", "bytes=9-3"]) {
      const res = await fetchApp(url, { headers: { range } });
      expect(res.status, range).toBe(200);
      expect((await res.arrayBuffer()).byteLength, range).toBe(1000);
    }
    expect((await fetchApp(`/r/${repo}/site/empty.txt`, { headers: { range: "bytes=0-1" } })).status).toBe(416);
  });

  it("honours If-Range against the ETag", async () => {
    const url = `/r/${repo}/site/media/clip.mp4`;
    const head = await fetchApp(url, { method: "HEAD" });
    const etag = head.headers.get("etag")!;
    const match = await fetchApp(url, { headers: { range: "bytes=0-1", "if-range": etag } });
    expect(match.status).toBe(206);
    await match.arrayBuffer();
    const stale = await fetchApp(url, { headers: { range: "bytes=0-1", "if-range": '"other"' } });
    expect(stale.status).toBe(200);
    await stale.arrayBuffer();
  });

  it("parses ranges correctly", () => {
    expect(parseRange(undefined, 10)).toEqual({ kind: "full" });
    expect(parseRange("bytes=-0", 10)).toEqual({ kind: "unsatisfiable" });
    expect(parseRange("bytes=-20", 10)).toEqual({ kind: "partial", start: 0, end: 9 });
    expect(parseRange("bytes=-", 10)).toEqual({ kind: "full" });
  });
});

describe("conditional requests", () => {
  it("compares ETags weakly and treats * as a match", async () => {
    const first = await fetchApp(`/r/${repo}/site/index.html`);
    const etag = first.headers.get("etag")!;
    await first.arrayBuffer();
    for (const header of [`W/${etag}`, "*", `"nope", W/${etag}`, etag]) {
      const res = await fetchApp(`/r/${repo}/site/index.html`, { headers: { "if-none-match": header } });
      expect(res.status, header).toBe(304);
    }
    const miss = await fetchApp(`/r/${repo}/site/index.html`, { headers: { "if-none-match": 'W/"other"' } });
    expect(miss.status).toBe(200);
    await miss.arrayBuffer();
    expect(etagMatches('W/"a"', '"a"')).toBe(true);
    expect(etagMatches('"b"', '"a"')).toBe(false);
  });
});

describe("PDFs", () => {
  it("are served as downloads by default (Chromium's viewer won't run in a sandbox)", async () => {
    const res = await fetchApp(`/r/${repo}/site/report.pdf`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toBe(`attachment; filename="report.pdf"; filename*=UTF-8''report.pdf`);
    expect(res.headers.get("content-security-policy")).toContain("sandbox");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    await res.arrayBuffer();
  });

  it("are served inline without the sandbox when PDF_INLINE is set", async () => {
    const call = async (path: string) => {
      const ctx = createExecutionContext();
      const res = await app.fetch(new Request(`${ORIGIN}${path}`), { ...env, PDF_INLINE: "true" }, ctx);
      const body = await res.text(); // drain before waiting: the body is piped via waitUntil
      await waitOnExecutionContext(ctx);
      return { res, body };
    };
    const { res, body } = await call(`/r/${repo}/site/report.pdf`);
    expect(res.status).toBe(200);
    expect(body).toBe("%PDF-1.4 test");
    expect(res.headers.get("content-disposition")).toBeNull();
    expect(res.headers.get("content-security-policy")).toBeNull();
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    // Other files keep the sandbox.
    const html = await call(`/r/${repo}/site/`);
    expect(html.res.headers.get("content-security-policy")).toContain("sandbox");
  });
});

describe("what anonymous visitors can learn", () => {
  it("does not reveal versions or publication state of protected documents before the gate", async () => {
    const priv = uniqueSlug("gate");
    await createRepo(key, priv, { access: "private" });
    await publish(key, priv, "plan", { "index.html": "1" });
    await publish(key, priv, "plan", { "index.html": "2" }, { replace: true });
    await publish(key, priv, "plan", { "index.html": "3" }, { replace: true });
    for (const path of ["v/3/", "v/4/", "v/999/", "missing.html"]) {
      const res = await fetchApp(`/r/${priv}/plan/${path}`);
      expect(res.status, path).toBe(401);
      await res.arrayBuffer();
    }
    // Callers past the gate still get precise errors.
    const missing = await fetchApp(`/r/${priv}/plan/v/4/`, { headers: bearer(session.token) });
    expect(missing.status).toBe(404);
    expect(await missing.text()).toContain("Version 4 not found.");

    const pw = uniqueSlug("gatepw");
    await createRepo(key, pw, { access: "password", password: "gate-pass" });
    await publish(key, pw, "doc", { "index.html": "x" });
    const res = await fetchApp(`/r/${pw}/doc/v/9/`);
    expect(res.status).toBe(401);
    expect(await res.text()).toContain("__unlock");
  });

  it("keeps private repository metadata off the public index", async () => {
    const secret = uniqueSlug("idxpriv");
    await createRepo(key, secret, { access: "private", indexEnabled: true, name: "Secret Merger Project", description: "Acquisition of X" });
    await publish(key, secret, "doc", { "index.html": "x" });
    const res = await fetchApp(`/r/${secret}/`);
    expect(res.status).toBe(404);
    const html = await res.text();
    expect(html).not.toContain("Secret Merger Project");
    expect(html).not.toContain("Acquisition of X");

    // Once it contains public documents, the index lists them.
    await publish(key, secret, "open", { "index.html": "o" }, { access: "public", title: "Open Doc" });
    const listed = await fetchApp(`/r/${secret}/`);
    expect(listed.status).toBe(200);
    expect(await listed.text()).toContain("Open Doc");

    const pwRepo = uniqueSlug("idxpw");
    await createRepo(key, pwRepo, { access: "password", password: "idx-pass", indexEnabled: true, name: "PW Repo" });
    expect((await fetchApp(`/r/${pwRepo}/`)).status).toBe(404);
    await machineJson(key, "PATCH", `/repos/${pwRepo}`, { access: "public" });
    expect((await fetchApp(`/r/${pwRepo}/`)).status).toBe(200);
  });
});
