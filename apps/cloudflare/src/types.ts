import type { Context } from "hono";
import type { Config, Env } from "./env.js";

export type ActorType = "machine" | "user" | "system";

/** Who performed an action; recorded on versions and audit entries. */
export interface Actor {
  type: ActorType;
  id: string | null;
  label: string | null;
  /** The account whose resources the action concerns (audit_log.user_id). */
  userId?: string | null;
}

export interface MachineIdentity {
  type: "machine";
  apiKeyId: string;
  name: string;
  scopes: string[];
  /** Owner of the API key. */
  userId: string;
}

export interface UserIdentity {
  type: "user";
  userId: string;
  email: string;
  createdAt: string;
}

export interface Variables {
  config: Config;
  machine?: MachineIdentity;
  user?: UserIdentity;
  /** The account the request acts for (session user or API key owner). */
  ownerId?: string;
  /** sha256 of the session token used for this request. */
  sessionHash?: string;
  sessionExpiresAt?: string;
}

export type AppEnv = { Bindings: Env; Variables: Variables };
export type AppContext = Context<AppEnv>;
