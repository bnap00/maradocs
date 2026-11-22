import { newId } from "../crypto.js";
import { nowIso } from "../http.js";
import type { Actor } from "../types.js";

/** Every audit event the Worker records. */
export const AUDIT_EVENT_TYPES = [
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
  "auth.register",
  "auth.login",
  "auth.login_failed",
  "auth.logout",
  "auth.logout_others",
  "auth.rate_limited",
  "account.delete",
  "settings.update",
  "password.change",
  "password.change_failed",
  "report.unlock",
  "report.unlock_failed",
] as const;

export type AuditEventType = (typeof AUDIT_EVENT_TYPES)[number];

export interface AuditInput {
  event: AuditEventType;
  actor: Actor;
  repo?: string | null;
  doc?: string | null;
  detail?: string | null;
  /** The account the event concerns; defaults to the actor's userId. */
  userId?: string | null;
}

/**
 * Build an audit INSERT for inclusion in a D1 batch, so the audit entry is
 * committed atomically with the change it describes. When `guard` is given
 * (an SQL boolean expression plus params) the row is only written if it holds,
 * e.g. "the row we just inserted exists".
 */
export function auditStmt(
  db: D1Database,
  input: AuditInput,
  guard?: { sql: string; params: unknown[] },
): D1PreparedStatement {
  const params: unknown[] = [
    newId("audit"),
    input.event,
    input.actor.type,
    input.actor.id,
    input.actor.label,
    input.repo ?? null,
    input.doc ?? null,
    input.detail ?? null,
    nowIso(),
    input.userId !== undefined ? input.userId : (input.actor.userId ?? null),
  ];
  const sql = `INSERT INTO audit_log
    (id, event, actor_type, actor_id, actor_label, repository_slug, document_slug, detail, created_at, user_id)
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${guard ? guard.sql : "1"}`;
  return db.prepare(sql).bind(...params, ...(guard?.params ?? []));
}
