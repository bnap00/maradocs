import { useEffect, useState } from "react";
import { absoluteTime, relativeTime } from "../../lib/format";
import { Tooltip } from "./Tooltip";

const listeners = new Set<() => void>();
let interval: ReturnType<typeof setInterval> | null = null;

function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const cb = () => setNow(Date.now());
    listeners.add(cb);
    if (!interval) interval = setInterval(() => listeners.forEach((l) => l()), 30_000);
    return () => {
      listeners.delete(cb);
      if (!listeners.size && interval) {
        clearInterval(interval);
        interval = null;
      }
    };
  }, []);
  return now;
}

export function RelativeTime({ iso, fallback = "Never" }: { iso: string | null | undefined; fallback?: string }) {
  const now = useNow();
  if (!iso) return <span className="muted">{fallback}</span>;
  const abs = absoluteTime(iso);
  const rel = relativeTime(iso, now);
  // Not a tab stop: the tooltip is a hover nicety, and screen readers get the
  // absolute time from the accessible name instead of a focus-only tooltip.
  return (
    <Tooltip content={abs}>
      <time dateTime={iso} className="reltime" aria-label={`${rel}, ${abs}`}>
        {rel}
      </time>
    </Tooltip>
  );
}

