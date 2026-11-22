import { type FormEvent, useEffect, useMemo, useState } from "react";
import { BookOpen, ChevronRight, ListTree, Plus, Search } from "lucide-react";
import { ApiError, api, errorMessage } from "../api";
import { AccessPicker, type AccessChoice, passwordError } from "../components/AccessPicker";
import { PageHeader } from "../components/Layout";
import {
  AccessBadge,
  Badge,
  Button,
  Dialog,
  EmptyState,
  ErrorState,
  Field,
  Input,
  PasswordInput,
  RelativeTime,
  SkeletonRows,
  Switch,
  Textarea,
  Tooltip,
  useToast,
} from "../components/ui";
import { useApp } from "../lib/app";
import { navigate, Link, useSearchParam } from "../lib/router";
import { slugError, slugify } from "../lib/slug";
import { useDocumentTitle } from "../lib/useDocumentTitle";
import { useResource } from "../lib/useResource";
import type { AccessMode, Repository } from "../types";

export function ReposPage() {
  useDocumentTitle("Repositories");
  const res = useResource(() => api.listRepos().then((r) => r.repos), []);
  const [creating, setCreating] = useState(false);
  const [query, setQuery] = useState("");

  // /repos?new=1 (from the overview) opens "New repository" straight away.
  const wantsNew = useSearchParam("new") === "1";
  useEffect(() => {
    if (!wantsNew) return;
    setCreating(true);
    navigate("/repos", { replace: true });
  }, [wantsNew]);

  const repos = res.data;
  const filtered = useMemo(() => {
    if (!repos) return [];
    const q = query.trim().toLowerCase();
    const sorted = [...repos].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    if (!q) return sorted;
    return sorted.filter(
      (r) => r.slug.includes(q) || r.name.toLowerCase().includes(q) || (r.description ?? "").toLowerCase().includes(q),
    );
  }, [repos, query]);

  return (
    <>
      <PageHeader
        title="Repositories"
        description="Repositories group related documents and set their default access."
        actions={
          <Button variant="primary" icon={<Plus size={15} aria-hidden />} onClick={() => setCreating(true)}>
            New repository
          </Button>
        }
      />

      {res.error && !repos ? (
        <ErrorState error={res.error} onRetry={res.reload} />
      ) : !repos ? (
        <div className="card">
          <SkeletonRows rows={4} cols={4} />
        </div>
      ) : repos.length === 0 ? (
        <div className="card">
          <EmptyState
            icon={<BookOpen size={20} aria-hidden />}
            title="Create your first repository"
            actions={
              <Button variant="primary" icon={<Plus size={15} aria-hidden />} onClick={() => setCreating(true)}>
                New repository
              </Button>
            }
          >
            A repository is a folder of documents, like <code>team-reports</code>. Each document gets a stable URL such as{" "}
            <code>/r/team-reports/weekly/</code>. The CLI also creates repositories on first publish.
          </EmptyState>
        </div>
      ) : (
        <div className="stack-4">
          {repos.length > 5 && (
            <div className="toolbar">
              <Input
                type="search"
                placeholder="Filter repositories"
                aria-label="Filter repositories"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                leading={<Search size={15} aria-hidden />}
                className="toolbar-search"
              />
            </div>
          )}
          <div className="card card-flush">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Repository</th>
                  <th scope="col">Documents</th>
                  <th scope="col">Default access</th>
                  <th scope="col">Index</th>
                  <th scope="col">Updated</th>
                  <th scope="col">
                    <span className="sr-only">Open</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((r) => (
                  <tr key={r.id} className="row-link" onClick={(e) => {
                    // Let real controls handle their own clicks; badges and times just navigate.
                    if ((e.target as HTMLElement).closest("a,button,input,select,textarea,label")) return;
                    navigate(`/repos/${encodeURIComponent(r.slug)}`);
                  }}>
                    <td data-label="Repository" className="cell-primary">
                      <Link to={`/repos/${encodeURIComponent(r.slug)}`} className="cell-title">
                        {r.name}
                      </Link>
                      <span className="cell-sub mono">{r.slug}</span>
                      {r.description && <span className="cell-sub cell-desc">{r.description}</span>}
                    </td>
                    <td data-label="Documents">
                      {r.docCount != null ? <span className="tabular">{r.docCount}</span> : <span className="muted">—</span>}
                    </td>
                    <td data-label="Default access">
                      <AccessBadge access={r.defaultAccess} />
                    </td>
                    <td data-label="Index">
                      {r.indexEnabled ? (
                        <Tooltip content="The repository index page lists its public documents.">
                          <span>
                            <Badge tone="accent" icon={<ListTree size={12} aria-hidden />}>
                              Browsable
                            </Badge>
                          </span>
                        </Tooltip>
                      ) : (
                        <span className="muted">Hidden</span>
                      )}
                    </td>
                    <td data-label="Updated">
                      <RelativeTime iso={r.updatedAt} />
                    </td>
                    <td className="cell-actions" data-label="">
                      <ChevronRight size={16} className="row-chevron" aria-hidden />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {filtered.length === 0 && (
              <EmptyState compact title="No matches">
                No repository matches “{query}”.
              </EmptyState>
            )}
          </div>
        </div>
      )}

      <CreateRepoDialog
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(repo) => {
          res.setData((prev) => [repo, ...(prev ?? [])]);
          navigate(`/repos/${encodeURIComponent(repo.slug)}`);
        }}
      />
    </>
  );
}

function CreateRepoDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (repo: Repository) => void;
}) {
  const toast = useToast();
  const { settings } = useApp();
  const defaultAccess: AccessMode = settings?.defaultRepoAccess ?? "private";
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [description, setDescription] = useState("");
  const [access, setAccess] = useState<AccessChoice>(defaultAccess);
  const [password, setPassword] = useState("");
  const [indexEnabled, setIndexEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName("");
    setSlug("");
    setSlugTouched(false);
    setDescription("");
    setAccess(defaultAccess);
    setPassword("");
    setIndexEnabled(false);
    setAttempted(false);
    setServerError(null);
  }, [open, defaultAccess]);

  const slugErr = slugError(slug);
  const nameErr = name.length > 120 ? "At most 120 characters" : null;
  const descErr = description.length > 500 ? "At most 500 characters" : null;
  const pwErr = access === "password" ? passwordError(password, true) : null;
  const valid = !slugErr && !nameErr && !descErr && !pwErr;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setAttempted(true);
    if (!valid || busy) return;
    setBusy(true);
    setServerError(null);
    try {
      const { repo } = await api.createRepo({
        slug,
        name: name.trim() || undefined,
        description: description.trim() || undefined,
        access: access === "inherit" ? undefined : access,
        indexEnabled,
        password: access === "password" ? password : undefined,
      });
      toast.success("Repository created", repo.name);
      onClose();
      onCreated(repo);
    } catch (err) {
      setServerError(
        err instanceof ApiError && err.status === 409 ? `A repository named “${slug}” already exists.` : errorMessage(err),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      dismissible={!busy}
      title="New repository"
      description="Group related documents under one URL prefix with shared defaults."
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form="create-repo" loading={busy}>
            Create repository
          </Button>
        </>
      }
    >
      <form id="create-repo" onSubmit={submit} className="stack-5" noValidate>
        <div className="form-grid">
          <Field label="Name" hint="A human-friendly name." error={nameErr}>
            {({ id, describedBy, invalid }) => (
              <Input
                id={id}
                aria-describedby={describedBy}
                invalid={invalid}
                value={name}
                placeholder="Team reports"
                maxLength={120}
                data-autofocus
                onChange={(e) => {
                  setName(e.target.value);
                  if (!slugTouched) setSlug(slugify(e.target.value));
                }}
              />
            )}
          </Field>
          <Field
            label="Slug"
            hint={`Used in URLs: /r/${slug || "…"}/`}
            error={attempted || (slugTouched && slug) ? slugErr : null}
          >
            {({ id, describedBy, invalid }) => (
              <Input
                id={id}
                aria-describedby={describedBy}
                invalid={invalid}
                value={slug}
                placeholder="team-reports"
                maxLength={64}
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
        </div>
        <Field label="Description" optional error={descErr}>
          {({ id, describedBy, invalid }) => (
            <Textarea
              id={id}
              aria-describedby={describedBy}
              invalid={invalid}
              value={description}
              rows={2}
              maxLength={500}
              placeholder="What lives here?"
              onChange={(e) => setDescription(e.target.value)}
            />
          )}
        </Field>
        <AccessPicker
          label="Default access for documents"
          value={access}
          onChange={setAccess}
        />
        {access === "password" && (
          <Field
            label="Repository password"
            hint="Documents that use password access fall back to this password."
            error={attempted ? pwErr : null}
          >
            {({ id, describedBy, invalid }) => (
              <PasswordInput
                id={id}
                aria-describedby={describedBy}
                invalid={invalid}
                value={password}
                autoComplete="new-password"
                onChange={(e) => setPassword(e.target.value)}
              />
            )}
          </Field>
        )}
        <Switch
          checked={indexEnabled}
          onChange={setIndexEnabled}
          label="Browsable index"
          description={`Show a public listing at /r/${slug || "…"}/ with this repository's public documents.`}
        />
        {serverError && (
          <p className="form-error" role="alert">
            {serverError}
          </p>
        )}
      </form>
    </Dialog>
  );
}
