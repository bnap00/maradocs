import { type ReactNode, useEffect, useId, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { errorMessage } from "../../api";
import { Button } from "./Button";
import { Dialog } from "./Dialog";
import { Input } from "./Field";

interface ConfirmDialogProps {
  open: boolean;
  onClose: () => void;
  /** Performs the action; the dialog stays open (busy) until it settles. */
  onConfirm: () => Promise<unknown>;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  confirmLabel?: string;
  tone?: "danger" | "default";
  /** Require typing this exact text before confirming. */
  confirmText?: string;
}

export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  description,
  children,
  confirmLabel = "Confirm",
  tone = "danger",
  confirmText,
}: ConfirmDialogProps) {
  const [busy, setBusy] = useState(false);
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string | null>(null);
  const inputId = useId();

  useEffect(() => {
    if (open) {
      setTyped("");
      setError(null);
      setBusy(false);
    }
  }, [open]);

  const ready = !confirmText || typed === confirmText;

  async function confirm() {
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={() => !busy && onClose()}
      dismissible={!busy}
      title={title}
      description={description}
      size="sm"
      tone={tone}
      icon={tone === "danger" ? <AlertTriangle size={18} aria-hidden /> : undefined}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant={tone === "danger" ? "danger" : "primary"} onClick={confirm} loading={busy} disabled={!ready}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      {children}
      {confirmText && (
        <form
          className="field"
          onSubmit={(e) => {
            e.preventDefault();
            void confirm();
          }}
        >
          <label htmlFor={inputId} className="field-label">
            Type <code className="kbd-inline">{confirmText}</code> to confirm
          </label>
          <Input
            id={inputId}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            autoCapitalize="off"
            data-autofocus
          />
        </form>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </Dialog>
  );
}
