/** SQLite schema. Applied idempotently at startup. */
export const SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS repositories (
  id              TEXT PRIMARY KEY,
  slug            TEXT NOT NULL UNIQUE,
  name            TEXT NOT NULL,
  description     TEXT,
  default_access  TEXT NOT NULL DEFAULT 'private',
  index_enabled   INTEGER NOT NULL DEFAULT 0,
  password_hash   TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS documents (
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
);

CREATE TABLE IF NOT EXISTS document_versions (
  id                  TEXT PRIMARY KEY,
  document_id         TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  version_number      INTEGER NOT NULL,
  storage_path        TEXT NOT NULL,
  checksum            TEXT NOT NULL,
  file_count          INTEGER NOT NULL DEFAULT 0,
  size_bytes          INTEGER NOT NULL DEFAULT 0,
  entrypoint          TEXT NOT NULL DEFAULT 'index.html',
  published_by_type   TEXT NOT NULL,
  published_by_id     TEXT,
  published_by_label  TEXT,
  created_at          TEXT NOT NULL,
  UNIQUE (document_id, version_number)
);

CREATE TABLE IF NOT EXISTS machines (
  id               TEXT PRIMARY KEY,
  key_id           TEXT NOT NULL UNIQUE,
  name             TEXT NOT NULL,
  scopes           TEXT NOT NULL DEFAULT '[]',
  subject          TEXT,
  created_at       TEXT NOT NULL,
  last_used_at     TEXT
);

CREATE TABLE IF NOT EXISTS api_keys (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  key_hash     TEXT NOT NULL UNIQUE,
  prefix       TEXT NOT NULL,
  scopes       TEXT NOT NULL DEFAULT '["publish"]',
  created_at   TEXT NOT NULL,
  last_used_at TEXT
);

CREATE TABLE IF NOT EXISTS admin_sessions (
  token_hash   TEXT PRIMARY KEY,
  created_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id              TEXT PRIMARY KEY,
  event           TEXT NOT NULL,
  actor_type      TEXT NOT NULL,
  actor_id        TEXT,
  actor_label     TEXT,
  repository_slug TEXT,
  document_slug   TEXT,
  detail          TEXT,
  created_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_documents_repo ON documents(repository_id);
CREATE INDEX IF NOT EXISTS idx_versions_doc ON document_versions(document_id);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at DESC);
`;
