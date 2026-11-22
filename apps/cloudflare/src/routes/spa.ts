// Dashboard SPA served from the ASSETS binding. wrangler.jsonc routes
// /dashboard/* through the Worker first (assets.run_worker_first) so every
// response gets the dashboard security headers, and unknown client-side
// routes fall back to index.html.

import { Hono } from "hono";
import { dashboardMissingPage } from "../pages.js";
import type { AppContext, AppEnv } from "../types.js";

export const DASHBOARD_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
  "connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'";

export function applyDashboardHeaders(headers: Headers): void {
  headers.set("content-security-policy", DASHBOARD_CSP);
  headers.set("x-frame-options", "DENY");
  headers.set("referrer-policy", "same-origin");
  headers.set("x-content-type-options", "nosniff");
}

/** Vite emits content-hashed file names under /dashboard/assets/, so they never change. */
const HASHED_ASSET = /^\/dashboard\/assets\/[^/]+-[A-Za-z0-9_-]{8,}\.[a-z0-9]+$/;

function withDashboardHeaders(res: Response, isHtml: boolean, pathname = ""): Response {
  const out = new Response(res.body, res);
  applyDashboardHeaders(out.headers);
  // HTML must revalidate so new deploys are picked up; content-hashed assets
  // are immutable. Everything else keeps the asset server's caching.
  if (isHtml) out.headers.set("cache-control", "no-cache");
  else if (res.status === 200 && HASHED_ASSET.test(pathname)) {
    out.headers.set("cache-control", "public, max-age=31536000, immutable");
  }
  return out;
}

function missing(c: AppContext): Response {
  const res = c.html(dashboardMissingPage(), 503);
  return withDashboardHeaders(res, true);
}

export const spaRoutes = new Hono<AppEnv>();

spaRoutes.get("/dashboard", (c) => c.redirect(`/dashboard/${new URL(c.req.url).search}`, 308));

spaRoutes.on(["GET", "HEAD"], "/dashboard/*", async (c) => {
  const assets = c.env.ASSETS;
  if (!assets) return missing(c);
  const url = new URL(c.req.url);
  let res = await assets.fetch(c.req.raw);
  const lastSegment = url.pathname.slice(url.pathname.lastIndexOf("/") + 1);
  const looksLikeFile = lastSegment.includes(".");
  if (res.status === 404 && !looksLikeFile) {
    // Client-side route: serve the SPA shell. Request "/dashboard/" (not
    // index.html) because the asset server redirects explicit index.html.
    const shell = new Request(new URL("/dashboard/", url), { method: c.req.method, headers: c.req.raw.headers });
    res = await assets.fetch(shell);
  }
  if (res.status === 404) {
    if (!looksLikeFile) return missing(c);
    return withDashboardHeaders(new Response("Not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } }), false);
  }
  const isHtml = (res.headers.get("content-type") ?? "").includes("text/html");
  return withDashboardHeaders(res, isHtml, url.pathname);
});
