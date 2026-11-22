import { type DragEvent, type FormEvent, useEffect, useId, useRef, useState } from "react";
import {
  CheckCircle2,
  ExternalLink,
  FileArchive,
  FileText,
  FolderOpen,
  FolderUp,
  Plus,
  RotateCcw,
  UploadCloud,
  X,
} from "lucide-react";
import { ApiError, absolute, api, errorMessage } from "../api";
import { useApp } from "../lib/app";
import {
  BundleError,
  type PreparedBundle,
  defaultEntrypoint,
  prepareDrop,
  prepareFileList,
  prepareZip,
  zipBundle,
} from "../lib/bundle";
import { formatBytes, pluralize } from "../lib/format";
import { slugError, slugify } from "../lib/slug";
import type { DocumentSummary, PublishResult, Repository, UploadFields } from "../types";
import { AccessPicker, type AccessChoice, passwordError } from "./AccessPicker";
import { AccessBadge, Button, ButtonAnchor, ButtonLink, CopyField, Dialog, Field, Input, PasswordInput, Select } from "./ui";

type Stage =
  | { kind: "pick" }
  | { kind: "reading" }
  | { kind: "ready" }
  | { kind: "zipping"; fraction: number }
  | { kind: "uploading"; loaded: number; total: number }
  | { kind: "done"; result: PublishResult };

interface UploadDialogProps {
  open: boolean;
  onClose: () => void;
  repo: Repository;
  /** When set, publishes a new version of this document (PUT). */
  doc?: DocumentSummary | null;
  existingSlugs?: string[];
  onPublished: (result: PublishResult) => void;
  /** An upload was stopped after it reached the server; the list may have a new version. */
  onMaybePublished?: () => void;
}

export function UploadDialog({
  open,
  onClose,
  repo,
  doc,
  existingSlugs = [],
  onPublished,
  onMaybePublished,
}: UploadDialogProps) {
  const replace = Boolean(doc);
  const { maxUploadBytes } = useApp();
  const [stage, setStage] = useState<Stage>({ kind: "pick" });
  const [bundle, setBundle] = useState<PreparedBundle | null>(null);
  const [pickError, setPickError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  const [title, setTitle] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [access, setAccess] = useState<AccessChoice>("inherit");
  const [password, setPassword] = useState("");
  const [entrypoint, setEntrypoint] = useState("");
  const [attempted, setAttempted] = useState(false);

  const zipInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const titleInput = useRef<HTMLInputElement>(null);
  const openButton = useRef<HTMLAnchorElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  /** Every byte reached the server: from here on a cancel can't stop the publish. */
  const sentAllRef = useRef(false);
  const dragDepth = useRef(0);
  const formId = useId();
  const titleId = useId();
  // Polite announcements for screen readers: phase changes only, never every percent.
  const [announcement, setAnnouncement] = useState("");

  // Reset whenever the dialog opens (or targets another document). Keyed on the
  // slug, not the object: the parent refetches the document after a publish and
  // a new object identity must not wipe the "Published" confirmation.
  const docSlug = doc?.slug ?? "";
  useEffect(() => {
    if (!open) return;
    setStage({ kind: "pick" });
    setBundle(null);
    setPickError(null);
    setSubmitError(null);
    setTitle("");
    setSlug(docSlug);
    setSlugTouched(false);
    setAccess("inherit");
    setPassword("");
    setEntrypoint("");
    setAttempted(false);
  }, [open, docSlug]);

  // `webkitdirectory` isn't in React's typings; set it imperatively.
  useEffect(() => {
    const el = folderInput.current;
    if (!el) return;
    el.setAttribute("webkitdirectory", "");
    el.setAttribute("directory", "");
  });

  useEffect(() => () => abortRef.current?.abort(), []);

  // Focus follows the flow: the picker buttons disappear once a bundle is
  // accepted (focus goes to the title field), and the form is replaced by the
  // confirmation when publishing succeeds (focus goes to "Open document").
  useEffect(() => {
    if (stage.kind === "ready" && bundle) titleInput.current?.focus({ preventScroll: true });
    if (stage.kind === "done") openButton.current?.focus({ preventScroll: true });
    // Only on entering those stages.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage.kind]);

  const phase =
    stage.kind === "zipping"
      ? "zipping"
      : stage.kind === "uploading"
        ? stage.total > 0 && stage.loaded >= stage.total
          ? "processing"
          : "uploading"
        : stage.kind;
  useEffect(() => {
    if (phase === "zipping") setAnnouncement("Compressing files…");
    else if (phase === "uploading") setAnnouncement("Uploading…");
    else if (phase === "processing") setAnnouncement("Upload complete. Processing on the server…");
    if (phase === "processing") sentAllRef.current = true;
  }, [phase]);

  const busy = stage.kind === "zipping" || stage.kind === "uploading" || stage.kind === "reading";

  async function accept(p: Promise<PreparedBundle> | PreparedBundle) {
    setPickError(null);
    setSubmitError(null);
    setStage({ kind: "reading" });
    try {
      const b = await p;
      if (maxUploadBytes && b.totalBytes > maxUploadBytes) {
        throw new BundleError(
          `The bundle is ${formatBytes(b.totalBytes)} uncompressed; this server accepts up to ${formatBytes(maxUploadBytes)}.`,
        );
      }
      if (!b.htmlFiles.length) throw new BundleError("No .html file found. A report needs at least one HTML page.");
      setBundle(b);
      setEntrypoint(b.hasIndex ? "" : defaultEntrypoint(b.htmlFiles) ?? "");
      if (!replace && !slugTouched && !title) {
        const base = b.name.replace(/\.zip$/i, "");
        setSlug(slugify(base));
      }
      setStage({ kind: "ready" });
      setAnnouncement(`${b.name} ready: ${pluralize(b.fileCount, "file")}, ${formatBytes(b.totalBytes)}.`);
    } catch (err) {
      setBundle(null);
      setStage({ kind: "pick" });
      setPickError(err instanceof BundleError ? err.message : errorMessage(err));
    }
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    if (busy) return;
    void accept(prepareDrop(e.dataTransfer));
  }

  const slugErr = replace ? null : slugError(slug) ?? (existingSlugs.includes(slug) ? "A document with this slug already exists — open it to publish a new version." : null);
  const needsPassword = !replace && access === "password";
  const pwRequired = needsPassword && !repo.hasPassword;
  const pwErr = needsPassword ? passwordError(password, pwRequired) : null;
  const titleErr = title.length > 160 ? "At most 160 characters" : null;
  const valid = Boolean(bundle) && !slugErr && !pwErr && !titleErr;

  async function submit(e?: FormEvent) {
    e?.preventDefault();
    setAttempted(true);
    if (!bundle || !valid || busy) return;
    setSubmitError(null);
    const controller = new AbortController();
    abortRef.current = controller;
    sentAllRef.current = false;
    try {
      setStage({ kind: "zipping", fraction: 0 });
      const zip = await zipBundle(bundle, (fraction) => setStage({ kind: "zipping", fraction }), controller.signal);
      if (maxUploadBytes && zip.size > maxUploadBytes) {
        throw new BundleError(
          `The zip is ${formatBytes(zip.size)}; this server accepts uploads up to ${formatBytes(maxUploadBytes)}.`,
        );
      }
      const fields: UploadFields = { doc: replace ? doc!.slug : slug };
      if (title.trim()) fields.title = title.trim();
      if (!replace && access !== "inherit") fields.access = access;
      if (needsPassword && password) fields.password = password;
      if (entrypoint && !bundle.hasIndex) fields.entrypoint = entrypoint;
      setStage({ kind: "uploading", loaded: 0, total: zip.size });
      const onProgress = (p: { loaded: number; total: number }) =>
        setStage({ kind: "uploading", loaded: p.loaded, total: p.total });
      const result = replace
        ? await api.replaceDoc(repo.slug, fields, zip, onProgress, controller.signal)
        : await api.publishDoc(repo.slug, fields, zip, onProgress, controller.signal);
      setStage({ kind: "done", result });
      setAnnouncement(`Published version ${result.versionNumber} of ${result.repo}/${result.doc}.`);
      onPublished(result);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        setStage({ kind: "ready" });
        if (sentAllRef.current) {
          // The Worker had the whole bundle; it may have committed the version anyway.
          setSubmitError("The upload was stopped after it reached the server, so it may already be published. Refresh the list to check before publishing again.");
          onMaybePublished?.();
        } else {
          setAnnouncement("Upload cancelled.");
        }
        return;
      }
      setStage({ kind: "ready" });
      if (err instanceof ApiError && err.status === 409) {
        setSubmitError("A document with this slug already exists. Open it and use “New version” instead.");
      } else {
        setSubmitError(err instanceof BundleError ? err.message : errorMessage(err));
      }
    } finally {
      abortRef.current = null;
    }
  }

  function cancelUpload() {
    abortRef.current?.abort();
  }

  function publishAnother() {
    setStage({ kind: "pick" });
    setBundle(null);
    setPickError(null);
    setSubmitError(null);
    setTitle("");
    setSlug("");
    setSlugTouched(false);
    setPassword("");
    setEntrypoint("");
    setAttempted(false);
  }

  const progress =
    stage.kind === "zipping"
      ? {
          label: "Compressing files…",
          pct: Math.round(stage.fraction * 100),
          detail: null as string | null,
        }
      : stage.kind === "uploading"
        ? {
            label: phase === "processing" ? "Processing on the server…" : "Uploading…",
            pct: stage.total ? Math.round((stage.loaded / stage.total) * 100) : 0,
            detail: `${formatBytes(stage.loaded)} of ${formatBytes(stage.total)}`,
          }
        : null;

  const live = (
    <p className="sr-only" role="status" aria-live="polite">
      {announcement}
    </p>
  );

  // ── Done ───────────────────────────────────────────────────────────────
  if (stage.kind === "done") {
    const r = stage.result;
    const detailPath = `/repos/${encodeURIComponent(r.repo)}/${encodeURIComponent(r.doc)}`;
    return (
      <Dialog
        open={open}
        onClose={onClose}
        title="Published"
        size="lg"
        icon={<CheckCircle2 size={18} aria-hidden />}
        description={`Version ${r.versionNumber} of ${r.repo}/${r.doc} is live.`}
        footer={
          <>
            {!replace && (
              <Button variant="ghost" icon={<Plus size={15} aria-hidden />} onClick={publishAnother} className="footer-start">
                Publish another
              </Button>
            )}
            {!replace && (
              <ButtonLink to={detailPath} icon={<FileText size={15} aria-hidden />} onClick={onClose}>
                View document
              </ButtonLink>
            )}
            {replace && (
              <Button variant="ghost" onClick={onClose}>
                Close
              </Button>
            )}
            <ButtonAnchor
              ref={openButton}
              variant="primary"
              href={r.url}
              target="_blank"
              rel="noopener noreferrer"
              icon={<ExternalLink size={15} aria-hidden />}
            >
              Open document
            </ButtonAnchor>
          </>
        }
      >
        {live}
        <div className="stack-4">
          <div className="stack-1">
            <label className="section-label" htmlFor={`${titleId}-latest`}>
              Always latest — share this
            </label>
            <CopyField id={`${titleId}-latest`} value={absolute(r.url)} label="Latest URL" copyLabel="Copy latest URL" />
          </div>
          <div className="stack-1">
            <label className="section-label" htmlFor={`${titleId}-pinned`}>
              Pinned to v{r.versionNumber} — never changes
            </label>
            <CopyField
              id={`${titleId}-pinned`}
              value={absolute(r.versionUrl)}
              label={`Version ${r.versionNumber} URL`}
              copyLabel={`Copy v${r.versionNumber} pinned URL`}
            />
          </div>
          <div className="publish-summary">
            <AccessBadge access={r.access} />
            <span>{pluralize(r.fileCount, "file")}</span>
            <span>{formatBytes(r.sizeBytes)}</span>
            <span className="mono muted">sha256 {r.checksum.slice(0, 12)}</span>
          </div>
        </div>
      </Dialog>
    );
  }

  const titleText = replace ? `New version of ${doc!.title}` : "Publish a document";
  const description = replace
    ? "Upload a .zip or folder. The current version stays available as a pinned version."
    : `Upload a static HTML report to ${repo.name}. Drop a .zip or a whole folder.`;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      dismissible={!busy}
      title={titleText}
      description={description}
      size="lg"
      footer={
        progress ? (
          phase === "processing" ? (
            // The bytes are on the server: cancelling now wouldn't stop the publish, so don't offer it.
            <Button variant="primary" loading>
              Finishing…
            </Button>
          ) : (
            <>
              <Button variant="ghost" onClick={cancelUpload} icon={<X size={15} aria-hidden />}>
                Cancel
              </Button>
              <Button variant="primary" loading>
                Publishing
              </Button>
            </>
          )
        ) : (
          <>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button
              variant="primary"
              type="submit"
              form={formId}
              disabled={!bundle || (attempted && !valid)}
              icon={<UploadCloud size={15} aria-hidden />}
            >
              {replace ? "Publish new version" : "Publish"}
            </Button>
          </>
        )
      }
    >
      {live}
      <form id={formId} onSubmit={submit} className="stack-5" noValidate>
        {/* Bundle picker */}
        {!bundle ? (
          <div
            className={`dropzone ${dragging ? "is-dragging" : ""} ${pickError ? "is-invalid" : ""}`}
            onDragEnter={(e) => {
              e.preventDefault();
              dragDepth.current++;
              setDragging(true);
            }}
            onDragOver={(e) => {
              e.preventDefault();
              e.dataTransfer.dropEffect = "copy";
            }}
            onDragLeave={() => {
              dragDepth.current = Math.max(0, dragDepth.current - 1);
              if (dragDepth.current === 0) setDragging(false);
            }}
            onDrop={onDrop}
          >
            <div className="dropzone-icon">
              <FolderUp size={22} aria-hidden />
            </div>
            <p className="dropzone-title">{stage.kind === "reading" ? "Reading files…" : "Drag a folder or .zip here"}</p>
            <p className="dropzone-text">
              The folder should contain an <code>index.html</code> (or any HTML entry page) plus its assets. Folders are
              zipped in your browser before upload.
            </p>
            <div className="dropzone-actions">
              <Button icon={<FolderOpen size={15} aria-hidden />} onClick={() => folderInput.current?.click()} disabled={busy}>
                Choose folder
              </Button>
              <Button icon={<FileArchive size={15} aria-hidden />} onClick={() => zipInput.current?.click()} disabled={busy}>
                Choose .zip
              </Button>
            </div>
            {maxUploadBytes && <p className="dropzone-limit">Up to {formatBytes(maxUploadBytes)} · 2,000 files</p>}
            <input
              ref={folderInput}
              type="file"
              multiple
              className="sr-only"
              tabIndex={-1}
              aria-hidden
              onChange={(e) => {
                const files = e.target.files;
                if (files && files.length) void accept(prepareFileList(Array.from(files)));
                e.target.value = "";
              }}
            />
            <input
              ref={zipInput}
              type="file"
              accept=".zip,application/zip,application/x-zip-compressed"
              className="sr-only"
              tabIndex={-1}
              aria-hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void accept(prepareZip(f));
                e.target.value = "";
              }}
            />
          </div>
        ) : (
          <div className="bundle-card">
            <span className="bundle-icon">
              {bundle.kind === "zip" ? <FileArchive size={18} aria-hidden /> : <FolderOpen size={18} aria-hidden />}
            </span>
            <div className="bundle-info">
              <span className="bundle-name">{bundle.name}</span>
              <span className="bundle-meta">
                {pluralize(bundle.fileCount, "file")} · {formatBytes(bundle.totalBytes)}
                {bundle.hasIndex ? " · index.html" : ""}
              </span>
            </div>
            {!busy && (
              <Button
                size="sm"
                variant="ghost"
                icon={<RotateCcw size={14} aria-hidden />}
                onClick={() => {
                  setBundle(null);
                  setStage({ kind: "pick" });
                }}
              >
                Change
              </Button>
            )}
          </div>
        )}
        {pickError && (
          <p className="form-error" role="alert">
            {pickError}
          </p>
        )}

        {bundle && !bundle.hasIndex && bundle.htmlFiles.length > 0 && (
          <Field label="Entry page" hint="No index.html at the top level — choose which page opens first.">
            {({ id, describedBy }) => (
              <Select id={id} aria-describedby={describedBy} value={entrypoint} onChange={(e) => setEntrypoint(e.target.value)} disabled={busy}>
                {bundle.htmlFiles.slice(0, 200).map((f) => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        )}

        <div className="form-grid">
          <Field
            label="Title"
            optional
            hint={replace ? "Leave blank to keep the current title." : "Shown in the dashboard and repository index."}
            error={titleErr}
          >
            {({ id, describedBy, invalid }) => (
              <Input
                id={id}
                ref={titleInput}
                aria-describedby={describedBy}
                invalid={invalid}
                value={title}
                placeholder={replace ? doc!.title : "Quarterly report"}
                maxLength={160}
                disabled={busy}
                onChange={(e) => {
                  setTitle(e.target.value);
                  if (!replace && !slugTouched) setSlug(slugify(e.target.value) || (bundle ? slugify(bundle.name.replace(/\.zip$/i, "")) : ""));
                }}
              />
            )}
          </Field>
          {!replace && (
            <Field
              label="Document slug"
              hint={`URL: /r/${repo.slug}/${slug || "…"}/`}
              error={attempted || slugTouched || existingSlugs.includes(slug) ? slugErr : null}
            >
              {({ id, describedBy, invalid }) => (
                <Input
                  id={id}
                  aria-describedby={describedBy}
                  invalid={invalid}
                  value={slug}
                  maxLength={64}
                  disabled={busy}
                  spellCheck={false}
                  autoCapitalize="off"
                  className="mono-input"
                  onChange={(e) => {
                    setSlugTouched(true);
                    setSlug(e.target.value.toLowerCase());
                  }}
                />
              )}
            </Field>
          )}
        </div>

        {!replace && (
          <>
            <AccessPicker
              value={access}
              onChange={setAccess}
              inheritFrom={repo.defaultAccess}
              disabled={busy}
              compact
            />
            {needsPassword && (
              <Field
                label="Document password"
                optional={!pwRequired}
                hint={
                  repo.hasPassword
                    ? "Leave blank to use the repository password."
                    : "Viewers will be asked for this password."
                }
                error={attempted ? pwErr : null}
              >
                {({ id, describedBy, invalid }) => (
                  <PasswordInput
                    id={id}
                    aria-describedby={describedBy}
                    invalid={invalid}
                    value={password}
                    autoComplete="new-password"
                    disabled={busy}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                )}
              </Field>
            )}
          </>
        )}

        {progress && (
          <div className="progress-block">
            <div className="progress-head" aria-hidden>
              <span>{progress.label}</span>
              <span className="mono">{progress.pct}%</span>
            </div>
            {/* The progressbar exposes the value; phase changes are announced by the live region above. */}
            <div
              className="progress"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={progress.pct}
              aria-valuetext={progress.detail ? `${progress.pct}%, ${progress.detail}` : `${progress.pct}%`}
              aria-label={progress.label}
            >
              <div className="progress-bar" style={{ width: `${progress.pct}%` }} />
            </div>
            {progress.detail && <p className="field-hint">{progress.detail}</p>}
          </div>
        )}

        {submitError && (
          <p className="form-error" role="alert">
            {submitError}
          </p>
        )}
      </form>
    </Dialog>
  );
}
