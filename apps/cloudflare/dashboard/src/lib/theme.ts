import { useCallback, useSyncExternalStore } from "react";

export type ThemePref = "system" | "light" | "dark";
const KEY = "maradocs.theme";
const EVENT = "maradocs:theme";

function read(): ThemePref {
  try {
    const v = window.localStorage.getItem(KEY);
    if (v === "light" || v === "dark" || v === "system") return v;
  } catch {
    // storage unavailable (private mode, blocked): fall back to system
  }
  return "system";
}

export function applyTheme(pref: ThemePref = read()): void {
  const root = document.documentElement;
  if (pref === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", pref);
}

function subscribe(cb: () => void): () => void {
  window.addEventListener(EVENT, cb);
  window.addEventListener("storage", cb);
  return () => {
    window.removeEventListener(EVENT, cb);
    window.removeEventListener("storage", cb);
  };
}

export function useTheme(): [ThemePref, (p: ThemePref) => void, "light" | "dark"] {
  const pref = useSyncExternalStore(subscribe, read, () => "system" as ThemePref);
  const systemDark = useSyncExternalStore(
    (cb) => {
      const mq = window.matchMedia("(prefers-color-scheme: dark)");
      mq.addEventListener("change", cb);
      return () => mq.removeEventListener("change", cb);
    },
    () => window.matchMedia("(prefers-color-scheme: dark)").matches,
    () => false,
  );
  const set = useCallback((p: ThemePref) => {
    try {
      if (p === "system") window.localStorage.removeItem(KEY);
      else window.localStorage.setItem(KEY, p);
    } catch {
      // ignore: the choice still applies for this page view
    }
    applyTheme(p);
    window.dispatchEvent(new Event(EVENT));
  }, []);
  const resolved = pref === "system" ? (systemDark ? "dark" : "light") : pref;
  return [pref, set, resolved];
}
