import type { CSSProperties } from "react";

export function Skeleton({
  width,
  height = 14,
  radius,
  className,
  style,
}: {
  width?: number | string;
  height?: number | string;
  radius?: number | string;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <span
      className={`skeleton ${className ?? ""}`}
      style={{ width, height, borderRadius: radius, ...style }}
      aria-hidden
    />
  );
}

export function SkeletonRows({ rows = 4, cols = 4 }: { rows?: number; cols?: number }) {
  return (
    <div className="skeleton-table" role="status" aria-label="Loading">
      {Array.from({ length: rows }, (_, r) => (
        <div className="skeleton-row" key={r}>
          {Array.from({ length: cols }, (_, c) => (
            <Skeleton key={c} width={c === 0 ? "38%" : `${14 + ((r + c) % 3) * 6}%`} />
          ))}
        </div>
      ))}
    </div>
  );
}

export function SkeletonCards({ count = 4 }: { count?: number }) {
  return (
    <>
      {Array.from({ length: count }, (_, i) => (
        <div className="card stat-card" key={i} aria-hidden>
          <Skeleton width={80} height={12} />
          <Skeleton width={56} height={26} style={{ marginTop: 12 }} />
        </div>
      ))}
    </>
  );
}
