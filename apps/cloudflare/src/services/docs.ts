import type { AccessMode, DocumentSummary, DocumentVersion } from "../vendor/shared/index.js";
import { badRequest, conflict, notFound } from "../errors.js";
import { hashPassword } from "../crypto.js";
import { reportsBaseUrl, defer, nowIso } from "../http.js";
import {
  presentDoc,
  presentVersion,
  versionColumns,
  type DocRow,
  type RepoRow,
  type VersionRow,
} from "../db/rows.js";
import { ownerId } from "../middleware.js";
import type { Actor, AppContext } from "../types.js";
import { auditStmt } from "./audit.js";
import { deleteBlobs } from "./repos.js";
import { parseManifest, planZip, writeZip } from "./bundle.js";

const repoNotFound = (repo: string) => notFound(`Repository '${repo}' not found`);
const docNotFound = (repo: string, doc: string) => notFound(`Document '${repo}/${doc}' not found`);

type DocListRow = DocRow & {
  latest_version_number: number | null;
  latest_size_bytes: number | null;
  latest_file_count: number | null;
  latest_published_at: string | null;
  version_count: number;
};

export interface DocumentDetail extends DocumentSummary {
  /**
   * Whether the document has its own password. `hasPassword` (shared machine
   * shape) is the effective value, which also covers the repository fallback.
   */
  hasOwnPassword: boolean;
  versionCount: number;
  latestSizeBytes: number | null;
  latestFileCount: number | null;
  latestPublishedAt: string | null;
}

const DOC_LIST_SQL = `SELECT d.*, v.version_number AS latest_version_number, v.size_bytes AS latest_size_bytes,
         v.file_count AS latest_file_count, v.created_at AS latest_published_at,
         (SELECT COUNT(*) FROM document_versions c WHERE c.document_id = d.id) AS version_count
  FROM documents d
  JOIN repositories r ON r.id = d.repository_id
  LEFT JOIN document_versions v ON v.id = d.latest_version_id`;

function presentDetail(repo: RepoRow, row: DocListRow, base: string): DocumentDetail {
  return {
    ...presentDoc(repo, row, row.latest_version_number, base),
    hasOwnPassword: row.password_hash != null,
    versionCount: row.version_count,
    latestSizeBytes: row.latest_size_bytes,
    latestFileCount: row.latest_file_count,
    latestPublishedAt: row.latest_published_at,
  };
}

async function loadDocs(c: AppContext, repoSlug: string): Promise<{ repo: RepoRow; rows: DocListRow[] }> {
  const db = c.env.DB;
  const owner = ownerId(c);
  const [repoRes, docsRes] = await db.batch([
    db.prepare(`SELECT * FROM repositories WHERE slug = ? AND owner_id = ?`).bind(repoSlug, owner),
    db.prepare(`${DOC_LIST_SQL} WHERE r.slug = ? AND r.owner_id = ? ORDER BY d.updated_at DESC`).bind(repoSlug, owner),
  ]);
  const repo = repoRes?.results[0] as RepoRow | undefined;
  if (!repo) throw repoNotFound(repoSlug);
  return { repo, rows: (docsRes?.results ?? []) as DocListRow[] };
}

/** Machine API listing: exactly the Node server's DocumentSummary shape. */
export async function listDocs(c: AppContext, repoSlug: string): Promise<DocumentSummary[]> {
  const { repo, rows } = await loadDocs(c, repoSlug);
  const base = reportsBaseUrl(c);
  return rows.map((row) => presentDoc(repo, row, row.latest_version_number, base));
}

/** Dashboard listing with version stats. */
export async function listDocDetails(c: AppContext, repoSlug: string): Promise<DocumentDetail[]> {
  const { repo, rows } = await loadDocs(c, repoSlug);
  const base = reportsBaseUrl(c);
  return rows.map((row) => presentDetail(repo, row, base));
}

export async function getDocDetail(c: AppContext, repoSlug: string, docSlug: string): Promise<DocumentDetail> {
  const db = c.env.DB;
  const owner = ownerId(c);
  const [repoRes, docRes] = await db.batch([
    db.prepare(`SELECT * FROM repositories WHERE slug = ? AND owner_id = ?`).bind(repoSlug, owner),
    db.prepare(`${DOC_LIST_SQL} WHERE r.slug = ? AND r.owner_id = ? AND d.slug = ?`).bind(repoSlug, owner, docSlug),
  ]);
  const repo = repoRes?.results[0] as RepoRow | undefined;
  if (!repo) throw repoNotFound(repoSlug);
  const row = docRes?.results[0] as DocListRow | undefined;
  if (!row) throw docNotFound(repoSlug, docSlug);
  return presentDetail(repo, row, reportsBaseUrl(c));
}

export async function listVersions(c: AppContext, repoSlug: string, docSlug: string): Promise<DocumentVersion[]> {
  const db = c.env.DB;
  const owner = ownerId(c);
  const [repoRes, docRes, versionsRes] = await db.batch([
    db.prepare(`SELECT id FROM repositories WHERE slug = ? AND owner_id = ?`).bind(repoSlug, owner),
    db
      .prepare(
        `SELECT d.id, d.latest_version_id FROM documents d JOIN repositories r ON r.id = d.repository_id
         WHERE r.slug = ? AND r.owner_id = ? AND d.slug = ?`,
      )
      .bind(repoSlug, owner, docSlug),
    db
      .prepare(
        `SELECT ${versionColumns("v")} FROM document_versions v
         JOIN documents d ON d.id = v.document_id
         JOIN repositories r ON r.id = d.repository_id
         WHERE r.slug = ? AND r.owner_id = ? AND d.slug = ?
         ORDER BY v.version_number DESC`,
      )
      .bind(repoSlug, owner, docSlug),
  ]);
  if (!repoRes?.results[0]) throw repoNotFound(repoSlug);
  const doc = docRes?.results[0] as { id: string; latest_version_id: string | null } | undefined;
  if (!doc) throw docNotFound(repoSlug, docSlug);
  return ((versionsRes?.results ?? []) as VersionRow[]).map((v) => presentVersion(v, doc.latest_version_id));
}

interface DocContextRow {
  repo_id: string;
  repo_slug: string;
  default_access: AccessMode;
  repo_password_hash: string | null;
  doc_id: string | null;
}


export async function rollbackDocument(
  c: AppContext,
  repoSlug: string,
  docSlug: string,
  version: number,
  actor: Actor,
): Promise<DocumentSummary> {
  const db = c.env.DB;
  const ctxRow = await db
    .prepare(
      `SELECT r.slug AS repo_slug, r.default_access, r.password_hash AS repo_password_hash,
              d.id AS doc_id, v.id AS version_id, v.entrypoint AS version_entrypoint
       FROM repositories r
       LEFT JOIN documents d ON d.repository_id = r.id AND d.slug = ?2
       LEFT JOIN document_versions v ON v.document_id = d.id AND v.version_number = ?3
       WHERE r.slug = ?1 AND r.owner_id = ?4`,
    )
    .bind(repoSlug, docSlug, version, ownerId(c))
    .first<DocContextRow & { version_id: string | null; version_entrypoint: string | null }>();
  if (!ctxRow) throw repoNotFound(repoSlug);
  if (!ctxRow.doc_id) throw docNotFound(repoSlug, docSlug);
  if (!ctxRow.version_id) throw notFound(`Version ${version} not found`);

  // The update only applies while the version still exists, and the audit row
  // only commits if the update did (a concurrent delete leaves no trace).
  const [updated] = await db.batch<DocRow>([
    db
      .prepare(
        `UPDATE documents SET latest_version_id = ?1, entrypoint = ?2, updated_at = ?3
         WHERE id = ?4 AND EXISTS (SELECT 1 FROM document_versions WHERE id = ?1 AND document_id = ?4)
         RETURNING *`,
      )
      .bind(ctxRow.version_id, ctxRow.version_entrypoint, nowIso(), ctxRow.doc_id),
    auditStmt(
      db,
      { event: "doc.rollback", actor, repo: repoSlug, doc: docSlug, detail: `promoted v${version} to latest` },
      { sql: "EXISTS (SELECT 1 FROM documents WHERE id = ? AND latest_version_id = ?)", params: [ctxRow.doc_id, ctxRow.version_id] },
    ),
  ]);
  const doc = updated?.results[0];
  if (!doc) throw docNotFound(repoSlug, docSlug);
  return presentDoc(
    { slug: repoSlug, default_access: ctxRow.default_access, password_hash: ctxRow.repo_password_hash },
    doc,
    version,
    reportsBaseUrl(c),
  );
}

export async function deleteDocument(c: AppContext, repoSlug: string, docSlug: string, actor: Actor): Promise<void> {
  const db = c.env.DB;
  const row = await db
    .prepare(
      `SELECT r.id AS repo_id, d.id AS doc_id
       FROM repositories r LEFT JOIN documents d ON d.repository_id = r.id AND d.slug = ?2
       WHERE r.slug = ?1 AND r.owner_id = ?3`,
    )
    .bind(repoSlug, docSlug, ownerId(c))
    .first<{ repo_id: string; doc_id: string | null }>();
  if (!row) throw repoNotFound(repoSlug);
  const docId = row.doc_id;
  if (!docId) throw docNotFound(repoSlug, docSlug);

  // One transaction: the version rows deleted are exactly the blobs removed
  // (RETURNING), so a version committed concurrently is never orphaned, and
  // the audit row only commits if this request actually deleted the document.
  const [versions, , deleted] = await db.batch([
    db.prepare(`DELETE FROM document_versions WHERE document_id = ? RETURNING storage_path`).bind(docId),
    auditStmt(
      db,
      { event: "doc.delete", actor, repo: repoSlug, doc: docSlug, detail: null },
      { sql: "EXISTS (SELECT 1 FROM documents WHERE id = ?)", params: [docId] },
    ),
    db.prepare(`DELETE FROM documents WHERE id = ?`).bind(docId),
  ]);
  const keys = ((versions?.results ?? []) as { storage_path: string }[]).map((r) => r.storage_path);
  await deleteBlobs(c, keys);
  if (!deleted?.meta.changes) throw docNotFound(repoSlug, docSlug);
}

export interface PatchDocInput {
  title?: string;
  access?: AccessMode | null;
  password?: string | null;
}

/** Dashboard: change title / access override (null = inherit) / password (null = clear). */
export async function patchDocument(
  c: AppContext,
  repoSlug: string,
  docSlug: string,
  input: PatchDocInput,
  actor: Actor,
): Promise<DocumentDetail> {
  const db = c.env.DB;
  const config = c.get("config");
  const row = await db
    .prepare(
      `SELECT r.slug AS repo_slug, r.default_access, r.password_hash AS repo_password_hash,
              d.id AS doc_id, d.access_override, d.password_hash AS doc_password_hash
       FROM repositories r LEFT JOIN documents d ON d.repository_id = r.id AND d.slug = ?2
       WHERE r.slug = ?1 AND r.owner_id = ?3`,
    )
    .bind(repoSlug, docSlug, ownerId(c))
    .first<DocContextRow & { access_override: AccessMode | null; doc_password_hash: string | null }>();
  if (!row) throw repoNotFound(repoSlug);
  if (!row.doc_id) throw docNotFound(repoSlug, docSlug);

  const nextOverride = input.access !== undefined ? input.access : row.access_override;
  let nextDocHash = row.doc_password_hash;
  if (input.password !== undefined) {
    nextDocHash = input.password ? await hashPassword(input.password, config.pbkdf2Iterations) : null;
  }
  if ((nextOverride ?? row.default_access) === "password" && !(nextDocHash ?? row.repo_password_hash)) {
    throw badRequest("A password is required when access is 'password'");
  }

  const changedAccess = input.access !== undefined || input.password !== undefined;
  const details: string[] = [];
  if (input.access !== undefined) details.push(`access=${input.access ?? "inherit"}`);
  if (input.password !== undefined) details.push(input.password ? "password set" : "password cleared");
  if (input.title !== undefined) details.push("title updated");

  // Guarded so that a document relying on the repository password can't be
  // left in 'password' access with no password by a concurrent repo update.
  const [updated] = await db.batch([
    db
      .prepare(
        `UPDATE documents SET title = COALESCE(?1, title), access_override = ?2, password_hash = ?3, updated_at = ?4
         WHERE id = ?5
           AND (?3 IS NOT NULL OR COALESCE(?2, (SELECT default_access FROM repositories WHERE id = documents.repository_id)) != 'password'
                OR EXISTS (SELECT 1 FROM repositories WHERE id = documents.repository_id AND password_hash IS NOT NULL))`,
      )
      .bind(input.title ?? null, nextOverride, nextDocHash, nowIso(), row.doc_id),
    auditStmt(
      db,
      {
        event: changedAccess ? "access.change" : "doc.update",
        actor,
        repo: repoSlug,
        doc: docSlug,
        detail: details.length ? details.join(" ") : "no changes",
      },
      { sql: "changes() > 0", params: [] },
    ),
  ]);
  if (!updated?.meta.changes) {
    const still = await db.prepare(`SELECT 1 FROM documents WHERE id = ?`).bind(row.doc_id).first();
    if (!still) throw docNotFound(repoSlug, docSlug);
    throw conflict("The repository password changed concurrently; a password is required when access is 'password'");
  }
  return getDocDetail(c, repoSlug, docSlug);
}

export interface BundleDownload {
  /** The zip bytes, streamed. */
  body: ReadableStream<Uint8Array>;
  length: number;
  versionNumber: number;
  checksum: string;
  entrypoint: string;
}

/**
 * Stream a version's files (latest when no number is given) as a stored zip,
 * straight from its packed blob. Uses the CRC-32s recorded at publish time;
 * versions published before they were recorded are read into memory once to
 * compute them.
 */
export async function getBundle(
  c: AppContext,
  repoSlug: string,
  docSlug: string,
  versionNumber?: number,
): Promise<BundleDownload> {
  const db = c.env.DB;
  const versionJoin =
    versionNumber !== undefined
      ? `v.document_id = d.id AND v.version_number = ?3`
      : `v.id = d.latest_version_id`;
  const row = await db
    .prepare(
      `SELECT r.id AS repo_id, d.id AS doc_id, v.version_number, v.checksum, v.entrypoint, v.storage_path,
              v.manifest, v.created_at
       FROM repositories r
       LEFT JOIN documents d ON d.repository_id = r.id AND d.slug = ?2
       LEFT JOIN document_versions v ON ${versionJoin}
       WHERE r.slug = ?1 AND r.owner_id = ?4`,
    )
    .bind(repoSlug, docSlug, versionNumber ?? null, ownerId(c))
    .first<{
      repo_id: string;
      doc_id: string | null;
      version_number: number | null;
      checksum: string;
      entrypoint: string;
      storage_path: string;
      manifest: string;
      created_at: string;
    }>();
  if (!row) throw repoNotFound(repoSlug);
  if (!row.doc_id) throw docNotFound(repoSlug, docSlug);
  if (row.version_number == null) {
    throw notFound(
      versionNumber !== undefined
        ? `Version ${versionNumber} of '${repoSlug}/${docSlug}' not found`
        : `Document '${repoSlug}/${docSlug}' has no versions`,
    );
  }
  const plan = planZip(parseManifest(row.manifest), new Date(row.created_at));
  let source: ReadableStream<Uint8Array> | Uint8Array | null = null;
  if (plan.blobLength > 0) {
    const object = await c.env.BUCKET.get(row.storage_path);
    if (!object) throw notFound(`Stored files for version ${row.version_number} are missing`);
    const legacy = plan.entries.some((e) => e.crc === null);
    source = legacy ? new Uint8Array(await object.arrayBuffer()) : object.body;
  }
  const { readable, writable } = new FixedLengthStream(plan.zipLength);
  defer(c, writeZip(plan, source, writable));
  return {
    body: readable,
    length: plan.zipLength,
    versionNumber: row.version_number,
    checksum: row.checksum,
    entrypoint: row.entrypoint,
  };
}
