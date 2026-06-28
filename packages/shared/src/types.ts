import type { ACCESS_MODES } from "./constants.js";

export type AccessMode = (typeof ACCESS_MODES)[number];

export type PublishedByType = "machine" | "user";

export interface Repository {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  defaultAccess: AccessMode;
  /** Whether the repository index (`/r/:repo/`) is browsable. */
  indexEnabled: boolean;
  hasPassword: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface DocumentSummary {
  id: string;
  repositorySlug: string;
  slug: string;
  title: string;
  /** Effective access mode (override falls back to the repository default). */
  access: AccessMode;
  accessOverride: AccessMode | null;
  entrypoint: string;
  latestVersionNumber: number | null;
  hasPassword: boolean;
  url: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DocumentVersion {
  id: string;
  documentId: string;
  versionNumber: number;
  checksum: string;
  fileCount: number;
  sizeBytes: number;
  entrypoint: string;
  publishedByType: PublishedByType;
  publishedById: string | null;
  publishedByLabel: string | null;
  isLatest: boolean;
  createdAt: string;
}

export interface Machine {
  id: string;
  keyId: string;  // was clerkApiKeyId
  name: string;
  scopes: string[];
  subject: string | null;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface AuditEntry {
  id: string;
  event: string;
  actorType: PublishedByType | "system";
  actorId: string | null;
  actorLabel: string | null;
  repositorySlug: string | null;
  documentSlug: string | null;
  detail: string | null;
  createdAt: string;
}

export interface PublishResult {
  repo: string;
  doc: string;
  versionNumber: number;
  access: AccessMode;
  url: string;
  versionUrl: string;
  fileCount: number;
  sizeBytes: number;
  checksum: string;
}
