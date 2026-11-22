// A tiny History-API router for the dashboard. All app paths are relative to
// BASE ("/dashboard"); the Worker falls back to index.html for unknown paths.
import {
  type AnchorHTMLAttributes,
  type MouseEvent,
  forwardRef,
  useSyncExternalStore,
} from "react";

export const BASE = "/dashboard";
const NAV_EVENT = "maradocs:navigate";

export interface Location {
  /** Path relative to BASE, always starting with "/" (e.g. "/repos/demo"). */
  pathname: string;
  search: string;
}

function stripBase(fullPath: string): string {
  if (fullPath === BASE) return "/";
  if (fullPath.startsWith(`${BASE}/`)) return fullPath.slice(BASE.length) || "/";
  return fullPath || "/";
}

let cached: Location | null = null;
let cachedKey = "";

function snapshot(): Location {
  const key = window.location.pathname + window.location.search;
  if (!cached || key !== cachedKey) {
    cachedKey = key;
    cached = { pathname: stripBase(window.location.pathname), search: window.location.search };
  }
  return cached;
}

function subscribe(cb: () => void): () => void {
  window.addEventListener("popstate", cb);
  window.addEventListener(NAV_EVENT, cb);
  return () => {
    window.removeEventListener("popstate", cb);
    window.removeEventListener(NAV_EVENT, cb);
  };
}

export function useLocation(): Location {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

export function useSearchParam(name: string): string | null {
  const { search } = useLocation();
  return new URLSearchParams(search).get(name);
}

/** Absolute href (including BASE) for an app path. */
export function href(to: string): string {
  if (to === "/") return `${BASE}/`;
  return `${BASE}${to.startsWith("/") ? to : `/${to}`}`;
}

export function navigate(to: string, opts: { replace?: boolean } = {}): void {
  const url = href(to);
  if (url === window.location.pathname + window.location.search) return;
  if (opts.replace) window.history.replaceState(null, "", url);
  else window.history.pushState(null, "", url);
  window.dispatchEvent(new Event(NAV_EVENT));
  if (!opts.replace) window.scrollTo({ top: 0 });
}

/** Current location as an absolute same-origin path, for `?next=`. */
export function currentFullPath(): string {
  return window.location.pathname + window.location.search;
}

/**
 * Validate a `?next=` value. Only same-origin relative paths under `/r/` or
 * `/dashboard/` are honoured, so the login page can't be abused as an open
 * redirect (`//evil.com`, `/\evil.com`, `javascript:` …).
 */
export function safeNext(next: string | null): string | null {
  if (!next) return null;
  if (!next.startsWith("/") || next.startsWith("//") || next.includes("\\")) return null;
  // Reject control characters (incl. tab/newline, which URL parsers strip).
  for (let i = 0; i < next.length; i++) {
    if (next.charCodeAt(i) < 0x20 || next.charCodeAt(i) === 0x7f) return null;
  }
  let url: URL;
  try {
    url = new URL(next, window.location.origin);
  } catch {
    return null;
  }
  if (url.origin !== window.location.origin) return null;
  const path = url.pathname;
  if (!path.startsWith("/r/") && !path.startsWith(`${BASE}/`)) return null;
  if (path.startsWith(`${BASE}/login`)) return null;
  return path + url.search + url.hash;
}

/** Follow a validated `next` target: SPA navigation for dashboard paths, full load otherwise. */
export function followNext(next: string | null): void {
  const target = safeNext(next);
  if (!target) {
    navigate("/", { replace: true });
    return;
  }
  if (target.startsWith(`${BASE}/`)) {
    window.history.replaceState(null, "", target);
    window.dispatchEvent(new Event(NAV_EVENT));
    return;
  }
  window.location.assign(target);
}

export type LoginReason = "expired";

export function loginPath(next?: string, reason?: LoginReason): string {
  const n = next ?? currentFullPath();
  const sp = new URLSearchParams();
  if (safeNext(n)) sp.set("next", n);
  if (reason) sp.set("reason", reason);
  const qs = sp.toString();
  return qs ? `/login?${qs}` : "/login";
}

/** Match `pattern` (e.g. "/repos/:repo") against a path; returns decoded params or null. */
export function matchPath(pattern: string, path: string): Record<string, string> | null {
  const p = pattern.split("/").filter(Boolean);
  const s = path.split("/").filter(Boolean);
  if (p.length !== s.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < p.length; i++) {
    const seg = p[i]!;
    const val = s[i]!;
    if (seg.startsWith(":")) {
      try {
        params[seg.slice(1)] = decodeURIComponent(val);
      } catch {
        return null;
      }
    } else if (seg !== val) {
      return null;
    }
  }
  return params;
}

type LinkProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> & { to: string };

export const Link = forwardRef<HTMLAnchorElement, LinkProps>(function Link(
  { to, onClick, target, ...rest },
  ref,
) {
  function handle(e: MouseEvent<HTMLAnchorElement>) {
    onClick?.(e);
    if (
      e.defaultPrevented ||
      e.button !== 0 ||
      e.metaKey ||
      e.ctrlKey ||
      e.shiftKey ||
      e.altKey ||
      (target && target !== "_self")
    ) {
      return;
    }
    e.preventDefault();
    navigate(to);
  }
  return <a ref={ref} href={href(to)} target={target} onClick={handle} {...rest} />;
});
