import { useEffect, useState } from "react";
import { ExternalLink } from "lucide-react";
import type { Api, AuditEntry } from "../api";
import { auditActionLabel, auditActor, auditEventMeta, auditHref, auditTarget } from "../auditDisplay";
import { Empty, Spinner } from "../components/ui";
import { timeAgo } from "../format";

export function Audit({ api, toast }: { api: Api; toast: (m: string, e?: boolean) => void }) {
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);

  useEffect(() => {
    api
      .listAudit()
      .then((r) => setEntries(r.audit))
      .catch((e) => toast(e.message, true));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <>
      <div className="topbar">
        <div>
          <h1>Audit log</h1>
          <p>Publishes, deletes, access changes, and rollbacks.</p>
        </div>
      </div>

      {entries === null ? (
        <Spinner />
      ) : entries.length === 0 ? (
        <div className="card">
          <Empty icon="📜" text="No activity recorded yet." />
        </div>
      ) : (
        <div className="card">
          {entries.map((e) => {
            const meta = auditEventMeta(e.event);
            const target = auditTarget(e);
            const href = auditHref(e);
            return (
              <div key={e.id} className="list-row static">
                <span style={{ fontSize: 18 }}>{meta.icon}</span>
                <div className="grow">
                  <div className="title">
                    {meta.label}
                    {target && <span style={{ color: "var(--muted)" }}> · {target}</span>}
                  </div>
                  <div className="sub">
                    {auditActor(e)}
                    {e.detail ? ` · ${e.detail}` : ""}
                  </div>
                </div>
                {href && (
                  <a className="btn ghost sm" href={href} target="_blank" rel="noreferrer">
                    <ExternalLink size={14} /> {auditActionLabel(e)}
                  </a>
                )}
                <div className="sub">{timeAgo(e.createdAt)}</div>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
