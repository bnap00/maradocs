import {
  type MutableRefObject,
  type ReactElement,
  type Ref,
  type ReactNode,
  cloneElement,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

interface TooltipProps {
  content: ReactNode;
  children: ReactElement<Record<string, unknown>>;
  side?: "top" | "bottom";
  delay?: number;
}

/**
 * Hover/focus tooltip rendered in a portal with fixed positioning, so it is
 * never clipped by scroll containers. The trigger gets aria-describedby.
 */
export function Tooltip({ content, children, side = "top", delay = 350 }: TooltipProps) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number; side: "top" | "bottom" } | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const show = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setOpen(true), delay);
  }, [delay]);
  const hide = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    setOpen(false);
    setPos(null);
  }, []);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && hide();
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", hide, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", hide, true);
    };
  }, [open, hide]);

  useLayoutEffect(() => {
    if (!open || !triggerRef.current || !tipRef.current) return;
    const r = triggerRef.current.getBoundingClientRect();
    const t = tipRef.current.getBoundingClientRect();
    const gap = 8;
    let s = side;
    let top = s === "top" ? r.top - t.height - gap : r.bottom + gap;
    if (s === "top" && top < 4) {
      s = "bottom";
      top = r.bottom + gap;
    } else if (s === "bottom" && top + t.height > window.innerHeight - 4) {
      s = "top";
      top = r.top - t.height - gap;
    }
    const left = Math.min(Math.max(4, r.left + r.width / 2 - t.width / 2), window.innerWidth - t.width - 4);
    setPos({ left, top, side: s });
  }, [open, side, content]);

  if (content == null || content === "") return children;

  const props = children.props as {
    onMouseEnter?: (e: unknown) => void;
    onMouseLeave?: (e: unknown) => void;
    onFocus?: (e: unknown) => void;
    onBlur?: (e: unknown) => void;
  };

  const childRef = (children.props as { ref?: Ref<HTMLElement> }).ref;

  const trigger = cloneElement(children, {
    ref: (node: HTMLElement | null) => {
      triggerRef.current = node;
      if (typeof childRef === "function") childRef(node);
      else if (childRef) (childRef as MutableRefObject<HTMLElement | null>).current = node;
    },
    "aria-describedby": open ? id : undefined,
    onMouseEnter: (e: unknown) => {
      props.onMouseEnter?.(e);
      show();
    },
    onMouseLeave: (e: unknown) => {
      props.onMouseLeave?.(e);
      hide();
    },
    onFocus: (e: unknown) => {
      props.onFocus?.(e);
      show();
    },
    onBlur: (e: unknown) => {
      props.onBlur?.(e);
      hide();
    },
  });

  return (
    <>
      {trigger}
      {open &&
        createPortal(
          <div
            ref={tipRef}
            id={id}
            role="tooltip"
            className={`tooltip ${pos ? "is-visible" : ""} tooltip-${pos?.side ?? side}`}
            style={pos ? { left: pos.left, top: pos.top } : { left: -9999, top: -9999 }}
          >
            {content}
          </div>,
          document.body,
        )}
    </>
  );
}
