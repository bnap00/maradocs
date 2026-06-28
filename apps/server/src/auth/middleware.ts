import type { FastifyReply, FastifyRequest } from "fastify";
import { forbidden, unauthorized } from "../util/errors.js";
import type { AppContext } from "../context.js";

function bearer(req: FastifyRequest): string | null {
  const header = req.headers.authorization;
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (match) return match[1]!.trim();
  return header.trim() || null;
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

export function requireUser(ctx: AppContext) {
  return async (req: FastifyRequest) => {
    const token = bearer(req);
    if (!token) throw unauthorized("Sign in required");
    const identity = await ctx.auth.verifySession(token);
    if (!identity) throw unauthorized("Invalid session");
    if (!identity.admin) throw forbidden("Dashboard access requires an admin user");
    req.user = identity;
    req.sessionToken = token;
  };
}
