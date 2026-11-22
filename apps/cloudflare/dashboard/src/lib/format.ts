const rtf = typeof Intl !== "undefined" && "RelativeTimeFormat" in Intl
  ? new Intl.RelativeTimeFormat(undefined, { numeric: "auto", style: "short" })
  : null;

const absFmt = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  const digits = v >= 100 ? 0 : v >= 10 ? 1 : 2;
  // Number() drops trailing zeros: 25 MB, not "25.0 MB"; 1.5 KB, not "1.50 KB".
  return `${Number(v.toFixed(digits))} ${units[i]}`;
}

export function formatNumber(n: number): string {
  return new Intl.NumberFormat().format(n);
}

export function parseDate(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function absoluteTime(iso: string | null | undefined): string {
  const d = parseDate(iso);
  return d ? absFmt.format(d) : "—";
}

export function relativeTime(iso: string | null | undefined, now: number = Date.now()): string {
  const d = parseDate(iso);
  if (!d) return "—";
  const diffSec = Math.round((d.getTime() - now) / 1000);
  const abs = Math.abs(diffSec);
  if (abs < 45) return "just now";
  if (!rtf) return absFmt.format(d);
  const table: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ["minute", 60],
    ["hour", 3600],
    ["day", 86400],
    ["week", 604800],
    ["month", 2629800],
    ["year", 31557600],
  ];
  let unit: Intl.RelativeTimeFormatUnit = "minute";
  let size = 60;
  for (const [u, s] of table) {
    if (abs >= s * 0.9) {
      unit = u;
      size = s;
    }
  }
  return rtf.format(Math.round(diffSec / size), unit);
}

export function shortHash(hash: string, len = 10): string {
  return hash.length > len ? hash.slice(0, len) : hash;
}

export function pluralize(n: number, one: string, many = `${one}s`): string {
  return `${formatNumber(n)} ${n === 1 ? one : many}`;
}
