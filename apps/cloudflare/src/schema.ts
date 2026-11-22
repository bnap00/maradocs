// D1 schema. Mirrors the Node server's SQLite schema, plus:
//   - document_versions.storage_path is an R2 object key (one packed blob per
//     version) and document_versions.manifest maps file paths to byte ranges
//     (and CRC-32s) inside that blob, so serving a file is a single ranged R2 read.
//   - settings / rate_limits tables replace process memory, which Workers lack.
//
// The schema is applied lazily on the first request each isolate handles, so a
// fresh deploy needs no migration step. Changes are ordered, numbered
// MIGRATIONS: each runs once, atomically with the schema_version bump. Never
// edit a released migration; append a new one.

const BASE_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS repositories (
    id              TEXT PRIMARY KEY,
    slug            TEXT NOT NULL UNIQUE,
    name            TEXT NOT NULL,
    description     TEXT,
    default_access  TEXT NOT NULL DEFAULT 'private',
    index_enabled   INTEGER NOT NULL DEFAULT 0,
    password_hash   TEXT,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS documents (
    id                 TEXT PRIMARY KEY,
    repository_id      TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    slug               TEXT NOT NULL,
    title              TEXT NOT NULL,
    access_override    TEXT,
    password_hash      TEXT,
    entrypoint         TEXT NOT NULL DEFAULT 'index.html',
    latest_version_id  TEXT,
    created_at         TEXT NOT NULL,
    updated_at         TEXT NOT NULL,
    UNIQUE (repository_id, slug)
  )`,
  `CREATE TABLE IF NOT EXISTS document_versions (
    id                  TEXT PRIMARY KEY,
    document_id         TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    version_number      INTEGER NOT NULL,
    storage_path        TEXT NOT NULL,
    manifest            TEXT NOT NULL DEFAULT '{}',
    checksum            TEXT NOT NULL,
    file_count          INTEGER NOT NULL DEFAULT 0,
    size_bytes          INTEGER NOT NULL DEFAULT 0,
    entrypoint          TEXT NOT NULL DEFAULT 'index.html',
    published_by_type   TEXT NOT NULL,
    published_by_id     TEXT,
    published_by_label  TEXT,
    created_at          TEXT NOT NULL,
    UNIQUE (document_id, version_number)
  )`,
  `CREATE TABLE IF NOT EXISTS machines (
    id               TEXT PRIMARY KEY,
    key_id           TEXT NOT NULL UNIQUE,
    name             TEXT NOT NULL,
    scopes           TEXT NOT NULL DEFAULT '[]',
    subject          TEXT,
    created_at       TEXT NOT NULL,
    last_used_at     TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS api_keys (
    id           TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    key_hash     TEXT NOT NULL UNIQUE,
    prefix       TEXT NOT NULL,
    scopes       TEXT NOT NULL DEFAULT '["publish"]',
    created_at   TEXT NOT NULL,
    last_used_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS admin_sessions (
    token_hash   TEXT PRIMARY KEY,
    created_at   TEXT NOT NULL,
    expires_at   TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS audit_log (
    id              TEXT PRIMARY KEY,
    event           TEXT NOT NULL,
    actor_type      TEXT NOT NULL,
    actor_id        TEXT,
    actor_label     TEXT,
    repository_slug TEXT,
    document_slug   TEXT,
    detail          TEXT,
    created_at      TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS settings (
    key    TEXT PRIMARY KEY,
    value  TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS rate_limits (
    key       TEXT PRIMARY KEY,
    count     INTEGER NOT NULL,
    reset_at  INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_documents_repo ON documents(repository_id)`,
  `CREATE INDEX IF NOT EXISTS idx_versions_doc ON document_versions(document_id)`,
  `CREATE INDEX IF NOT EXISTS idx_audit_created_id ON audit_log(created_at DESC, id DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_versions_created ON document_versions(created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_expires ON admin_sessions(expires_at)`,
  `CREATE INDEX IF NOT EXISTS idx_rate_limits_reset ON rate_limits(reset_at)`,
];

export interface Migration {
  version: number;
  statements: string[];
}

/**
 * Ordered schema migrations. v2 is the original schema (every statement is
 * idempotent, so databases created before numbered migrations replay it
 * harmlessly). `ALTER TABLE … ADD COLUMN` steps tolerate "duplicate column"
 * errors so concurrent isolates migrating at once don't fail.
 */
export const MIGRATIONS: Migration[] = [
  { version: 2, statements: BASE_STATEMENTS },
  {
    // Admin sessions are bound to the credential that created them.
    version: 3,
    statements: [
      `ALTER TABLE admin_sessions ADD COLUMN cred_fp TEXT`,
      // Sessions created before binding can't be verified: sign in again.
      `DELETE FROM admin_sessions WHERE cred_fp IS NULL`,
      // The orphan-blob sweep looks versions up by storage key.
      `CREATE INDEX IF NOT EXISTS idx_versions_storage ON document_versions(storage_path)`,
    ],
  },
  {
    // User accounts. Each user owns their repositories, API keys, machines and
    // audit rows; rows from before accounts (NULL owner) are adopted by the
    // first account created (see routes/auth.ts). The single-admin sessions
    // are dropped: everyone signs in again.
    version: 4,
    statements: [
      `CREATE TABLE IF NOT EXISTS users (
        id             TEXT PRIMARY KEY,
        email          TEXT NOT NULL UNIQUE,
        password_hash  TEXT NOT NULL,
        created_at     TEXT NOT NULL,
        updated_at     TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS sessions (
        token_hash  TEXT PRIMARY KEY,
        user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at  TEXT NOT NULL,
        expires_at  TEXT NOT NULL,
        last_seen   TEXT NOT NULL,
        user_agent  TEXT
      )`,
      `CREATE INDEX IF NOT EXISTS idx_user_sessions_user ON sessions(user_id)`,
      `CREATE INDEX IF NOT EXISTS idx_user_sessions_expires ON sessions(expires_at)`,
      `DROP TABLE IF EXISTS admin_sessions`,
      `ALTER TABLE repositories ADD COLUMN owner_id TEXT`,
      `ALTER TABLE api_keys ADD COLUMN user_id TEXT`,
      `ALTER TABLE audit_log ADD COLUMN user_id TEXT`,
      `ALTER TABLE machines ADD COLUMN user_id TEXT`,
      `CREATE INDEX IF NOT EXISTS idx_repos_owner ON repositories(owner_id)`,
      `CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys(user_id)`,
      `CREATE INDEX IF NOT EXISTS idx_machines_user ON machines(user_id)`,
      `CREATE INDEX IF NOT EXISTS idx_audit_user_created ON audit_log(user_id, created_at DESC, id DESC)`,
      // Superseded by per-user state (the dashboard password survives only as a claim password).
      `DELETE FROM settings WHERE key = 'admin_secret_hash'`,
    ],
  },
];

export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version;

// A plain flag (not a cached promise): a promise created by one request's I/O
// must not be awaited by others — if that request is cancelled, every later
// request on the isolate would hang. The check is cheap and idempotent, so
// concurrent first requests may each run it.
let schemaReady = false;

/** Apply pending migrations once per isolate (one cheap SELECT when current). */
export async function ensureSchema(db: D1Database): Promise<void> {
  if (schemaReady) return;
  await migrate(db);
  schemaReady = true;
}

/** Test hook: forget that the schema was checked. */
export function resetSchemaCache(): void {
  schemaReady = false;
}

async function currentVersion(db: D1Database): Promise<number> {
  try {
    const row = await db
      .prepare(`SELECT value FROM settings WHERE key = 'schema_version'`)
      .first<{ value: string }>();
    const n = Number(row?.value ?? 0);
    return Number.isInteger(n) ? n : 0;
  } catch {
    return 0; // settings table does not exist yet: fresh database.
  }
}

function setVersionStmt(db: D1Database, version: number): D1PreparedStatement {
  // Only ever moves forward, so a slower isolate can't roll the version back.
  return db
    .prepare(
      `INSERT INTO settings (key, value) VALUES ('schema_version', ?1)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value
       WHERE CAST(settings.value AS INTEGER) < CAST(excluded.value AS INTEGER)`,
    )
    .bind(String(version));
}

function isDuplicateColumn(err: unknown): boolean {
  return /duplicate column name/i.test(String((err as Error)?.message ?? err));
}

/** Run every migration newer than the stored schema_version. Returns the resulting version. */
export async function migrate(db: D1Database): Promise<number> {
  let version = await currentVersion(db);
  for (const migration of MIGRATIONS) {
    if (migration.version <= version) continue;
    try {
      await db.batch([...migration.statements.map((sql) => db.prepare(sql)), setVersionStmt(db, migration.version)]);
    } catch (err) {
      if (!isDuplicateColumn(err)) throw err;
      // Another isolate applied (part of) this migration concurrently: apply
      // the remaining statements one by one, skipping columns that exist.
      for (const sql of migration.statements) {
        try {
          await db.prepare(sql).run();
        } catch (stepErr) {
          if (!isDuplicateColumn(stepErr)) throw stepErr;
        }
      }
      await setVersionStmt(db, migration.version).run();
    }
    version = migration.version;
  }
  return version;
}
