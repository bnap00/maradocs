import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import type {
  AccessMode,
  AuditEntry,
  DocumentVersion,
  Machine,
  PublishedByType,
  Repository,
} from "@maradocs/shared";
import { OWNER_INDEX_SQL, SCHEMA_SQL } from "./schema.js";
import { newId } from "../util/ids.js";

const nowIso = () => new Date().toISOString();

interface RepoRow {
  id: string;
  owner_id: string | null;
  slug: string;
  name: string;
  description: string | null;
  default_access: AccessMode;
  index_enabled: number;
  password_hash: string | null;
  created_at: string;
  updated_at: string;
}

interface DocRow {
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

interface VersionRow {
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

interface MachineRow {
  id: string;
  key_id: string;
  name: string;
  scopes: string;
  subject: string | null;
  created_at: string;
  last_used_at: string | null;
}

interface ApiKeyRow {
  id: string;
  user_id: string | null;
  name: string;
  key_hash: string;
  prefix: string;
  scopes: string;
  created_at: string;
  last_used_at: string | null;
}

interface SessionRow {
  token_hash: string;
  user_id: string;
  created_at: string;
  expires_at: string;
  last_seen: string;
  user_agent: string | null;
}

interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  created_at: string;
  updated_at: string;
}

export interface UserRecord {
  id: string;
  email: string;
  passwordHash: string;
  createdAt: string;
  updatedAt: string;
}

export interface ApiKey {
  id: string;
  userId: string | null;
  name: string;
  keyHash: string;
  prefix: string;
  scopes: string[];
  createdAt: string;
  lastUsedAt: string | null;
}

export interface Session {
  tokenHash: string;
  userId: string;
  createdAt: string;
  expiresAt: string;
  lastSeen: string;
  userAgent: string | null;
}

function mapSession(row: SessionRow): Session {
  return {
    tokenHash: row.token_hash,
    userId: row.user_id,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    lastSeen: row.last_seen,
    userAgent: row.user_agent,
  };
}

function mapUser(row: UserRow): UserRecord {
  return {
    id: row.id,
    email: row.email,
    passwordHash: row.password_hash,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

interface AuditRow {
  id: string;
  event: string;
  actor_type: string;
  actor_id: string | null;
  actor_label: string | null;
  repository_slug: string | null;
  document_slug: string | null;
  detail: string | null;
  created_at: string;
}

export interface RepoRecord extends Repository {
  /** Owning account; null only for legacy rows not yet adopted by the first account. */
  ownerId: string | null;
  passwordHash: string | null;
}

export interface DocRecord {
  id: string;
  repositoryId: string;
  slug: string;
  title: string;
  accessOverride: AccessMode | null;
  passwordHash: string | null;
  entrypoint: string;
  latestVersionId: string | null;
  createdAt: string;
  updatedAt: string;
}

function mapRepo(row: RepoRow): RepoRecord {
  return {
    id: row.id,
    ownerId: row.owner_id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    defaultAccess: row.default_access,
    indexEnabled: row.index_enabled === 1,
    hasPassword: row.password_hash != null,
    passwordHash: row.password_hash,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapDoc(row: DocRow): DocRecord {
  return {
    id: row.id,
    repositoryId: row.repository_id,
    slug: row.slug,
    title: row.title,
    accessOverride: row.access_override,
    passwordHash: row.password_hash,
    entrypoint: row.entrypoint,
    latestVersionId: row.latest_version_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapApiKey(row: ApiKeyRow): ApiKey {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    keyHash: row.key_hash,
    prefix: row.prefix,
    scopes: JSON.parse(row.scopes) as string[],
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
  };
}

function mapVersion(row: VersionRow, latestId: string | null): DocumentVersion {
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

export class Store {
  private db: Database.Database;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(SCHEMA_SQL);
    this.migrate();
  }

  private hasColumn(table: string, column: string): boolean {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    return columns.some((c) => c.name === column);
  }

  /** Bring databases created by older releases up to the current schema. */
  private migrate(): void {
    if (!this.hasColumn("api_keys", "scopes")) {
      this.db.exec(`ALTER TABLE api_keys ADD COLUMN scopes TEXT NOT NULL DEFAULT '["publish"]'`);
    }
    // User accounts: owner columns on existing tables. Legacy rows stay NULL
    // until the first account is created, which adopts them.
    if (!this.hasColumn("repositories", "owner_id")) {
      this.db.exec(`ALTER TABLE repositories ADD COLUMN owner_id TEXT`);
    }
    if (!this.hasColumn("api_keys", "user_id")) {
      this.db.exec(`ALTER TABLE api_keys ADD COLUMN user_id TEXT`);
    }
    if (!this.hasColumn("audit_log", "user_id")) {
      this.db.exec(`ALTER TABLE audit_log ADD COLUMN user_id TEXT`);
    }
    // The single-admin session table is gone: everyone signs in again.
    this.db.exec(`DROP TABLE IF EXISTS admin_sessions`);
    this.db.exec(OWNER_INDEX_SQL);
  }

  close(): void {
    this.db.close();
  }

  // ---- Repositories -------------------------------------------------------

  createRepo(input: {
    ownerId: string | null;
    slug: string;
    name: string;
    description: string | null;
    defaultAccess: AccessMode;
    indexEnabled: boolean;
    passwordHash: string | null;
  }): RepoRecord {
    const ts = nowIso();
    const id = newId("repo");
    this.db
      .prepare(
        `INSERT INTO repositories
         (id, owner_id, slug, name, description, default_access, index_enabled, password_hash, created_at, updated_at)
         VALUES (@id, @owner_id, @slug, @name, @description, @default_access, @index_enabled, @password_hash, @created_at, @updated_at)`,
      )
      .run({
        id,
        owner_id: input.ownerId,
        slug: input.slug,
        name: input.name,
        description: input.description,
        default_access: input.defaultAccess,
        index_enabled: input.indexEnabled ? 1 : 0,
        password_hash: input.passwordHash,
        created_at: ts,
        updated_at: ts,
      });
    return this.getRepo(input.slug)!;
  }

  getRepo(slug: string): RepoRecord | null {
    const row = this.db
      .prepare(`SELECT * FROM repositories WHERE slug = ?`)
      .get(slug) as RepoRow | undefined;
    return row ? mapRepo(row) : null;
  }

  /** Repositories owned by `ownerId` (`IS` so a null owner matches legacy rows). */
  listRepos(ownerId: string | null): RepoRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM repositories WHERE owner_id IS ? ORDER BY created_at DESC`)
      .all(ownerId) as RepoRow[];
    return rows.map(mapRepo);
  }

  updateRepo(
    id: string,
    fields: Partial<{
      name: string;
      description: string | null;
      defaultAccess: AccessMode;
      indexEnabled: boolean;
      passwordHash: string | null;
    }>,
  ): void {
    const sets: string[] = [];
    const params: Record<string, unknown> = { id, updated_at: nowIso() };
    if (fields.name !== undefined) {
      sets.push("name = @name");
      params.name = fields.name;
    }
    if (fields.description !== undefined) {
      sets.push("description = @description");
      params.description = fields.description;
    }
    if (fields.defaultAccess !== undefined) {
      sets.push("default_access = @default_access");
      params.default_access = fields.defaultAccess;
    }
    if (fields.indexEnabled !== undefined) {
      sets.push("index_enabled = @index_enabled");
      params.index_enabled = fields.indexEnabled ? 1 : 0;
    }
    if (fields.passwordHash !== undefined) {
      sets.push("password_hash = @password_hash");
      params.password_hash = fields.passwordHash;
    }
    sets.push("updated_at = @updated_at");
    this.db
      .prepare(`UPDATE repositories SET ${sets.join(", ")} WHERE id = @id`)
      .run(params);
  }

  // ---- Documents ----------------------------------------------------------

  getDoc(repositoryId: string, slug: string): DocRecord | null {
    const row = this.db
      .prepare(`SELECT * FROM documents WHERE repository_id = ? AND slug = ?`)
      .get(repositoryId, slug) as DocRow | undefined;
    return row ? mapDoc(row) : null;
  }

  listDocs(repositoryId: string): DocRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM documents WHERE repository_id = ? ORDER BY updated_at DESC`,
      )
      .all(repositoryId) as DocRow[];
    return rows.map(mapDoc);
  }

  createDoc(input: {
    repositoryId: string;
    slug: string;
    title: string;
    accessOverride: AccessMode | null;
    passwordHash: string | null;
    entrypoint: string;
  }): DocRecord {
    const ts = nowIso();
    const id = newId("doc");
    this.db
      .prepare(
        `INSERT INTO documents
         (id, repository_id, slug, title, access_override, password_hash, entrypoint, latest_version_id, created_at, updated_at)
         VALUES (@id, @repository_id, @slug, @title, @access_override, @password_hash, @entrypoint, NULL, @created_at, @updated_at)`,
      )
      .run({
        id,
        repository_id: input.repositoryId,
        slug: input.slug,
        title: input.title,
        access_override: input.accessOverride,
        password_hash: input.passwordHash,
        entrypoint: input.entrypoint,
        created_at: ts,
        updated_at: ts,
      });
    return this.getDoc(input.repositoryId, input.slug)!;
  }

  updateDoc(
    id: string,
    fields: Partial<{
      title: string;
      accessOverride: AccessMode | null;
      passwordHash: string | null;
      entrypoint: string;
      latestVersionId: string | null;
    }>,
  ): void {
    const sets: string[] = [];
    const params: Record<string, unknown> = { id, updated_at: nowIso() };
    if (fields.title !== undefined) {
      sets.push("title = @title");
      params.title = fields.title;
    }
    if (fields.accessOverride !== undefined) {
      sets.push("access_override = @access_override");
      params.access_override = fields.accessOverride;
    }
    if (fields.passwordHash !== undefined) {
      sets.push("password_hash = @password_hash");
      params.password_hash = fields.passwordHash;
    }
    if (fields.entrypoint !== undefined) {
      sets.push("entrypoint = @entrypoint");
      params.entrypoint = fields.entrypoint;
    }
    if (fields.latestVersionId !== undefined) {
      sets.push("latest_version_id = @latest_version_id");
      params.latest_version_id = fields.latestVersionId;
    }
    sets.push("updated_at = @updated_at");
    this.db.prepare(`UPDATE documents SET ${sets.join(", ")} WHERE id = @id`).run(params);
  }

  deleteDoc(id: string): void {
    this.db.prepare(`DELETE FROM documents WHERE id = ?`).run(id);
  }

  // ---- Versions -----------------------------------------------------------

  nextVersionNumber(documentId: string): number {
    const row = this.db
      .prepare(
        `SELECT COALESCE(MAX(version_number), 0) AS max FROM document_versions WHERE document_id = ?`,
      )
      .get(documentId) as { max: number };
    return row.max + 1;
  }

  createVersion(input: {
    documentId: string;
    versionNumber: number;
    storagePath: string;
    checksum: string;
    fileCount: number;
    sizeBytes: number;
    entrypoint: string;
    publishedByType: PublishedByType;
    publishedById: string | null;
    publishedByLabel: string | null;
  }): VersionRow {
    const ts = nowIso();
    const id = newId("ver");
    this.db
      .prepare(
        `INSERT INTO document_versions
         (id, document_id, version_number, storage_path, checksum, file_count, size_bytes, entrypoint, published_by_type, published_by_id, published_by_label, created_at)
         VALUES (@id, @document_id, @version_number, @storage_path, @checksum, @file_count, @size_bytes, @entrypoint, @published_by_type, @published_by_id, @published_by_label, @created_at)`,
      )
      .run({
        id,
        document_id: input.documentId,
        version_number: input.versionNumber,
        storage_path: input.storagePath,
        checksum: input.checksum,
        file_count: input.fileCount,
        size_bytes: input.sizeBytes,
        entrypoint: input.entrypoint,
        published_by_type: input.publishedByType,
        published_by_id: input.publishedById,
        published_by_label: input.publishedByLabel,
        created_at: ts,
      });
    return this.db
      .prepare(`SELECT * FROM document_versions WHERE id = ?`)
      .get(id) as VersionRow;
  }

  getVersionByNumber(documentId: string, versionNumber: number): VersionRow | null {
    return (
      (this.db
        .prepare(
          `SELECT * FROM document_versions WHERE document_id = ? AND version_number = ?`,
        )
        .get(documentId, versionNumber) as VersionRow | undefined) ?? null
    );
  }

  getVersionById(id: string): VersionRow | null {
    return (
      (this.db
        .prepare(`SELECT * FROM document_versions WHERE id = ?`)
        .get(id) as VersionRow | undefined) ?? null
    );
  }

  listVersions(documentId: string, latestVersionId: string | null): DocumentVersion[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM document_versions WHERE document_id = ? ORDER BY version_number DESC`,
      )
      .all(documentId) as VersionRow[];
    return rows.map((r) => mapVersion(r, latestVersionId));
  }

  // ---- Machines -----------------------------------------------------------

  upsertMachine(input: {
    keyId: string;
    name: string;
    scopes: string[];
    subject: string | null;
  }): Machine {
    const existing = this.db
      .prepare(`SELECT * FROM machines WHERE key_id = ?`)
      .get(input.keyId) as MachineRow | undefined;
    const ts = nowIso();
    if (existing) {
      this.db
        .prepare(
          `UPDATE machines SET name = ?, scopes = ?, subject = ?, last_used_at = ? WHERE id = ?`,
        )
        .run(input.name, JSON.stringify(input.scopes), input.subject, ts, existing.id);
      return this.mapMachine({
        ...existing,
        name: input.name,
        scopes: JSON.stringify(input.scopes),
        subject: input.subject,
        last_used_at: ts,
      });
    }
    const id = newId("mach");
    this.db
      .prepare(
        `INSERT INTO machines (id, key_id, name, scopes, subject, created_at, last_used_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, input.keyId, input.name, JSON.stringify(input.scopes), input.subject, ts, ts);
    return this.mapMachine({
      id,
      key_id: input.keyId,
      name: input.name,
      scopes: JSON.stringify(input.scopes),
      subject: input.subject,
      created_at: ts,
      last_used_at: ts,
    });
  }

  /** Machines seen through API keys owned by `userId`. */
  listMachines(userId: string): Machine[] {
    const rows = this.db
      .prepare(
        `SELECT m.* FROM machines m JOIN api_keys k ON k.id = m.key_id
         WHERE k.user_id = ? ORDER BY m.last_used_at DESC NULLS LAST`,
      )
      .all(userId) as MachineRow[];
    return rows.map((r) => this.mapMachine(r));
  }

  private mapMachine(row: MachineRow): Machine {
    return {
      id: row.id,
      keyId: row.key_id,
      name: row.name,
      scopes: JSON.parse(row.scopes) as string[],
      subject: row.subject,
      createdAt: row.created_at,
      lastUsedAt: row.last_used_at,
    };
  }

  // ---- API Keys -----------------------------------------------------------

  createApiKey(input: {
    userId: string | null;
    name: string;
    keyHash: string;
    prefix: string;
    scopes: string[];
  }): ApiKey {
    const id = newId("apikey");
    const ts = nowIso();
    this.db
      .prepare(
        `INSERT INTO api_keys (id, user_id, name, key_hash, prefix, scopes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, input.userId, input.name, input.keyHash, input.prefix, JSON.stringify(input.scopes), ts);
    return {
      id,
      userId: input.userId,
      name: input.name,
      keyHash: input.keyHash,
      prefix: input.prefix,
      scopes: input.scopes,
      createdAt: ts,
      lastUsedAt: null,
    };
  }

  getApiKeyByHash(keyHash: string): ApiKey | null {
    const row = this.db
      .prepare(`SELECT * FROM api_keys WHERE key_hash = ?`)
      .get(keyHash) as ApiKeyRow | undefined;
    return row ? mapApiKey(row) : null;
  }

  listApiKeys(userId: string): ApiKey[] {
    const rows = this.db
      .prepare(`SELECT * FROM api_keys WHERE user_id = ? ORDER BY created_at DESC`)
      .all(userId) as ApiKeyRow[];
    return rows.map(mapApiKey);
  }

  /** Delete one of `userId`'s keys (and its machines row). False when not theirs. */
  deleteApiKey(id: string, userId: string): boolean {
    return this.tx(() => {
      const res = this.db
        .prepare(`DELETE FROM api_keys WHERE id = ? AND user_id = ?`)
        .run(id, userId);
      if (res.changes === 0) return false;
      this.db.prepare(`DELETE FROM machines WHERE key_id = ?`).run(id);
      return true;
    });
  }

  touchApiKey(id: string): void {
    this.db
      .prepare(`UPDATE api_keys SET last_used_at = ? WHERE id = ?`)
      .run(nowIso(), id);
  }

  // ---- Users --------------------------------------------------------------

  countUsers(): number {
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM users`).get() as { n: number }).n;
  }

  getUserByEmail(email: string): UserRecord | null {
    const row = this.db.prepare(`SELECT * FROM users WHERE email = ?`).get(email) as
      | UserRow
      | undefined;
    return row ? mapUser(row) : null;
  }

  getUserById(id: string): UserRecord | null {
    const row = this.db.prepare(`SELECT * FROM users WHERE id = ?`).get(id) as UserRow | undefined;
    return row ? mapUser(row) : null;
  }

  /**
   * Insert a user. When `guard` is given it runs inside the same transaction
   * (e.g. "registration only while no users exist") so concurrent sign-ups
   * cannot both pass the check. The first account ever created adopts every
   * legacy row (repositories, API keys, audit entries) that has no owner yet.
   */
  createUser(
    input: { email: string; passwordHash: string },
    guard?: (userCount: number) => void,
  ): UserRecord {
    return this.tx(() => {
      const count = this.countUsers();
      guard?.(count);
      const ts = nowIso();
      const id = newId("user");
      this.db
        .prepare(
          `INSERT INTO users (id, email, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(id, input.email, input.passwordHash, ts, ts);
      if (count === 0) {
        this.db.prepare(`UPDATE repositories SET owner_id = ? WHERE owner_id IS NULL`).run(id);
        this.db.prepare(`UPDATE api_keys SET user_id = ? WHERE user_id IS NULL`).run(id);
        this.db.prepare(`UPDATE audit_log SET user_id = ? WHERE user_id IS NULL`).run(id);
      }
      return this.getUserById(id)!;
    });
  }

  updateUserPassword(id: string, passwordHash: string): void {
    this.db
      .prepare(`UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?`)
      .run(passwordHash, nowIso(), id);
  }

  /**
   * Delete a user and everything they own: sessions, API keys + machines,
   * repositories (documents and versions cascade) and audit rows. Returns the
   * slugs of the deleted repositories so the caller can remove stored files.
   */
  deleteUser(id: string): string[] {
    return this.tx(() => {
      const slugs = (
        this.db.prepare(`SELECT slug FROM repositories WHERE owner_id = ?`).all(id) as {
          slug: string;
        }[]
      ).map((r) => r.slug);
      this.db.prepare(`DELETE FROM sessions WHERE user_id = ?`).run(id);
      this.db
        .prepare(`DELETE FROM machines WHERE key_id IN (SELECT id FROM api_keys WHERE user_id = ?)`)
        .run(id);
      this.db.prepare(`DELETE FROM api_keys WHERE user_id = ?`).run(id);
      this.db.prepare(`DELETE FROM repositories WHERE owner_id = ?`).run(id);
      this.db.prepare(`DELETE FROM audit_log WHERE user_id = ?`).run(id);
      this.db.prepare(`DELETE FROM users WHERE id = ?`).run(id);
      return slugs;
    });
  }

  // ---- Sessions -----------------------------------------------------------

  createSession(input: {
    tokenHash: string;
    userId: string;
    expiresAt: string;
    userAgent?: string | null;
  }): Session {
    const ts = nowIso();
    const userAgent = input.userAgent ? input.userAgent.slice(0, 200) : null;
    this.db
      .prepare(
        `INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_seen, user_agent)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(input.tokenHash, input.userId, ts, input.expiresAt, ts, userAgent);
    return {
      tokenHash: input.tokenHash,
      userId: input.userId,
      createdAt: ts,
      expiresAt: input.expiresAt,
      lastSeen: ts,
      userAgent,
    };
  }

  /** Look up a session by token hash, including expired ones (caller decides). */
  getSessionByHash(tokenHash: string): Session | null {
    const row = this.db
      .prepare(`SELECT * FROM sessions WHERE token_hash = ?`)
      .get(tokenHash) as SessionRow | undefined;
    return row ? mapSession(row) : null;
  }

  touchSession(tokenHash: string, lastSeen: string, expiresAt: string): void {
    this.db
      .prepare(`UPDATE sessions SET last_seen = ?, expires_at = ? WHERE token_hash = ?`)
      .run(lastSeen, expiresAt, tokenHash);
  }

  deleteSession(tokenHash: string): void {
    this.db.prepare(`DELETE FROM sessions WHERE token_hash = ?`).run(tokenHash);
  }

  /** Revoke every session of `userId` except `keepTokenHash`. Returns how many were removed. */
  deleteOtherSessions(userId: string, keepTokenHash: string): number {
    return this.db
      .prepare(`DELETE FROM sessions WHERE user_id = ? AND token_hash != ?`)
      .run(userId, keepTokenHash).changes;
  }

  purgeExpiredSessions(): void {
    this.db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(nowIso());
  }

  // ---- Settings -----------------------------------------------------------

  getSetting(key: string): string | null {
    const row = this.db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  /** Return the stored value, or atomically store and return `create()`'s. */
  getOrCreateSetting(key: string, create: () => string): string {
    this.db
      .prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING`)
      .run(key, create());
    return this.getSetting(key)!;
  }

  // ---- Audit --------------------------------------------------------------

  addAudit(input: {
    /** Account the event concerns (owner of the resource); null for anonymous events. */
    userId: string | null;
    event: string;
    actorType: "machine" | "user" | "system";
    actorId: string | null;
    actorLabel: string | null;
    repositorySlug: string | null;
    documentSlug: string | null;
    detail: string | null;
  }): void {
    this.db
      .prepare(
        `INSERT INTO audit_log (id, user_id, event, actor_type, actor_id, actor_label, repository_slug, document_slug, detail, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        newId("audit"),
        input.userId,
        input.event,
        input.actorType,
        input.actorId,
        input.actorLabel,
        input.repositorySlug,
        input.documentSlug,
        input.detail,
        nowIso(),
      );
  }

  listAudit(userId: string, limit = 100): AuditEntry[] {
    const rows = this.db
      .prepare(`SELECT * FROM audit_log WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`)
      .all(userId, limit) as AuditRow[];
    return rows.map((r) => ({
      id: r.id,
      event: r.event,
      actorType: r.actor_type as AuditEntry["actorType"],
      actorId: r.actor_id,
      actorLabel: r.actor_label,
      repositorySlug: r.repository_slug,
      documentSlug: r.document_slug,
      detail: r.detail,
      createdAt: r.created_at,
    }));
  }

  /** Run a function inside a transaction. */
  tx<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }
}
