import { useCallback, useEffect, useRef, useState } from "react";
import { Activity as ActivityIcon, Cpu, Filter, X } from "lucide-react";
import { api } from "../api";
import { PageHeader } from "../components/Layout";
import {
  Badge,
  Button,
  EmptyState,
  ErrorState,
  RelativeTime,
  Segmented,
  Select,
  SkeletonRows,
  useToast,
} from "../components/ui";
import { AuditDetail, auditActor, auditTarget, auditTargetPath, eventMeta, formatAuditDetail } from "../lib/audit";
import { Link, navigate, useLocation } from "../lib/router";
import { useDocumentTitle } from "../lib/useDocumentTitle";
import { useResource } from "../lib/useResource";
import { AUDIT_EVENTS, type AuditEntry } from "../types";

const PAGE = 50;

type Tab = "audit" | "machines";

export function ActivityPage() {
  useDocumentTitle("Activity");
  const { search } = useLocation();
  const params = new URLSearchParams(search);
  const tab: Tab = params.get("tab") === "machines" ? "machines" : "audit";
  const event = params.get("event") ?? "";
  const repo = params.get("repo") ?? "";

  function setParams(next: { tab?: Tab; event?: string; repo?: string }) {
    const sp = new URLSearchParams();
    const t = next.tab ?? tab;
    if (t !== "audit") sp.set("tab", t);
    const e = next.event ?? event;
    const r = next.repo ?? repo;
    if (t === "audit") {
      if (e) sp.set("event", e);
      if (r) sp.set("repo", r);
    }
    const qs = sp.toString();
    navigate(`/activity${qs ? `?${qs}` : ""}`, { replace: true });
  }

  return (
    <>
      <PageHeader
        title="Activity"
        description="An audit trail of everything that changed, and the machines that publish here."
        actions={
          <Segmented<Tab>
            label="Activity view"
            value={tab}
            onChange={(t) => setParams({ tab: t })}
            options={[
              { value: "audit", label: "Audit log", icon: <ActivityIcon size={14} aria-hidden /> },
              { value: "machines", label: "Machines", icon: <Cpu size={14} aria-hidden /> },
            ]}
          />
        }
      />
      {tab === "audit" ? (
        <AuditLog event={event} repo={repo} onFilter={(f) => setParams(f)} />
      ) : (
        <Machines />
      )}
    </>
  );
}

function AuditLog({
  event,
  repo,
  onFilter,
}: {
  event: string;
  repo: string;
  onFilter: (f: { event?: string; repo?: string }) => void;
}) {
  const toast = useToast();
  const repos = useResource(() => api.listRepos().then((r) => r.repos.map((x) => x.slug).sort()), []);
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const seq = useRef(0);
  const sentinel = useRef<HTMLDivElement>(null);

  const loadFirst = useCallback(async () => {
    const id = ++seq.current;
    setEntries(null);
    setError(null);
    setCursor(null);
    try {
      const page = await api.listAudit({ limit: PAGE, event: event || null, repo: repo || null });
      if (id !== seq.current) return;
      setEntries(page.audit);
      setCursor(page.nextCursor);
    } catch (err) {
      if (id === seq.current) setError(err);
    }
  }, [event, repo]);

  useEffect(() => {
    void loadFirst();
  }, [loadFirst]);

  const loadMore = useCallback(async () => {
    if (!cursor || loadingMore) return;
    const id = seq.current;
    setLoadingMore(true);
    try {
      const page = await api.listAudit({ limit: PAGE, before: cursor, event: event || null, repo: repo || null });
      if (id !== seq.current) return;
      setEntries((prev) => {
        const seen = new Set((prev ?? []).map((e) => e.id));
        return [...(prev ?? []), ...page.audit.filter((e) => !seen.has(e.id))];
      });
      setCursor(page.nextCursor);
    } catch (err) {
      toast.error(err);
    } finally {
      setLoadingMore(false);
    }
  }, [cursor, loadingMore, event, repo, toast]);

  // Infinite scroll: load the next page when the sentinel scrolls into view.
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !cursor || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver((items) => {
      if (items.some((i) => i.isIntersecting)) void loadMore();
    }, { rootMargin: "200px" });
    io.observe(el);
    return () => io.disconnect();
  }, [cursor, loadMore]);

  const filtered = Boolean(event || repo);

  return (
    <div className="stack-4">
      <div className="toolbar" role="group" aria-label="Filters">
        <span className="toolbar-label">
          <Filter size={14} aria-hidden /> Filter
        </span>
        <Select aria-label="Event type" value={event} onChange={(e) => onFilter({ event: e.target.value })} className="toolbar-select">
          <option value="">All events</option>
          {AUDIT_EVENTS.map((ev) => (
            <option key={ev} value={ev}>
              {eventMeta(ev).label}
            </option>
          ))}
        </Select>
        <Select aria-label="Repository" value={repo} onChange={(e) => onFilter({ repo: e.target.value })} className="toolbar-select">
          <option value="">All repositories</option>
          {repo && !repos.data?.includes(repo) && <option value={repo}>{repo}</option>}
          {repos.data?.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </Select>
        {filtered && (
          <Button size="sm" variant="ghost" icon={<X size={14} aria-hidden />} onClick={() => onFilter({ event: "", repo: "" })}>
            Clear
          </Button>
        )}
      </div>

      <div className="card card-flush">
        {error && !entries ? (
          <ErrorState error={error} onRetry={loadFirst} />
        ) : !entries ? (
          <SkeletonRows rows={8} cols={4} />
        ) : entries.length === 0 ? (
          <EmptyState icon={<ActivityIcon size={20} aria-hidden />} title={filtered ? "No matching events" : "No activity yet"}>
            {filtered ? "Try a different filter." : "Publishes, sign-ins, key and setting changes are recorded here."}
          </EmptyState>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Event</th>
                <th scope="col">Target</th>
                <th scope="col">Actor</th>
                <th scope="col">Details</th>
                <th scope="col">When</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((a) => {
                const meta = eventMeta(a.event);
                const path = auditTargetPath(a);
                const target = auditTarget(a);
                return (
                  <tr key={a.id}>
                    <td data-label="Event" className="cell-primary">
                      <Badge tone={meta.tone} icon={meta.icon}>
                        {meta.label}
                      </Badge>
                    </td>
                    <td data-label="Target">
                      {!target ? (
                        <span className="muted">—</span>
                      ) : path ? (
                        <Link to={path} className="mono">
                          {target}
                        </Link>
                      ) : (
                        <span className="mono">{target}</span>
                      )}
                    </td>
                    <td data-label="Actor">
                      <span className="actor">
                        {a.actorType === "machine" ? <Cpu size={13} aria-hidden /> : null}
                        {auditActor(a)}
                      </span>
                    </td>
                    <td data-label="Details" className="cell-detail">
                      {formatAuditDetail(a).length ? (
                        <span className="audit-detail" title={a.detail ?? undefined}>
                          <AuditDetail entry={a} />
                        </span>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td data-label="When">
                      <RelativeTime iso={a.createdAt} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
      {entries && entries.length > 0 && (
        <div className="load-more" ref={sentinel}>
          {cursor ? (
            <Button onClick={loadMore} loading={loadingMore}>
              Load more
            </Button>
          ) : (
            <span className="muted small">You've reached the beginning.</span>
          )}
        </div>
      )}
    </div>
  );
}

function Machines() {
  const res = useResource(() => api.listMachines().then((r) => r.machines), []);
  const machines = res.data;
  return (
    <div className="card card-flush">
      {res.error && !machines ? (
        <ErrorState error={res.error} onRetry={res.reload} />
      ) : !machines ? (
        <SkeletonRows rows={4} cols={4} />
      ) : machines.length === 0 ? (
        <EmptyState
          icon={<Cpu size={20} aria-hidden />}
          title="No machines yet"
          actions={
            <Link to="/connect" className="btn btn-secondary">
              <span className="btn-label">Connect an agent</span>
            </Link>
          }
        >
          A machine appears here the first time an API key is used.
        </EmptyState>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th scope="col">Machine</th>
              <th scope="col">Scopes</th>
              <th scope="col">First seen</th>
              <th scope="col">Last active</th>
            </tr>
          </thead>
          <tbody>
            {machines.map((m) => (
              <tr key={m.id}>
                <td data-label="Machine" className="cell-primary">
                  <span className="cell-title-plain">{m.name}</span>
                  {m.subject && <span className="cell-sub mono">{m.subject}</span>}
                </td>
                <td data-label="Scopes">
                  <span className="badge-list">
                    {m.scopes.map((s) => (
                      <Badge key={s} tone={s === "admin" ? "warning" : s === "publish" ? "accent" : "neutral"}>
                        {s}
                      </Badge>
                    ))}
                  </span>
                </td>
                <td data-label="First seen">
                  <RelativeTime iso={m.createdAt} />
                </td>
                <td data-label="Last active">
                  <RelativeTime iso={m.lastUsedAt} fallback="—" />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
