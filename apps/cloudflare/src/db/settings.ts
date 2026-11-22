// Runtime settings persisted in D1 (`settings` table). These override the
// wrangler vars so the dashboard can change them without a redeploy.

import { ACCESS_MODES, type AccessMode } from "../vendor/shared/index.js";
import type { Config, Env } from "../env.js";
import { randomToken } from "../crypto.js";

/**
 * Legacy dashboard-set admin password (before accounts). Kept only as a
 * claim password for the first account; removed once an account exists.
 */
export const SETTING_ADMIN_PASSWORD_HASH = "admin_password_hash";
export const SETTING_COOKIE_SECRET = "cookie_secret";
/** Legacy instance-wide default access; adopted by the first account. */
export const SETTING_DEFAULT_REPO_ACCESS = "default_repo_access";

/** Per-user default access for new repositories. */
export function defaultRepoAccessKey(userId: string): string {
  return `${SETTING_DEFAULT_REPO_ACCESS}:${userId}`;
}

export function settingStmt(db: D1Database, key: string): D1PreparedStatement {
  return db.prepare(`SELECT value FROM settings WHERE key = ?`).bind(key);
}

export async function getSetting(db: D1Database, key: string): Promise<string | null> {
  const row = await settingStmt(db, key).first<{ value: string }>();
  return row?.value ?? null;
}

export function putSettingStmt(db: D1Database, key: string, value: string): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .bind(key, value);
}

export function parseAccess(value: string | null | undefined): AccessMode | null {
  return value && (ACCESS_MODES as readonly string[]).includes(value) ? (value as AccessMode) : null;
}

/** Default access for a user's new repositories: their dashboard setting, else the DEFAULT_REPO_ACCESS var. */
export async function getDefaultRepoAccess(db: D1Database, config: Config, userId: string): Promise<AccessMode> {
  return parseAccess(await getSetting(db, defaultRepoAccessKey(userId))) ?? config.defaultRepoAccess;
}

// The cookie secret never changes once created, so it is cached per isolate.
let cachedSecret: { db: D1Database; value: string } | null = null;
let warnedShortSecret = false;

/** Minimum COOKIE_SECRET length; shorter values are ignored (with a warning). */
export const MIN_COOKIE_SECRET_LENGTH = 32;

/** The cookie secret if it is known without a D1 round trip (env var or isolate cache). */
export function cookieSecretSync(env: Env): string | null {
  const configured = env.COOKIE_SECRET?.trim();
  if (configured && configured.length >= MIN_COOKIE_SECRET_LENGTH) return configured;
  if (configured && !warnedShortSecret) {
    warnedShortSecret = true;
    console.warn(
      `COOKIE_SECRET is shorter than ${MIN_COOKIE_SECRET_LENGTH} characters and is ignored; ` +
        "using the generated secret stored in D1. Use e.g. `openssl rand -hex 32`.",
    );
  }
  if (cachedSecret && cachedSecret.db === env.DB) return cachedSecret.value;
  return null;
}

/** Remember a cookie secret read as part of another D1 batch (see settingStmt). */
export function rememberCookieSecret(env: Env, value: string): void {
  cachedSecret = { db: env.DB, value };
}

/**
 * HMAC secret for password-unlock cookies: COOKIE_SECRET when set, otherwise a
 * random value generated on first use and stored in D1 (first writer wins).
 */
export async function getCookieSecret(env: Env): Promise<string> {
  const known = cookieSecretSync(env);
  if (known) return known;
  const [, select] = await env.DB.batch<{ value: string }>([
    env.DB
      .prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING`)
      .bind(SETTING_COOKIE_SECRET, randomToken(48)),
    settingStmt(env.DB, SETTING_COOKIE_SECRET),
  ]);
  const value = select?.results[0]?.value;
  if (!value) throw new Error("cookie secret could not be initialised");
  cachedSecret = { db: env.DB, value };
  return value;
}
