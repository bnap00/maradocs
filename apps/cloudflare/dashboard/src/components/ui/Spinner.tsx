export function Spinner({ size = 16, label }: { size?: number; label?: string }) {
  return (
    <svg
      className="spinner"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.22" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

export function PageSpinner({ label = "Loading" }: { label?: string }) {
  return (
    <div className="page-spinner" role="status">
      <Spinner size={22} />
      <span className="sr-only">{label}</span>
    </div>
  );
}
