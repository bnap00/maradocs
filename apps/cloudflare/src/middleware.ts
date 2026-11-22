import type { MiddlewareHandler } from "hono";
import { forbidden, notFound, unauthorized } from "./errors.js";
import { sha256Hex } from "./crypto.js";
import { SESSION_COOKIE, defer, getCookie, isSafeMethod, isSameOriginRequest, setCookie } from "./http.js";
import { isValidSlug } from "./vendor/shared/index.js";
import {
  SESSION_TTL_MS,
  apiKeyLookupStmt,
  credentialFromHeader,
  hasScope,
  isApiKeyToken,
  machineFromRow,
  sessionExpired,
  sessionLookupStmt,
  sessionNeedsRefresh,
  sessionRefreshStmt,
  shouldTouch,
  touchApiKey,
  type ApiKeyLookupRow,
  type SessionUserRow,
} from "./services/auth.js";
import type { Actor, AppContext, AppEnv } from "./types.js";

/** Header the dashboard sends on every request; cookie-authenticated writes without it are refused (CSRF). */
export const CSRF_HEADER = "x-maradocs";

/**
 * Account session auth for the dashboard API, account and key management.
 * Accepts the session cookie (browser) or `Authorization: Bearer <session
 * token>` (CLI). Cookie-authenticated writes must be same-origin and carry
 * `x-maradocs: 1` (CSRF). Sessions slide: activity more than an hour after
 * the last refresh pushes the expiry to 30 days from now.
 */
export const requireSession: MiddlewareHandler<AppEnv> = async (c, next) => {
  const header = c.req.header("authorization");
  const viaCookie = !header;
  const token = header ? credentialFromHeader(header) : getCookie(c, SESSION_COOKIE);
  if (!token || isApiKeyToken(token)) throw unauthorized("Sign in required");
  if (viaCookie && !isSafeMethod(c.req.method)) {
    if (!isSameOriginRequest(c) || c.req.header(CSRF_HEADER) !== "1") {
      throw forbidden("Cross-site request blocked: the request origin does not match this server");
    }
  }
  const tokenHash = await sha256Hex(token);
  const db = c.env.DB;
  const session = await sessionLookupStmt(db, tokenHash).first<SessionUserRow>();
  if (!session) throw unauthorized("Invalid session");
  const now = Date.now();
  if (sessionExpired(session, now)) {
    defer(c, db.prepare(`DELETE FROM sessions WHERE token_hash = ?`).bind(tokenHash).run());
    throw unauthorized("Session expired. Sign in again.");
  }
  let expiresAt = session.expires_at;
  if (sessionNeedsRefresh(session, now)) {
    await sessionRefreshStmt(db, tokenHash, now).run();
    expiresAt = new Date(now + SESSION_TTL_MS).toISOString();
    if (viaCookie) setCookie(c, SESSION_COOKIE, token, { path: "/", maxAge: Math.floor(SESSION_TTL_MS / 1000) });
  }
  c.set("user", { type: "user", userId: session.user_id, email: session.email, createdAt: session.created_at });
  c.set("ownerId", session.user_id);
  c.set("sessionHash", tokenHash);
  c.set("sessionExpiresAt", expiresAt);
  await next();
};

/** API key auth for the machine API (`Authorization: Bearer mdo_…` or a bare key). */
export const requireMachine: MiddlewareHandler<AppEnv> = async (c, next) => {
  const token = credentialFromHeader(c.req.header("authorization"));
  if (!token) throw unauthorized("Missing API key");
  const row = await apiKeyLookupStmt(c.env.DB, await sha256Hex(token)).first<ApiKeyLookupRow>();
  if (!row) throw unauthorized("Invalid or expired API key");
  const machine = machineFromRow(row);
  if (!machine) {
    throw unauthorized(
      "This API key predates user accounts. Create your account in the dashboard (it adopts existing keys) and try again.",
    );
  }
  c.set("machine", machine);
  c.set("ownerId", machine.userId);
  if (shouldTouch(row.last_used_at)) defer(c, touchApiKey(c.env.DB, machine));
  await next();
};

/** The account the request acts for. */
export function ownerId(c: AppContext): string {
  const id = c.get("ownerId");
  if (!id) throw unauthorized();
  return id;
}

export function requireScope(scope: string): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const machine = c.get("machine");
    if (!machine) throw unauthorized();
    if (!hasScope(machine, scope)) throw forbidden(`API key missing required scope: ${scope}`);
    await next();
  };
}

export function requireAnyScope(...scopes: string[]): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const machine = c.get("machine");
    if (!machine) throw unauthorized();
    if (!hasScope(machine, ...scopes)) {
      throw forbidden(`API key missing required scope: one of ${scopes.join(", ")}`);
    }
    await next();
  };
}

export function machineActor(c: AppContext): Actor {
  const m = c.get("machine")!;
  return { type: "machine", id: m.apiKeyId, label: m.name, userId: m.userId };
}

export function userActor(c: AppContext): Actor {
  const u = c.get("user")!;
  return { type: "user", id: u.userId, label: u.email, userId: u.userId };
}

/** Route params must be valid slugs; anything else cannot exist, so it is a 404. */
export function repoParam(c: AppContext): string {
  const repo = c.req.param("repo") ?? "";
  if (!isValidSlug(repo)) throw notFound(`Repository '${repo}' not found`);
  return repo;
}

export function docParam(c: AppContext, repo: string): string {
  const doc = c.req.param("doc") ?? "";
  if (!isValidSlug(doc)) throw notFound(`Document '${repo}/${doc}' not found`);
  return doc;
}
