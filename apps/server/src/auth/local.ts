import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import type { Store, UserRecord } from "../db/store.js";

export interface MachineIdentity {
  type: "machine";
  apiKeyId: string;
  /** Owner of the key. Null only for a legacy key not yet adopted by the first account. */
  userId: string | null;
  name: string;
  scopes: string[];
  subject: string | null;
}

export interface UserIdentity {
  type: "user";
  userId: string;
  email: string;
  /** SHA-256 of the presented session token (identifies this session). */
  sessionTokenHash: string;
  /** True when this request slid the session's expiry forward. */
  sessionRefreshed: boolean;
}

/** Public user shape returned by the auth API. */
export interface PublicUser {
  id: string;
  email: string;
  createdAt: string;
}

export const SESSION_COOKIE = "maradocs_session";
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Sliding window: extend a session at most once per hour of activity. */
export const SESSION_TOUCH_MS = 60 * 60 * 1000;
export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 1024;
export const API_KEY_PREFIX = "mdo_";

export function sha256hex(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function publicUser(user: UserRecord): PublicUser {
  return { id: user.id, email: user.email, createdAt: user.createdAt };
}

export function newSessionToken(): { rawToken: string; tokenHash: string } {
  const rawToken = crypto.randomBytes(32).toString("base64url");
  return { rawToken, tokenHash: sha256hex(rawToken) };
}

/** Constant-time string comparison (via fixed-length digests). */
export function safeEqual(a: string, b: string): boolean {
  return crypto.timingSafeEqual(
    crypto.createHash("sha256").update(a).digest(),
    crypto.createHash("sha256").update(b).digest(),
  );
}

export class LocalAuth {
  /** Hash verified against when the email is unknown, so timing doesn't reveal it. */
  private dummyHash: Promise<string>;

  constructor(
    private store: Store,
    private bcryptRounds = 12,
  ) {
    this.dummyHash = bcrypt.hash(crypto.randomBytes(16).toString("hex"), bcryptRounds);
  }

  async verifyApiKey(secret: string): Promise<MachineIdentity | null> {
    if (!secret.startsWith(API_KEY_PREFIX)) return null;
    const key = this.store.getApiKeyByHash(sha256hex(secret));
    if (!key) return null;
    this.store.touchApiKey(key.id);
    return {
      type: "machine",
      apiKeyId: key.id,
      userId: key.userId,
      name: key.name,
      scopes: key.scopes,
      subject: null,
    };
  }

  /**
   * Resolve a session token. Expired sessions are deleted when presented.
   * Sessions slide: once `last_seen` is over an hour old, the expiry moves to
   * now + 30 days.
   */
  async verifySession(token: string): Promise<UserIdentity | null> {
    if (!token || token.startsWith(API_KEY_PREFIX)) return null;
    const tokenHash = sha256hex(token);
    const session = this.store.getSessionByHash(tokenHash);
    if (!session) return null;
    const now = Date.now();
    if (Date.parse(session.expiresAt) <= now) {
      this.store.deleteSession(tokenHash);
      return null;
    }
    const user = this.store.getUserById(session.userId);
    if (!user) {
      this.store.deleteSession(tokenHash);
      return null;
    }
    let sessionRefreshed = false;
    if (now - Date.parse(session.lastSeen) > SESSION_TOUCH_MS) {
      this.store.touchSession(
        tokenHash,
        new Date(now).toISOString(),
        new Date(now + SESSION_TTL_MS).toISOString(),
      );
      sessionRefreshed = true;
    }
    return { type: "user", userId: user.id, email: user.email, sessionTokenHash: tokenHash, sessionRefreshed };
  }

  /** Create a session for `userId`; returns the raw token (never stored). */
  createSession(userId: string, userAgent?: string | null): string {
    const { rawToken, tokenHash } = newSessionToken();
    this.store.createSession({
      tokenHash,
      userId,
      expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString(),
      userAgent: userAgent ?? null,
    });
    return rawToken;
  }

  /**
   * Check an email/password pair. Unknown emails still run a bcrypt compare
   * against a dummy hash so response timing doesn't reveal which emails exist.
   */
  async checkCredentials(email: string, password: string): Promise<{
    user: UserRecord | null;
    ok: boolean;
  }> {
    const user = this.store.getUserByEmail(email);
    if (!user) {
      await bcrypt.compare(password, await this.dummyHash);
      return { user: null, ok: false };
    }
    return { user, ok: await bcrypt.compare(password, user.passwordHash) };
  }

  async verifyUserPassword(user: UserRecord, password: string): Promise<boolean> {
    return bcrypt.compare(password, user.passwordHash);
  }

  hashPassword(password: string): Promise<string> {
    return hashPassword(password, this.bcryptRounds);
  }
}

export async function hashPassword(password: string, rounds = 12): Promise<string> {
  return bcrypt.hash(password, rounds);
}
