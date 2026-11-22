import type { ServerConfig } from "./config.js";
import type { Store } from "./db/store.js";
import type { Storage } from "./services/storage.js";
import type { LocalAuth, MachineIdentity, UserIdentity } from "./auth/local.js";

export interface AppContext {
  config: ServerConfig;
  store: Store;
  storage: Storage;
  auth: LocalAuth;
  /** Resolved secret for signing cookies (COOKIE_SECRET or the generated, persisted one). */
  cookieSecret: string;
}

declare module "fastify" {
  interface FastifyRequest {
    machine?: MachineIdentity;
    user?: UserIdentity;
  }
  interface FastifyInstance {
    ctx: AppContext;
  }
}
