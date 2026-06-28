import type { ServerConfig } from "./config.js";
import type { Store } from "./db/store.js";
import type { Storage } from "./services/storage.js";
import type { LocalAuth, MachineIdentity, UserIdentity } from "./auth/local.js";

export interface AppContext {
  config: ServerConfig;
  store: Store;
  storage: Storage;
  auth: LocalAuth;
}

declare module "fastify" {
  interface FastifyRequest {
    machine?: MachineIdentity;
    user?: UserIdentity;
    /** Raw bearer token extracted by requireUser; used by logout to hash and delete the session. */
    sessionToken?: string;
  }
  interface FastifyInstance {
    ctx: AppContext;
  }
}
