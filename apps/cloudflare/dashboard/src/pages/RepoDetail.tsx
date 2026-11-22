import { type CSSProperties, type FormEvent, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  ExternalLink,
  FileText,
  Info,
  ListTree,
  Search,
  Settings2,
  SlidersHorizontal,
  Trash2,
  UploadCloud,
} from "lucide-react";
import { ApiError, absolute, api, docUrl, errorMessage, repoIndexUrl } from "../api";
import { AccessPicker, type AccessChoice, type PasswordMode, PasswordSetting, passwordError } from "../components/AccessPicker";
import { PageHeader } from "../components/Layout";
import { UploadDialog } from "../components/UploadDialog";
import {
  AccessBadge,
  Badge,
  Button,
  ButtonAnchor,
  ButtonLink,
  ConfirmDialog,
  CopyButton,
  Drawer,
  EmptyState,
  ErrorState,
  Field,
  Input,
  RelativeTime,
  Skeleton,
  SkeletonRows,
  Switch,
  Textarea,
  Tooltip,
  useToast,
} from "../components/ui";
import { useApp } from "../lib/app";
import { formatBytes } from "../lib/format";
import { Link, navigate, useSearchParam } from "../lib/router";
import { useDocumentTitle } from "../lib/useDocumentTitle";
import { useResource } from "../lib/useResource";
import type { AccessMode, DocumentSummary, Repository } from "../types";

/** Higher = more restrictive. */
const RESTRICTIVENESS: Record<AccessMode, number> = { public: 0, password: 1, private: 2 };
const ACCESS_ADJECTIVE: Record<AccessMode, string> = { public: "public", password: "password-protected", private: "private" };

function docsPhrase(n: number | null): string {
  if (n === null) return "Documents that inherit this setting";
  return n === 1 ? "1 document inherits this setting and" : `${n} documents inherit this setting and`;
}

export function RepoDetailPage({ repoSlug }: { repoSlug: string }) {
  const toast = useToast();
  const { serverUrl } = useApp();
  const repoRes = useResource(() => api.getRepo(repoSlug).then((r) => r.repo), [repoSlug]);
  const docsRes = useResource(() => api.listDocs(repoSlug).then((r) => r.docs), [repoSlug]);
  const repo = repoRes.data;
  const docs = docsRes.data;
  useDocumentTitle(repo?.name ?? repoSlug);

  const [query, setQuery] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [deleting, setDeleting] = useState<DocumentSummary | null>(null);

  // /repos/<slug>?publish=1 (the overview's Publish button) opens the upload dialog.
  const wantsPublish = useSearchParam("publish") === "1";
  useEffect(() => {
    if (!wantsPublish || !repo) return;
    setUploadOpen(true);
    navigate(`/repos/${encodeURIComponent(repoSlug)}`, { replace: true });
  }, [wantsPublish, repo, repoSlug]);

  const filtered = useMemo(() => {
    if (!docs) return [];
    const q = query.trim().toLowerCase();
    const sorted = [...docs].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    if (!q) return sorted;
    return sorted.filter((d) => d.slug.includes(q) || d.title.toLowerCase().includes(q));
  }, [docs, query]);

  const notFound = repoRes.error instanceof ApiError && repoRes.error.status === 404;

  const breadcrumb = (
    <>
      <Link to="/repos">Repositories</Link>
      <span aria-hidden>/</span>
      <span aria-current="page">{repoSlug}</span>
    </>
  );

  if (notFound) {
    return (
      <>
        <PageHeader title="Repository not found" breadcrumb={breadcrumb} />
        <div className="card">
          <EmptyState
            title={`No repository called “${repoSlug}”`}
            actions={<ButtonLink to="/repos">Back to repositories</ButtonLink>}
          >
            It may have been deleted, or the link is mistyped.
          </EmptyState>
        </div>
      </>
    );
  }

  return (
    <>
      <PageHeader
        breadcrumb={breadcrumb}
        title={repo ? repo.name : <Skeleton width={220} height={26} />}
        description={repo?.description ?? undefined}
        meta={
          repo && (
            <>
              <span className="mono muted">/r/{repo.slug}/</span>
              <AccessBadge access={repo.defaultAccess} />
              {repo.indexEnabled && (
                <Badge tone="accent" icon={<ListTree size={12} aria-hidden />}>
                  Browsable index
                </Badge>
              )}
            </>
          )
        }
        actions={
          repo && (
            <>
              {repo.indexEnabled && (
                <ButtonAnchor
                  href={repoIndexUrl(repo.slug)}
                  target="_blank"
                  rel="noopener noreferrer"
                  icon={<ExternalLink size={15} aria-hidden />}
                >
                  View index
                </ButtonAnchor>
              )}
              <Button icon={<Settings2 size={15} aria-hidden />} onClick={() => setSettingsOpen(true)}>
                Settings
              </Button>
              <Button variant="primary" icon={<UploadCloud size={15} aria-hidden />} onClick={() => setUploadOpen(true)}>
                Publish
              </Button>
            </>
          )
        }
      />

      {(repoRes.error && !repo) || (docsRes.error && !docs) ? (
        <ErrorState
          error={repoRes.error ?? docsRes.error}
          onRetry={() => {
            void repoRes.reload();
            void docsRes.reload();
          }}
        />
      ) : !docs ? (
        <div className="card">
          <SkeletonRows rows={4} cols={5} />
        </div>
      ) : docs.length === 0 ? (
        <div className="card">
          <EmptyState
            icon={<FileText size={20} aria-hidden />}
            title="No documents yet"
            actions={
              <Button variant="primary" icon={<UploadCloud size={15} aria-hidden />} onClick={() => setUploadOpen(true)}>
                Publish a document
              </Button>
            }
          >
            Drop a folder with an <code>index.html</code> (or a .zip) to publish it here. From a terminal:{" "}
            <code>maradocs publish ./report --repo {repoSlug} --doc hello</code>
          </EmptyState>
        </div>
      ) : (
        <div className="stack-4">
          {docs.length > 5 && (
            <div className="toolbar">
              <Input
                type="search"
                placeholder="Filter documents"
                aria-label="Filter documents"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                leading={<Search size={15} aria-hidden />}
                className="toolbar-search"
              />
            </div>
          )}
          <div className="card card-flush">
            {/* --row-actions: four icon buttons per row (mobile card layout reserves room for them). */}
            <table className="table" style={{ "--row-actions": 4 } as CSSProperties}>
              <thead>
                <tr>
                  <th scope="col">Document</th>
                  <th scope="col">Access</th>
                  <th scope="col">Latest</th>
                  <th scope="col">Updated</th>
                  <th scope="col" className="th-actions">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((d) => {
                  const detail = `/repos/${encodeURIComponent(repoSlug)}/${encodeURIComponent(d.slug)}`;
                  // Open same-origin (carries the session for private docs); copy the canonical URL.
                  const url = docUrl(repoSlug, d.slug);
                  const shareUrl = d.url ?? absolute(url, serverUrl);
                  return (
                    <tr key={d.id}>
                      <td data-label="Document" className="cell-primary">
                        <Link to={detail} className="cell-title">
                          {d.title}
                        </Link>
                        <span className="cell-sub mono">{d.slug}</span>
                      </td>
                      <td data-label="Access">
                        <AccessBadge access={d.access} inherited={d.accessOverride === null} />
                      </td>
                      <td data-label="Latest">
                        {d.latestVersionNumber != null ? (
                          <span className="latest-cell">
                            <span className="version-chip">v{d.latestVersionNumber}</span>
                            {d.latestSizeBytes != null && <span className="muted small">{formatBytes(d.latestSizeBytes)}</span>}
                          </span>
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </td>
                      <td data-label="Updated">
                        <RelativeTime iso={d.updatedAt} />
                      </td>
                      <td className="cell-actions">
                        <div className="row-actions">
                          <Tooltip content="Open in new tab">
                            <a
                              className="btn btn-ghost btn-icon btn-sm"
                              href={url}
                              target="_blank"
                              rel="noopener noreferrer"
                              aria-label={`Open ${d.title} in a new tab`}
                            >
                              <ExternalLink size={14} aria-hidden />
                            </a>
                          </Tooltip>
                          <CopyButton text={shareUrl} label={`Copy link to ${d.title}`} />
                          <Tooltip content="Settings & versions">
                            <Link to={detail} className="btn btn-ghost btn-icon btn-sm" aria-label={`Settings for ${d.title}`}>
                              <SlidersHorizontal size={14} aria-hidden />
                            </Link>
                          </Tooltip>
                          <Tooltip content="Delete">
                            <button
                              type="button"
                              className="btn btn-danger-ghost btn-icon btn-sm"
                              onClick={() => setDeleting(d)}
                              aria-label={`Delete ${d.title}`}
                            >
                              <Trash2 size={14} aria-hidden />
                            </button>
                          </Tooltip>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {filtered.length === 0 && (
              <EmptyState compact title="No matches">
                No document matches “{query}”.
              </EmptyState>
            )}
          </div>
        </div>
      )}

      {repo && (
        <>
          <RepoSettingsDrawer
            open={settingsOpen}
            onClose={() => setSettingsOpen(false)}
            repo={repo}
            docs={docs ?? null}
            onSaved={(r) => {
              repoRes.setData(r);
              void docsRes.reload();
            }}
            onDeleted={() => navigate("/repos", { replace: true })}
          />
          <UploadDialog
            open={uploadOpen}
            onClose={() => setUploadOpen(false)}
            repo={repo}
            existingSlugs={docs?.map((d) => d.slug) ?? []}
            onPublished={() => {
              void docsRes.reload();
            }}
            onMaybePublished={() => void docsRes.reload()}
          />
        </>
      )}

      <ConfirmDialog
        open={Boolean(deleting)}
        onClose={() => setDeleting(null)}
        title={`Delete “${deleting?.title ?? ""}”?`}
        description="All versions and files are removed permanently and its links stop working."
        confirmLabel="Delete document"
        onConfirm={async () => {
          if (!deleting) return;
          await api.deleteDoc(repoSlug, deleting.slug);
          docsRes.setData((prev) => prev?.filter((d) => d.id !== deleting.id));
          toast.success("Document deleted", `${repoSlug}/${deleting.slug}`);
        }}
      />
    </>
  );
}

function RepoSettingsDrawer({
  open,
  onClose,
  repo,
  docs,
  onSaved,
  onDeleted,
}: {
  open: boolean;
  onClose: () => void;
  repo: Repository;
  /** null while the document list is still loading. */
  docs: DocumentSummary[] | null;
  onSaved: (r: Repository) => void;
  onDeleted: () => void;
}) {
  const toast = useToast();
  const [name, setName] = useState(repo.name);
  const [description, setDescription] = useState(repo.description ?? "");
  const [access, setAccess] = useState<AccessChoice>(repo.defaultAccess);
  const [pwMode, setPwMode] = useState<PasswordMode>(repo.hasPassword ? "keep" : "set");
  const [password, setPassword] = useState("");
  const [indexEnabled, setIndexEnabled] = useState(repo.indexEnabled);
  const [busy, setBusy] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmLoosen, setConfirmLoosen] = useState(false);

  // What the change means for documents that follow the repository default.
  const docCount = docs?.length ?? repo.docCount;
  const inheriting = docs ? docs.filter((d) => d.accessOverride === null).length : null;
  const nextAccess: AccessMode = access === "inherit" ? repo.defaultAccess : access;
  const accessChanged = nextAccess !== repo.defaultAccess;
  const loosening = accessChanged && RESTRICTIVENESS[nextAccess] < RESTRICTIVENESS[repo.defaultAccess];
  // Public documents after the change: overrides that are public, plus inheriting docs if the default becomes public.
  const publicDocs = docs
    ? docs.filter((d) => (d.accessOverride ?? nextAccess) === "public").length
    : null;

  useEffect(() => {
    if (!open) return;
    setName(repo.name);
    setDescription(repo.description ?? "");
    setAccess(repo.defaultAccess);
    setPwMode(repo.hasPassword ? "keep" : "set");
    setPassword("");
    setIndexEnabled(repo.indexEnabled);
    setAttempted(false);
    setError(null);
  }, [open, repo]);

  const pwErr = pwMode === "set" ? passwordError(password, access === "password" && !repo.hasPassword) : null;
  const nameErr = !name.trim() ? "Required" : name.length > 120 ? "At most 120 characters" : null;
  const descErr = description.length > 500 ? "At most 500 characters" : null;
  const clearingWhileRequired = access === "password" && pwMode === "clear";
  const valid = !pwErr && !nameErr && !descErr && !clearingWhileRequired;

  async function save(e: FormEvent) {
    e.preventDefault();
    setAttempted(true);
    if (!valid || busy) return;
    // Opening up documents (private/password → less restrictive) is confirmed first.
    if (loosening && (inheriting ?? 1) > 0) {
      setConfirmLoosen(true);
      return;
    }
    await commit();
  }

  async function commit() {
    const input: Parameters<typeof api.updateRepo>[1] = {};
    if (name.trim() !== repo.name) input.name = name.trim();
    const desc = description.trim() || null;
    if (desc !== repo.description) input.description = desc;
    if (access !== "inherit" && access !== repo.defaultAccess) input.access = access;
    if (indexEnabled !== repo.indexEnabled) input.indexEnabled = indexEnabled;
    if (pwMode === "set" && password) input.password = password;
    if (pwMode === "clear") input.password = null;
    if (Object.keys(input).length === 0) {
      onClose();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { repo: updated } = await api.updateRepo(repo.slug, input);
      onSaved(updated);
      toast.success("Repository updated");
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Drawer
        open={open}
        onClose={onClose}
        dismissible={!busy}
        title="Repository settings"
        description={<span className="mono">{repo.slug}</span>}
        footer={
          <>
            <Button variant="ghost" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button variant="primary" type="submit" form="repo-settings" loading={busy}>
              Save changes
            </Button>
          </>
        }
      >
        <form id="repo-settings" onSubmit={save} className="stack-5" noValidate>
          <Field label="Name" error={attempted ? nameErr : null}>
            {({ id, describedBy, invalid }) => (
              <Input id={id} aria-describedby={describedBy} invalid={invalid} value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
            )}
          </Field>
          <Field label="Description" optional error={descErr}>
            {({ id, describedBy, invalid }) => (
              <Textarea id={id} aria-describedby={describedBy} invalid={invalid} rows={3} value={description} maxLength={500} onChange={(e) => setDescription(e.target.value)} />
            )}
          </Field>
          <div className="stack-2">
            <AccessPicker label="Default access" value={access} onChange={setAccess} compact />
            {accessChanged && inheriting !== 0 && (
              <div className={`callout ${loosening ? "callout-warning" : ""}`} role="status">
                {loosening ? <AlertTriangle size={16} aria-hidden /> : <Info size={16} aria-hidden />}
                <div>
                  {docsPhrase(inheriting)} will become <strong>{ACCESS_ADJECTIVE[nextAccess]}</strong>
                  {nextAccess === "public" ? ": anyone with the link can open them." : "."} Documents with their own
                  access setting keep it.
                </div>
              </div>
            )}
          </div>
          {(access === "password" || repo.hasPassword) && (
            <PasswordSetting
              label="Repository password"
              hasPassword={repo.hasPassword}
              mode={pwMode}
              onModeChange={(m) => {
                setPwMode(m);
                setPassword("");
              }}
              value={password}
              onValueChange={setPassword}
              required={access === "password" && !repo.hasPassword}
              allowClear={access !== "password"}
              clearHint="Switch default access away from Password to remove the password."
              fallbackNote="Documents with password access and no password of their own use this one."
              error={attempted ? pwErr : null}
            />
          )}
          <div className="stack-2">
            <Switch
              checked={indexEnabled}
              onChange={setIndexEnabled}
              label="Browsable index"
              description={
                publicDocs === null || publicDocs === 0
                  ? `List public documents at /r/${repo.slug}/.`
                  : `List public documents at /r/${repo.slug}/ — ${publicDocs === 1 ? "1 document" : `${publicDocs} documents`} would be listed.`
              }
            />
            {indexEnabled && publicDocs === 0 && (
              <div className="callout" role="status">
                <Info size={16} aria-hidden />
                <div>
                  No document here is public yet, so the index will be empty — but the repository's name and description
                  will be visible to anyone at <code>/r/{repo.slug}/</code>.
                </div>
              </div>
            )}
          </div>
          {attempted && clearingWhileRequired && (
            <p className="form-error" role="alert">
              Password access needs a password. Keep the current one or pick another access mode.
            </p>
          )}
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
        </form>

        <section className="danger-zone" aria-labelledby="danger-zone-title">
          <h3 id="danger-zone-title" className="danger-zone-title">
            Danger zone
          </h3>
          <div className="danger-zone-row">
            <div>
              <p className="danger-zone-label">Delete this repository</p>
              <p className="field-hint">
                {docCount === undefined
                  ? "Permanently removes all of its documents, every version and all stored files."
                  : docCount === 0
                    ? "This repository has no documents. Deleting it frees its URL prefix."
                    : `Permanently removes ${docCount === 1 ? "its 1 document" : `all ${docCount} documents`}, every version and all stored files.`}
              </p>
            </div>
            <Button variant="danger" icon={<Trash2 size={15} aria-hidden />} onClick={() => setConfirmDelete(true)} disabled={busy}>
              Delete
            </Button>
          </div>
        </section>
      </Drawer>

      <ConfirmDialog
        open={confirmLoosen}
        onClose={() => setConfirmLoosen(false)}
        title={`Make ${inheriting === null ? "inheriting documents" : inheriting === 1 ? "1 document" : `${inheriting} documents`} ${ACCESS_ADJECTIVE[nextAccess]}?`}
        description={
          nextAccess === "public"
            ? `Every document in ${repo.name} that follows the repository default becomes viewable by anyone with its link, immediately.`
            : `Documents in ${repo.name} that follow the repository default will open for anyone with the password instead of only signed-in admins and API keys.`
        }
        confirmLabel={nextAccess === "public" ? "Make public" : "Change access"}
        onConfirm={commit}
      />

      <ConfirmDialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title="Delete repository?"
        description={`This deletes ${repo.name} with all of its documents and versions. Links to them will stop working. This can't be undone.`}
        confirmLabel="Delete repository"
        confirmText={repo.slug}
        onConfirm={async () => {
          await api.deleteRepo(repo.slug);
          toast.success("Repository deleted", repo.slug);
          setConfirmDelete(false);
          onClose();
          onDeleted();
        }}
      />
    </>
  );
}
