import type { AuditEntry } from "./api";

export const EVENT_LABEL: Record<string, { icon: string; label: string }> = {
  "repo.create": { icon: "📁", label: "Repository created" },
  "repo.update": { icon: "✏️", label: "Repository updated" },
  "access.change": { icon: "🔐", label: "Access changed" },
  "doc.publish": { icon: "🚀", label: "Document published" },
  "doc.replace": { icon: "♻️", label: "Document replaced" },
  "doc.delete": { icon: "🗑️", label: "Document deleted" },
  "doc.rollback": { icon: "⏪", label: "Rolled back" },
  "auth.register": { icon: "👤", label: "Account created" },
  "auth.login": { icon: "🔑", label: "Signed in" },
  "auth.login_failed": { icon: "⚠️", label: "Failed sign-in" },
  "auth.logout": { icon: "👋", label: "Signed out" },
  "auth.logout_others": { icon: "🚪", label: "Signed out other sessions" },
  "password.change": { icon: "🔒", label: "Password changed" },
  "key.create": { icon: "🗝️", label: "API key created" },
  "key.delete": { icon: "🗑️", label: "API key deleted" },
};

export function auditEventMeta(event: string): { icon: string; label: string } {
  return EVENT_LABEL[event] ?? { icon: "•", label: event };
}

export function auditTarget(entry: AuditEntry): string {
  return [entry.repositorySlug, entry.documentSlug].filter(Boolean).join("/");
}

export function auditActor(entry: AuditEntry): string {
  if (entry.actorType === "user" && entry.actorLabel?.startsWith("user_")) {
    return "Dashboard user";
  }
  return entry.actorLabel ?? entry.actorType;
}

export function auditHref(entry: AuditEntry): string | null {
  if (!entry.repositorySlug) return null;
  if (entry.documentSlug) return `/r/${entry.repositorySlug}/${entry.documentSlug}/`;
  return `/r/${entry.repositorySlug}/`;
}

export function auditActionLabel(entry: AuditEntry): string {
  return entry.documentSlug ? "Open doc" : "Open repo";
}
