// Accounts and sessions (`/api/v1/auth`): email + password accounts, each
// owning its repositories, documents, API keys, machines and audit log.

import { Hono } from "hono";
import { z } from "zod";
import { HttpError, conflict, forbidden, notFound, rateLimited, unauthorized } from "../errors.js";
import { hashPassword, newId, passwordHashIterations, rehashPassword, verifyPassword } from "../crypto.js";
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from "../env.js";
import {
  SESSION_COOKIE,
  clearCookie,
  clientIp,
  defer,
  isSameOriginRequest,
  nowIso,
  readJson,
  setCookie,
} from "../http.js";
import { presentApiKey, type ApiKeyRow } from "../db/rows.js";
import {
  SETTING_ADMIN_PASSWORD_HASH,
  SETTING_DEFAULT_REPO_ACCESS,
  defaultRepoAccessKey,
} from "../db/settings.js";
import { ownerId, requireSession, userActor } from "../middleware.js";
import { auditStmt } from "../services/audit.js";
import {
  API_KEY_SCOPES,
  SESSION_TTL_MS,
  checkClaimPassword,
  claimConfigured,
  emailSchema,
  legacyAdminHashStmt,
  newApiKey,
  newSessionToken,
  passwordSchema,
  presentUser,
  purgeExpiredSessionsStmt,
  registrationOpen,
  sessionInsertStmt,
  userByEmailStmt,
  userCountStmt,
  verifyDummyPassword,
  warnUnusedClaimSecret,
  type UserRow,
} from "../services/auth.js";
import { deleteBlobs } from "../services/repos.js";
import {
  ACCOUNT_PASSWORD_LIMIT,
  LOGIN_GLOBAL_LIMIT,
  LOGIN_LIMIT,
  REGISTER_LIMIT,
  evaluateGlobalLimit,
  evaluateRateLimit,
  rateLimitClientKey,
  rateLimitHitStmt,
  rateLimitPeekStmt,
  rateLimitPurgeStmt,
  rateLimitResetStmt,
  type RateLimitResult,
} from "../services/ratelimit.js";
import type { Actor, AppContext, AppEnv } from "../types.js";

export const SYSTEM_ACTOR = { type: "system" as const, id: null, label: null };
export const LOGIN_GLOBAL_KEY = "login:global";

const registerSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  claimPassword: z.string().max(MAX_PASSWORD_LENGTH).optional(),
});
const loginSchema = z.object({
  email: z.string().trim().toLowerCase().min(1).max(254),
  password: z.string().min(1).max(MAX_PASSWORD_LENGTH),
});
const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(MAX_PASSWORD_LENGTH),
  newPassword: passwordSchema,
});
const deleteAccountSchema = z.object({ password: z.string().min(1).max(MAX_PASSWORD_LENGTH) });
const apiKeyScopesSchema = z.array(z.enum(API_KEY_SCOPES)).min(1);
const createKeySchema = z.object({
  name: z.string().trim().min(1).max(100),
  scopes: apiKeyScopesSchema.optional(),
});

type RateRow = { count: number; reset_at: number } | undefined;

/**
 * Browsers always send Origin on POST (and Sec-Fetch-Site); the CLI's fetch
 * sends neither. Only non-browser clients get the session token in the body:
 * the dashboard relies on the HttpOnly cookie, so script running in the page
 * can't lift a portable bearer token.
 */
function isBrowserRequest(c: AppContext): boolean {
  return Boolean(c.req.header("origin") || c.req.header("sec-fetch-site"));
}

/** Login/register CSRF: browsers always send Origin on cross-site POSTs; CLIs send none. */
function rejectCrossSite(c: AppContext): void {
  if (c.req.header("origin") && !isSameOriginRequest(c)) {
    throw forbidden("Cross-site request blocked: the request origin does not match this server");
  }
}

function setSessionCookie(c: AppContext, token: string): void {
  setCookie(c, SESSION_COOKIE, token, { path: "/", maxAge: Math.floor(SESSION_TTL_MS / 1000) });
}

function accountActor(user: Pick<UserRow, "id" | "email">): Actor {
  return { type: "user", id: user.id, label: user.email, userId: user.id };
}

function retryAfter(...results: RateLimitResult[]): number {
  return Math.max(0, ...results.filter((r) => !r.allowed).map((r) => r.retryAfterSeconds));
}

export const authRoutes = new Hono<AppEnv>();

// ---- Registration & sign-in ------------------------------------------------------

authRoutes.get("/config", async (c) => {
  const db = c.env.DB;
  const [count, legacy] = await db.batch([userCountStmt(db), legacyAdminHashStmt(db)]);
  const hasUsers = (count?.results[0] as { has_users: number } | undefined)?.has_users === 1;
  const storedHash = (legacy?.results[0] as { value: string } | undefined)?.value ?? null;
  warnUnusedClaimSecret(c.env, hasUsers);
  return c.json({
    registration: registrationOpen(c.get("config"), hasUsers),
    claimRequired: !hasUsers && claimConfigured(c.env, storedHash),
    firstAccount: !hasUsers,
    minPasswordLength: MIN_PASSWORD_LENGTH,
  });
});

authRoutes.post("/register", async (c) => {
  rejectCrossSite(c);
  const input = await readJson(c, registerSchema);
  const db = c.env.DB;
  const config = c.get("config");
  const ip = clientIp(c);
  const limitKey = `register:${rateLimitClientKey(ip)}`;
  const [hit, count, legacy] = await db.batch([
    rateLimitHitStmt(db, limitKey, REGISTER_LIMIT),
    userCountStmt(db),
    legacyAdminHashStmt(db),
  ]);
  const limit = evaluateRateLimit(hit?.results[0] as RateRow, REGISTER_LIMIT);
  if (!limit.allowed) {
    if (limit.firstRejection) {
      defer(c, auditStmt(db, { event: "auth.rate_limited", actor: SYSTEM_ACTOR, detail: `scope=register ip=${ip}` }).run());
    }
    throw rateLimited(
      `Too many sign-up attempts. Try again in ${Math.ceil(limit.retryAfterSeconds / 60)} minute(s).`,
      limit.retryAfterSeconds,
    );
  }
  const hasUsers = (count?.results[0] as { has_users: number } | undefined)?.has_users === 1;
  const storedHash = (legacy?.results[0] as { value: string } | undefined)?.value ?? null;
  if (!registrationOpen(config, hasUsers)) {
    throw new HttpError(403, "registration_closed", "Registration is closed on this server. Ask its operator for an account.");
  }
  const claimNeeded = !hasUsers && claimConfigured(c.env, storedHash);
  if (claimNeeded) {
    if (!input.claimPassword) {
      throw new HttpError(
        403,
        "claim_required",
        "Creating the first account on this server requires the claim password (the ADMIN_PASSWORD secret).",
      );
    }
    if (!(await checkClaimPassword(c.env, storedHash, input.claimPassword))) {
      throw new HttpError(403, "claim_required", "The claim password is incorrect.");
    }
  }

  const passwordHash = await hashPassword(input.password, config.pbkdf2Iterations);
  const userId = newId("user");
  const now = nowIso();
  const session = await newSessionToken();
  // Only the first account may be created when REGISTRATION=first or a claim
  // password guards the instance; the check is repeated inside the batch so
  // two concurrent sign-ups can't both become "first".
  const onlyFirst = config.registration === "first" || claimNeeded ? 1 : 0;
  // Rows from before accounts existed (no owner) go to the first account.
  const adopt = `EXISTS (SELECT 1 FROM users WHERE id = ?1) AND (SELECT COUNT(*) FROM users) = 1`;
  const actor = accountActor({ id: userId, email: input.email });
  const [inserted] = await db.batch([
    db
      .prepare(
        `INSERT INTO users (id, email, password_hash, created_at, updated_at)
         SELECT ?1, ?2, ?3, ?4, ?4 WHERE (?5 = 0 OR NOT EXISTS (SELECT 1 FROM users))
         ON CONFLICT(email) DO NOTHING`,
      )
      .bind(userId, input.email, passwordHash, now, onlyFirst),
    db.prepare(`UPDATE repositories SET owner_id = ?1 WHERE owner_id IS NULL AND ${adopt}`).bind(userId),
    db.prepare(`UPDATE api_keys SET user_id = ?1 WHERE user_id IS NULL AND ${adopt}`).bind(userId),
    db.prepare(`UPDATE machines SET user_id = ?1 WHERE user_id IS NULL AND ${adopt}`).bind(userId),
    db.prepare(`UPDATE audit_log SET user_id = ?1 WHERE user_id IS NULL AND ${adopt}`).bind(userId),
    db
      .prepare(
        `INSERT INTO settings (key, value)
         SELECT ?2, value FROM settings WHERE key = ?3 AND ${adopt}
         ON CONFLICT(key) DO NOTHING`,
      )
      .bind(userId, defaultRepoAccessKey(userId), SETTING_DEFAULT_REPO_ACCESS),
    db
      .prepare(`DELETE FROM settings WHERE key IN (?2, ?3) AND ${adopt}`)
      .bind(userId, SETTING_DEFAULT_REPO_ACCESS, SETTING_ADMIN_PASSWORD_HASH),
    sessionInsertStmt(db, session, userId, c.req.header("user-agent")),
    auditStmt(
      db,
      { event: "auth.register", actor, detail: `ip=${ip}` },
      { sql: "EXISTS (SELECT 1 FROM users WHERE id = ?)", params: [userId] },
    ),
  ]);
  if (!inserted?.meta.changes) {
    const taken = await userByEmailStmt(db, input.email).first();
    if (taken) throw conflict("An account with this email already exists");
    throw new HttpError(403, "registration_closed", "Registration is closed on this server. Ask its operator for an account.");
  }
  setSessionCookie(c, session.token);
  const user = presentUser({ id: userId, email: input.email, created_at: now });
  return c.json(isBrowserRequest(c) ? { user } : { user, token: session.token }, 201);
});

authRoutes.post("/login", async (c) => {
  rejectCrossSite(c);
  const { email, password } = await readJson(c, loginSchema);
  const db = c.env.DB;
  const config = c.get("config");
  const ip = clientIp(c);
  const limitKey = `login:${rateLimitClientKey(ip)}`;

  const [hit, globalRow, userRes] = await db.batch([
    rateLimitHitStmt(db, limitKey, LOGIN_LIMIT),
    rateLimitPeekStmt(db, LOGIN_GLOBAL_KEY),
    userByEmailStmt(db, email),
  ]);
  const limit = evaluateRateLimit(hit?.results[0] as RateRow, LOGIN_LIMIT);
  const global = evaluateGlobalLimit(globalRow?.results[0] as RateRow, LOGIN_GLOBAL_LIMIT);
  if (!limit.allowed || !global.allowed) {
    if (limit.firstRejection) {
      defer(c, auditStmt(db, { event: "auth.rate_limited", actor: SYSTEM_ACTOR, detail: `scope=login ip=${ip}` }).run());
    }
    const wait = retryAfter(limit, global);
    throw rateLimited(`Too many login attempts. Try again in ${Math.ceil(wait / 60)} minute(s).`, wait);
  }

  const user = userRes?.results[0] as UserRow | undefined;
  const ok = user
    ? await verifyPassword(password, user.password_hash)
    : await verifyDummyPassword(password, config.pbkdf2Iterations);
  if (!ok || !user) {
    defer(
      c,
      db.batch([
        auditStmt(db, { event: "auth.login_failed", actor: SYSTEM_ACTOR, detail: `ip=${ip}`, userId: user?.id ?? null }),
        rateLimitHitStmt(db, LOGIN_GLOBAL_KEY, LOGIN_GLOBAL_LIMIT),
        // Audit the global lockout once, when the counter reaches its limit.
        auditStmt(
          db,
          { event: "auth.rate_limited", actor: SYSTEM_ACTOR, detail: "scope=login-global (all networks)" },
          { sql: "(SELECT count FROM rate_limits WHERE key = ?) = ?", params: [LOGIN_GLOBAL_KEY, LOGIN_GLOBAL_LIMIT.max] },
        ),
      ]),
    );
    throw unauthorized("Invalid email or password");
  }

  const statements: D1PreparedStatement[] = [];
  if (passwordHashIterations(user.password_hash) !== config.pbkdf2Iterations) {
    // Move the hash to the configured cost (same salt).
    const rehashed = await rehashPassword(password, user.password_hash, config.pbkdf2Iterations);
    statements.push(
      db
        .prepare(`UPDATE users SET password_hash = ? WHERE id = ? AND password_hash = ?`)
        .bind(rehashed, user.id, user.password_hash),
    );
  }
  const session = await newSessionToken();
  await db.batch([
    ...statements,
    sessionInsertStmt(db, session, user.id, c.req.header("user-agent")),
    rateLimitResetStmt(db, limitKey),
    auditStmt(db, { event: "auth.login", actor: accountActor(user), detail: `ip=${ip}` }),
  ]);
  defer(c, db.batch([purgeExpiredSessionsStmt(db), rateLimitPurgeStmt(db)]));
  setSessionCookie(c, session.token);
  const body = presentUser(user);
  return c.json(isBrowserRequest(c) ? { user: body } : { user: body, token: session.token });
});

// ---- Current account -------------------------------------------------------------

authRoutes.get("/me", requireSession, (c) => {
  const u = c.get("user")!;
  return c.json({ user: { id: u.userId, email: u.email, createdAt: u.createdAt } });
});

authRoutes.post("/logout", requireSession, async (c) => {
  const db = c.env.DB;
  await db.batch([
    db.prepare(`DELETE FROM sessions WHERE token_hash = ?`).bind(c.get("sessionHash")),
    auditStmt(db, { event: "auth.logout", actor: userActor(c), detail: `ip=${clientIp(c)}` }),
  ]);
  clearCookie(c, SESSION_COOKIE, "/");
  return c.body(null, 204);
});

/** Sign out every other session of the current account (also POST /dashboard/sessions/revoke-all). */
export async function logoutOthers(c: AppContext): Promise<Response> {
  const db = c.env.DB;
  const [deleted] = await db.batch([
    db.prepare(`DELETE FROM sessions WHERE user_id = ? AND token_hash != ?`).bind(ownerId(c), c.get("sessionHash")),
    auditStmt(db, { event: "auth.logout_others", actor: userActor(c), detail: `ip=${clientIp(c)}` }),
  ]);
  return c.json({ revoked: deleted?.meta.changes ?? 0 });
}

authRoutes.post("/logout-others", requireSession, logoutOthers);

/**
 * Check the account password for a sensitive action, rate limited per
 * account (a stolen session can't guess faster by rotating addresses).
 */
async function verifyAccountPassword(c: AppContext, password: string, scope: string): Promise<UserRow> {
  const db = c.env.DB;
  const userId = ownerId(c);
  const limitKey = `password:user:${userId}`;
  const [hit, userRes] = await db.batch([
    rateLimitHitStmt(db, limitKey, ACCOUNT_PASSWORD_LIMIT),
    db.prepare(`SELECT * FROM users WHERE id = ?`).bind(userId),
  ]);
  const limit = evaluateRateLimit(hit?.results[0] as RateRow, ACCOUNT_PASSWORD_LIMIT);
  if (!limit.allowed) {
    if (limit.firstRejection) {
      defer(c, auditStmt(db, { event: "auth.rate_limited", actor: userActor(c), detail: `scope=${scope}` }).run());
    }
    throw rateLimited("Too many password attempts. Try again later.", limit.retryAfterSeconds);
  }
  const user = userRes?.results[0] as UserRow | undefined;
  if (!user) throw unauthorized("Invalid session");
  if (!(await verifyPassword(password, user.password_hash))) {
    defer(c, auditStmt(db, { event: "password.change_failed", actor: userActor(c), detail: `scope=${scope} ip=${clientIp(c)}` }).run());
    throw unauthorized("Current password is incorrect");
  }
  return user;
}

/** Change the account password; every other session is signed out (also POST /dashboard/password). */
export async function changePassword(c: AppContext): Promise<Response> {
  const input = await readJson(c, changePasswordSchema);
  const user = await verifyAccountPassword(c, input.currentPassword, "change-password");
  const db = c.env.DB;
  const newHash = await hashPassword(input.newPassword, c.get("config").pbkdf2Iterations);
  await db.batch([
    db.prepare(`UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?`).bind(newHash, nowIso(), user.id),
    db.prepare(`DELETE FROM sessions WHERE user_id = ? AND token_hash != ?`).bind(user.id, c.get("sessionHash")),
    rateLimitResetStmt(db, `password:user:${user.id}`),
    auditStmt(db, { event: "password.change", actor: userActor(c), detail: "other sessions signed out" }),
  ]);
  return c.json({ user: presentUser(user) });
}

authRoutes.post("/change-password", requireSession, changePassword);

authRoutes.delete("/account", requireSession, async (c) => {
  const { password } = await readJson(c, deleteAccountSchema);
  const user = await verifyAccountPassword(c, password, "delete-account");
  const db = c.env.DB;
  const id = user.id;
  const owned = `SELECT id FROM repositories WHERE owner_id = ?1`;
  const [versions] = await db.batch([
    db
      .prepare(
        `DELETE FROM document_versions WHERE document_id IN (SELECT id FROM documents WHERE repository_id IN (${owned}))
         RETURNING storage_path`,
      )
      .bind(id),
    db.prepare(`DELETE FROM documents WHERE repository_id IN (${owned})`).bind(id),
    db.prepare(`DELETE FROM repositories WHERE owner_id = ?1`).bind(id),
    db.prepare(`DELETE FROM machines WHERE user_id = ?1 OR key_id IN (SELECT id FROM api_keys WHERE user_id = ?1)`).bind(id),
    db.prepare(`DELETE FROM api_keys WHERE user_id = ?1`).bind(id),
    db.prepare(`DELETE FROM sessions WHERE user_id = ?1`).bind(id),
    db.prepare(`DELETE FROM audit_log WHERE user_id = ?1`).bind(id),
    db.prepare(`DELETE FROM settings WHERE key = ?`).bind(defaultRepoAccessKey(id)),
    db.prepare(`DELETE FROM rate_limits WHERE key = ?`).bind(`password:user:${id}`),
    db.prepare(`DELETE FROM users WHERE id = ?1`).bind(id),
    // An operator-visible trace that carries no personal data.
    auditStmt(db, { event: "account.delete", actor: { type: "user", id, label: null }, userId: null }),
  ]);
  const keys = ((versions?.results ?? []) as { storage_path: string }[]).map((r) => r.storage_path);
  await deleteBlobs(c, keys);
  clearCookie(c, SESSION_COOKIE, "/");
  return c.body(null, 204);
});

// ---- API keys (the caller's own) ---------------------------------------------------

authRoutes.get("/keys", requireSession, async (c) => {
  const { results } = await c.env.DB
    .prepare(
      `SELECT id, name, prefix, scopes, created_at, last_used_at FROM api_keys WHERE user_id = ? ORDER BY created_at DESC`,
    )
    .bind(ownerId(c))
    .all<Omit<ApiKeyRow, "key_hash" | "user_id">>();
  return c.json({ keys: results.map(presentApiKey) });
});

authRoutes.post("/keys", requireSession, async (c) => {
  const input = await readJson(c, createKeySchema);
  const scopes = [...new Set(input.scopes ?? ["publish"])];
  const { key, keyHash, prefix } = await newApiKey();
  const id = newId("apikey");
  const db = c.env.DB;
  await db.batch([
    db
      .prepare(
        `INSERT INTO api_keys (id, name, key_hash, prefix, scopes, created_at, user_id) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(id, input.name, keyHash, prefix, JSON.stringify(scopes), nowIso(), ownerId(c)),
    auditStmt(db, {
      event: "key.create",
      actor: userActor(c),
      detail: `${input.name} (${prefix}…) scopes=${scopes.join(",")}`,
    }),
  ]);
  return c.json({ key, id, name: input.name, prefix, scopes }, 201);
});

authRoutes.delete("/keys/:id", requireSession, async (c) => {
  const id = c.req.param("id");
  if (!/^akey_[0-9a-f]{24}$/.test(id)) throw notFound("API key not found");
  const db = c.env.DB;
  const actor = userActor(c);
  const owner = ownerId(c);
  // Audit row and delete commit together: the audit insert reads the key's
  // name before the delete removes it, and is skipped if the key is gone.
  const [, , deleted] = await db.batch([
    db
      .prepare(
        `INSERT INTO audit_log
           (id, event, actor_type, actor_id, actor_label, repository_slug, document_slug, detail, created_at, user_id)
         SELECT ?, 'key.revoke', ?, ?, ?, NULL, NULL, name || ' (' || prefix || '…)', ?, user_id
         FROM api_keys WHERE id = ? AND user_id = ?`,
      )
      .bind(newId("audit"), actor.type, actor.id, actor.label, nowIso(), id, owner),
    db
      .prepare(`DELETE FROM machines WHERE key_id IN (SELECT id FROM api_keys WHERE id = ? AND user_id = ?)`)
      .bind(id, owner),
    db.prepare(`DELETE FROM api_keys WHERE id = ? AND user_id = ?`).bind(id, owner),
  ]);
  if (!deleted?.meta.changes) throw notFound("API key not found");
  return c.body(null, 204);
});
