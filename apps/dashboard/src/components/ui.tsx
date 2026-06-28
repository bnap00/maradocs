import { useEffect, useId, useRef, type ReactNode } from "react";
import { X } from "lucide-react";
import type { AccessMode } from "../api";

export function AccessBadge({ access }: { access: AccessMode }) {
  return <span className={`badge ${access}`}>{access}</span>;
}

export function Modal({
  title,
  hint,
  children,
  onClose,
  wide,
}: {
  title: string;
  hint?: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const titleId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className={`modal ${wide ? "wide" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "start" }}>
          <div>
            <h2 id={titleId}>{title}</h2>
            {hint && <p className="hint">{hint}</p>}
          </div>
          <button ref={closeRef} className="btn ghost sm" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Spinner() {
  return <div className="spinner" />;
}

export function Empty({ icon, text }: { icon: string; text: string }) {
  return (
    <div className="empty">
      <div className="big">{icon}</div>
      <div>{text}</div>
    </div>
  );
}
