import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import type { Store } from "../db/store.js";

export interface MachineIdentity {
  type: "machine";
  apiKeyId: string;
  name: string;
  scopes: string[];
  subject: string | null;
}

export interface UserIdentity {
  type: "user";
  userId: string;
  admin: boolean;
}

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export class LocalAuth {
  constructor(
    private store: Store,
    private passwordHash: string,
  ) {}

  async verifyApiKey(secret: string): Promise<MachineIdentity | null> {
    const key = this.store.getApiKeyByHash(sha256(secret));
    if (!key) return null;
    this.store.touchApiKey(key.id);
    return { type: "machine", apiKeyId: key.id, name: key.name, scopes: key.scopes, subject: null };
  }

  async verifySession(token: string): Promise<UserIdentity | null> {
    const session = this.store.getSessionByHash(sha256(token));
    if (!session) return null;
    return { type: "user", userId: "admin", admin: true };
  }

  async checkAdminPassword(password: string): Promise<boolean> {
    return bcrypt.compare(password, this.passwordHash);
  }
}

export async function hashPassword(password: string, rounds = 12): Promise<string> {
  return bcrypt.hash(password, rounds);
}
