import type { ReactNode } from "react";
import { AlertCircle, RotateCw } from "lucide-react";
import { errorMessage } from "../../api";
import { Button } from "./Button";

export function EmptyState({
  icon,
  title,
  children,
  actions,
  compact,
}: {
  icon?: ReactNode;
  title: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
  compact?: boolean;
}) {
  return (
    <div className={`empty ${compact ? "empty-compact" : ""}`}>
      {icon && <div className="empty-icon">{icon}</div>}
      <h3 className="empty-title">{title}</h3>
      {children && <div className="empty-text">{children}</div>}
      {actions && <div className="empty-actions">{actions}</div>}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return (
    <div className="empty empty-error" role="alert">
      <div className="empty-icon">
        <AlertCircle size={20} aria-hidden />
      </div>
      <h3 className="empty-title">Couldn't load this</h3>
      <div className="empty-text">{errorMessage(error)}</div>
      {onRetry && (
        <div className="empty-actions">
          <Button icon={<RotateCw size={15} aria-hidden />} onClick={onRetry}>
            Try again
          </Button>
        </div>
      )}
    </div>
  );
}
