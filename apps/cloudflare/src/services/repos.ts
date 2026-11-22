import type { CreateRepoInput, Repository, UpdateRepoInput } from "../vendor/shared/index.js";
import { badRequest, conflict, notFound } from "../errors.js";
import { hashPassword, newId } from "../crypto.js";
import { defer, nowIso } from "../http.js";
import { presentRepo, type RepoRow } from "../db/rows.js";
import { getDefaultRepoAccess } from "../db/settings.js";
import { ownerId } from "../middleware.js";
import type { Actor, AppContext } from "../types.js";
import { auditStmt } from "./audit.js";

// Every lookup is scoped to the caller's account: another user's repository
// is indistinguishable from a missing one (404). Slugs stay globally unique
// because they are part of the public /r/<repo>/<doc> URLs.

export async function getRepoRow(c: AppContext, slug: string): Promise<RepoRow> {
  const row = await c.env.DB
    .prepare(`SELECT * FROM repositories WHERE slug = ? AND owner_id = ?`)
    .bind(slug, ownerId(c))
    .first<RepoRow>();
  if (!row) throw notFound(`Repository '${slug}' not found`);
  return row;
}

export async function listRepos(c: AppContext): Promise<Repository[]> {
  const { results } = await c.env.DB
    .prepare(`SELECT * FROM repositories WHERE owner_id = ? ORDER BY created_at DESC`)
    .bind(ownerId(c))
    .all<RepoRow>();
  return results.map(presentRepo);
}

export interface RepositoryWithStats extends Repository {
  docCount: number;
}

/** Dashboard listing: repositories plus document counts, in one query. */
export async function listReposWithStats(c: AppContext): Promise<RepositoryWithStats[]> {
  const { results } = await c.env.DB
    .prepare(
      `SELECT r.*, (SELECT COUNT(*) FROM documents d WHERE d.repository_id = r.id) AS doc_count
       FROM repositories r WHERE r.owner_id = ? ORDER BY r.created_at DESC`,
    )
    .bind(ownerId(c))
    .all<RepoRow & { doc_count: number }>();
  return results.map((row) => ({ ...presentRepo(row), docCount: row.doc_count }));
}

export async function getRepoWithStats(c: AppContext, slug: string): Promise<RepositoryWithStats> {
  const row = await c.env.DB
    .prepare(
      `SELECT r.*, (SELECT COUNT(*) FROM documents d WHERE d.repository_id = r.id) AS doc_count
       FROM repositories r WHERE r.slug = ? AND r.owner_id = ?`,
    )
    .bind(slug, ownerId(c))
    .first<RepoRow & { doc_count: number }>();
  if (!row) throw notFound(`Repository '${slug}' not found`);
  return { ...presentRepo(row), docCount: row.doc_count };
}

export async function createRepo(c: AppContext, input: CreateRepoInput, actor: Actor): Promise<Repository> {
  const db = c.env.DB;
  const config = c.get("config");
  const owner = ownerId(c);
  const access = input.access ?? (await getDefaultRepoAccess(db, config, owner));
  if (access === "password" && !input.password) {
    throw badRequest("A password is required when access is 'password'");
  }
  const passwordHash = input.password ? await hashPassword(input.password, config.pbkdf2Iterations) : null;
  const ts = nowIso();
  const row: RepoRow = {
    id: newId("repo"),
    slug: input.slug,
    name: input.name ?? input.slug,
    description: input.description ?? null,
    default_access: access,
    index_enabled: input.indexEnabled ? 1 : 0,
    password_hash: passwordHash,
    owner_id: owner,
    created_at: ts,
    updated_at: ts,
  };
  const [insert] = await db.batch([
    db
      .prepare(
        `INSERT INTO repositories
           (id, slug, name, description, default_access, index_enabled, password_hash, owner_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(slug) DO NOTHING`,
      )
      .bind(
        row.id,
        row.slug,
        row.name,
        row.description,
        row.default_access,
        row.index_enabled,
        row.password_hash,
        owner,
        ts,
        ts,
      ),
    auditStmt(
      db,
      { event: "repo.create", actor, repo: row.slug, detail: `access=${access}` },
      { sql: "EXISTS (SELECT 1 FROM repositories WHERE id = ?)", params: [row.id] },
    ),
  ]);
  if (!insert?.meta.changes) {
    const existing = await db
      .prepare(`SELECT owner_id FROM repositories WHERE slug = ?`)
      .bind(input.slug)
      .first<{ owner_id: string | null }>();
    if (existing && existing.owner_id === owner) throw conflict(`Repository '${input.slug}' already exists`);
    throw conflict(`Repository slug '${input.slug}' is already taken`);
  }
  return presentRepo(row);
}

export async function updateRepo(
  c: AppContext,
  slug: string,
  input: UpdateRepoInput,
  actor: Actor,
): Promise<Repository> {
  const db = c.env.DB;
  const config = c.get("config");
  const repo = await getRepoRow(c, slug);

  const nextAccess = input.access ?? repo.default_access;
  let nextHash = repo.password_hash;
  if (input.password !== undefined) {
    nextHash = input.password ? await hashPassword(input.password, config.pbkdf2Iterations) : null;
  }
  if (nextAccess === "password" && !nextHash) {
    throw badRequest("A password is required when access is 'password'");
  }
  // Documents in 'password' access without their own password rely on the
  // repository password; clearing it would lock every visitor out of them.
  const strandedSql = `SELECT slug FROM documents
    WHERE repository_id = ?1 AND password_hash IS NULL AND COALESCE(access_override, ?2) = 'password'
    ORDER BY slug LIMIT 20`;
  if (!nextHash) {
    const { results } = await db.prepare(strandedSql).bind(repo.id, nextAccess).all<{ slug: string }>();
    if (results.length) throw strandedError(results.map((r) => r.slug));
  }

  const changedAccess = input.access !== undefined || input.password !== undefined;
  const details: string[] = [];
  if (input.access) details.push(`access=${input.access}`);
  if (input.password !== undefined) details.push(input.password ? "password set" : "password cleared");
  // The guard re-checks the invariant inside the transaction (a concurrent
  // publish/patch could have added such a document since the check above).
  const [updated] = await db.batch<RepoRow>([
    db
      .prepare(
        `UPDATE repositories SET
           name = ?1, description = ?2, default_access = ?3, index_enabled = ?4, password_hash = ?5, updated_at = ?6
         WHERE id = ?7
           AND (?5 IS NOT NULL OR NOT EXISTS (
             SELECT 1 FROM documents WHERE repository_id = ?7 AND password_hash IS NULL
               AND COALESCE(access_override, ?3) = 'password'))
         RETURNING *`,
      )
      .bind(
        input.name ?? repo.name,
        input.description !== undefined ? input.description : repo.description,
        nextAccess,
        input.indexEnabled !== undefined ? (input.indexEnabled ? 1 : 0) : repo.index_enabled,
        nextHash,
        nowIso(),
        repo.id,
      ),
    auditStmt(
      db,
      {
        event: changedAccess ? "access.change" : "repo.update",
        actor,
        repo: repo.slug,
        detail: details.length ? details.join(" ") : "metadata updated",
      },
      { sql: "changes() > 0", params: [] },
    ),
  ]);
  const row = updated?.results[0];
  if (!row) {
    const still = await db.prepare(`SELECT id FROM repositories WHERE id = ?`).bind(repo.id).first();
    if (!still) throw notFound(`Repository '${slug}' not found`);
    const { results } = await db.prepare(strandedSql).bind(repo.id, nextAccess).all<{ slug: string }>();
    throw strandedError(results.map((r) => r.slug));
  }
  return presentRepo(row);
}

function strandedError(docs: string[]) {
  return badRequest(
    `Cannot remove the repository password: these documents use 'password' access without their own password ` +
      `(${docs.join(", ")}). Give them a password or change their access first.`,
    { documents: docs },
  );
}

/** Delete a repository with all documents, versions and stored blobs. */
export async function deleteRepo(c: AppContext, slug: string, actor: Actor): Promise<void> {
  const db = c.env.DB;
  const repo = await db
    .prepare(`SELECT id FROM repositories WHERE slug = ? AND owner_id = ?`)
    .bind(slug, ownerId(c))
    .first<{ id: string }>();
  if (!repo) throw notFound(`Repository '${slug}' not found`);
  const repoId = repo.id;

  // RETURNING yields exactly the blobs of the rows this transaction deleted,
  // including versions committed concurrently since any earlier read.
  const [versions, , , deleted] = await db.batch([
    db
      .prepare(
        `DELETE FROM document_versions WHERE document_id IN (SELECT id FROM documents WHERE repository_id = ?)
         RETURNING storage_path`,
      )
      .bind(repoId),
    db.prepare(`DELETE FROM documents WHERE repository_id = ?`).bind(repoId),
    auditStmt(
      db,
      { event: "repo.delete", actor, repo: slug, detail: "repository, documents and versions removed" },
      { sql: "EXISTS (SELECT 1 FROM repositories WHERE id = ?)", params: [repoId] },
    ),
    db.prepare(`DELETE FROM repositories WHERE id = ?`).bind(repoId),
  ]);
  const keys = ((versions?.results ?? []) as { storage_path: string }[]).map((r) => r.storage_path);
  await deleteBlobs(c, keys);
  if (!deleted?.meta.changes) throw notFound(`Repository '${slug}' not found`);
}

/** Delete R2 objects in chunks of 1000 (the per-call limit). */
export async function deleteBlobs(c: AppContext, keys: string[]): Promise<void> {
  const chunks: string[][] = [];
  for (let i = 0; i < keys.length; i += 1000) chunks.push(keys.slice(i, i + 1000));
  try {
    await Promise.all(chunks.map((chunk) => c.env.BUCKET.delete(chunk)));
  } catch (err) {
    // Metadata is already gone; retry once in the background rather than fail the request.
    console.error("blob delete failed, retrying in background", err);
    defer(c, Promise.all(chunks.map((chunk) => c.env.BUCKET.delete(chunk))));
  }
}
