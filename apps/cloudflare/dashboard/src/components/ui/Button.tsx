import { type AnchorHTMLAttributes, type ButtonHTMLAttributes, type ReactNode, forwardRef } from "react";
import { Link } from "../../lib/router";
import { Spinner } from "./Spinner";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "danger-ghost";
export type ButtonSize = "sm" | "md";

interface CommonProps {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: ReactNode;
  iconRight?: ReactNode;
  /** Square icon-only button; requires aria-label. */
  iconOnly?: boolean;
  block?: boolean;
}

function classes(p: CommonProps & { className?: string; loading?: boolean }): string {
  return [
    "btn",
    `btn-${p.variant ?? "secondary"}`,
    p.size === "sm" ? "btn-sm" : "",
    p.iconOnly ? "btn-icon" : "",
    p.block ? "btn-block" : "",
    p.loading ? "is-loading" : "",
    p.className ?? "",
  ]
    .filter(Boolean)
    .join(" ");
}

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> &
  CommonProps & { loading?: boolean };

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant, size, icon, iconRight, iconOnly, block, loading, className, children, disabled, type, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type ?? "button"}
      className={classes({ variant, size, iconOnly, block, loading, className })}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <Spinner size={size === "sm" ? 14 : 16} /> : icon}
      {children != null && children !== false && <span className="btn-label">{children}</span>}
      {iconRight}
    </button>
  );
});

type AnchorProps = AnchorHTMLAttributes<HTMLAnchorElement> & CommonProps;

/** External / plain anchor styled as a button (e.g. report links, downloads). */
export const ButtonAnchor = forwardRef<HTMLAnchorElement, AnchorProps>(function ButtonAnchor(
  { variant, size, icon, iconRight, iconOnly, block, className, children, ...rest },
  ref,
) {
  return (
    <a ref={ref} className={classes({ variant, size, iconOnly, block, className })} {...rest}>
      {icon}
      {children != null && children !== false && <span className="btn-label">{children}</span>}
      {iconRight}
    </a>
  );
});

type LinkProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> & CommonProps & { to: string };

/** In-app navigation styled as a button. */
export function ButtonLink({ variant, size, icon, iconRight, iconOnly, block, className, children, to, ...rest }: LinkProps) {
  return (
    <Link to={to} className={classes({ variant, size, iconOnly, block, className })} {...rest}>
      {icon}
      {children != null && children !== false && <span className="btn-label">{children}</span>}
      {iconRight}
    </Link>
  );
}
