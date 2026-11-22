import { useEffect, useState } from "react";

/** Whole seconds left until `until` (epoch ms); 0 when unset or past. */
export function useCountdown(until: number | null): number {
  // Ticks once a second while counting down; the value itself is derived from
  // the clock during render, so it is correct on the very render `until` changes.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (until === null) return;
    const t = setInterval(() => {
      setTick((n) => n + 1);
      if (Date.now() >= until) clearInterval(t);
    }, 1000);
    return () => clearInterval(t);
  }, [until]);
  return until === null ? 0 : Math.max(0, Math.ceil((until - Date.now()) / 1000));
}

/** 868 → "14:28"; 42 → "0:42". */
export function formatCountdown(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}
