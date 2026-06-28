import type {
  DocumentVersion,
  PublishDocInput,
  PublishResult,
} from "@maradocs/shared";
import type { AppContext } from "../context.js";
import { badRequest, conflict, notFound } from "../util/errors.js";
import { hashPassword } from "./access.js";
import { extractBundle, resolveEntrypoint } from "./publish.js";
import { presentDoc } from "./present.js";
import { buildBaseUrl, docUrl, versionUrl } from "./url.js";
import { getRepoOr404, type Actor } from "./repoService.js";

const publishLocks = new Map<string, Promise<void>>();

async function withPublishLock<T>(key: string, work: () => Promise<T>): Promise<T> {
  const previous = publishLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.then(() => current, () => current);
  publishLocks.set(key, queued);
  await previous;
  try {
    return await work();
  } finally {
    release();
    if (publishLocks.get(key) === queued) publishLocks.delete(key);
  }
}

interface PublishOptions {
  origin?: string;
  /** When true, the document must already exist (PUT replace semantics). */
  mustExist?: boolean;
  /** When true, the document must not already exist. */
  mustNotExist?: boolean;
}

/**
 * Publish (create) or replace a document by extracting a new immutable
 * version. Shared by POST (create) and PUT (replace).
 */
export async function publishDocument(
  ctx: AppContext,
  repoSlug: string,
  input: PublishDocInput,
  file: Buffer,
  actor: Actor,
  opts: PublishOptions = {},
): Promise<PublishResult> {
  return withPublishLock(`${repoSlug}/${input.doc}`, () =>
    publishDocumentUnlocked(ctx, repoSlug, input, file, actor, opts),
  );
}

async function publishDocumentUnlocked(
  ctx: AppContext,
  repoSlug: string,
  input: PublishDocInput,
  file: Buffer,
  actor: Actor,
  opts: PublishOptions = {},
): Promise<PublishResult> {
  const repo = getRepoOr404(ctx, repoSlug);
  const existing = ctx.store.getDoc(repo.id, input.doc);

  if (opts.mustExist && !existing) {
    throw notFound(`Document '${repoSlug}/${input.doc}' not found`);
  }
  if (opts.mustNotExist && existing) {
    throw conflict(`Document '${repoSlug}/${input.doc}' already exists`);
  }

  // Resolve access override / password for the document.
  let accessOverride = existing?.accessOverride ?? null;
  if (input.access !== undefined) accessOverride = input.access;
  let passwordHash = existing?.passwordHash ?? null;
  if (input.password) passwordHash = await hashPassword(input.password);

  const effectiveAccessMode = accessOverride ?? repo.defaultAccess;
  if (effectiveAccessMode === "password" && !(passwordHash ?? repo.passwordHash)) {
    throw badRequest("A password is required when access is 'password'");
  }

  // For new docs, version is always 1 — compute path before any DB write so
  // no doc row exists if extraction fails (avoids zombie records on crash).
  const versionNumber = existing ? ctx.store.nextVersionNumber(existing.id) : 1;
  const versionDir = ctx.storage.versionDir(repo.slug, input.doc, versionNumber);
  ctx.storage.removeDir(versionDir); // clean any partial leftover

  let extract;
  try {
    extract = await extractBundle(file, versionDir, ctx.config.maxUploadBytes);
  } catch (err) {
    ctx.storage.removeDir(versionDir);
    throw err;
  }
  const entrypoint = resolveEntrypoint(extract.files, input.entrypoint);

  // Create/update doc + version atomically. If the transaction fails the
  // extracted files on disk are orphaned — clean them up before re-throwing.
  let txResult: { version: { checksum: string }; doc: { id: string; slug: string; title: string } };
  try {
    txResult = ctx.store.tx(() => {
      const doc =
        existing ??
        ctx.store.createDoc({
          repositoryId: repo.id,
          slug: input.doc,
          title: input.title ?? input.doc,
          accessOverride,
          passwordHash,
          entrypoint,
        });
      const version = ctx.store.createVersion({
        documentId: doc.id,
        versionNumber,
        storagePath: versionDir,
        checksum: extract.checksum,
        fileCount: extract.fileCount,
        sizeBytes: extract.sizeBytes,
        entrypoint,
        publishedByType: actor.type,
        publishedById: actor.id,
        publishedByLabel: actor.label,
      });
      ctx.store.updateDoc(doc.id, {
        latestVersionId: version.id,
        entrypoint,
        title: input.title ?? doc.title,
        accessOverride,
        passwordHash,
      });
      return { version, doc };
    });
  } catch (err) {
    ctx.storage.removeDir(versionDir);
    throw err;
  }
  const { version: savedVersion, doc } = txResult;

  ctx.store.addAudit({
    event: existing ? "doc.replace" : "doc.publish",
    actorType: actor.type,
    actorId: actor.id,
    actorLabel: actor.label,
    repositorySlug: repo.slug,
    documentSlug: doc.slug,
    detail: `v${versionNumber} access=${effectiveAccessMode} files=${extract.fileCount}`,
  });

  const base = buildBaseUrl(ctx.config, opts.origin);
  return {
    repo: repo.slug,
    doc: doc.slug,
    versionNumber,
    access: effectiveAccessMode,
    url: docUrl(base, repo.slug, doc.slug),
    versionUrl: versionUrl(base, repo.slug, doc.slug, versionNumber),
    fileCount: extract.fileCount,
    sizeBytes: extract.sizeBytes,
    checksum: savedVersion.checksum,
  };
}

export function listVersions(
  ctx: AppContext,
  repoSlug: string,
  docSlug: string,
): DocumentVersion[] {
  const repo = getRepoOr404(ctx, repoSlug);
  const doc = ctx.store.getDoc(repo.id, docSlug);
  if (!doc) throw notFound(`Document '${repoSlug}/${docSlug}' not found`);
  return ctx.store.listVersions(doc.id, doc.latestVersionId);
}

export function deleteDocument(
  ctx: AppContext,
  repoSlug: string,
  docSlug: string,
  actor: Actor,
): void {
  const repo = getRepoOr404(ctx, repoSlug);
  const doc = ctx.store.getDoc(repo.id, docSlug);
  if (!doc) throw notFound(`Document '${repoSlug}/${docSlug}' not found`);
  ctx.store.deleteDoc(doc.id);
  ctx.storage.removeDir(ctx.storage.docDir(repo.slug, doc.slug));
  ctx.store.addAudit({
    event: "doc.delete",
    actorType: actor.type,
    actorId: actor.id,
    actorLabel: actor.label,
    repositorySlug: repo.slug,
    documentSlug: doc.slug,
    detail: null,
  });
}

export function rollbackDocument(
  ctx: AppContext,
  repoSlug: string,
  docSlug: string,
  version: number,
  actor: Actor,
  origin?: string,
) {
  const repo = getRepoOr404(ctx, repoSlug);
  const doc = ctx.store.getDoc(repo.id, docSlug);
  if (!doc) throw notFound(`Document '${repoSlug}/${docSlug}' not found`);
  const target = ctx.store.getVersionByNumber(doc.id, version);
  if (!target) throw notFound(`Version ${version} not found`);

  ctx.store.updateDoc(doc.id, {
    latestVersionId: target.id,
    entrypoint: target.entrypoint,
  });
  ctx.store.addAudit({
    event: "doc.rollback",
    actorType: actor.type,
    actorId: actor.id,
    actorLabel: actor.label,
    repositorySlug: repo.slug,
    documentSlug: doc.slug,
    detail: `promoted v${version} to latest`,
  });
  const fresh = ctx.store.getDoc(repo.id, docSlug)!;
  return presentDoc(ctx, repo, fresh, origin);
}
