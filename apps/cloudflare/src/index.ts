// MaraDocs Worker entrypoint. See app.ts for the HTTP surface.
import { app } from "./app.js";
import type { Env } from "./env.js";
import { ensureSchema } from "./schema.js";
import { sweepOrphanBlobs } from "./services/gc.js";

export default {
  fetch: app.fetch,
  /** Daily cron (wrangler.jsonc `triggers`): reconcile R2 blobs with D1. */
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      (async () => {
        await ensureSchema(env.DB);
        await sweepOrphanBlobs(env);
      })(),
    );
  },
} satisfies ExportedHandler<Env>;
