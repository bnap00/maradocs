import type { FastifyReply, FastifyRequest } from "fastify";
import { HttpError, forbidden, unauthorized } from "../util/errors.js";
import type { AppContext } from "../context.js";
import { API_KEY_PREFIX, SESSION_COOKIE, SESSION_TTL_MS } from "./local.js";

export function bearer(req: FastifyRequest): string | null {
  const header = req.headers.authorization;
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (match) return match[1]!.trim();
  return header.trim() || null;
}

export interface SessionCredential {
  token: string;
  via: "bearer" | "cookie";
}

/**
 * Where a session credential comes from: a non-API-key bearer token (CLI) or
 * the session cookie (browser). `mdo_` tokens are API keys, never sessions.
 */
export function sessionCredential(req: FastifyRequest): SessionCredential | null {
  const token = bearer(req);
  if (token && !token.startsWith(API_KEY_PREFIX)) return { token, via: "bearer" };
  const cookie = req.cookies?.[SESSION_COOKIE];
  if (cookie) return { token: cookie, via: "cookie" };
  return null;
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Cookie-authenticated unsafe requests must carry `x-maradocs: 1` (CSRF defence). */
export function csrfHeaderOk(req: FastifyRequest): boolean {
  return SAFE_METHODS.has(req.method) || req.headers["x-maradocs"] === "1";
}

export function setSessionCookie(ctx: AppContext, reply: FastifyReply, token: string): void {
  reply.setCookie(SESSION_COOKIE, token, {
    path: "/",
    httpOnly: true,
    // Lax (not Strict): private report links opened from chat/email must carry it.
    sameSite: "lax",
    secure: ctx.config.cookieSecure,
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  });
}

export function clearSessionCookie(ctx: AppContext, reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: ctx.config.cookieSecure,
  });
}

export function requireMachine(ctx: AppContext) {
  return async (req: FastifyRequest, _reply: FastifyReply) => {
    const token = bearer(req);
    if (!token) throw unauthorized("Missing API key");
    const identity = await ctx.auth.verifyApiKey(token);
    if (!identity) throw unauthorized("Invalid or expired API key");
    req.machine = identity;
    ctx.store.upsertMachine({
      keyId: identity.apiKeyId,
      name: identity.name,
      scopes: identity.scopes,
      subject: identity.subject,
    });
  };
}

export function requireScope(scope: string) {
  return async (req: FastifyRequest) => {
    const m = req.machine;
    if (!m) throw unauthorized();
    if (!m.scopes.includes(scope) && !m.scopes.includes("admin")) {
      throw forbidden(`API key missing required scope: ${scope}`);
    }
  };
}

/** Pass when the key has any of the given scopes ("admin" always passes). */
export function requireAnyScope(...scopes: string[]) {
  return async (req: FastifyRequest) => {
    const m = req.machine;
    if (!m) throw unauthorized();
    if (!m.scopes.includes("admin") && !scopes.some((s) => m.scopes.includes(s))) {
      throw forbidden(`API key missing required scope: one of ${scopes.join(", ")}`);
    }
  };
}

/** Require a signed-in account (session cookie or bearer session token). */
export function requireUser(ctx: AppContext) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const cred = sessionCredential(req);
    if (!cred) throw unauthorized("Sign in required");
    if (cred.via === "cookie" && !csrfHeaderOk(req)) {
      throw new HttpError(403, "csrf_failed", "Missing x-maradocs header");
    }
    const identity = await ctx.auth.verifySession(cred.token);
    if (!identity) {
      if (cred.via === "cookie") clearSessionCookie(ctx, reply);
      throw unauthorized("Invalid or expired session");
    }
    // Keep the browser cookie's Max-Age in step with the sliding expiry.
    if (identity.sessionRefreshed && cred.via === "cookie") {
      setSessionCookie(ctx, reply, cred.token);
    }
    req.user = identity;
  };
}
