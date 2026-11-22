import { z } from "zod";
import type { Config, Env } from "../env.js";
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH, claimSecret } from "../env.js";
import { hashPassword, newId, randomToken, sha256Hex, timingSafeEqual, verifyPassword } from "../crypto.js";
import { nowIso } from "../http.js";
import { parseScopes, type ApiKeyRow } from "../db/rows.js";
import { SETTING_ADMIN_PASSWORD_HASH } from "../db/settings.js";
import type { MachineIdentity } from "../types.js";

/** Sessions last 30 days and slide: activity more than an hour after the last refresh extends them. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const SESSION_REFRESH_MS = 60 * 60 * 1000;
export const API_KEY_SCOPES = ["read", "publish", "admin"] as const;
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

/** API key usage (last_used_at, machines registry) is recorded at most this often per key. */
export const TOUCH_INTERVAL_MS = 5 * 60 * 1000;

// ---- Accounts --------------------------------------------------------------------

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(254)
  .regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, "must be a valid email address");

export const passwordSchema = z
  .string()
  .min(MIN_PASSWORD_LENGTH, `must be at least ${MIN_PASSWORD_LENGTH} characters`)
  .max(MAX_PASSWORD_LENGTH);

export interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  created_at: string;
  updated_at: string;
}

export interface PublicUser {
  id: string;
  email: string;
  createdAt: string;
}

export function presentUser(row: Pick<UserRow, "id" | "email" | "created_at">): PublicUser {
  return { id: row.id, email: row.email, createdAt: row.created_at };
}

export function userByEmailStmt(db: D1Database, email: string): D1PreparedStatement {
  return db.prepare(`SELECT * FROM users WHERE email = ?`).bind(email);
}

export function userCountStmt(db: D1Database): D1PreparedStatement {
  return db.prepare(`SELECT EXISTS (SELECT 1 FROM users) AS has_users`);
}

// A wrong password for an unknown email costs one PBKDF2 derivation too, so
// response timing doesn't reveal which emails have accounts.
const dummyHashes = new Map<number, Promise<string>>();

export function verifyDummyPassword(password: string, iterations: number): Promise<boolean> {
  let hash = dummyHashes.get(iterations);
  if (!hash) {
    hash = hashPassword(randomToken(16), iterations);
    dummyHashes.set(iterations, hash);
  }
  return hash.then((h) => verifyPassword(password, h)).then(() => false);
}

// ---- Claim password ----------------------------------------------------------------

/**
 * Whether the first account needs a claim password: the ADMIN_PASSWORD secret
 * or the legacy dashboard-set admin password, while no account exists.
 */
export function claimConfigured(env: Env, storedHash: string | null): boolean {
  return claimSecret(env) != null || storedHash != null;
}

/** Check a claim password against the secret (constant time) or the legacy dashboard hash. */
export async function checkClaimPassword(env: Env, storedHash: string | null, given: string): Promise<boolean> {
  const secret = claimSecret(env);
  let ok = false;
  if (secret != null) {
    const [a, b] = await Promise.all([sha256Hex(given), sha256Hex(secret)]);
    ok = timingSafeEqual(a, b);
  }
  if (!ok && storedHash) ok = await verifyPassword(given, storedHash);
  return ok;
}

export function legacyAdminHashStmt(db: D1Database): D1PreparedStatement {
  return db.prepare(`SELECT value FROM settings WHERE key = ?`).bind(SETTING_ADMIN_PASSWORD_HASH);
}

/** Whether POST /register is currently allowed by REGISTRATION (claim aside). */
export function registrationOpen(config: Config, hasUsers: boolean): boolean {
  if (config.registration === "open") return true;
  if (config.registration === "first") return !hasUsers;
  return false;
}

let warnedClaim = false;

/** One warning per isolate: ADMIN_PASSWORD only matters until the first account exists. */
export function warnUnusedClaimSecret(env: Env, hasUsers: boolean): void {
  if (warnedClaim || !hasUsers || claimSecret(env) == null) return;
  warnedClaim = true;
  console.warn(
    "ADMIN_PASSWORD is set but no longer used: it is only the claim password for the first account, " +
      "and accounts exist. Remove it with `npx wrangler secret delete ADMIN_PASSWORD`.",
  );
}

// ---- Sessions --------------------------------------------------------------------

/** Extract a credential from an Authorization header ("Bearer x" or a bare token, like the server). */
export function credentialFromHeader(header: string | undefined | null): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (match) return match[1]!.trim() || null;
  return header.trim() || null;
}

export function isApiKeyToken(token: string): boolean {
  return token.startsWith("mdo_");
}

export interface SessionUserRow {
  token_hash: string;
  user_id: string;
  expires_at: string;
  last_seen: string;
  email: string;
  created_at: string;
}

/** A session with its user (expired rows included, so callers can delete them). */
export function sessionLookupStmt(db: D1Database, tokenHash: string): D1PreparedStatement {
  return db
    .prepare(
      `SELECT s.token_hash, s.user_id, s.expires_at, s.last_seen, u.email, u.created_at
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ?`,
    )
    .bind(tokenHash);
}

export function sessionExpired(row: Pick<SessionUserRow, "expires_at">, now = Date.now()): boolean {
  return Date.parse(row.expires_at) <= now;
}

/** Whether a valid session's expiry should slide forward (at most one write per hour). */
export function sessionNeedsRefresh(row: Pick<SessionUserRow, "last_seen">, now = Date.now()): boolean {
  const last = Date.parse(row.last_seen);
  return !Number.isFinite(last) || now - last > SESSION_REFRESH_MS;
}

export function sessionRefreshStmt(db: D1Database, tokenHash: string, now = Date.now()): D1PreparedStatement {
  return db
    .prepare(`UPDATE sessions SET last_seen = ?, expires_at = ? WHERE token_hash = ?`)
    .bind(new Date(now).toISOString(), new Date(now + SESSION_TTL_MS).toISOString(), tokenHash);
}

export async function newSessionToken(): Promise<{ token: string; tokenHash: string; expiresAt: string }> {
  const token = randomToken(32);
  return {
    token,
    tokenHash: await sha256Hex(token),
    expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString(),
  };
}

export function sessionInsertStmt(
  db: D1Database,
  session: { tokenHash: string; expiresAt: string },
  userId: string,
  userAgent: string | undefined,
): D1PreparedStatement {
  const now = nowIso();
  return db
    .prepare(
      `INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_seen, user_agent)
       SELECT ?1, ?2, ?3, ?4, ?3, ?5 WHERE EXISTS (SELECT 1 FROM users WHERE id = ?2)`,
    )
    .bind(session.tokenHash, userId, now, session.expiresAt, userAgent ? userAgent.slice(0, 200) : null);
}

export function purgeExpiredSessionsStmt(db: D1Database): D1PreparedStatement {
  return db.prepare(`DELETE FROM sessions WHERE expires_at <= ?`).bind(nowIso());
}

// ---- API keys --------------------------------------------------------------------

export function apiKeyLookupStmt(db: D1Database, keyHash: string): D1PreparedStatement {
  return db
    .prepare(`SELECT id, name, prefix, scopes, created_at, last_used_at, user_id FROM api_keys WHERE key_hash = ?`)
    .bind(keyHash);
}

export type ApiKeyLookupRow = Pick<ApiKeyRow, "id" | "name" | "scopes" | "last_used_at" | "user_id">;

/** Null for keys with no owner (created before accounts and not yet adopted). */
export function machineFromRow(row: Pick<ApiKeyRow, "id" | "name" | "scopes" | "user_id">): MachineIdentity | null {
  if (!row.user_id) return null;
  return { type: "machine", apiKeyId: row.id, name: row.name, scopes: parseScopes(row.scopes), userId: row.user_id };
}

/** Whether usage needs recording, given the key's last_used_at (avoids a D1 write per request). */
export function shouldTouch(lastUsedAt: string | null | undefined, now = Date.now()): boolean {
  if (!lastUsedAt) return true;
  const last = Date.parse(lastUsedAt);
  return !Number.isFinite(last) || now - last >= TOUCH_INTERVAL_MS;
}

/**
 * Record API key usage (last_used_at + machines registry), throttled to one
 * write per key every few minutes so automation can't exhaust the D1 Free
 * plan's daily write budget. Not needed to answer the request, so callers run
 * it via waitUntil.
 */
export function touchApiKey(db: D1Database, machine: MachineIdentity, now = Date.now()): Promise<unknown> {
  const ts = new Date(now).toISOString();
  const staleBefore = new Date(now - TOUCH_INTERVAL_MS).toISOString();
  return db.batch([
    db
      .prepare(`UPDATE api_keys SET last_used_at = ?1 WHERE id = ?2 AND (last_used_at IS NULL OR last_used_at < ?3)`)
      .bind(ts, machine.apiKeyId, staleBefore),
    db
      .prepare(
        `INSERT INTO machines (id, key_id, name, scopes, subject, created_at, last_used_at, user_id)
         SELECT ?1, ?2, ?3, ?4, NULL, ?5, ?5, ?7 WHERE EXISTS (SELECT 1 FROM api_keys WHERE id = ?2)
         ON CONFLICT(key_id) DO UPDATE SET
           name = excluded.name, scopes = excluded.scopes, last_used_at = excluded.last_used_at,
           user_id = excluded.user_id
         WHERE machines.last_used_at IS NULL OR machines.last_used_at < ?6`,
      )
      .bind(newId("mach"), machine.apiKeyId, machine.name, JSON.stringify(machine.scopes), ts, staleBefore, machine.userId),
  ]);
}

export function hasScope(machine: MachineIdentity, ...scopes: string[]): boolean {
  return machine.scopes.includes("admin") || scopes.some((s) => machine.scopes.includes(s));
}

export async function newApiKey(): Promise<{ key: string; keyHash: string; prefix: string }> {
  const key = `mdo_${randomToken(32)}`;
  return { key, keyHash: await sha256Hex(key), prefix: key.slice(0, 12) };
}
