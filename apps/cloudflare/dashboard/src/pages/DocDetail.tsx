import { type FormEvent, useEffect, useState } from "react";
import {
  Bot,
  Download,
  ExternalLink,
  Monitor,
  RotateCw,
  Smartphone,
  Tablet,
  Trash2,
  UploadCloud,
  User,
  History,
} from "lucide-react";
import { ApiError, absolute, api, docUrl, errorMessage, versionUrl } from "../api";
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
  CopyField,
  CopyTextButton,
  EmptyState,
  ErrorState,
  Field,
  Input,
  RelativeTime,
  Segmented,
  Skeleton,
  SkeletonRows,
  Tooltip,
  useToast,
} from "../components/ui";
import { useApp } from "../lib/app";
import { formatBytes, pluralize, shortHash } from "../lib/format";
import { Link, navigate } from "../lib/router";
import { useDocumentTitle } from "../lib/useDocumentTitle";
import { useResource } from "../lib/useResource";
import type { DocumentSummary, DocumentVersion, Repository } from "../types";

type Viewport = "desktop" | "tablet" | "mobile";

export function DocDetailPage({ repoSlug, docSlug }: { repoSlug: string; docSlug: string }) {
  const toast = useToast();
  const { serverUrl } = useApp();

  const dataRes = useResource(async () => {
    const [{ repo }, { doc }] = await Promise.all([api.getRepo(repoSlug), api.getDoc(repoSlug, docSlug)]);
    return { repo, doc };
  }, [repoSlug, docSlug]);
  const versionsRes = useResource(
    () => api.listVersions(repoSlug, docSlug).then((r) => [...r.versions].sort((a, b) => b.versionNumber - a.versionNumber)),
    [repoSlug, docSlug],
  );

  const repo = dataRes.data?.repo;
  const doc = dataRes.data?.doc;
  const versions = versionsRes.data;
  useDocumentTitle(doc?.title ?? docSlug);

  const [viewport, setViewport] = useState<Viewport>("desktop");
  const [frameKey, setFrameKey] = useState(0);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [rollbackTo, setRollbackTo] = useState<DocumentVersion | null>(null);

  const repoPath = `/repos/${encodeURIComponent(repoSlug)}`;
  const breadcrumb = (
    <>
      <Link to="/repos">Repositories</Link>
      <span aria-hidden>/</span>
      <Link to={repoPath}>{repoSlug}</Link>
      <span aria-hidden>/</span>
      <span aria-current="page">{docSlug}</span>
    </>
  );

  if (dataRes.error && !dataRes.data) {
    const notFound = dataRes.error instanceof ApiError && dataRes.error.status === 404;
    return (
      <>
        <PageHeader title={notFound ? "Document not found" : docSlug} breadcrumb={breadcrumb} />
        {notFound ? (
          <div className="card">
            <EmptyState title={errorMessage(dataRes.error)} actions={<ButtonLink to={repoPath}>Back to {repoSlug}</ButtonLink>}>
              It may have been deleted, or the link is mistyped.
            </EmptyState>
          </div>
        ) : (
          <ErrorState error={dataRes.error} onRetry={dataRes.reload} />
        )}
      </>
    );
  }

  // Preview/open same-origin so the session cookie reaches private docs; share the canonical URL.
  const url = docUrl(repoSlug, docSlug);
  const absUrl = doc?.url ?? absolute(url, serverUrl);
  const latest = versions?.find((v) => v.isLatest) ?? versions?.[0];

  // The preview iframe is sandboxed without allow-same-origin (report scripts
  // must never reach the dashboard), so the report runs in an opaque origin
  // and its CSS/JS/image requests can't carry the session cookie. For private
  // and password documents the Worker answers the frame's (cookie-carrying)
  // navigation with a redirect to a short-lived capability URL
  // (/r/<repo>/<doc>/v/<n>/~<token>/…); relative subresources resolve under
  // it and are authorised by the token. Reload re-mints it.
  const previewSrc = doc?.latestVersionNumber != null ? versionUrl(repoSlug, docSlug, doc.latestVersionNumber) : null;

  function refreshAll() {
    void dataRes.reload();
    void versionsRes.reload();
    setFrameKey((k) => k + 1);
  }

  return (
    <>
      <PageHeader
        breadcrumb={breadcrumb}
        title={doc ? doc.title : <Skeleton width={260} height={26} />}
        meta={
          doc && (
            <>
              <span className="mono muted">
                /r/{repoSlug}/{docSlug}/
              </span>
              <AccessBadge access={doc.access} inherited={doc.accessOverride === null} />
              {doc.latestVersionNumber != null && <span className="version-chip">v{doc.latestVersionNumber}</span>}
              <span className="muted">
                Updated <RelativeTime iso={doc.updatedAt} />
              </span>
            </>
          )
        }
        actions={
          doc && (
            <>
              <CopyTextButton text={absUrl}>Copy link</CopyTextButton>
              <ButtonAnchor href={url} target="_blank" rel="noopener noreferrer" icon={<ExternalLink size={15} aria-hidden />}>
                Open
              </ButtonAnchor>
              <Button variant="primary" icon={<UploadCloud size={15} aria-hidden />} onClick={() => setUploadOpen(true)}>
                New version
              </Button>
            </>
          )
        }
      />

      <div className="doc-grid">
        <section className="card card-flush preview-card" aria-labelledby="preview-title">
          <header className="preview-toolbar">
            <h2 id="preview-title" className="card-title">
              Live preview
            </h2>
            <div className="preview-tools">
              <Segmented<Viewport>
                label="Preview width"
                size="sm"
                value={viewport}
                onChange={setViewport}
                options={[
                  { value: "desktop", label: "", icon: <Monitor size={14} aria-hidden />, title: "Desktop" },
                  { value: "tablet", label: "", icon: <Tablet size={14} aria-hidden />, title: "Tablet" },
                  { value: "mobile", label: "", icon: <Smartphone size={14} aria-hidden />, title: "Mobile" },
                ]}
              />
              <Tooltip content="Reload preview">
                <button type="button" className="btn btn-ghost btn-icon btn-sm" onClick={() => setFrameKey((k) => k + 1)} aria-label="Reload preview">
                  <RotateCw size={14} aria-hidden />
                </button>
              </Tooltip>
              <Tooltip content="Open in new tab">
                <a className="btn btn-ghost btn-icon btn-sm" href={url} target="_blank" rel="noopener noreferrer" aria-label="Open in new tab">
                  <ExternalLink size={14} aria-hidden />
                </a>
              </Tooltip>
            </div>
          </header>
          <div className={`preview-stage preview-${viewport}`}>
            {doc && previewSrc ? (
              <iframe
                key={frameKey}
                className="preview-frame"
                src={previewSrc}
                title={`Preview of ${doc.title}`}
                sandbox="allow-scripts allow-forms allow-popups allow-downloads"
                referrerPolicy="no-referrer"
                loading="lazy"
              />
            ) : doc ? (
              <EmptyState compact title="No published version">
                Publish a version to see a preview.
              </EmptyState>
            ) : (
              <Skeleton width="100%" height="100%" radius={0} />
            )}
          </div>
        </section>

        <div className="doc-side">
          <section className="card" aria-labelledby="links-title">
            <header className="card-header">
              <h2 id="links-title" className="card-title">
                Links
              </h2>
            </header>
            <div className="stack-3">
              <div className="stack-1">
                <span className="section-label">Always latest</span>
                <CopyField value={absUrl} label="Latest URL" copyLabel="Copy latest URL" />
              </div>
              {latest && (
                <div className="stack-1">
                  <span className="section-label">Pinned to v{latest.versionNumber}</span>
                  <CopyField
                    value={absolute(versionUrl(repoSlug, docSlug, latest.versionNumber), serverUrl)}
                    label={`Version ${latest.versionNumber} URL`}
                    copyLabel={`Copy v${latest.versionNumber} pinned URL`}
                  />
                </div>
              )}
              <p className="field-hint">Pinned links never change, even after you publish new versions.</p>
            </div>
          </section>

          {doc && repo ? (
            <DocSettingsCard
              repo={repo}
              doc={doc}
              onSaved={(updated) => {
                dataRes.setData((prev) => (prev ? { ...prev, doc: updated } : prev));
                setFrameKey((k) => k + 1);
              }}
              onReload={refreshAll}
            />
          ) : (
            <div className="card">
              <SkeletonRows rows={3} cols={1} />
            </div>
          )}

          <section className="card danger-card" aria-labelledby="doc-danger">
            <div className="danger-zone-row">
              <div>
                <h2 id="doc-danger" className="danger-zone-label">
                  Delete document
                </h2>
                <p className="field-hint">Removes every version and file. Links stop working.</p>
              </div>
              <Button variant="danger-ghost" icon={<Trash2 size={15} aria-hidden />} onClick={() => setConfirmDelete(true)} disabled={!doc}>
                Delete
              </Button>
            </div>
          </section>
        </div>
      </div>

      <section className="card versions-card" aria-labelledby="versions-title">
        <header className="card-header">
          <h2 id="versions-title" className="card-title">
            Versions
          </h2>
          {versions && <span className="muted small">{pluralize(versions.length, "version")}</span>}
        </header>
        {versionsRes.error && !versions ? (
          <ErrorState error={versionsRes.error} onRetry={versionsRes.reload} />
        ) : !versions ? (
          <SkeletonRows rows={3} cols={4} />
        ) : versions.length === 0 ? (
          <EmptyState compact title="No versions yet" />
        ) : (
          <ol className="timeline">
            {versions.map((v) => (
              <VersionItem
                key={v.id}
                v={v}
                repoSlug={repoSlug}
                docSlug={docSlug}
                serverUrl={serverUrl}
                onRollback={() => setRollbackTo(v)}
              />
            ))}
          </ol>
        )}
      </section>

      {repo && doc && (
        <UploadDialog
          open={uploadOpen}
          onClose={() => setUploadOpen(false)}
          repo={repo}
          doc={doc}
          onPublished={refreshAll}
          onMaybePublished={refreshAll}
        />
      )}

      <ConfirmDialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title={`Delete “${doc?.title ?? docSlug}”?`}
        description={`All ${versions ? pluralize(versions.length, "version") : "versions"} and files are removed permanently. This can't be undone.`}
        confirmLabel="Delete document"
        onConfirm={async () => {
          await api.deleteDoc(repoSlug, docSlug);
          toast.success("Document deleted", `${repoSlug}/${docSlug}`);
          navigate(repoPath, { replace: true });
        }}
      />

      <ConfirmDialog
        open={Boolean(rollbackTo)}
        onClose={() => setRollbackTo(null)}
        tone="default"
        title={`Make v${rollbackTo?.versionNumber ?? ""} the latest?`}
        description="The document's main link will serve this version. Newer versions stay available as pinned links."
        confirmLabel="Make latest"
        onConfirm={async () => {
          if (!rollbackTo) return;
          await api.rollback(repoSlug, docSlug, rollbackTo.versionNumber);
          toast.success(`v${rollbackTo.versionNumber} is now the latest version`);
          refreshAll();
        }}
      />
    </>
  );
}

function VersionItem({
  v,
  repoSlug,
  docSlug,
  serverUrl,
  onRollback,
}: {
  v: DocumentVersion;
  repoSlug: string;
  docSlug: string;
  serverUrl: string;
  onRollback: () => void;
}) {
  const pinned = versionUrl(repoSlug, docSlug, v.versionNumber);
  const who = v.publishedByLabel ?? (v.publishedByType === "machine" ? "API key" : "Admin");
  return (
    <li className={`timeline-item ${v.isLatest ? "is-latest" : ""}`}>
      <span className="timeline-dot" aria-hidden />
      <div className="timeline-main">
        <div className="timeline-head">
          <span className="timeline-version">v{v.versionNumber}</span>
          {v.isLatest && <Badge tone="success">Latest</Badge>}
          <span className="timeline-who">
            {v.publishedByType === "machine" ? <Bot size={13} aria-hidden /> : <User size={13} aria-hidden />}
            {who}
          </span>
          <span className="muted">
            <RelativeTime iso={v.createdAt} />
          </span>
        </div>
        <div className="timeline-meta">
          <span>{pluralize(v.fileCount, "file")}</span>
          <span>{formatBytes(v.sizeBytes)}</span>
          <span className="mono">{v.entrypoint}</span>
          <span className="checksum">
            <Tooltip content={<span className="mono tooltip-wrap">sha256 {v.checksum}</span>}>
              <span className="mono">{shortHash(v.checksum, 12)}</span>
            </Tooltip>
            <CopyButton text={v.checksum} label={`Copy v${v.versionNumber} checksum`} />
          </span>
        </div>
      </div>
      <div className="timeline-actions">
        <Tooltip content="Open this version">
          <a className="btn btn-ghost btn-icon btn-sm" href={pinned} target="_blank" rel="noopener noreferrer" aria-label={`Open version ${v.versionNumber}`}>
            <ExternalLink size={14} aria-hidden />
          </a>
        </Tooltip>
        <CopyButton text={absolute(pinned, serverUrl)} label={`Copy v${v.versionNumber} pinned link`} />
        <Tooltip content="Download zip">
          <a className="btn btn-ghost btn-icon btn-sm" href={api.bundleUrl(repoSlug, docSlug, v.versionNumber)} download aria-label={`Download version ${v.versionNumber} as zip`}>
            <Download size={14} aria-hidden />
          </a>
        </Tooltip>
        {!v.isLatest && (
          <Button size="sm" variant="secondary" icon={<History size={14} aria-hidden />} onClick={onRollback}>
            Make latest
          </Button>
        )}
      </div>
    </li>
  );
}

function DocSettingsCard({
  repo,
  doc,
  onSaved,
  onReload,
}: {
  repo: Repository;
  doc: DocumentSummary;
  onSaved: (doc: DocumentSummary) => void;
  onReload: () => void;
}) {
  const toast = useToast();
  // `hasPassword` is effective (doc or repo); only the doc's own password can be changed here.
  const ownPassword = doc.hasOwnPassword ?? (doc.hasPassword && !repo.hasPassword);
  const [title, setTitle] = useState(doc.title);
  const [access, setAccess] = useState<AccessChoice>(doc.accessOverride ?? "inherit");
  const [pwMode, setPwMode] = useState<PasswordMode>(ownPassword ? "keep" : "set");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setTitle(doc.title);
    setAccess(doc.accessOverride ?? "inherit");
    setPwMode(ownPassword ? "keep" : "set");
    setPassword("");
    setAttempted(false);
    setError(null);
  }, [doc, ownPassword]);

  const effective = access === "inherit" ? repo.defaultAccess : access;
  const isPassword = effective === "password";
  const fallback = repo.hasPassword;
  const pwRequired = isPassword && !fallback && (!ownPassword || pwMode === "clear");
  const pwErr = pwMode === "set" ? passwordError(password, isPassword && !fallback && !ownPassword) : null;
  const clearBlocked = pwMode === "clear" && isPassword && !fallback;
  const titleErr = !title.trim() ? "Required" : title.length > 160 ? "At most 160 characters" : null;

  const desiredOverride = access === "inherit" ? null : access;
  const dirty =
    title.trim() !== doc.title ||
    desiredOverride !== doc.accessOverride ||
    (pwMode === "set" && password.length > 0) ||
    pwMode === "clear";

  async function save(e: FormEvent) {
    e.preventDefault();
    setAttempted(true);
    if (titleErr || pwErr || clearBlocked || busy) return;
    if (pwRequired && !(pwMode === "set" && password)) return;
    const input: Parameters<typeof api.updateDoc>[2] = {};
    if (title.trim() !== doc.title) input.title = title.trim();
    if (desiredOverride !== doc.accessOverride) input.access = desiredOverride;
    if (pwMode === "set" && password) input.password = password;
    if (pwMode === "clear") input.password = null;
    if (!Object.keys(input).length) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.updateDoc(repo.slug, doc.slug, input);
      toast.success("Document settings saved");
      if (res?.doc) onSaved(res.doc);
      else onReload();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card" aria-labelledby="doc-settings-title">
      <header className="card-header">
        <h2 id="doc-settings-title" className="card-title">
          Settings
        </h2>
      </header>
      <form onSubmit={save} className="stack-4" noValidate>
        <Field label="Title" error={attempted ? titleErr : null}>
          {({ id, describedBy, invalid }) => (
            <Input id={id} aria-describedby={describedBy} invalid={invalid} value={title} maxLength={160} onChange={(e) => setTitle(e.target.value)} />
          )}
        </Field>
        <AccessPicker
          value={access}
          onChange={setAccess}
          inheritFrom={repo.defaultAccess}
          inheritName={repo.name}
          compact
        />
        {(isPassword || ownPassword) && (
          <PasswordSetting
            label="Document password"
            hasPassword={ownPassword}
            mode={pwMode}
            onModeChange={(m) => {
              setPwMode(m);
              setPassword("");
            }}
            value={password}
            onValueChange={setPassword}
            required={isPassword && !fallback && !ownPassword}
            allowClear={!isPassword || fallback}
            clearHint="Password access needs a password; the repository has none to fall back to."
            fallbackNote={
              fallback
                ? ownPassword
                  ? "Overrides the repository password for this document."
                  : "Optional — without one, viewers use the repository password."
                : undefined
            }
            error={attempted ? pwErr : null}
          />
        )}
        {attempted && clearBlocked && (
          <p className="form-error" role="alert">
            Password access needs a password. Keep this one or choose another access mode.
          </p>
        )}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="row-end">
          <Button type="submit" variant="primary" loading={busy} disabled={!dirty}>
            Save
          </Button>
        </div>
      </form>
    </section>
  );
}
