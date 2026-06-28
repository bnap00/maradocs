import type { DocumentSummary, Repository } from "@maradocs/shared";
import type { AppContext } from "../context.js";
import type { DocRecord, RepoRecord } from "../db/store.js";
import { effectiveAccess, effectivePasswordHash } from "./access.js";
import { buildBaseUrl, docUrl } from "./url.js";

export function presentRepo(repo: RepoRecord): Repository {
  return {
    id: repo.id,
    slug: repo.slug,
    name: repo.name,
    description: repo.description,
    defaultAccess: repo.defaultAccess,
    indexEnabled: repo.indexEnabled,
    hasPassword: repo.hasPassword,
    createdAt: repo.createdAt,
    updatedAt: repo.updatedAt,
  };
}

export function presentDoc(
  ctx: AppContext,
  repo: RepoRecord,
  doc: DocRecord,
  origin?: string,
): DocumentSummary {
  const base = buildBaseUrl(ctx.config, origin);
  const latest = doc.latestVersionId
    ? ctx.store.getVersionById(doc.latestVersionId)
    : null;
  const access = effectiveAccess(repo, doc);
  return {
    id: doc.id,
    repositorySlug: repo.slug,
    slug: doc.slug,
    title: doc.title,
    access,
    accessOverride: doc.accessOverride,
    entrypoint: doc.entrypoint,
    latestVersionNumber: latest?.version_number ?? null,
    hasPassword: effectivePasswordHash(repo, doc) != null,
    url: latest ? docUrl(base, repo.slug, doc.slug) : null,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}
