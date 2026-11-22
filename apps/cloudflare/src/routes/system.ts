import { Hono } from "hono";
import { cloudflareOpenapiSpec } from "../openapi-cf.js";
import { APP_VERSION } from "../env.js";
import type { AppEnv } from "../types.js";

export const systemRoutes = new Hono<AppEnv>();

systemRoutes.get("/", (c) => c.redirect("/dashboard/", 302));

// `configured` is always true: accounts need no secrets (the first visitor
// creates the owner account; see GET /api/v1/auth/config). Kept for clients
// that check it.
systemRoutes.get("/health", (c) =>
  c.json({
    status: "ok",
    service: "maradocs",
    runtime: "cloudflare",
    configured: true,
    time: new Date().toISOString(),
  }),
);

systemRoutes.get("/api/v1/openapi.json", (c) => c.json(cloudflareOpenapiSpec));

systemRoutes.get("/api/v1/public-config", (c) =>
  c.json({ defaultRepoAccess: c.get("config").defaultRepoAccess, configured: true, version: APP_VERSION }),
);
