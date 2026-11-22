import { Fragment, type ReactNode } from "react";
import {
  FilePlus2,
  FileX2,
  FolderPlus,
  FolderPen,
  FolderX,
  History,
  KeyRound,
  KeySquare,
  LogIn,
  LockOpen,
  LogOut,
  PencilLine,
  Timer,
  RefreshCw,
  Settings2,
  ShieldAlert,
  ShieldCheck,
  ShieldX,
  UserPlus,
} from "lucide-react";
import { ACCESS_MODES, type AccessMode, type AuditEntry } from "../types";
import { ACCESS_META, AccessBadge, type BadgeTone } from "../components/ui/Badge";
import { pluralize } from "./format";

interface EventMeta {
  label: string;
  icon: ReactNode;
  tone: BadgeTone;
}

const S = 14;

export const EVENT_META: Record<string, EventMeta> = {
  "repo.create": { label: "Repository created", icon: <FolderPlus size={S} />, tone: "accent" },
  "repo.update": { label: "Repository updated", icon: <FolderPen size={S} />, tone: "neutral" },
  "repo.delete": { label: "Repository deleted", icon: <FolderX size={S} />, tone: "danger" },
  "doc.publish": { label: "Document published", icon: <FilePlus2 size={S} />, tone: "success" },
  "doc.replace": { label: "New version published", icon: <RefreshCw size={S} />, tone: "success" },
  "doc.delete": { label: "Document deleted", icon: <FileX2 size={S} />, tone: "danger" },
  "doc.rollback": { label: "Rolled back", icon: <History size={S} />, tone: "warning" },
  "doc.update": { label: "Document updated", icon: <PencilLine size={S} />, tone: "neutral" },
  "access.change": { label: "Access changed", icon: <ShieldCheck size={S} />, tone: "warning" },
  "key.create": { label: "API key created", icon: <KeyRound size={S} />, tone: "accent" },
  "key.revoke": { label: "API key revoked", icon: <KeySquare size={S} />, tone: "danger" },
  "auth.register": { label: "Account created", icon: <UserPlus size={S} />, tone: "accent" },
  "auth.login": { label: "Signed in", icon: <LogIn size={S} />, tone: "neutral" },
  "auth.login_failed": { label: "Failed sign-in", icon: <ShieldAlert size={S} />, tone: "danger" },
  "auth.logout": { label: "Signed out", icon: <LogOut size={S} />, tone: "neutral" },
  "auth.logout_others": { label: "Other sessions signed out", icon: <LogOut size={S} />, tone: "warning" },
  "auth.rate_limited": { label: "Rate limited", icon: <Timer size={S} />, tone: "danger" },
  "settings.update": { label: "Settings updated", icon: <Settings2 size={S} />, tone: "neutral" },
  "password.change": { label: "Password changed", icon: <ShieldX size={S} />, tone: "warning" },
  "password.change_failed": { label: "Wrong account password", icon: <ShieldAlert size={S} />, tone: "danger" },
  // Recorded before user accounts existed.
  "auth.sessions_revoked": { label: "All sessions signed out", icon: <LogOut size={S} />, tone: "warning" },
  "password.reset": { label: "Admin password reset", icon: <ShieldX size={S} />, tone: "warning" },
  "report.unlock": { label: "Report unlocked", icon: <LockOpen size={S} />, tone: "neutral" },
  "report.unlock_failed": { label: "Wrong report password", icon: <ShieldAlert size={S} />, tone: "danger" },
};

export function eventMeta(event: string): EventMeta {
  return EVENT_META[event] ?? { label: event, icon: <Settings2 size={S} />, tone: "neutral" };
}

/** The value of an `ip=…` token in an audit detail, if any. */
function detailIp(detail: string | null): string | null {
  const m = detail?.match(/(?:^|\s)ip=(\S+)/);
  return m ? m[1]! : null;
}

export function auditActor(entry: AuditEntry): string {
  // Failed sign-ins and report unlocks have no actor: say who we don't know, and from where.
  if (
    entry.event === "auth.login_failed" ||
    (entry.event === "auth.rate_limited" && entry.actorType !== "user") ||
    entry.event === "report.unlock" ||
    entry.event === "report.unlock_failed"
  ) {
    const ip = detailIp(entry.detail);
    return ip ? `Unknown (${ip})` : "Unknown";
  }
  if (entry.actorType === "user") {
    // Accounts are recorded by email; entries from before accounts say "admin".
    return !entry.actorLabel || entry.actorLabel.toLowerCase() === "admin" ? "Admin" : entry.actorLabel;
  }
  if (entry.actorLabel) return entry.actorLabel;
  if (entry.actorType === "machine") return "API key";
  return "System";
}

const isAccess = (v: string): v is AccessMode => (ACCESS_MODES as readonly string[]).includes(v);

/**
 * Turns the Worker's compact audit details ("v3 access=public files=12",
 * "ip=203.0.113.9", "CI (mdo_ab12…) scopes=publish,read") into readable parts.
 * Unknown text is kept as is, so new server formats still show up.
 */
export function formatAuditDetail(entry: AuditEntry): ReactNode[] {
  const detail = entry.detail?.trim();
  if (!detail) return [];

  // API keys: "<name> (<prefix>…) scopes=a,b"
  const key = detail.match(/^(.*) \((mdo_[^)]*)\)(?: scopes=(\S+))?$/);
  if (key && entry.event.startsWith("key.")) {
    const parts: ReactNode[] = [key[1]!, <code key="prefix">{key[2]}</code>];
    if (key[3]) parts.push(key[3].split(",").join(", "));
    return parts;
  }

  // Settings: "defaultRepoAccess private -> public"
  const setting = detail.match(/^defaultRepoAccess (\w+) -> (\w+)$/);
  if (setting && isAccess(setting[1]!) && isAccess(setting[2]!)) {
    return [`Default access: ${ACCESS_META[setting[1]!].label} → ${ACCESS_META[setting[2]!].label}`];
  }

  const parts: ReactNode[] = [];
  let text: string[] = [];
  const flush = () => {
    if (text.length) parts.push(text.join(" "));
    text = [];
  };
  detail.split(/\s+/).forEach((token, i) => {
    const kv = token.match(/^(\w+)=(.*)$/);
    if (!kv) {
      text.push(token);
      return;
    }
    flush();
    const [, k, v] = kv as unknown as [string, string, string];
    if (k === "ip") {
      // When there is no actor, the IP is already shown in the actor column.
      if (!auditActor(entry).startsWith("Unknown")) parts.push(`from ${v}`);
    } else if (k === "access" && isAccess(v)) {
      parts.push(<AccessBadge key={`a${i}`} access={v} withTooltip={false} />);
    } else if (k === "access" && v === "inherit") {
      parts.push("Inherits repository default");
    } else if (k === "scope") {
      parts.push(v === "login" ? "Sign-in" : v.startsWith("unlock") ? "Report unlock" : v);
    } else if (k === "files" && /^\d+$/.test(v)) {
      parts.push(pluralize(Number(v), "file"));
    } else {
      parts.push(`${k}: ${v}`);
    }
  });
  flush();
  return parts;
}

/** Audit detail parts joined with separators. */
export function AuditDetail({ entry }: { entry: AuditEntry }) {
  const parts = formatAuditDetail(entry);
  if (!parts.length) return null;
  return (
    <>
      {parts.map((p, i) => (
        <Fragment key={i}>
          {i > 0 && (
            <span className="audit-sep" aria-hidden>
              ·
            </span>
          )}
          {p}
        </Fragment>
      ))}
    </>
  );
}

/** In-app link for the audit target, if it still makes sense to link. */
export function auditTargetPath(entry: AuditEntry): string | null {
  if (!entry.repositorySlug || entry.event === "repo.delete") return null;
  const repo = encodeURIComponent(entry.repositorySlug);
  if (entry.documentSlug) {
    if (entry.event === "doc.delete") return `/repos/${repo}`;
    return `/repos/${repo}/${encodeURIComponent(entry.documentSlug)}`;
  }
  return `/repos/${repo}`;
}

export function auditTarget(entry: AuditEntry): string {
  return [entry.repositorySlug, entry.documentSlug].filter(Boolean).join(" / ");
}
