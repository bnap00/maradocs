import type { ReactNode } from "react";
import { Globe, KeyRound, Lock } from "lucide-react";
import type { AccessMode } from "../../types";
import { Tooltip } from "./Tooltip";

export type BadgeTone = "neutral" | "accent" | "success" | "warning" | "danger" | "info";

export function Badge({
  tone = "neutral",
  icon,
  children,
  className,
}: {
  tone?: BadgeTone;
  icon?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span className={`badge badge-${tone} ${className ?? ""}`}>
      {icon}
      {children}
    </span>
  );
}

/**
 * Who can open a private document. Shared by the access badge tooltip and the
 * access picker so the two can't drift: any API key with read, publish or
 * admin scope can view private (and password-protected) documents.
 */
export const PRIVATE_ACCESS_SUMMARY =
  "Only signed-in admins and API keys (read, publish or admin scope) can view.";

export const ACCESS_META: Record<
  AccessMode,
  { label: string; icon: (size?: number) => ReactNode; summary: string }
> = {
  public: {
    label: "Public",
    icon: (s = 12) => <Globe size={s} aria-hidden />,
    summary: "Anyone with the link can view.",
  },
  password: {
    label: "Password",
    icon: (s = 12) => <KeyRound size={s} aria-hidden />,
    summary: "Viewers must enter a shared password.",
  },
  private: {
    label: "Private",
    icon: (s = 12) => <Lock size={s} aria-hidden />,
    summary: PRIVATE_ACCESS_SUMMARY,
  },
};

export function AccessBadge({
  access,
  inherited,
  withTooltip = true,
}: {
  access: AccessMode;
  /** Shown as "inherited from repository" in the tooltip. */
  inherited?: boolean;
  withTooltip?: boolean;
}) {
  const meta = ACCESS_META[access];
  const badge = (
    <span className={`badge badge-access badge-access-${access}`}>
      {meta.icon()}
      {meta.label}
      {inherited && <span className="badge-dot" aria-hidden />}
      {inherited && <span className="sr-only">(inherited)</span>}
    </span>
  );
  if (!withTooltip) return badge;
  return (
    <Tooltip content={`${meta.summary}${inherited ? " Inherited from the repository default." : ""}`}>
      {badge}
    </Tooltip>
  );
}
