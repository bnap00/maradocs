import type { z } from "zod";
import type { AppContext } from "./types.js";
import { badRequest } from "./errors.js";

export const SESSION_COOKIE = "maradocs_session";

/** True for plain-http loopback requests (wrangler dev), where `Secure` cookies would be dropped. */
export function isLocalHttp(url: URL): boolean {
  if (url.protocol !== "http:") return false;
  const host = url.hostname;
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host.endsWith(".localhost");
}

export function requestUrl(c: AppContext): URL {
  return new URL(c.req.url);
}

export function requestOrigin(c: AppContext): string {
  return requestUrl(c).origin;
}

/** Base URL for links in API responses: PUBLIC_BASE_URL wins over the request origin. */
export function baseUrl(c: AppContext): string {
  return c.get("config").publicBaseUrl ?? requestOrigin(c);
}

/** Base URL for report links: the REPORTS_HOST origin when configured, else baseUrl(). */
export function reportsBaseUrl(c: AppContext): string {
  return c.get("config").reportsOrigin ?? baseUrl(c);
}

export function clientIp(c: AppContext): string {
  return c.req.header("cf-connecting-ip")?.trim() || "unknown";
}

export function docUrl(base: string, repo: string, doc: string): string {
  return `${base}/r/${repo}/${doc}/`;
}

export function versionUrl(base: string, repo: string, doc: string, version: number): string {
  return `${base}/r/${repo}/${doc}/v/${version}/`;
}

// ---- Cookies -----------------------------------------------------------------

export function parseCookies(header: string | undefined | null): Map<string, string> {
  const out = new Map<string, string>();
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    if (!name || out.has(name)) continue;
    let value = part.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    try {
      out.set(name, decodeURIComponent(value));
    } catch {
      out.set(name, value);
    }
  }
  return out;
}

export function getCookie(c: AppContext, name: string): string | undefined {
  return parseCookies(c.req.header("cookie")).get(name);
}

export interface CookieOptions {
  path: string;
  maxAge?: number;
  httpOnly?: boolean;
  /** "None" forces `Secure` (browsers reject it otherwise; they accept Secure on http://localhost). */
  sameSite?: "Lax" | "Strict" | "None";
}

export function serializeCookie(
  c: AppContext,
  name: string,
  value: string,
  opts: CookieOptions,
): string {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${opts.path}`];
  if (opts.maxAge !== undefined) {
    parts.push(`Max-Age=${opts.maxAge}`);
    if (opts.maxAge <= 0) parts.push("Expires=Thu, 01 Jan 1970 00:00:00 GMT");
  }
  if (opts.httpOnly !== false) parts.push("HttpOnly");
  if (opts.sameSite === "None" || !isLocalHttp(requestUrl(c))) parts.push("Secure");
  parts.push(`SameSite=${opts.sameSite ?? "Lax"}`);
  return parts.join("; ");
}

export function setCookie(c: AppContext, name: string, value: string, opts: CookieOptions): void {
  c.header("set-cookie", serializeCookie(c, name, value, opts), { append: true });
}

export function clearCookie(c: AppContext, name: string, path: string): void {
  setCookie(c, name, "", { path, maxAge: 0 });
}

// ---- Request helpers ---------------------------------------------------------

/**
 * CSRF guard for cookie-authenticated, state-changing requests: the browser
 * must prove the request came from our own origin.
 */
export function isSameOriginRequest(c: AppContext): boolean {
  const origin = c.req.header("origin");
  const allowed = new Set([requestOrigin(c)]);
  const publicBase = c.get("config").publicBaseUrl;
  if (publicBase) {
    try {
      allowed.add(new URL(publicBase).origin);
    } catch {
      /* ignore malformed PUBLIC_BASE_URL */
    }
  }
  if (origin) return allowed.has(origin);
  return c.req.header("sec-fetch-site") === "same-origin";
}

export function isSafeMethod(method: string): boolean {
  return method === "GET" || method === "HEAD" || method === "OPTIONS";
}

/** Parse and validate a JSON body. Invalid JSON is a 400, schema failures a validation_error. */
export async function readJson<T extends z.ZodTypeAny>(c: AppContext, schema: T): Promise<z.infer<T>> {
  let body: unknown;
  const text = await c.req.text();
  if (text.trim() === "") {
    body = {};
  } else {
    try {
      body = JSON.parse(text);
    } catch {
      throw badRequest("Request body must be valid JSON");
    }
  }
  return schema.parse(body);
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) =>
    ch === "&" ? "&amp;" : ch === "<" ? "&lt;" : ch === ">" ? "&gt;" : ch === '"' ? "&quot;" : "&#39;",
  );
}

export const nowIso = (): string => new Date().toISOString();

/**
 * Run non-critical work after the response (ctx.waitUntil). Failures are
 * logged, never surfaced to the client.
 */
export function defer(c: AppContext, work: Promise<unknown>): void {
  const guarded = work.catch((err: unknown) => {
    console.error("background task failed", err);
  });
  try {
    c.executionCtx.waitUntil(guarded);
  } catch {
    // No ExecutionContext (e.g. app.request() in unit tests): let it run detached.
  }
}

/**
 * Keep the request's work alive until `work` settles even if the client
 * disconnects (Workers cancel a request's pending I/O otherwise). The caller
 * still awaits `work` and handles its result.
 */
export function keepAlive<T>(c: AppContext, work: Promise<T>): Promise<T> {
  try {
    c.executionCtx.waitUntil(work.catch(() => undefined));
  } catch {
    // No ExecutionContext (unit tests).
  }
  return work;
}
