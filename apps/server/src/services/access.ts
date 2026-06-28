import bcrypt from "bcryptjs";
import { createHmac, timingSafeEqual } from "node:crypto";
import type { AccessMode } from "@maradocs/shared";
import { DEFAULTS } from "@maradocs/shared";
import type { RepoRecord, DocRecord } from "../db/store.js";

/** Hash a password with bcrypt. Plaintext is never persisted. */
export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 12);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

/**
 * Effective access for a document: the document override wins, otherwise the
 * repository default applies.
 */
export function effectiveAccess(repo: RepoRecord, doc: DocRecord): AccessMode {
  return doc.accessOverride ?? repo.defaultAccess;
}

/** Effective password hash gating a document (doc-level wins over repo-level). */
export function effectivePasswordHash(
  repo: RepoRecord,
  doc: DocRecord,
): string | null {
  return doc.passwordHash ?? repo.passwordHash;
}

// ---- Signed password cookies ----------------------------------------------

export function passwordCookieName(repo: string, doc: string): string {
  return `${DEFAULTS.PASSWORD_COOKIE_PREFIX}${repo}__${doc}`;
}

/**
 * The cookie value binds the unlock to the current password hash, so rotating
 * the password invalidates previously issued cookies automatically.
 */
export function signPasswordCookie(secret: string, passwordHash: string): string {
  return createHmac("sha256", secret).update(passwordHash).digest("hex");
}

export function verifyPasswordCookie(
  secret: string,
  passwordHash: string,
  cookieValue: string | undefined,
): boolean {
  if (!cookieValue) return false;
  const expected = signPasswordCookie(secret, passwordHash);
  const a = Buffer.from(expected);
  const b = Buffer.from(cookieValue);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
