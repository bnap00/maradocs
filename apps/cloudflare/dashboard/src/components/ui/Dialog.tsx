import { type ReactNode, type RefObject, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

const FOCUSABLE =
  'a[href], area[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), iframe, [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

let openCount = 0;
const stack: Array<RefObject<HTMLDivElement | null>> = [];

function focusables(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => el.offsetParent !== null || el === document.activeElement,
  );
}

/**
 * Shared modal behaviour: portal, focus trap, Esc to close, restore focus,
 * body scroll lock, stacked modals (only the top one reacts to keys).
 */
function useModal(
  open: boolean,
  onClose: () => void,
  panelRef: RefObject<HTMLDivElement | null>,
  dismissible: boolean,
  initialFocus?: RefObject<HTMLElement | null>,
) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const dismissRef = useRef(dismissible);
  dismissRef.current = dismissible;

  useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    stack.push(panelRef);
    openCount++;
    if (openCount === 1) {
      const scrollbar = window.innerWidth - document.documentElement.clientWidth;
      document.body.style.overflow = "hidden";
      if (scrollbar > 0) document.body.style.paddingRight = `${scrollbar}px`;
    }

    // The panel is rendered in the same commit that sets `open` (see
    // usePresence), so it is in the DOM when this effect runs. Focus it now;
    // a rAF fallback covers content that mounts a frame later.
    const focusInitial = (): boolean => {
      const panel = panelRef.current;
      if (!panel) return false;
      if (panel.contains(document.activeElement)) return true;
      const target =
        initialFocus?.current ??
        panel.querySelector<HTMLElement>("[data-autofocus]") ??
        focusables(panel).find((el) => !el.classList.contains("modal-close")) ??
        panel;
      target.focus({ preventScroll: true });
      return true;
    };
    const raf = focusInitial() ? 0 : requestAnimationFrame(() => void focusInitial());

    function onKey(e: KeyboardEvent) {
      if (stack[stack.length - 1] !== panelRef) return;
      const panel = panelRef.current;
      if (!panel) return;
      if (e.key === "Escape") {
        if (dismissRef.current) {
          e.stopPropagation();
          closeRef.current();
        }
        return;
      }
      if (e.key !== "Tab") return;
      const items = focusables(panel);
      if (!items.length) {
        e.preventDefault();
        panel.focus();
        return;
      }
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const active = document.activeElement;
      if (e.shiftKey && (active === first || !panel.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !panel.contains(active))) {
        e.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", onKey, true);

    return () => {
      if (raf) cancelAnimationFrame(raf);
      document.removeEventListener("keydown", onKey, true);
      const i = stack.lastIndexOf(panelRef);
      if (i !== -1) stack.splice(i, 1);
      openCount--;
      if (openCount === 0) {
        document.body.style.overflow = "";
        document.body.style.paddingRight = "";
      }
      if (previouslyFocused && document.contains(previouslyFocused)) {
        previouslyFocused.focus({ preventScroll: true });
      }
    };
  }, [open, panelRef, initialFocus]);
}

/** Keep content mounted during the exit animation. */
function usePresence(open: boolean, ms = 180): boolean {
  const [mounted, setMounted] = useState(open);
  useEffect(() => {
    if (open) {
      setMounted(true);
      return;
    }
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const t = setTimeout(() => setMounted(false), reduce ? 0 : ms);
    return () => clearTimeout(t);
  }, [open, ms]);
  // Render immediately when opening (no extra commit), keep rendering while closing.
  return open || mounted;
}

interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  size?: "sm" | "md" | "lg";
  /** Prevent closing via Esc / backdrop (e.g. while uploading). */
  dismissible?: boolean;
  initialFocus?: RefObject<HTMLElement | null>;
  icon?: ReactNode;
  tone?: "default" | "danger";
}

export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = "md",
  dismissible = true,
  initialFocus,
  icon,
  tone = "default",
}: DialogProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descId = useId();
  const mounted = usePresence(open);
  useModal(open, onClose, panelRef, dismissible, initialFocus);
  if (!mounted) return null;
  return createPortal(
    <div className={`modal-root ${open ? "is-open" : "is-closing"}`}>
      <div className="modal-backdrop" onMouseDown={() => dismissible && onClose()} aria-hidden />
      <div className="modal-center">
        <div
          ref={panelRef}
          className={`modal modal-${size} ${tone === "danger" ? "modal-danger" : ""}`}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          aria-describedby={description ? descId : undefined}
          tabIndex={-1}
        >
          <header className="modal-header">
            {icon && <div className="modal-icon">{icon}</div>}
            <div className="modal-titles">
              <h2 id={titleId} className="modal-title">
                {title}
              </h2>
              {description && (
                <p id={descId} className="modal-description">
                  {description}
                </p>
              )}
            </div>
            {dismissible && (
              <button type="button" className="modal-close btn btn-ghost btn-icon btn-sm" onClick={onClose} aria-label="Close">
                <X size={16} aria-hidden />
              </button>
            )}
          </header>
          {children != null && <div className="modal-body">{children}</div>}
          {footer && <footer className="modal-footer">{footer}</footer>}
        </div>
      </div>
    </div>,
    document.body,
  );
}

interface DrawerProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  dismissible?: boolean;
  side?: "right" | "left";
  className?: string;
}

export function Drawer({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  dismissible = true,
  side = "right",
  className,
}: DrawerProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descId = useId();
  const mounted = usePresence(open, 240);
  useModal(open, onClose, panelRef, dismissible);
  if (!mounted) return null;
  return createPortal(
    <div className={`modal-root drawer-root drawer-${side} ${open ? "is-open" : "is-closing"}`}>
      <div className="modal-backdrop" onMouseDown={() => dismissible && onClose()} aria-hidden />
      <div
        ref={panelRef}
        className={`drawer ${className ?? ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        tabIndex={-1}
      >
        <header className="drawer-header">
          <div className="modal-titles">
            <h2 id={titleId} className="modal-title">
              {title}
            </h2>
            {description && (
              <p id={descId} className="modal-description">
                {description}
              </p>
            )}
          </div>
          {dismissible && (
            <button type="button" className="modal-close btn btn-ghost btn-icon btn-sm" onClick={onClose} aria-label="Close">
              <X size={16} aria-hidden />
            </button>
          )}
        </header>
        <div className="drawer-body">{children}</div>
        {footer && <footer className="drawer-footer">{footer}</footer>}
      </div>
    </div>,
    document.body,
  );
}
