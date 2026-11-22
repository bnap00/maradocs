import { type ReactNode, createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from "lucide-react";
import { errorMessage } from "../../api";

type Tone = "success" | "error" | "info" | "warning";

interface ToastItem {
  id: number;
  tone: Tone;
  title: ReactNode;
  description?: ReactNode;
  action?: { label: string; onClick: () => void };
  duration: number;
}

interface ToastApi {
  show: (t: Omit<ToastItem, "id" | "duration"> & { duration?: number }) => void;
  success: (title: ReactNode, description?: ReactNode) => void;
  error: (errOrTitle: unknown, description?: ReactNode) => void;
  info: (title: ReactNode, description?: ReactNode) => void;
}

const Ctx = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useToast must be used inside <ToastProvider>");
  return ctx;
}

const ICONS: Record<Tone, ReactNode> = {
  success: <CheckCircle2 size={17} aria-hidden />,
  error: <XCircle size={17} aria-hidden />,
  info: <Info size={17} aria-hidden />,
  warning: <AlertTriangle size={17} aria-hidden />,
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => setItems((xs) => xs.filter((x) => x.id !== id)), []);

  const show = useCallback<ToastApi["show"]>((t) => {
    const id = nextId.current++;
    const duration = t.duration ?? (t.tone === "error" ? 7000 : 4500);
    setItems((xs) => [...xs.slice(-4), { ...t, id, duration }]);
  }, []);

  const api = useMemo<ToastApi>(
    () => ({
      show,
      success: (title, description) => show({ tone: "success", title, description }),
      info: (title, description) => show({ tone: "info", title, description }),
      error: (errOrTitle, description) => {
        if (errOrTitle instanceof DOMException && errOrTitle.name === "AbortError") return;
        const isNode = typeof errOrTitle === "string" || (typeof errOrTitle === "object" && errOrTitle !== null && "$$typeof" in errOrTitle);
        show({
          tone: "error",
          title: isNode ? (errOrTitle as ReactNode) : errorMessage(errOrTitle),
          description,
        });
      },
    }),
    [show],
  );

  return (
    <Ctx.Provider value={api}>
      {children}
      {/* Not a live region itself: each toast announces through its own
          role (status / alert), so nothing is read twice. */}
      <div className="toast-region" role="region" aria-label="Notifications">
        {items.map((t) => (
          <Toast key={t.id} item={t} onDismiss={() => dismiss(t.id)} />
        ))}
      </div>
    </Ctx.Provider>
  );
}

function usePageHidden(): boolean {
  const [hidden, setHidden] = useState(() => typeof document !== "undefined" && document.visibilityState === "hidden");
  useEffect(() => {
    const onChange = () => setHidden(document.visibilityState === "hidden");
    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
  }, []);
  return hidden;
}

function Toast({ item, onDismiss }: { item: ToastItem; onDismiss: () => void }) {
  const [hovered, setHovered] = useState(false);
  // Don't let a toast (especially an error) expire while the tab is in the background.
  const hidden = usePageHidden();
  const paused = hovered || hidden;
  const remaining = useRef(item.duration);
  const started = useRef(Date.now());

  useEffect(() => {
    if (paused) return;
    started.current = Date.now();
    const t = setTimeout(onDismiss, remaining.current);
    return () => {
      clearTimeout(t);
      remaining.current -= Date.now() - started.current;
    };
  }, [paused, onDismiss]);

  return (
    <div
      className={`toast toast-${item.tone}`}
      role={item.tone === "error" ? "alert" : "status"}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setHovered(true)}
      onBlur={() => setHovered(false)}
    >
      <span className="toast-icon">{ICONS[item.tone]}</span>
      <div className="toast-content">
        <div className="toast-title">{item.title}</div>
        {item.description && <div className="toast-description">{item.description}</div>}
      </div>
      {item.action && (
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => {
            item.action!.onClick();
            onDismiss();
          }}
        >
          {item.action.label}
        </button>
      )}
      <button type="button" className="toast-close" onClick={onDismiss} aria-label="Dismiss notification">
        <X size={14} aria-hidden />
      </button>
    </div>
  );
}
