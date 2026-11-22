// Central DTO types for the dashboard. These mirror the Worker's HTTP surface
// (see CLOUDFLARE_SPEC.md "HTTP surface") and the vendored shared types in
// src/vendor/shared/types.ts. The dashboard cannot import from the Worker's
// tree (it is built separately by Vite), so the shapes are restated here.

export const ACCESS_MODES = ["public", "password", "private"] as const;
export type AccessMode = (typeof ACCESS_MODES)[number];

export const API_KEY_SCOPES = ["read", "publish", "admin"] as const;
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

export type PublishedByType = "machine" | "user";

export interface Repository {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  defaultAccess: AccessMode;
  indexEnabled: boolean;
  hasPassword: boolean;
  createdAt: string;
  updatedAt: string;
  /** Dashboard API extra: number of documents. */
  docCount?: number;
}

export interface DocumentSummary {
  id: string;
  repositorySlug: string;
  slug: string;
  title: string;
  /** Effective access (override falls back to the repository default). */
  access: AccessMode;
  accessOverride: AccessMode | null;
  entrypoint: string;
  latestVersionNumber: number | null;
  /** Effective: true when the document or its repository has a password. */
  hasPassword: boolean;
  /** Dashboard API extra: the document has its own password (overrides the repo's). */
  hasOwnPassword?: boolean;
  url: string | null;
  createdAt: string;
  updatedAt: string;
  /** Dashboard API extras (DocumentDetail). */
  versionCount?: number;
  latestSizeBytes?: number | null;
  latestFileCount?: number | null;
  latestPublishedAt?: string | null;
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
  keyId: string;
  name: string;
  scopes: string[];
  subject: string | null;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface ApiKeyInfo {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  createdAt: string;
  lastUsedAt: string | null;
}

export interface CreatedApiKey {
  key: string;
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
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

export interface PublicConfig {
  defaultRepoAccess: AccessMode;
  configured: boolean;
  version: string;
}

export interface Health {
  status: "ok";
  service: "maradocs";
  runtime: string;
  configured: boolean;
  time: string;
}

/** A MaraDocs account. */
export interface User {
  id: string;
  email: string;
  createdAt: string;
}

/** GET /api/v1/auth/config */
export interface AuthConfig {
  /** Whether POST /register would currently be allowed. */
  registration: boolean;
  /** No account exists yet and the first one needs the claim password (ADMIN_PASSWORD). */
  claimRequired: boolean;
  /** No account exists yet. */
  firstAccount?: boolean;
  minPasswordLength: number;
}

/** POST /api/v1/auth/login and /register (browsers get no token). */
export interface AuthResult {
  user: User;
}

export interface Me {
  user: User;
  session?: { expiresAt?: string | null } | null;
}

/** A recent publish as listed on the overview (one row per version). */
export interface RecentPublish {
  repo: string;
  doc: string;
  title: string;
  versionNumber: number;
  fileCount: number;
  sizeBytes: number;
  publishedByType: PublishedByType;
  publishedByLabel: string | null;
  createdAt: string;
  checksum?: string;
  isLatest?: boolean;
  /** Absolute document URL (server base URL). */
  url?: string;
}

export interface Overview {
  counts: {
    repos: number;
    docs: number;
    versions: number;
    apiKeys: number;
    machines?: number;
  };
  /** Total bytes stored across all versions. */
  storedBytes: number;
  recentPublishes: RecentPublish[];
  recentAudit: AuditEntry[];
}

export interface AuditPage {
  audit: AuditEntry[];
  nextCursor: string | null;
}

export interface AuditQuery {
  limit?: number;
  before?: string | null;
  repo?: string | null;
  event?: string | null;
}

export interface Settings {
  defaultRepoAccess: AccessMode;
  maxUploadMb: number;
  publicBaseUrl: string | null;
  serverUrl: string;
  /** REGISTRATION on this deployment. */
  registration?: "open" | "first" | "closed";
  version?: string;
}

export interface CreateRepoInput {
  slug: string;
  name?: string;
  description?: string;
  access?: AccessMode;
  indexEnabled?: boolean;
  password?: string;
}

export interface UpdateRepoInput {
  name?: string;
  description?: string | null;
  access?: AccessMode;
  indexEnabled?: boolean;
  password?: string | null;
}

export interface UpdateDocInput {
  title?: string;
  /** `null` = inherit the repository default. */
  access?: AccessMode | null;
  /** String sets/rotates the document password, `null` clears it. */
  password?: string | null;
}

export interface UploadFields {
  doc: string;
  title?: string;
  /** Omitted = inherit (new doc) / keep current (replace). */
  access?: AccessMode;
  password?: string;
  entrypoint?: string;
}

export interface UploadProgress {
  loaded: number;
  total: number;
}

/** Error body every API route returns on failure. */
export interface ApiErrorBody {
  error: string;
  message: string;
  details?: unknown;
}

/** Audit event types the Worker records. */
export const AUDIT_EVENTS = [
  "repo.create",
  "repo.update",
  "repo.delete",
  "doc.publish",
  "doc.replace",
  "doc.delete",
  "doc.rollback",
  "doc.update",
  "access.change",
  "key.create",
  "key.revoke",
  "auth.login",
  "auth.login_failed",
  "auth.logout",
  "auth.rate_limited",
  "auth.sessions_revoked",
  "settings.update",
  "password.change",
  "password.change_failed",
  "password.reset",
  "report.unlock",
  "report.unlock_failed",
] as const;
export type AuditEvent = (typeof AUDIT_EVENTS)[number];
