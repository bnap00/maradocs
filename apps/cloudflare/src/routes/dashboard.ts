// Dashboard API (`/api/v1/dashboard`, account session). A superset of the
// Node server's dashboard API used by the SPA. Everything is scoped to the
// signed-in account.

import { Hono } from "hono";
import { z } from "zod";
import {
  accessModeSchema,
  createRepoSchema,
  rollbackSchema,
  slugSchema,
  updateRepoSchema,
} from "../vendor/shared/index.js";
import { APP_VERSION } from "../env.js";
import { reportsBaseUrl, docUrl, readJson, requestOrigin } from "../http.js";
import {
  presentAudit,
  presentMachine,
  versionColumns,
  type AuditRow,
  type MachineRow,
  type VersionRow,
} from "../db/rows.js";
import { defaultRepoAccessKey, getDefaultRepoAccess, putSettingStmt } from "../db/settings.js";
import { docParam, ownerId, repoParam, requireSession, userActor } from "../middleware.js";
import { auditStmt } from "../services/audit.js";
import {
  createRepo,
  deleteRepo,
  getRepoWithStats,
  listReposWithStats,
  updateRepo,
} from "../services/repos.js";
import {
  deleteDocument,
  getDocDetail,
  listDocDetails,
  listVersions,
  patchDocument,
  rollbackDocument,
} from "../services/docs.js";
import type { AppContext, AppEnv } from "../types.js";
import { handleBundle, handlePublish } from "./shared.js";
import { changePassword, logoutOthers } from "./auth.js";

const patchDocSchema = z.object({
  title: z.string().min(1).max(160).optional(),
  access: accessModeSchema.nullable().optional(),
  password: z.string().min(4).max(256).nullable().optional(),
});

const auditQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  before: z.string().max(200).optional(),
  repo: slugSchema.optional(),
  event: z
    .string()
    .max(64)
    .regex(/^[a-z_]+(\.[a-z_]*)?\*?$/, "invalid event filter")
    .optional(),
});

const settingsPatchSchema = z.object({ defaultRepoAccess: accessModeSchema });

export const dashboardRoutes = new Hono<AppEnv>();

dashboardRoutes.use("*", requireSession);

dashboardRoutes.get("/me", (c) => {
  const u = c.get("user")!;
  return c.json({
    user: { id: u.userId, email: u.email, createdAt: u.createdAt },
    session: { expiresAt: c.get("sessionExpiresAt") },
  });
});

dashboardRoutes.get("/overview", async (c) => {
  const db = c.env.DB;
  const owner = ownerId(c);
  const docsOf = `SELECT d.id FROM documents d JOIN repositories r ON r.id = d.repository_id WHERE r.owner_id = ?1`;
  const [counts, recent, audit] = await db.batch([
    db
      .prepare(
        `SELECT (SELECT COUNT(*) FROM repositories WHERE owner_id = ?1) AS repos,
                (SELECT COUNT(*) FROM (${docsOf})) AS docs,
                (SELECT COUNT(*) FROM document_versions WHERE document_id IN (${docsOf})) AS versions,
                (SELECT COUNT(*) FROM api_keys WHERE user_id = ?1) AS api_keys,
                (SELECT COUNT(*) FROM machines WHERE user_id = ?1) AS machines,
                (SELECT COALESCE(SUM(size_bytes), 0) FROM document_versions WHERE document_id IN (${docsOf})) AS stored_bytes`,
      )
      .bind(owner),
    db
      .prepare(
        `SELECT ${versionColumns("v")}, d.slug AS doc_slug, d.title AS doc_title, d.latest_version_id,
                r.slug AS repo_slug
         FROM document_versions v
         JOIN documents d ON d.id = v.document_id
         JOIN repositories r ON r.id = d.repository_id
         WHERE r.owner_id = ?
         ORDER BY v.created_at DESC LIMIT 10`,
      )
      .bind(owner),
    db.prepare(`SELECT * FROM audit_log WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 10`).bind(owner),
  ]);
  const n = counts?.results[0] as Record<string, number>;
  const base = reportsBaseUrl(c);
  type RecentRow = VersionRow & { doc_slug: string; doc_title: string; latest_version_id: string | null; repo_slug: string };
  return c.json({
    counts: {
      repos: n.repos ?? 0,
      docs: n.docs ?? 0,
      versions: n.versions ?? 0,
      apiKeys: n.api_keys ?? 0,
      machines: n.machines ?? 0,
    },
    storedBytes: n.stored_bytes ?? 0,
    recentPublishes: ((recent?.results ?? []) as RecentRow[]).map((v) => ({
      repo: v.repo_slug,
      doc: v.doc_slug,
      title: v.doc_title,
      versionNumber: v.version_number,
      fileCount: v.file_count,
      sizeBytes: v.size_bytes,
      checksum: v.checksum,
      publishedByType: v.published_by_type,
      publishedByLabel: v.published_by_label,
      isLatest: v.id === v.latest_version_id,
      createdAt: v.created_at,
      url: docUrl(base, v.repo_slug, v.doc_slug),
    })),
    recentAudit: ((audit?.results ?? []) as AuditRow[]).map(presentAudit),
  });
});

// ---- Repositories --------------------------------------------------------------

dashboardRoutes.get("/repos", async (c) => c.json({ repos: await listReposWithStats(c) }));

dashboardRoutes.post("/repos", async (c) => {
  const input = await readJson(c, createRepoSchema);
  const repo = await createRepo(c, input, userActor(c));
  return c.json({ repo: { ...repo, docCount: 0 } }, 201);
});

dashboardRoutes.get("/repos/:repo", async (c) => c.json({ repo: await getRepoWithStats(c, repoParam(c)) }));

dashboardRoutes.patch("/repos/:repo", async (c) => {
  const slug = repoParam(c);
  const input = await readJson(c, updateRepoSchema);
  await updateRepo(c, slug, input, userActor(c));
  return c.json({ repo: await getRepoWithStats(c, slug) });
});

dashboardRoutes.delete("/repos/:repo", async (c) => {
  await deleteRepo(c, repoParam(c), userActor(c));
  return c.json({ deleted: true });
});

// ---- Documents -----------------------------------------------------------------

dashboardRoutes.get("/repos/:repo/docs", async (c) => c.json({ docs: await listDocDetails(c, repoParam(c)) }));

dashboardRoutes.post("/repos/:repo/docs", async (c) => handlePublish(c, repoParam(c), userActor(c), "create"));

dashboardRoutes.get("/repos/:repo/docs/:doc", async (c) => {
  const repo = repoParam(c);
  return c.json({ doc: await getDocDetail(c, repo, docParam(c, repo)) });
});

dashboardRoutes.put("/repos/:repo/docs/:doc", async (c) => {
  const repo = repoParam(c);
  return handlePublish(c, repo, userActor(c), "replace", docParam(c, repo));
});

dashboardRoutes.patch("/repos/:repo/docs/:doc", async (c) => {
  const repo = repoParam(c);
  const doc = docParam(c, repo);
  const input = await readJson(c, patchDocSchema);
  return c.json({ doc: await patchDocument(c, repo, doc, input, userActor(c)) });
});

dashboardRoutes.delete("/repos/:repo/docs/:doc", async (c) => {
  const repo = repoParam(c);
  await deleteDocument(c, repo, docParam(c, repo), userActor(c));
  return c.json({ deleted: true });
});

dashboardRoutes.get("/repos/:repo/docs/:doc/versions", async (c) => {
  const repo = repoParam(c);
  return c.json({ versions: await listVersions(c, repo, docParam(c, repo)) });
});

dashboardRoutes.get("/repos/:repo/docs/:doc/bundle", async (c) => {
  const repo = repoParam(c);
  return handleBundle(c, repo, docParam(c, repo));
});

dashboardRoutes.post("/repos/:repo/docs/:doc/rollback", async (c) => {
  const repo = repoParam(c);
  const doc = docParam(c, repo);
  const { version } = await readJson(c, rollbackSchema);
  return c.json({ doc: await rollbackDocument(c, repo, doc, version, userActor(c)) });
});

// ---- Machines & audit ------------------------------------------------------------

dashboardRoutes.get("/machines", async (c) => {
  const { results } = await c.env.DB
    .prepare(
      `SELECT m.*, CASE WHEN k.id IS NULL THEN 1 ELSE 0 END AS revoked
       FROM machines m LEFT JOIN api_keys k ON k.id = m.key_id
       WHERE m.user_id = ?
       ORDER BY m.last_used_at DESC NULLS LAST`,
    )
    .bind(ownerId(c))
    .all<MachineRow & { revoked: number }>();
  return c.json({ machines: results.map((m) => ({ ...presentMachine(m), revoked: m.revoked === 1 })) });
});

dashboardRoutes.get("/audit", async (c) => {
  const q = auditQuerySchema.parse(c.req.query());
  // Cursor is "<createdAt>|<id>" (as returned in nextCursor); a bare createdAt also works.
  let beforeAt: string | null = null;
  let beforeId = "";
  if (q.before) {
    const sep = q.before.indexOf("|");
    beforeAt = sep >= 0 ? q.before.slice(0, sep) : q.before;
    beforeId = sep >= 0 ? q.before.slice(sep + 1) : "";
  }
  let eventExact: string | null = null;
  let eventPrefix: string | null = null;
  if (q.event) {
    if (q.event.endsWith("*")) eventPrefix = q.event.slice(0, -1);
    else eventExact = q.event;
  }
  const { results } = await c.env.DB
    .prepare(
      `SELECT * FROM audit_log
       WHERE user_id = ?7
         AND (?1 IS NULL OR repository_slug = ?1)
         AND (?2 IS NULL OR event = ?2)
         AND (?3 IS NULL OR substr(event, 1, length(?3)) = ?3)
         AND (?4 IS NULL OR created_at < ?4 OR (created_at = ?4 AND id < ?5))
       ORDER BY created_at DESC, id DESC
       LIMIT ?6`,
    )
    .bind(q.repo ?? null, eventExact, eventPrefix, beforeAt, beforeId, q.limit + 1, ownerId(c))
    .all<AuditRow>();
  const page = results.slice(0, q.limit);
  const last = page[page.length - 1];
  return c.json({
    audit: page.map(presentAudit),
    nextCursor: results.length > q.limit && last ? `${last.created_at}|${last.id}` : null,
  });
});

// ---- Settings & account --------------------------------------------------------------

async function settingsPayload(c: AppContext) {
  const config = c.get("config");
  return {
    defaultRepoAccess: await getDefaultRepoAccess(c.env.DB, config, ownerId(c)),
    maxUploadMb: Math.round((config.maxUploadBytes / (1024 * 1024)) * 100) / 100,
    publicBaseUrl: config.publicBaseUrl,
    serverUrl: config.publicBaseUrl ?? requestOrigin(c),
    registration: config.registration,
    version: APP_VERSION,
  };
}

dashboardRoutes.get("/settings", async (c) => c.json(await settingsPayload(c)));

dashboardRoutes.patch("/settings", async (c) => {
  const input = await readJson(c, settingsPatchSchema);
  const db = c.env.DB;
  const owner = ownerId(c);
  const previous = await getDefaultRepoAccess(db, c.get("config"), owner);
  await db.batch([
    putSettingStmt(db, defaultRepoAccessKey(owner), input.defaultRepoAccess),
    auditStmt(db, {
      event: "settings.update",
      actor: userActor(c),
      detail: `defaultRepoAccess ${previous} -> ${input.defaultRepoAccess}`,
    }),
  ]);
  return c.json(await settingsPayload(c));
});

// Aliases of POST /api/v1/auth/change-password and /logout-others.
dashboardRoutes.post("/password", changePassword);
dashboardRoutes.post("/sessions/revoke-all", logoutOthers);
