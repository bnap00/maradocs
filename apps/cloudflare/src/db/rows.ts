// Row shapes returned by D1 and their mapping to the public API types (which
// are byte-for-byte the Node server's shapes; see src/vendor/shared/types.ts).

import type {
  AccessMode,
  AuditEntry,
  DocumentSummary,
  DocumentVersion,
  Machine,
  PublishedByType,
  Repository,
} from "../vendor/shared/index.js";
import { docUrl } from "../http.js";

export interface RepoRow {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  default_access: AccessMode;
  index_enabled: number;
  password_hash: string | null;
  owner_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface DocRow {
  id: string;
  repository_id: string;
  slug: string;
  title: string;
  access_override: AccessMode | null;
  password_hash: string | null;
  entrypoint: string;
  latest_version_id: string | null;
  created_at: string;
  updated_at: string;
}

/** Version columns without the (potentially large) manifest. */
export const VERSION_COLUMNS = `id, document_id, version_number, storage_path, checksum, file_count,
  size_bytes, entrypoint, published_by_type, published_by_id, published_by_label, created_at`;

export const versionColumns = (alias: string): string =>
  VERSION_COLUMNS.split(",")
    .map((c) => `${alias}.${c.trim()}`)
    .join(", ");

export interface VersionRow {
  id: string;
  document_id: string;
  version_number: number;
  storage_path: string;
  checksum: string;
  file_count: number;
  size_bytes: number;
  entrypoint: string;
  published_by_type: PublishedByType;
  published_by_id: string | null;
  published_by_label: string | null;
  created_at: string;
}

export interface ApiKeyRow {
  id: string;
  name: string;
  key_hash: string;
  prefix: string;
  scopes: string;
  created_at: string;
  last_used_at: string | null;
  user_id: string | null;
}

export interface MachineRow {
  id: string;
  key_id: string;
  name: string;
  scopes: string;
  subject: string | null;
  created_at: string;
  last_used_at: string | null;
  user_id: string | null;
}

export interface AuditRow {
  id: string;
  event: string;
  actor_type: string;
  actor_id: string | null;
  actor_label: string | null;
  repository_slug: string | null;
  document_slug: string | null;
  detail: string | null;
  created_at: string;
  user_id: string | null;
}

export function parseScopes(raw: string): string[] {
  try {
    const value = JSON.parse(raw) as unknown;
    return Array.isArray(value) ? value.filter((s): s is string => typeof s === "string") : [];
  } catch {
    return [];
  }
}

export function presentRepo(row: RepoRow): Repository {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    defaultAccess: row.default_access,
    indexEnabled: row.index_enabled === 1,
    hasPassword: row.password_hash != null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function presentDoc(
  repo: Pick<RepoRow, "slug" | "default_access" | "password_hash">,
  doc: DocRow,
  latestVersionNumber: number | null,
  base: string,
): DocumentSummary {
  return {
    id: doc.id,
    repositorySlug: repo.slug,
    slug: doc.slug,
    title: doc.title,
    access: doc.access_override ?? repo.default_access,
    accessOverride: doc.access_override,
    entrypoint: doc.entrypoint,
    latestVersionNumber,
    hasPassword: (doc.password_hash ?? repo.password_hash) != null,
    url: latestVersionNumber != null ? docUrl(base, repo.slug, doc.slug) : null,
    createdAt: doc.created_at,
    updatedAt: doc.updated_at,
  };
}

export function presentVersion(row: VersionRow, latestId: string | null): DocumentVersion {
  return {
    id: row.id,
    documentId: row.document_id,
    versionNumber: row.version_number,
    checksum: row.checksum,
    fileCount: row.file_count,
    sizeBytes: row.size_bytes,
    entrypoint: row.entrypoint,
    publishedByType: row.published_by_type,
    publishedById: row.published_by_id,
    publishedByLabel: row.published_by_label,
    isLatest: row.id === latestId,
    createdAt: row.created_at,
  };
}

export function presentMachine(row: MachineRow): Machine {
  return {
    id: row.id,
    keyId: row.key_id,
    name: row.name,
    scopes: parseScopes(row.scopes),
    subject: row.subject,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
  };
}

export function presentApiKey(row: Omit<ApiKeyRow, "key_hash" | "user_id">) {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    scopes: parseScopes(row.scopes),
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
  };
}

export function presentAudit(row: AuditRow): AuditEntry {
  return {
    id: row.id,
    event: row.event,
    actorType: row.actor_type as AuditEntry["actorType"],
    actorId: row.actor_id,
    actorLabel: row.actor_label,
    repositorySlug: row.repository_slug,
    documentSlug: row.document_slug,
    detail: row.detail,
    createdAt: row.created_at,
  };
}
