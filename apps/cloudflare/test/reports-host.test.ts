// REPORTS_HOST: reports on their own hostname, so a report (published with a
// lower-trust key) can never pose as the dashboard login on the same address.
import { beforeAll, describe, expect, it } from "vitest";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { app } from "../src/app";
import { loadConfig } from "../src/env";
import { mintReportToken, nowSeconds, HANDOFF_TOKEN_TTL_SECONDS } from "../src/services/reportToken";
import { sha256Hex } from "../src/crypto";
import { getCookieSecret } from "../src/db/settings";
import { createApiKey, createRepo, env, login, makeZip, publish, register, uniqueSlug, uploadForm, type Account } from "./helpers";

const DASHBOARD = "https://maradocs.test";
const REPORTS = "https://reports.maradocs.test";
const NAV = { "sec-fetch-mode": "navigate", "sec-fetch-dest": "document", "sec-fetch-site": "none" };
const STYLE = { "sec-fetch-mode": "no-cors", "sec-fetch-dest": "style", "sec-fetch-site": "cross-site" };

/** Call the app with REPORTS_HOST configured, as either host. */
async function call(origin: string, path: string, init: RequestInit = {}): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await app.fetch(
    new Request(`${origin}${path}`, { redirect: "manual", ...init }),
    { ...env, REPORTS_HOST: "reports.maradocs.test", PUBLIC_BASE_URL: DASHBOARD },
    ctx,
  );
  const body = await res.arrayBuffer();
  await waitOnExecutionContext(ctx);
  return new Response(res.status === 304 || res.status === 204 ? null : body, res);
}

let session: Account;
let key: string;
let repo: string;

beforeAll(async () => {
  session = await login();
  key = await createApiKey(session.token, ["publish"]);
  repo = uniqueSlug("rh");
  await createRepo(key, repo);
  await publish(key, repo, "open", { "index.html": "public report", "a.css": "a{}" });
  await publish(key, repo, "secret", { "index.html": "private report", "a.css": "s{}" }, { access: "private" });
});

describe("REPORTS_HOST", () => {
  it("needs PUBLIC_BASE_URL and a distinct host, otherwise it is ignored", () => {
    const base = { DB: env.DB, BUCKET: env.BUCKET };
    expect(loadConfig({ ...base, REPORTS_HOST: "reports.example.com" }).reportsOrigin).toBeNull();
    expect(loadConfig({ ...base, REPORTS_HOST: "docs.example.com", PUBLIC_BASE_URL: "https://docs.example.com" }).reportsOrigin).toBeNull();
    expect(loadConfig({ ...base, REPORTS_HOST: "reports.example.com", PUBLIC_BASE_URL: "https://docs.example.com" }).reportsOrigin).toBe(
      "https://reports.example.com",
    );
    expect(loadConfig({ ...base, REPORTS_HOST: "http://localhost:8788", PUBLIC_BASE_URL: "http://localhost:8787" }).reportsOrigin).toBe(
      "http://localhost:8788",
    );
  });

  it("serves only reports (and /health) on the reports host", async () => {
    expect(await (await call(REPORTS, `/r/${repo}/open/`)).text()).toBe("public report");
    expect((await call(REPORTS, "/health")).status).toBe(200);
    for (const path of ["/dashboard/", "/dashboard/login", "/api/v1/repos", "/api/v1/public-config", "/"]) {
      expect((await call(REPORTS, path)).status, path).toBe(404);
    }
    const login = await call(REPORTS, "/api/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "x" }),
    });
    expect(login.status).toBe(404);
  });

  it("redirects report URLs on the dashboard host to the reports host", async () => {
    const res = await call(DASHBOARD, `/r/${repo}/open/a.css?x=1`);
    expect(res.status).toBe(308);
    expect(res.headers.get("location")).toBe(`${REPORTS}/r/${repo}/open/a.css?x=1`);
    expect((await call(DASHBOARD, `/r/${repo}/open/__unlock`, { method: "POST" })).status).toBe(404);
  });

  it("links reports to the reports host in API responses", async () => {
    // Serialise the form so the request carries a Content-Length, as it does off the network.
    const form = new Response(uploadForm({ doc: "linked" }, makeZip({ "index.html": "l" })));
    const body = new Uint8Array(await form.arrayBuffer());
    const res = await call(DASHBOARD, `/api/v1/repos/${repo}/docs`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": form.headers.get("content-type")!,
        "content-length": String(body.byteLength),
      },
      body,
    });
    expect(res.status).toBe(201);
    const result = (await res.json()) as { url: string; versionUrl: string };
    expect(result.url).toBe(`${REPORTS}/r/${repo}/linked/`);
    expect(result.versionUrl).toBe(`${REPORTS}/r/${repo}/linked/v/1/`);
  });

  it("sends anonymous visitors of private reports to the dashboard to sign in", async () => {
    const res = await call(REPORTS, `/r/${repo}/secret/`, { headers: NAV });
    expect(res.status).toBe(401);
    expect(await res.text()).toContain(`${DASHBOARD}/dashboard/login?next=${encodeURIComponent(`/r/${repo}/secret/`)}`);
  });

  it("hands the signed-in owner over to the reports host without sharing the session cookie", async () => {
    // 1. After signing in, the dashboard opens /r/… on its own host.
    const first = await call(DASHBOARD, `/r/${repo}/secret/a.css`, { headers: { cookie: session.cookie, ...NAV } });
    expect(first.status).toBe(302);
    const handoff = new URL(first.headers.get("location")!);
    expect(handoff.origin).toBe(REPORTS);
    expect(handoff.pathname).toBe(`/r/${repo}/secret/__view`);
    expect(handoff.searchParams.get("next")).toBe(`/r/${repo}/secret/a.css`);
    expect(first.headers.get("cache-control")).toBe("no-store");

    // 2. The reports host exchanges the handoff token for its own view cookie.
    const exchange = await call(REPORTS, `${handoff.pathname}${handoff.search}`, { headers: NAV });
    expect(exchange.status).toBe(303);
    expect(exchange.headers.get("location")).toBe(`/r/${repo}/secret/a.css`);
    const setCookie = exchange.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain(`maradocs_view_${repo}__secret=`);
    expect(setCookie).toContain("SameSite=None");
    const view = setCookie.split(";")[0]!;

    // 3. The report opens on the reports host and its subresources load via a token URL.
    const nav = await call(REPORTS, `/r/${repo}/secret/`, { headers: { cookie: view, ...NAV } });
    expect(nav.status).toBe(302);
    const tokenUrl = nav.headers.get("location")!;
    expect(tokenUrl).toMatch(new RegExp(`^/r/${repo}/secret/~s\\.`));
    expect(await (await call(REPORTS, tokenUrl, { headers: { cookie: view, ...NAV } })).text()).toBe("private report");
    expect(await (await call(REPORTS, `${tokenUrl}a.css`, { headers: STYLE })).text()).toBe("s{}");

    // The handoff token is useless as a path token, and a forged one sets no cookie.
    const handoffToken = handoff.searchParams.get("t")!;
    expect((await call(REPORTS, `/r/${repo}/secret/${handoffToken}/a.css`, { headers: STYLE })).status).toBe(401);
    const forged = await call(REPORTS, `/r/${repo}/secret/__view?t=${encodeURIComponent(handoffToken.slice(0, -2) + "AA")}&next=/r/${repo}/secret/`);
    expect(forged.status).toBe(303);
    expect(forged.headers.get("set-cookie")).toBeNull();
  });

  it("does not hand off public reports or anonymous visitors", async () => {
    const open = await call(DASHBOARD, `/r/${repo}/open/`, { headers: { cookie: session.cookie, ...NAV } });
    expect(open.status).toBe(308);
    const anon = await call(DASHBOARD, `/r/${repo}/secret/`, { headers: NAV });
    expect(anon.status).toBe(308);
    expect(anon.headers.get("location")).toBe(`${REPORTS}/r/${repo}/secret/`);
  });

  it("hands off only the repository's owner", async () => {
    const other = await register();
    // Another account's session on the dashboard host continues as an anonymous visitor.
    const res = await call(DASHBOARD, `/r/${repo}/secret/`, { headers: { cookie: other.cookie, ...NAV } });
    expect(res.status).toBe(308);
    expect(res.headers.get("location")).toBe(`${REPORTS}/r/${repo}/secret/`);

    // A handoff token bound to a non-owner's session (well-formed and correctly
    // signed) is refused by the reports host: no view cookie.
    const doc = await env.DB.prepare(
      `SELECT d.id FROM documents d JOIN repositories r ON r.id = d.repository_id WHERE r.slug = ? AND d.slug = 'secret'`,
    )
      .bind(repo)
      .first<{ id: string }>();
    const binding = await sha256Hex(other.token);
    const ctx = { docId: doc!.id, repo, doc: "secret", scope: "handoff", binding };
    const token = await mintReportToken(await getCookieSecret(env), "s", ctx, nowSeconds(), HANDOFF_TOKEN_TTL_SECONDS);
    const exchange = await call(REPORTS, `/r/${repo}/secret/__view?t=${encodeURIComponent(token)}&next=/r/${repo}/secret/`);
    expect(exchange.status).toBe(303);
    expect(exchange.headers.get("set-cookie")).toBeNull();
  });
});
