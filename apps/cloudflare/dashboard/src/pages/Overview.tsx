import { useState } from "react";
import { ArrowRight, BookOpen, Database, FileText, KeyRound, Layers, Plug, Rocket } from "lucide-react";
import { api, versionUrl } from "../api";
import { PageHeader } from "../components/Layout";
import {
  Badge,
  Button,
  ButtonLink,
  CodeBlock,
  Dialog,
  Field,
  Select,
  EmptyState,
  ErrorState,
  RelativeTime,
  SkeletonCards,
  SkeletonRows,
} from "../components/ui";
import { useApp } from "../lib/app";
import { auditActor, auditTarget, auditTargetPath, eventMeta } from "../lib/audit";
import { formatBytes, formatNumber, pluralize } from "../lib/format";
import { Link, navigate } from "../lib/router";
import { useDocumentTitle } from "../lib/useDocumentTitle";
import { useResource } from "../lib/useResource";
import type { Repository } from "../types";

export function OverviewPage() {
  useDocumentTitle("Overview");
  const { serverUrl, user } = useApp();
  const res = useResource(() => api.overview(), []);
  const o = res.data;
  const publish = usePublishLauncher(o?.recentPublishes[0]?.repo ?? null);

  const stats = o
    ? [
        { label: "Repositories", value: formatNumber(o.counts.repos), icon: <BookOpen size={15} aria-hidden />, to: "/repos" },
        { label: "Documents", value: formatNumber(o.counts.docs), icon: <FileText size={15} aria-hidden />, to: null },
        { label: "Versions", value: formatNumber(o.counts.versions), icon: <Layers size={15} aria-hidden />, to: null },
        { label: "Storage used", value: formatBytes(o.storedBytes), icon: <Database size={15} aria-hidden />, to: null },
      ]
    : [];

  return (
    <>
      <PageHeader
        title="Overview"
        description="What's been published, and what's happening on this deployment."
        actions={
          <Button variant="primary" icon={<Rocket size={15} aria-hidden />} onClick={publish.start} loading={publish.loading}>
            Publish
          </Button>
        }
      />
      {publish.dialog}

      {res.error && !o ? (
        <ErrorState error={res.error} onRetry={res.reload} />
      ) : (
        <div className="stack-6">
          <section aria-label="Totals" className="stat-grid">
            {!o ? (
              <SkeletonCards count={4} />
            ) : (
              stats.map((s) => {
                const body = (
                  <>
                    <span className="stat-label">
                      {s.icon}
                      {s.label}
                    </span>
                    <span className="stat-value">{s.value}</span>
                  </>
                );
                return s.to ? (
                  <Link key={s.label} to={s.to} className="card stat-card stat-card-link">
                    {body}
                  </Link>
                ) : (
                  <div key={s.label} className="card stat-card">
                    {body}
                  </div>
                );
              })
            )}
          </section>

          {o && o.counts.apiKeys === 0 && (
            <section className="card connect-card" aria-labelledby="connect-title">
              <div className="connect-card-icon">
                <Plug size={18} aria-hidden />
              </div>
              <div className="connect-card-body">
                <h2 id="connect-title" className="card-title">
                  Connect an agent
                </h2>
                <p className="card-text">
                  Let Claude Code, CI jobs or any script publish reports here. Install the CLI and run one command — it
                  signs in with your account and mints a publish-only API key.
                </p>
                <CodeBlock code={`npm install -g @maradocs/cli\nmaradocs auth bootstrap --server ${serverUrl} --email ${user.email}`} label="Copy commands" />
                <div className="row-2">
                  <ButtonLink to="/connect" variant="primary" iconRight={<ArrowRight size={15} aria-hidden />}>
                    Full setup guide
                  </ButtonLink>
                  <ButtonLink to="/keys" variant="ghost" icon={<KeyRound size={15} aria-hidden />}>
                    Create a key manually
                  </ButtonLink>
                </div>
              </div>
            </section>
          )}

          <div className="overview-grid">
            <section className="card" aria-labelledby="recent-publishes">
              <header className="card-header">
                <h2 id="recent-publishes" className="card-title">
                  Recent publishes
                </h2>
              </header>
              {!o ? (
                <SkeletonRows rows={5} cols={3} />
              ) : o.recentPublishes.length === 0 ? (
                <EmptyState
                  compact
                  icon={<Rocket size={18} aria-hidden />}
                  title="Nothing published yet"
                  actions={
                    <ButtonLink to="/repos?new=1" size="sm" variant="secondary">
                      Create a repository
                    </ButtonLink>
                  }
                >
                  Create a repository, then publish a folder from the dashboard — or with{" "}
                  <code>maradocs publish ./report --repo demo --doc hello</code>.
                </EmptyState>
              ) : (
                <ul className="feed">
                  {o.recentPublishes.map((p) => (
                    <li key={`${p.repo}/${p.doc}/${p.versionNumber}`} className="feed-item">
                      <span className="feed-icon feed-icon-success">
                        <FileText size={14} aria-hidden />
                      </span>
                      <div className="feed-body">
                        <Link
                          to={`/repos/${encodeURIComponent(p.repo)}/${encodeURIComponent(p.doc)}`}
                          className="feed-title"
                        >
                          {p.title}
                        </Link>
                        <span className="feed-meta">
                          <span className="mono">
                            {p.repo}/{p.doc}
                          </span>
                          <span aria-hidden>·</span>
                          <span>v{p.versionNumber}</span>
                          <span aria-hidden>·</span>
                          <span>{pluralize(p.fileCount, "file")}</span>
                          <span aria-hidden>·</span>
                          <span>{p.publishedByLabel ?? (p.publishedByType === "machine" ? "API key" : "You")}</span>
                        </span>
                      </div>
                      <div className="feed-side">
                        <RelativeTime iso={p.createdAt} />
                        {/* Each row is one version: open that version, not whatever is latest now. */}
                        <a
                          href={versionUrl(p.repo, p.doc, p.versionNumber)}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="feed-open"
                          aria-label={`Open version ${p.versionNumber} of ${p.title} in a new tab`}
                        >
                          Open v{p.versionNumber}
                        </a>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="card" aria-labelledby="recent-activity">
              <header className="card-header">
                <h2 id="recent-activity" className="card-title">
                  Recent activity
                </h2>
                <Link to="/activity" className="card-header-link">
                  View all
                </Link>
              </header>
              {!o ? (
                <SkeletonRows rows={5} cols={2} />
              ) : o.recentAudit.length === 0 ? (
                <EmptyState compact title="No activity yet">
                  Sign-ins, publishes and setting changes will show up here.
                </EmptyState>
              ) : (
                <ul className="feed">
                  {o.recentAudit.map((a) => {
                    const meta = eventMeta(a.event);
                    const path = auditTargetPath(a);
                    const target = auditTarget(a);
                    return (
                      <li key={a.id} className="feed-item">
                        <span className={`feed-icon feed-icon-${meta.tone}`} aria-hidden>
                          {meta.icon}
                        </span>
                        <div className="feed-body">
                          <span className="feed-title-plain">{meta.label}</span>
                          <span className="feed-meta">
                            {target &&
                              (path ? (
                                <Link to={path} className="mono">
                                  {target}
                                </Link>
                              ) : (
                                <span className="mono">{target}</span>
                              ))}
                            {target && <span aria-hidden>·</span>}
                            <span>{auditActor(a)}</span>
                          </span>
                        </div>
                        <div className="feed-side">
                          <RelativeTime iso={a.createdAt} />
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          </div>
          {o && o.counts.apiKeys > 0 && (
            <p className="muted small">
              <Badge tone="neutral" icon={<KeyRound size={12} aria-hidden />}>
                {pluralize(o.counts.apiKeys, "API key")}
              </Badge>{" "}
              can publish to this deployment. <Link to="/keys">Manage keys</Link>
            </p>
          )}
        </div>
      )}
    </>
  );
}

/**
 * "Publish" from the overview: publishing needs a repository, so pick one and
 * land on its page with the upload dialog open. With no repositories yet it
 * opens "New repository"; with exactly one it goes straight there.
 */
function usePublishLauncher(recentRepo: string | null) {
  const [loading, setLoading] = useState(false);
  const [repos, setRepos] = useState<Repository[] | null>(null);
  const [choice, setChoice] = useState("");

  const go = (slug: string) => navigate(`/repos/${encodeURIComponent(slug)}?publish=1`);

  async function start() {
    setLoading(true);
    try {
      const list = (await api.listRepos()).repos;
      if (list.length === 0) navigate("/repos?new=1");
      else if (list.length === 1) go(list[0]!.slug);
      else {
        const sorted = [...list].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
        setChoice(sorted.some((r) => r.slug === recentRepo) ? recentRepo! : sorted[0]!.slug);
        setRepos(sorted);
      }
    } catch {
      // Couldn't list repositories: fall back to the repository page, which shows the error.
      navigate("/repos");
    } finally {
      setLoading(false);
    }
  }

  const dialog = (
    <Dialog
      open={repos !== null}
      onClose={() => setRepos(null)}
      size="sm"
      icon={<Rocket size={18} aria-hidden />}
      title="Publish a document"
      description="Choose the repository it belongs to. Its default access applies unless you pick another."
      footer={
        <>
          <ButtonLink to="/repos?new=1" variant="ghost">
            New repository
          </ButtonLink>
          <Button variant="primary" type="submit" form="publish-pick" iconRight={<ArrowRight size={15} aria-hidden />}>
            Continue
          </Button>
        </>
      }
    >
      <form
        id="publish-pick"
        onSubmit={(e) => {
          e.preventDefault();
          if (choice) go(choice);
        }}
      >
        <Field label="Repository">
          {({ id }) => (
            <Select id={id} value={choice} onChange={(e) => setChoice(e.target.value)} data-autofocus>
              {(repos ?? []).map((r) => (
                <option key={r.slug} value={r.slug}>
                  {r.name === r.slug ? r.slug : `${r.name} (${r.slug})`}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </form>
    </Dialog>
  );

  return { start, loading, dialog };
}
