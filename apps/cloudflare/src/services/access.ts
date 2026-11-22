import type { AccessMode } from "../vendor/shared/index.js";
import { DEFAULTS } from "../vendor/shared/index.js";
import { hmacSha256Hex, passwordBinding, timingSafeEqual } from "../crypto.js";

export interface AccessFields {
  default_access: AccessMode;
  repo_password_hash: string | null;
  access_override: AccessMode | null;
  doc_password_hash: string | null;
}

/** Document override wins, otherwise the repository default applies. */
export function effectiveAccess(f: Pick<AccessFields, "default_access" | "access_override">): AccessMode {
  return f.access_override ?? f.default_access;
}

/** Doc-level password wins over the repository password. */
export function effectivePasswordHash(
  f: Pick<AccessFields, "repo_password_hash" | "doc_password_hash">,
): string | null {
  return f.doc_password_hash ?? f.repo_password_hash;
}

export function unlockCookieName(repo: string, doc: string): string {
  return `${DEFAULTS.PASSWORD_COOKIE_PREFIX}${repo}__${doc}`;
}

export function unlockCookiePath(repo: string, doc: string): string {
  return `/r/${repo}/${doc}`;
}

/** Short-lived cookie carrying an owner-session view token for one document (see serveDocument). */
export function viewCookieName(repo: string, doc: string): string {
  return `maradocs_view_${repo}__${doc}`;
}

/**
 * The unlock cookie binds the document and its current password (by salt, see
 * passwordBinding), so a cookie for one doc can't unlock another and setting
 * a new password invalidates every previously issued cookie.
 */
export function signUnlock(secret: string, repo: string, doc: string, passwordHash: string): Promise<string> {
  return hmacSha256Hex(secret, `${repo}/${doc}:${passwordBinding(passwordHash)}`);
}

export async function verifyUnlock(
  secret: string,
  repo: string,
  doc: string,
  passwordHash: string,
  cookieValue: string | undefined,
): Promise<boolean> {
  if (!cookieValue) return false;
  return timingSafeEqual(await signUnlock(secret, repo, doc, passwordHash), cookieValue);
}
