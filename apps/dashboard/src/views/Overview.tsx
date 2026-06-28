import { useEffect, useState } from "react";
import { ArrowRight, ExternalLink } from "lucide-react";
import type { Api, AuditEntry } from "../api";
import { auditActionLabel, auditActor, auditEventMeta, auditHref, auditTarget } from "../auditDisplay";
import { Spinner } from "../components/ui";
import { timeAgo } from "../format";

interface Stats {
  repos: number;
  docs: number;
  apiKeys: number;
  recent: AuditEntry[];
}

export function Overview({
  api,
  toast,
  onNavigate,
}: {
  api: Api;
  toast: (m: string, e?: boolean) => void;
  onNavigate: (v: "repos" | "apiKeys" | "audit") => void;
}) {
  const [stats, setStats] = useState<Stats | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const [repos, machines, audit] = await Promise.all([
          api.listRepos(),
          api.listMachines(),
          api.listAudit(),
        ]);
        let docs = 0;
        await Promise.all(
          repos.repos.map(async (r) => {
            const d = await api.listDocs(r.slug);
            docs += d.docs.length;
          }),
        );
        setStats({
          repos: repos.repos.length,
          docs,
          apiKeys: machines.machines.length,
          recent: audit.audit.slice(0, 6),
        });
      } catch (e) {
        toast((e as Error).message, true);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!stats) return <Spinner />;

  return (
    <>
      <div className="topbar">
        <div>
          <h1>Overview</h1>
          <p>Your publishing surface at a glance.</p>
        </div>
      </div>

      <div className="grid-cards">
        <button className="stat" style={{ textAlign: "left", cursor: "pointer" }} onClick={() => onNavigate("repos")}>
          <div className="n">{stats.repos}</div>
          <div className="l">Repositories</div>
        </button>
        <div className="stat">
          <div className="n">{stats.docs}</div>
          <div className="l">Documents</div>
        </div>
        <button className="stat" style={{ textAlign: "left", cursor: "pointer" }} onClick={() => onNavigate("apiKeys")}>
          <div className="n">{stats.apiKeys}</div>
          <div className="l">API Keys</div>
        </button>
        <button className="stat" style={{ textAlign: "left", cursor: "pointer" }} onClick={() => onNavigate("audit")}>
          <div className="n">{stats.recent.length}</div>
          <div className="l">Recent events</div>
        </button>
      </div>

      <div className="card">
        <div className="list-row static" style={{ fontWeight: 600 }}>
          <div className="grow">Recent activity</div>
          <button className="btn ghost sm" onClick={() => onNavigate("audit")}>
            View all <ArrowRight size={14} />
          </button>
        </div>
        {stats.recent.length === 0 ? (
          <div className="list-row static">
            <span className="sub">No activity yet — publish your first report.</span>
          </div>
        ) : (
          stats.recent.map((e) => {
            const meta = auditEventMeta(e.event);
            const target = auditTarget(e);
            const href = auditHref(e);
            return (
              <div key={e.id} className="list-row static">
                <span style={{ fontSize: 18 }}>{meta.icon}</span>
                <div className="grow">
                  <div className="title" style={{ fontSize: 13 }}>
                    {meta.label}
                    {target && <span style={{ color: "var(--muted)" }}> · {target}</span>}
                  </div>
                  <div className="sub">{auditActor(e)}</div>
                </div>
                {href && (
                  <a className="btn ghost sm" href={href} target="_blank" rel="noreferrer">
                    <ExternalLink size={14} /> {auditActionLabel(e)}
                  </a>
                )}
                <div className="sub">{timeAgo(e.createdAt)}</div>
              </div>
            );
          })
        )}
      </div>
    </>
  );
}
