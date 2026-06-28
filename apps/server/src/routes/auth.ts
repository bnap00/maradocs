import type { FastifyInstance } from "fastify";
import crypto from "node:crypto";
import { z } from "zod";
import { unauthorized } from "../util/errors.js";
import { requireUser } from "../auth/middleware.js";

function sha256hex(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function genApiKey(): { rawKey: string; keyHash: string; prefix: string } {
  const rawKey = "mdo_" + crypto.randomBytes(32).toString("base64url");
  return { rawKey, keyHash: sha256hex(rawKey), prefix: rawKey.slice(0, 12) };
}

function genSessionToken(): { rawToken: string; tokenHash: string } {
  const rawToken = crypto.randomBytes(32).toString("base64url");
  return { rawToken, tokenHash: sha256hex(rawToken) };
}

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const apiKeyScopesSchema = z.array(z.enum(["read", "publish", "admin"])).min(1).default(["publish"]);

export async function authRoutes(app: FastifyInstance): Promise<void> {
  const ctx = app.ctx;

  app.post<{ Body: { password?: string } }>(
    "/login",
    { config: { rateLimit: { max: 5, timeWindow: "15 minutes" } } },
    async (req, reply) => {
      const { password } = z.object({ password: z.string() }).parse(req.body);
      const ok = await ctx.auth.checkAdminPassword(password);
      if (!ok) throw unauthorized("Invalid password");
      const { rawToken, tokenHash } = genSessionToken();
      const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
      ctx.store.createSession({ tokenHash, expiresAt });
      reply.setCookie("__session", rawToken, {
        path: "/",
        httpOnly: true,
        sameSite: "lax",
        secure: ctx.config.isProduction,
        maxAge: Math.floor(SESSION_TTL_MS / 1000),
      });
      return { token: rawToken };
    },
  );

  app.post("/logout", { preHandler: requireUser(ctx) }, async (req, reply) => {
    // req.sessionToken is guaranteed by requireUser
    ctx.store.deleteSession(sha256hex(req.sessionToken!));
    reply.clearCookie("__session", { path: "/" });
    reply.code(204).send();
  });

  app.get("/keys", { preHandler: requireUser(ctx) }, async () => ({
    keys: ctx.store.listApiKeys().map(({ keyHash: _keyHash, ...key }) => key),
  }));

  app.post<{ Body: { name?: string; scopes?: string[] } }>(
    "/keys",
    { preHandler: requireUser(ctx) },
    async (req, reply) => {
      const { name, scopes } = z
        .object({ name: z.string().min(1).max(100), scopes: apiKeyScopesSchema.optional() })
        .parse(req.body);
      const { rawKey, keyHash, prefix } = genApiKey();
      const key = ctx.store.createApiKey({ name, keyHash, prefix, scopes: scopes ?? ["publish"] });
      reply.code(201);
      return { key: rawKey, id: key.id, name: key.name, prefix: key.prefix, scopes: key.scopes };
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/keys/:id",
    { preHandler: requireUser(ctx) },
    async (req, reply) => {
      ctx.store.deleteApiKey(req.params.id);
      reply.code(204).send();
    },
  );
}
