// Publishing a document version: validate, then stream the zip's files into
// ONE R2 blob, then commit everything in ONE transactional D1 batch. Version
// numbers are computed inside SQL, so concurrent publishes never collide.
//
// Memory: the request body (the zip is a view into it, see multipart.ts) plus
// one preallocated blob of the uncompressed files: about 2x the upload.

import type { AccessMode, PublishDocInput, PublishResult } from "../vendor/shared/index.js";
import { publishDocSchema } from "../vendor/shared/index.js";
import { badRequest, conflict, lengthRequired, notFound, payloadTooLarge } from "../errors.js";
import { hashPassword, newId } from "../crypto.js";
import { reportsBaseUrl, defer, docUrl, keepAlive, nowIso, versionUrl } from "../http.js";
import { ownerId } from "../middleware.js";
import type { Actor, AppContext } from "../types.js";
import { packBundle, parseBundle, resolveEntrypoint } from "./bundle.js";
import { multipartBoundary, parseMultipart } from "./multipart.js";

/** Multipart overhead allowed on top of MAX_UPLOAD_MB (boundaries, other fields). */
const MULTIPART_SLACK_BYTES = 1024 * 1024;

export interface ParsedUpload {
  fields: Record<string, string>;
  /** The zip bytes (a view into the request body). */
  file: Uint8Array | null;
}

/** Parse a multipart upload: string fields plus a zip under `file` (or `bundle`). */
export async function parseUpload(c: AppContext): Promise<ParsedUpload> {
  const { maxUploadBytes } = c.get("config");
  const contentType = c.req.header("content-type") ?? "";
  if (!multipartBoundary(contentType)) throw badRequest("Expected a multipart upload");
  // Size is checked BEFORE the body is buffered: without a declared length a
  // chunked upload could make the runtime buffer up to the edge's body limit.
  const lengthHeader = c.req.header("content-length");
  if (lengthHeader === undefined || !/^\d+$/.test(lengthHeader.trim())) {
    throw lengthRequired("Content-Length is required for uploads");
  }
  const limit = maxUploadBytes + MULTIPART_SLACK_BYTES;
  if (Number(lengthHeader) > limit) throw payloadTooLarge("Upload too large");
  let body: Uint8Array;
  try {
    body = new Uint8Array(await c.req.raw.arrayBuffer());
  } catch {
    throw badRequest("Expected a multipart upload");
  }
  if (body.byteLength > limit) throw payloadTooLarge("Upload too large");
  const { fields, files } = parseMultipart(body, contentType);
  const file = files.get("file") ?? files.get("bundle") ?? null;
  if (Object.keys(fields).length === 0 && !file) throw badRequest("Expected a multipart upload");
  return { fields, file: file?.data ?? null };
}

const OPTIONAL_FIELDS = ["title", "access", "password", "entrypoint"] as const;

/** Validate multipart fields; empty optional fields (common from HTML forms) count as absent. */
export function parsePublishFields(fields: Record<string, string>, docOverride?: string): PublishDocInput {
  const out: Record<string, unknown> = { doc: fields.doc };
  for (const key of OPTIONAL_FIELDS) {
    const value = fields[key];
    if (value !== undefined && value !== "") out[key] = value;
  }
  if (docOverride !== undefined) out.doc = docOverride;
  return publishDocSchema.parse(out);
}

interface TargetRow {
  repo_id: string;
  repo_slug: string;
  default_access: AccessMode;
  repo_password_hash: string | null;
  doc_id: string | null;
  access_override: AccessMode | null;
  doc_password_hash: string | null;
}

export async function publishDocument(
  c: AppContext,
  repoSlug: string,
  input: PublishDocInput,
  zip: Uint8Array,
  actor: Actor,
  mode: "create" | "replace",
): Promise<PublishResult> {
  const db = c.env.DB;
  const config = c.get("config");
  if (zip.byteLength > config.maxUploadBytes) throw payloadTooLarge("Upload too large");

  // 1. Existence checks before touching the zip.
  const target = await db
    .prepare(
      `SELECT r.id AS repo_id, r.slug AS repo_slug, r.default_access, r.password_hash AS repo_password_hash,
              d.id AS doc_id, d.access_override, d.password_hash AS doc_password_hash
       FROM repositories r
       LEFT JOIN documents d ON d.repository_id = r.id AND d.slug = ?2
       WHERE r.slug = ?1 AND r.owner_id = ?3`,
    )
    .bind(repoSlug, input.doc, ownerId(c))
    .first<TargetRow>();
  if (!target) throw notFound(`Repository '${repoSlug}' not found`);
  if (mode === "create" && target.doc_id) {
    throw conflict(`Document '${repoSlug}/${input.doc}' already exists`);
  }
  if (mode === "replace" && !target.doc_id) {
    throw notFound(`Document '${repoSlug}/${input.doc}' not found`);
  }

  const accessOverride = input.access ?? target.access_override ?? null;
  const effective = accessOverride ?? target.default_access;
  const hasPassword = Boolean(input.password) || (target.doc_password_hash ?? target.repo_password_hash) != null;
  if (effective === "password" && !hasPassword) {
    throw badRequest("A password is required when access is 'password'");
  }

  // 2. Validate the archive (names, sizes, overlap) without inflating
  //    anything, then inflate into one blob, verifying sizes and CRCs.
  const bundle = parseBundle(zip, config.maxUploadBytes);
  const packed = await packBundle(zip, bundle);
  const entrypoint = resolveEntrypoint(packed.files, input.entrypoint);
  const newPasswordHash = input.password ? await hashPassword(input.password, config.pbkdf2Iterations) : null;

  // 3. Upload the blob under a fresh key, then commit metadata atomically.
  //    Both run to completion even if the client disconnects, so a stored
  //    blob is never left without its version row because the request was
  //    cancelled in between.
  const versionId = newId("ver");
  const storageKey = `versions/${versionId}.bin`;
  await keepAlive(
    c,
    c.env.BUCKET.put(storageKey, packed.blob, {
      httpMetadata: { contentType: "application/octet-stream" },
      customMetadata: { checksum: packed.checksum, repo: repoSlug, doc: input.doc },
    }),
  );

  const now = nowIso();
  const newDocId = newId("doc");
  const statements: D1PreparedStatement[] = [];
  if (mode === "create") {
    statements.push(
      db
        .prepare(
          `INSERT INTO documents
             (id, repository_id, slug, title, access_override, password_hash, entrypoint, latest_version_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
           ON CONFLICT(repository_id, slug) DO NOTHING`,
        )
        .bind(newDocId, target.repo_id, input.doc, input.title ?? input.doc, accessOverride, newPasswordHash, entrypoint, now, now),
    );
  }
  // For "create" the version only attaches to the doc row WE inserted: if a
  // concurrent request won the race, nothing is inserted and we report 409.
  statements.push(
    db
      .prepare(
        `INSERT INTO document_versions
           (id, document_id, version_number, storage_path, manifest, checksum, file_count, size_bytes,
            entrypoint, published_by_type, published_by_id, published_by_label, created_at)
         SELECT ?1, d.id,
                COALESCE((SELECT MAX(version_number) FROM document_versions WHERE document_id = d.id), 0) + 1,
                ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11
         FROM documents d
         WHERE d.repository_id = ?12 AND d.slug = ?13 AND (?14 IS NULL OR d.id = ?14)`,
      )
      .bind(
        versionId,
        storageKey,
        JSON.stringify(packed.manifest),
        packed.checksum,
        packed.fileCount,
        packed.sizeBytes,
        entrypoint,
        actor.type,
        actor.id,
        actor.label,
        now,
        target.repo_id,
        input.doc,
        mode === "create" ? newDocId : null,
      ),
  );
  statements.push(
    db
      .prepare(
        `UPDATE documents SET
           latest_version_id = ?1,
           entrypoint = ?2,
           title = COALESCE(?3, title),
           access_override = CASE WHEN ?4 = 1 THEN ?5 ELSE access_override END,
           password_hash = COALESCE(?6, password_hash),
           updated_at = ?7
         WHERE id = (SELECT document_id FROM document_versions WHERE id = ?1)`,
      )
      .bind(versionId, entrypoint, input.title ?? null, input.access !== undefined ? 1 : 0, input.access ?? null, newPasswordHash, now),
  );
  statements.push(
    db
      .prepare(
        `INSERT INTO audit_log
           (id, event, actor_type, actor_id, actor_label, repository_slug, document_slug, detail, created_at, user_id)
         SELECT ?, ?, ?, ?, ?, ?, ?,
                'v' || v.version_number || ' access=' || COALESCE(d.access_override, r.default_access) || ' files=' || v.file_count,
                ?, r.owner_id
         FROM document_versions v
         JOIN documents d ON d.id = v.document_id
         JOIN repositories r ON r.id = d.repository_id
         WHERE v.id = ?`,
      )
      .bind(
        newId("audit"),
        mode === "create" ? "doc.publish" : "doc.replace",
        actor.type,
        actor.id,
        actor.label,
        repoSlug,
        input.doc,
        now,
        versionId,
      ),
  );
  statements.push(
    db
      .prepare(
        `SELECT v.version_number, COALESCE(d.access_override, r.default_access) AS access
         FROM document_versions v
         JOIN documents d ON d.id = v.document_id
         JOIN repositories r ON r.id = d.repository_id
         WHERE v.id = ?`,
      )
      .bind(versionId),
  );

  let saved: { version_number: number; access: AccessMode } | undefined;
  try {
    const results = await keepAlive(c, db.batch(statements));
    saved = results[results.length - 1]?.results[0] as typeof saved;
  } catch (err) {
    // D1 errors can be ambiguous (the commit may have happened): only delete
    // the blob once it is certain no version row references it. If even that
    // check fails, the blob is left for the scheduled orphan sweep.
    defer(
      c,
      (async () => {
        const row = await db.prepare(`SELECT 1 FROM document_versions WHERE id = ?`).bind(versionId).first();
        if (!row) await c.env.BUCKET.delete(storageKey);
      })(),
    );
    throw err;
  }
  if (!saved) {
    // The document appeared (create) or vanished (replace) concurrently.
    defer(c, c.env.BUCKET.delete(storageKey));
    if (mode === "create") throw conflict(`Document '${repoSlug}/${input.doc}' already exists`);
    throw notFound(`Document '${repoSlug}/${input.doc}' not found`);
  }

  const base = reportsBaseUrl(c);
  return {
    repo: repoSlug,
    doc: input.doc,
    versionNumber: saved.version_number,
    access: saved.access,
    url: docUrl(base, repoSlug, input.doc),
    versionUrl: versionUrl(base, repoSlug, input.doc, saved.version_number),
    fileCount: packed.fileCount,
    sizeBytes: packed.sizeBytes,
    checksum: packed.checksum,
  };
}
