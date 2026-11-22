import { Hono } from "hono";
import { ZodError } from "zod";
import { loadConfig } from "./env.js";
import { HttpError } from "./errors.js";
import { ensureSchema } from "./schema.js";
import { PAGE_CSP, errorPage as renderErrorPage, notFoundPage } from "./pages.js";
import { systemRoutes } from "./routes/system.js";
import { authRoutes } from "./routes/auth.js";
import { machineRoutes } from "./routes/machine.js";
import { dashboardRoutes } from "./routes/dashboard.js";
import { readRoutes } from "./routes/read.js";
import { spaRoutes } from "./routes/spa.js";
import type { AppContext, AppEnv } from "./types.js";

function isReadSurface(path: string): boolean {
  return path === "/r" || path.startsWith("/r/");
}

function isDashboardPath(path: string): boolean {
  return path === "/dashboard" || path.startsWith("/dashboard/");
}

function setIfMissing(headers: Headers, name: string, value: string): void {
  if (!headers.has(name)) headers.set(name, value);
}

function errorPage(c: AppContext, status: number, message: string): Response {
  const page = status === 404 ? notFoundPage(message) : renderErrorPage(status >= 500 ? "Something went wrong" : "Request failed", message);
  return c.body(page, status as 404, {
    "content-type": "text/html; charset=utf-8",
    "content-security-policy": PAGE_CSP,
    "cache-control": "private, no-store",
    "x-content-type-options": "nosniff",
  });
}

export function createApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.use("*", async (c, next) => {
    const config = loadConfig(c.env);
    c.set("config", config);
    const path = c.req.path;
    // A separate reports host serves reports only: no dashboard or API there,
    // so a report can never sit on the same address as the admin login.
    if (config.reportsOrigin && new URL(c.req.url).host === new URL(config.reportsOrigin).host) {
      if (!isReadSurface(path) && path !== "/health") {
        return errorPage(c, 404, "The page you are looking for does not exist.");
      }
    }
    // Static dashboard assets don't need the database.
    if (!isDashboardPath(path)) await ensureSchema(c.env.DB);
    await next();

    if (isReadSurface(path) || isDashboardPath(path)) return; // those routes set their own headers
    try {
      c.res.headers.set("x-content-type-options", "nosniff");
    } catch {
      c.res = new Response(c.res.body, c.res); // immutable headers (e.g. a fetched response)
    }
    const headers = c.res.headers;
    headers.set("x-content-type-options", "nosniff");
    setIfMissing(headers, "referrer-policy", "same-origin");
    setIfMissing(headers, "x-frame-options", "DENY");
    if (path.startsWith("/api/") || path === "/health") setIfMissing(headers, "cache-control", "no-store");
  });

  app.route("/", systemRoutes);
  app.route("/api/v1/auth", authRoutes);
  app.route("/api/v1/dashboard", dashboardRoutes);
  app.route("/api/v1", machineRoutes);
  app.route("/", readRoutes);
  app.route("/", spaRoutes);

  app.notFound((c) => {
    if (c.req.path.startsWith("/api/")) {
      return c.json({ error: "not_found", message: `Route ${c.req.method} ${c.req.path} not found` }, 404);
    }
    return errorPage(c, 404, "The page you are looking for does not exist.");
  });

  app.onError((err, c) => {
    const path = c.req.path;
    let status = 500;
    let body: { error: string; message: string; details?: unknown };
    let headers: Record<string, string> | undefined;
    if (err instanceof HttpError) {
      status = err.statusCode;
      body = { error: err.code, message: err.message, details: err.details };
      headers = err.headers;
    } else if (err instanceof ZodError) {
      status = 400;
      body = { error: "validation_error", message: "Request validation failed", details: err.issues };
    } else {
      console.error("Unhandled error", path, err);
      body = { error: "internal_error", message: "Internal server error" };
    }
    if (isReadSurface(path)) {
      return errorPage(c, status, status === 404 ? "Not found." : body.message);
    }
    const res = c.json(body, status as 500);
    if (headers) for (const [k, v] of Object.entries(headers)) res.headers.set(k, v);
    return res;
  });

  return app;
}

export const app = createApp();
