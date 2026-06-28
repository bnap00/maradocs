import { useEffect, useMemo, useState, type ReactNode } from "react";
import { FolderGit2, KeyRound, ScrollText, LayoutDashboard } from "lucide-react";
import { createApi, type TokenGetter } from "./api";
import { Repositories } from "./views/Repositories";
import { ApiKeys } from "./views/ApiKeys";
import { Audit } from "./views/Audit";
import { Overview } from "./views/Overview";

type View = "overview" | "repos" | "apiKeys" | "audit";

const NAV: { id: View; label: string; icon: ReactNode }[] = [
  { id: "overview", label: "Overview", icon: <LayoutDashboard size={18} /> },
  { id: "repos", label: "Repositories", icon: <FolderGit2 size={18} /> },
  { id: "apiKeys", label: "API Keys", icon: <KeyRound size={18} /> },
  { id: "audit", label: "Audit log", icon: <ScrollText size={18} /> },
];

export function Dashboard({
  getToken,
  account,
  onSessionExpired,
}: {
  getToken: TokenGetter;
  account: ReactNode;
  onSessionExpired?: () => void;
}) {
  const api = useMemo(() => createApi(getToken, onSessionExpired), [getToken, onSessionExpired]);
  const [view, setView] = useState<View>("overview");
  const [toast, setToast] = useState<{ msg: string; error?: boolean } | null>(null);

  const showToast = (msg: string, error?: boolean) => setToast({ msg, error });

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3200);
    return () => clearTimeout(t);
  }, [toast]);

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <div className="logo">M</div>
          <div>
            <b>MaraDocs</b>
            <small>Publisher dashboard live dev check</small>
          </div>
        </div>
        {NAV.map((n) => (
          <button
            key={n.id}
            className={`nav-item ${view === n.id ? "active" : ""}`}
            onClick={() => setView(n.id)}
          >
            {n.icon}
            {n.label}
          </button>
        ))}
        <div className="sidebar-foot">{account}</div>
      </aside>

      <main className="main">
        {view === "overview" && <Overview api={api} toast={showToast} onNavigate={setView} />}
        {view === "repos" && <Repositories api={api} toast={showToast} />}
        {view === "apiKeys" && <ApiKeys api={api} toast={showToast} />}
        {view === "audit" && <Audit api={api} toast={showToast} />}
      </main>

      {toast && <div className={`toast ${toast.error ? "error" : ""}`}>{toast.msg}</div>}
    </div>
  );
}
