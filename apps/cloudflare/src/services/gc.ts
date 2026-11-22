// Scheduled reconciliation of R2 with D1: removes version blobs that no
// document_versions row references (a publish whose metadata commit failed or
// was interrupted, or a delete whose blob removal failed). Runs from the cron
// trigger in wrangler.jsonc; cron triggers are available on the Free plan.

import type { Env } from "../env.js";

/** Blobs younger than this are skipped: their publish may still be committing. */
export const ORPHAN_MIN_AGE_MS = 60 * 60 * 1000;
/** R2 list pages (1000 keys each) per run; keeps a run far below 50 D1 queries. */
export const SWEEP_MAX_PAGES = 10;

export interface SweepResult {
  scanned: number;
  deleted: string[];
}

export async function sweepOrphanBlobs(
  env: Env,
  opts: { now?: number; maxPages?: number } = {},
): Promise<SweepResult> {
  const now = opts.now ?? Date.now();
  const maxPages = opts.maxPages ?? SWEEP_MAX_PAGES;
  const deleted: string[] = [];
  let scanned = 0;
  let cursor: string | undefined;
  for (let page = 0; page < maxPages; page += 1) {
    const listed = await env.BUCKET.list({ prefix: "versions/", limit: 1000, cursor });
    scanned += listed.objects.length;
    const candidates = listed.objects
      .filter((o) => now - o.uploaded.getTime() > ORPHAN_MIN_AGE_MS)
      .map((o) => o.key);
    if (candidates.length) {
      const { results } = await env.DB.prepare(
        `SELECT value AS key FROM json_each(?1)
         WHERE value NOT IN (SELECT storage_path FROM document_versions)`,
      )
        .bind(JSON.stringify(candidates))
        .all<{ key: string }>();
      const orphans = results.map((r) => r.key);
      if (orphans.length) {
        await env.BUCKET.delete(orphans);
        deleted.push(...orphans);
      }
    }
    if (!listed.truncated) break;
    cursor = listed.cursor;
  }
  if (deleted.length) console.log(`orphan sweep: removed ${deleted.length} unreferenced blob(s)`);
  return { scanned, deleted };
}
