import { type ReactNode, useEffect, useRef, useState } from "react";
import {
  Activity,
  BookOpen,
  CircleUser,
  KeyRound,
  LayoutGrid,
  LogOut,
  Menu,
  Monitor,
  Moon,
  Plug,
  Settings,
  Sun,
} from "lucide-react";
import { Link, useLocation } from "../lib/router";
import { type ThemePref, useTheme } from "../lib/theme";
import { useApp } from "../lib/app";
import { Drawer, Segmented, Tooltip } from "./ui";

interface NavItem {
  to: string;
  label: string;
  icon: ReactNode;
  match: (path: string) => boolean;
}

const NAV: NavItem[] = [
  { to: "/", label: "Overview", icon: <LayoutGrid size={16} aria-hidden />, match: (p) => p === "/" },
  { to: "/repos", label: "Repositories", icon: <BookOpen size={16} aria-hidden />, match: (p) => p.startsWith("/repos") },
  { to: "/keys", label: "API keys", icon: <KeyRound size={16} aria-hidden />, match: (p) => p.startsWith("/keys") },
  { to: "/connect", label: "Connect", icon: <Plug size={16} aria-hidden />, match: (p) => p.startsWith("/connect") },
  { to: "/activity", label: "Activity", icon: <Activity size={16} aria-hidden />, match: (p) => p.startsWith("/activity") },
  { to: "/settings", label: "Settings", icon: <Settings size={16} aria-hidden />, match: (p) => p.startsWith("/settings") },
];

export function Logo({ size = 26 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden className="logo-mark">
      <rect width="32" height="32" rx="8" fill="var(--accent)" />
      <path
        d="M9 22V10.5l7 6.5 7-6.5V22"
        fill="none"
        stroke="#fff"
        strokeWidth="2.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function Brand() {
  return (
    <Link to="/" className="brand" aria-label="MaraDocs overview">
      <Logo />
      <span className="brand-name">MaraDocs</span>
    </Link>
  );
}

function NavList({ onNavigate }: { onNavigate?: () => void }) {
  const { pathname } = useLocation();
  return (
    <nav aria-label="Main">
      <ul className="nav-list">
        {NAV.map((item) => {
          const active = item.match(pathname);
          return (
            <li key={item.to}>
              <Link
                to={item.to}
                className={`nav-item ${active ? "is-active" : ""}`}
                aria-current={active ? "page" : undefined}
                onClick={onNavigate}
              >
                {item.icon}
                <span>{item.label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

function ThemeSwitch() {
  const [pref, setPref] = useTheme();
  return (
    <Segmented<ThemePref>
      label="Color theme"
      size="sm"
      value={pref}
      onChange={setPref}
      options={[
        { value: "light", label: "", icon: <Sun size={14} aria-hidden />, title: "Light" },
        { value: "system", label: "", icon: <Monitor size={14} aria-hidden />, title: "System" },
        { value: "dark", label: "", icon: <Moon size={14} aria-hidden />, title: "Dark" },
      ]}
    />
  );
}

function SidebarFooter({ onSignOut }: { onSignOut: () => void }) {
  const { publicConfig, user } = useApp();
  return (
    <div className="sidebar-footer">
      <Link to="/settings" className="sidebar-account" title={`Signed in as ${user.email}`}>
        <CircleUser size={15} aria-hidden />
        <span className="sidebar-account-email">
          <span className="sr-only">Signed in as </span>
          {user.email}
        </span>
      </Link>
      <div className="sidebar-footer-row">
        <ThemeSwitch />
        <Tooltip content="Sign out">
          <button type="button" className="btn btn-ghost btn-icon btn-sm" onClick={onSignOut} aria-label="Sign out">
            <LogOut size={15} aria-hidden />
          </button>
        </Tooltip>
      </div>
      {publicConfig?.version && <p className="sidebar-version">v{publicConfig.version} · Cloudflare</p>}
    </div>
  );
}

export function Layout({ children, onSignOut }: { children: ReactNode; onSignOut: () => void }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const { pathname } = useLocation();
  const lastPath = useRef(pathname);
  const focusPending = useRef(false);

  useEffect(() => setMenuOpen(false), [pathname]);

  // Client-side navigation: move focus to the new page's heading so screen
  // readers announce it and keyboard users start at the content, not back in
  // the sidebar. Waits for the mobile menu to close (its focus restore runs
  // first) and skips the initial render.
  useEffect(() => {
    if (pathname !== lastPath.current) {
      lastPath.current = pathname;
      focusPending.current = true;
    }
    if (!focusPending.current || menuOpen) return;
    focusPending.current = false;
    const raf = requestAnimationFrame(() => {
      const main = document.getElementById("main");
      const heading = main?.querySelector<HTMLElement>("h1");
      (heading ?? main)?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(raf);
  }, [pathname, menuOpen]);

  return (
    <div className="shell">
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      <aside className="sidebar" aria-label="Sidebar">
        <div className="sidebar-top">
          <Brand />
        </div>
        <NavList />
        <SidebarFooter onSignOut={onSignOut} />
      </aside>

      <header className="topbar">
        <Brand />
        <button
          type="button"
          className="btn btn-ghost btn-icon"
          onClick={() => setMenuOpen(true)}
          aria-label="Open menu"
          aria-expanded={menuOpen}
          aria-haspopup="dialog"
        >
          <Menu size={18} aria-hidden />
        </button>
      </header>

      <Drawer open={menuOpen} onClose={() => setMenuOpen(false)} title="Menu" side="left" className="nav-drawer">
        <div className="nav-drawer-inner">
          <NavList onNavigate={() => setMenuOpen(false)} />
          <SidebarFooter onSignOut={onSignOut} />
        </div>
      </Drawer>

      <main id="main" className="main" tabIndex={-1}>
        <div className="content">{children}</div>
      </main>
    </div>
  );
}

export function PageHeader({
  title,
  description,
  actions,
  breadcrumb,
  meta,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  breadcrumb?: ReactNode;
  meta?: ReactNode;
}) {
  return (
    <div className="page-header">
      {breadcrumb && <div className="breadcrumb">{breadcrumb}</div>}
      <div className="page-header-row">
        <div className="page-header-text">
          <h1 className="page-title" tabIndex={-1}>
            {title}
          </h1>
          {description && <p className="page-description">{description}</p>}
          {meta && <div className="page-meta">{meta}</div>}
        </div>
        {actions && <div className="page-actions">{actions}</div>}
      </div>
    </div>
  );
}
