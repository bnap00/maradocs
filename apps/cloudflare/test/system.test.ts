import { describe, expect, it } from "vitest";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { app } from "../src/app";
import { ORIGIN, env, fetchApp, json } from "./helpers";

describe("system routes", () => {
  it("redirects / to the dashboard", async () => {
    const res = await fetchApp("/");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/dashboard/");
  });

  it("reports health with runtime and configured flag", async () => {
    const res = await fetchApp("/health");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await json(res);
    expect(body).toMatchObject({ status: "ok", service: "maradocs", runtime: "cloudflare", configured: true });
    expect(typeof body.time).toBe("string");
  });

  it("serves public config and the OpenAPI document", async () => {
    const cfg = await json(await fetchApp("/api/v1/public-config"));
    expect(cfg).toMatchObject({ defaultRepoAccess: "private", configured: true });
    expect(typeof cfg.version).toBe("string");
    const spec = await json(await fetchApp("/api/v1/openapi.json"));
    expect(spec.openapi).toMatch(/^3\./);
    expect(spec.paths["/api/v1/repos"]).toBeDefined();
  });

  it("returns JSON 404s under /api and HTML 404s elsewhere", async () => {
    const api = await fetchApp("/api/v1/nope");
    expect(api.status).toBe(404);
    expect(await json(api)).toMatchObject({ error: "not_found" });
    const page = await fetchApp("/nope");
    expect(page.status).toBe(404);
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(page.headers.get("content-security-policy")).toContain("default-src 'none'");
  });

  it("sets baseline security headers on API responses", async () => {
    const res = await fetchApp("/api/v1/public-config");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("referrer-policy")).toBe("same-origin");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("serves the dashboard (or its build hint) with a strict CSP and SPA fallback", async () => {
    const redirect = await fetchApp("/dashboard");
    expect(redirect.status).toBe(308);
    expect(redirect.headers.get("location")).toBe("/dashboard/");
    for (const path of ["/dashboard/", "/dashboard/repos/some-repo"]) {
      const res = await fetchApp(path);
      expect([200, 503]).toContain(res.status);
      expect(res.headers.get("content-type")).toContain("text/html");
      const csp = res.headers.get("content-security-policy") ?? "";
      expect(csp).toContain("default-src 'self'");
      expect(csp).toContain("script-src 'self'");
      expect(csp).toContain("frame-ancestors 'none'");
      expect(res.headers.get("x-frame-options")).toBe("DENY");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      await res.arrayBuffer();
    }
    const missingAsset = await fetchApp("/dashboard/assets/does-not-exist.js");
    expect(missingAsset.status).toBe(404);
    await missingAsset.arrayBuffer();
  });

  it("needs no secrets: /health reports configured without ADMIN_PASSWORD", async () => {
    const ctx = createExecutionContext();
    const res = await app.fetch(new Request(`${ORIGIN}/health`), { ...env, ADMIN_PASSWORD: "" }, ctx);
    await waitOnExecutionContext(ctx);
    expect(await json(res)).toMatchObject({ status: "ok", runtime: "cloudflare", configured: true });
    const cfg = await json(await fetchApp("/api/v1/public-config"));
    expect(cfg).toMatchObject({ defaultRepoAccess: "private", configured: true });
  });
});
