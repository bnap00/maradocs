/** Access modes a repository or document can have. */
export const ACCESS_MODES = ["public", "password", "private"] as const;

/** Default configuration values shared by the server and CLI. */
export const DEFAULTS = {
  PORT: 8787,
  DATA_DIR: "/data",
  DEFAULT_REPO_ACCESS: "private" as const,
  MAX_UPLOAD_MB: 50,
  /** Cookie name used for the password-gate signed cookie. */
  PASSWORD_COOKIE_PREFIX: "maradocs_pw_",
  /** Header carrying the MaraDocs API key for machine publishing. */
  API_KEY_HEADER: "authorization",
  /** Entry file served for a document root. */
  DEFAULT_ENTRYPOINT: "index.html",
} as const;

/** Audit event types recorded in the dashboard audit log. */
export const AUDIT_EVENTS = [
  "repo.create",
  "repo.update",
  "doc.publish",
  "doc.replace",
  "doc.delete",
  "doc.rollback",
  "access.change",
] as const;

export type AuditEvent = (typeof AUDIT_EVENTS)[number];
