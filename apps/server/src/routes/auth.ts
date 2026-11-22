import type { FastifyInstance, FastifyRequest } from "fastify";
import crypto from "node:crypto";
import { z } from "zod";
import { HttpError, conflict, forbidden, notFound } from "../util/errors.js";
import {
  clearSessionCookie,
  requireUser,
  setSessionCookie,
} from "../auth/middleware.js";
import {
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  publicUser,
  safeEqual,
  sha256hex,
} from "../auth/local.js";
import type { AppContext } from "../context.js";

function genApiKey(): { rawKey: string; keyHash: string; prefix: string } {
  const rawKey = "mdo_" + crypto.randomBytes(32).toString("base64url");
  return { rawKey, keyHash: sha256hex(rawKey), prefix: rawKey.slice(0, 12) };
}

const apiKeyScopesSchema = z.array(z.enum(["read", "publish", "admin"])).min(1).default(["publish"]);

const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(254)
  .regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, "Enter a valid email address");
const newPasswordSchema = z
  .string()
  .min(MIN_PASSWORD_LENGTH, `Password must be at least ${MIN_PASSWORD_LENGTH} characters`)
  .max(MAX_PASSWORD_LENGTH);
const anyPasswordSchema = z.string().max(MAX_PASSWORD_LENGTH);

/** True when the request comes from a browser (which only gets the cookie, not the raw token). */
function isBrowser(req: FastifyRequest): boolean {
  return Boolean(req.headers.origin || req.headers["sec-fetch-site"]);
}

/** Reject login/register attempts posted from another site. */
function rejectCrossSite(ctx: AppContext, req: FastifyRequest): void {
  if (req.headers["sec-fetch-site"] === "cross-site") throw forbidden("Cross-site request rejected");
  const origin = req.headers.origin;
  if (!origin) return;
  let originUrl: URL;
  try {
    originUrl = new URL(origin);
  } catch {
    throw forbidden("Cross-site request rejected");
  }
  const host = originUrl.host;
  const allowed = new Set<string>();
  if (req.headers.host) {
    try {
      // Normalise through URL so default ports compare equal ("example.com:443").
      allowed.add(new URL(`${originUrl.protocol}//${req.headers.host}`).host);
    } catch {
      /* malformed Host header: only PUBLIC_BASE_URL can match */
    }
  }
  if (ctx.config.publicBaseUrl) {
    try {
      allowed.add(new URL(ctx.config.publicBaseUrl).host);
    } catch {
      /* validated elsewhere */
    }
  }
  if (!allowed.has(host)) throw forbidden("Cross-site request rejected");
}

/** Small fixed-window limiter for keys that aren't the client IP (e.g. per user). */
function windowLimiter(max: number, windowMs: number) {
  const hits = new Map<string, { count: number; resetAt: number }>();
  return (key: string): boolean => {
    const now = Date.now();
    const current = hits.get(key);
    if (!current || current.resetAt <= now) {
      if (hits.size > 5000) {
        for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
      }
      hits.set(key, { count: 1, resetAt: now + windowMs });
      return true;
    }
    current.count += 1;
    return current.count <= max;
  };
}

function rateLimited(): HttpError {
  return new HttpError(429, "rate_limited", "Too many requests");
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  const ctx = app.ctx;
  const passwordCheckLimit = windowLimiter(10, 60 * 60 * 1000);

  function audit(
    event: string,
    user: { id: string; email: string } | null,
    detail: string | null = null,
  ) {
    ctx.store.addAudit({
      userId: user?.id ?? null,
      event,
      actorType: "user",
      actorId: user?.id ?? null,
      actorLabel: user?.email ?? null,
      repositorySlug: null,
      documentSlug: null,
      detail,
    });
  }

  /** Is POST /register allowed right now? */
  function registrationOpen(userCount: number): boolean {
    if (ctx.config.registration === "open") return true;
    if (ctx.config.registration === "first") return userCount === 0;
    return false;
  }

  app.get("/config", async () => {
    const count = ctx.store.countUsers();
    return {
      registration: registrationOpen(count),
      claimRequired: count === 0 && Boolean(ctx.config.adminPassword),
      firstAccount: count === 0,
      minPasswordLength: MIN_PASSWORD_LENGTH,
    };
  });

  app.post(
    "/register",
    { config: { rateLimit: { max: 5, timeWindow: "1 hour" } } },
    async (req, reply) => {
      rejectCrossSite(ctx, req);
      const body = z
        .object({
          email: emailSchema,
          password: newPasswordSchema,
          claimPassword: z.string().max(MAX_PASSWORD_LENGTH).optional(),
        })
        .parse(req.body);

      const guard = (count: number) => {
        if (!registrationOpen(count)) {
          throw new HttpError(403, "registration_closed", "Registration is closed on this server");
        }
        if (count === 0 && ctx.config.adminPassword) {
          if (!body.claimPassword) {
            throw new HttpError(
              403,
              "claim_required",
              "This server has existing data: enter the server's ADMIN_PASSWORD as the claim password",
            );
          }
          if (!safeEqual(body.claimPassword, ctx.config.adminPassword)) {
            throw new HttpError(403, "claim_required", "Incorrect claim password");
          }
        }
      };
      // Fail fast before hashing; re-checked inside the insert transaction.
      guard(ctx.store.countUsers());
      if (ctx.store.getUserByEmail(body.email)) {
        throw conflict("An account with this email already exists");
      }

      const passwordHash = await ctx.auth.hashPassword(body.password);
      let user;
      try {
        user = ctx.store.createUser({ email: body.email, passwordHash }, guard);
      } catch (err) {
        if ((err as { code?: string }).code === "SQLITE_CONSTRAINT_UNIQUE") {
          throw conflict("An account with this email already exists");
        }
        throw err;
      }
      const token = ctx.auth.createSession(user.id, req.headers["user-agent"]);
      setSessionCookie(ctx, reply, token);
      audit("auth.register", user);
      reply.code(201);
      return isBrowser(req) ? { user: publicUser(user) } : { user: publicUser(user), token };
    },
  );

  app.post(
    "/login",
    { config: { rateLimit: { max: 5, timeWindow: "15 minutes" } } },
    async (req, reply) => {
      rejectCrossSite(ctx, req);
      const body = z
        .object({ email: z.string().max(254), password: anyPasswordSchema })
        .parse(req.body);
      const email = body.email.trim().toLowerCase();
      const { user, ok } = await ctx.auth.checkCredentials(email, body.password);
      if (!user || !ok) {
        audit("auth.login_failed", user);
        throw new HttpError(401, "unauthorized", "Invalid email or password");
      }
      ctx.store.purgeExpiredSessions();
      const token = ctx.auth.createSession(user.id, req.headers["user-agent"]);
      setSessionCookie(ctx, reply, token);
      audit("auth.login", user);
      return isBrowser(req) ? { user: publicUser(user) } : { user: publicUser(user), token };
    },
  );

  app.get("/me", { preHandler: requireUser(ctx) }, async (req) => {
    const user = ctx.store.getUserById(req.user!.userId);
    if (!user) throw notFound("Account not found");
    return { user: publicUser(user) };
  });

  app.post("/logout", { preHandler: requireUser(ctx) }, async (req, reply) => {
    ctx.store.deleteSession(req.user!.sessionTokenHash);
    clearSessionCookie(ctx, reply);
    audit("auth.logout", { id: req.user!.userId, email: req.user!.email });
    reply.code(204).send();
  });

  app.post("/logout-others", { preHandler: requireUser(ctx) }, async (req) => {
    const u = req.user!;
    const revoked = ctx.store.deleteOtherSessions(u.userId, u.sessionTokenHash);
    audit("auth.logout_others", { id: u.userId, email: u.email }, `revoked=${revoked}`);
    return { revoked };
  });

  app.post("/change-password", { preHandler: requireUser(ctx) }, async (req) => {
    const u = req.user!;
    if (!passwordCheckLimit(u.userId)) throw rateLimited();
    const body = z
      .object({ currentPassword: anyPasswordSchema, newPassword: newPasswordSchema })
      .parse(req.body);
    const user = ctx.store.getUserById(u.userId);
    if (!user) throw notFound("Account not found");
    if (!(await ctx.auth.verifyUserPassword(user, body.currentPassword))) {
      throw new HttpError(401, "invalid_password", "Current password is incorrect");
    }
    ctx.store.updateUserPassword(user.id, await ctx.auth.hashPassword(body.newPassword));
    const revoked = ctx.store.deleteOtherSessions(user.id, u.sessionTokenHash);
    audit("password.change", user, `revoked=${revoked}`);
    return { user: publicUser(ctx.store.getUserById(user.id)!) };
  });

  app.delete("/account", { preHandler: requireUser(ctx) }, async (req, reply) => {
    const u = req.user!;
    if (!passwordCheckLimit(u.userId)) throw rateLimited();
    const { password } = z.object({ password: anyPasswordSchema }).parse(req.body ?? {});
    const user = ctx.store.getUserById(u.userId);
    if (!user) throw notFound("Account not found");
    if (!(await ctx.auth.verifyUserPassword(user, password))) {
      throw new HttpError(401, "invalid_password", "Password is incorrect");
    }
    const repoSlugs = ctx.store.deleteUser(user.id);
    for (const slug of repoSlugs) ctx.storage.removeDir(ctx.storage.repoDir(slug));
    // Kept without the email: the account's own audit rows are gone with it.
    ctx.store.addAudit({
      userId: null,
      event: "account.delete",
      actorType: "user",
      actorId: user.id,
      actorLabel: null,
      repositorySlug: null,
      documentSlug: null,
      detail: `repos=${repoSlugs.length}`,
    });
    clearSessionCookie(ctx, reply);
    reply.code(204).send();
  });

  app.get("/keys", { preHandler: requireUser(ctx) }, async (req) => ({
    keys: ctx.store
      .listApiKeys(req.user!.userId)
      .map(({ keyHash: _keyHash, userId: _userId, ...key }) => key),
  }));

  app.post<{ Body: { name?: string; scopes?: string[] } }>(
    "/keys",
    { preHandler: requireUser(ctx) },
    async (req, reply) => {
      const { name, scopes } = z
        .object({ name: z.string().min(1).max(100), scopes: apiKeyScopesSchema.optional() })
        .parse(req.body);
      const { rawKey, keyHash, prefix } = genApiKey();
      const key = ctx.store.createApiKey({
        userId: req.user!.userId,
        name,
        keyHash,
        prefix,
        scopes: scopes ?? ["publish"],
      });
      ctx.store.addAudit({
        userId: req.user!.userId,
        event: "key.create",
        actorType: "user",
        actorId: req.user!.userId,
        actorLabel: req.user!.email,
        repositorySlug: null,
        documentSlug: null,
        detail: `${key.name} scopes=${key.scopes.join(",")}`,
      });
      reply.code(201);
      return { key: rawKey, id: key.id, name: key.name, prefix: key.prefix, scopes: key.scopes };
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/keys/:id",
    { preHandler: requireUser(ctx) },
    async (req, reply) => {
      if (!ctx.store.deleteApiKey(req.params.id, req.user!.userId)) {
        throw notFound("API key not found");
      }
      ctx.store.addAudit({
        userId: req.user!.userId,
        event: "key.delete",
        actorType: "user",
        actorId: req.user!.userId,
        actorLabel: req.user!.email,
        repositorySlug: null,
        documentSlug: null,
        detail: req.params.id,
      });
      reply.code(204).send();
    },
  );
}
