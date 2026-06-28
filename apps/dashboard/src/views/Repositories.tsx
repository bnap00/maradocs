import { useEffect, useState } from "react";
import {
  ChevronRight,
  Plus,
  ExternalLink,
  Settings2,
  History,
  Trash2,
  FileText,
  FolderGit2,
} from "lucide-react";
import type {
  AccessMode,
  Api,
  DocumentSummary,
  DocumentVersion,
  Repository,
} from "../api";
import { AccessBadge, Empty, Modal, Spinner } from "../components/ui";
import { formatBytes, timeAgo } from "../format";

type Toast = (msg: string, error?: boolean) => void;

const ACCESS: AccessMode[] = ["public", "password", "private"];

export function Repositories({ api, toast }: { api: Api; toast: Toast }) {
  const [repos, setRepos] = useState<Repository[] | null>(null);
  const [selected, setSelected] = useState<Repository | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [editRepo, setEditRepo] = useState<Repository | null>(null);

  const loadRepos = () =>
    api
      .listRepos()
      .then((r) => setRepos(r.repos))
      .catch((e) => toast(e.message, true));

  useEffect(() => {
    loadRepos();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (selected) {
    return (
      <>
        <RepoDetail
          api={api}
          toast={toast}
          repo={selected}
          onBack={() => {
            setSelected(null);
            loadRepos();
          }}
          onEdit={() => setEditRepo(selected)}
        />
        {editRepo && (
          <RepoForm
            api={api}
            toast={toast}
            existing={editRepo}
            onClose={() => setEditRepo(null)}
            onSaved={(updated) => {
              setEditRepo(null);
              setSelected(updated ?? null);
              loadRepos();
            }}
          />
        )}
      </>
    );
  }

  return (
    <>
      <div className="topbar">
        <div>
          <h1>Repositories</h1>
          <p>Namespaces that group your published documents.</p>
        </div>
        <button className="btn primary" onClick={() => setShowCreate(true)}>
          <Plus size={16} /> New repository
        </button>
      </div>

      {repos === null ? (
        <Spinner />
      ) : repos.length === 0 ? (
        <div className="card">
          <Empty icon="📁" text="No repositories yet. Create one to start publishing." />
        </div>
      ) : (
        <div className="card">
          {repos.map((r) => (
            <button key={r.id} className="list-row" onClick={() => setSelected(r)}>
              <FolderGit2 size={20} color="var(--accent)" />
              <div className="grow">
                <div className="title">{r.name}</div>
                <div className="sub">
                  {r.slug} · updated {timeAgo(r.updatedAt)}
                </div>
              </div>
              <AccessBadge access={r.defaultAccess} />
              {r.indexEnabled && <span className="badge neutral">index</span>}
              <ChevronRight size={18} color="var(--faint)" />
            </button>
          ))}
        </div>
      )}

      {showCreate && (
        <RepoForm
          api={api}
          toast={toast}
          onClose={() => setShowCreate(false)}
          onSaved={() => {
            setShowCreate(false);
            loadRepos();
          }}
        />
      )}
      {editRepo && (
        <RepoForm
          api={api}
          toast={toast}
          existing={editRepo}
          onClose={() => setEditRepo(null)}
          onSaved={(updated) => {
            setEditRepo(null);
            setSelected(updated ?? null);
            loadRepos();
          }}
        />
      )}
    </>
  );
}

function RepoDetail({
  api,
  toast,
  repo,
  onBack,
  onEdit,
}: {
  api: Api;
  toast: Toast;
  repo: Repository;
  onBack: () => void;
  onEdit: () => void;
}) {
  const [docs, setDocs] = useState<DocumentSummary[] | null>(null);
  const [versionsFor, setVersionsFor] = useState<DocumentSummary | null>(null);

  const load = () =>
    api
      .listDocs(repo.slug)
      .then((r) => setDocs(r.docs))
      .catch((e) => toast(e.message, true));

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repo.slug]);

  const removeDoc = async (doc: DocumentSummary) => {
    if (!confirm(`Delete ${repo.slug}/${doc.slug} and all versions?`)) return;
    try {
      await api.deleteDoc(repo.slug, doc.slug);
      toast(`Deleted ${doc.slug}`);
      load();
    } catch (e) {
      toast((e as Error).message, true);
    }
  };

  return (
    <>
      <div className="crumbs">
        <button onClick={onBack}>Repositories</button>
        <ChevronRight size={14} />
        <span style={{ color: "var(--text)" }}>{repo.slug}</span>
      </div>
      <div className="topbar">
        <div>
          <h1 style={{ display: "flex", gap: 10, alignItems: "center" }}>
            {repo.name} <AccessBadge access={repo.defaultAccess} />
          </h1>
          <p>{repo.description || "No description"}</p>
        </div>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", justifyContent: "flex-end" }}>
          {repo.indexEnabled && (
            <a className="btn" href={`/r/${repo.slug}/`} target="_blank" rel="noreferrer">
              <ExternalLink size={16} /> Open index
            </a>
          )}
          <button className="btn" onClick={onEdit}>
            <Settings2 size={16} /> Access & settings
          </button>
        </div>
      </div>

      {docs === null ? (
        <Spinner />
      ) : docs.length === 0 ? (
        <div className="card">
          <Empty
            icon="📄"
            text={`No documents yet. Publish one with: maradocs publish ./report --repo ${repo.slug} --doc <slug>`}
          />
        </div>
      ) : (
        <div className="card">
          {docs.map((d) => (
            <div key={d.id} className="list-row static">
              <FileText size={18} color="var(--accent)" />
              <div className="grow">
                <div className="title">{d.title}</div>
                <div className="sub">
                  {d.slug}
                  {d.latestVersionNumber ? ` · v${d.latestVersionNumber}` : " · no version"} ·
                  updated {timeAgo(d.updatedAt)}
                </div>
              </div>
              <AccessBadge access={d.access} />
              <button className="btn ghost sm" onClick={() => setVersionsFor(d)}>
                <History size={15} /> Versions
              </button>
              {d.url && (
                <a className="btn ghost sm" href={d.url} target="_blank" rel="noreferrer">
                  <ExternalLink size={15} /> Open
                </a>
              )}
              <button className="btn ghost sm" onClick={() => removeDoc(d)}>
                <Trash2 size={15} color="var(--red)" />
              </button>
            </div>
          ))}
        </div>
      )}

      {versionsFor && (
        <VersionsModal
          api={api}
          toast={toast}
          repo={repo.slug}
          doc={versionsFor}
          onClose={() => setVersionsFor(null)}
          onChanged={load}
        />
      )}
    </>
  );
}

function VersionsModal({
  api,
  toast,
  repo,
  doc,
  onClose,
  onChanged,
}: {
  api: Api;
  toast: Toast;
  repo: string;
  doc: DocumentSummary;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [versions, setVersions] = useState<DocumentVersion[] | null>(null);

  const load = () =>
    api
      .listVersions(repo, doc.slug)
      .then((r) => setVersions(r.versions))
      .catch((e) => toast(e.message, true));

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const rollback = async (v: DocumentVersion) => {
    try {
      await api.rollback(repo, doc.slug, v.versionNumber);
      toast(`Promoted v${v.versionNumber} to latest`);
      load();
      onChanged();
    } catch (e) {
      toast((e as Error).message, true);
    }
  };

  return (
    <Modal
      title={`${repo}/${doc.slug}`}
      hint="Immutable versions. Promote any version to become the latest."
      onClose={onClose}
      wide
    >
      {versions === null ? (
        <Spinner />
      ) : (
        <div className="card">
          {versions.map((v) => (
            <div key={v.id} className="list-row static">
              <div className="grow">
                <div className="title">
                  v{v.versionNumber}{" "}
                  {v.isLatest && <span className="badge latest">latest</span>}
                </div>
                <div className="sub">
                  {formatBytes(v.sizeBytes)} · {v.fileCount} files · by{" "}
                  {v.publishedByLabel ?? v.publishedByType} · {timeAgo(v.createdAt)}
                </div>
                <div className="sub mono">{v.checksum.slice(0, 24)}…</div>
              </div>
              <a
                className="btn ghost sm"
                href={`/r/${repo}/${doc.slug}/v/${v.versionNumber}/`}
                target="_blank"
                rel="noreferrer"
              >
                <ExternalLink size={14} /> View
              </a>
              {!v.isLatest && (
                <button className="btn sm" onClick={() => rollback(v)}>
                  <History size={14} /> Promote
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}

function RepoForm({
  api,
  toast,
  existing,
  onClose,
  onSaved,
}: {
  api: Api;
  toast: Toast;
  existing?: Repository;
  onClose: () => void;
  onSaved: (repo?: Repository) => void;
}) {
  const [slug, setSlug] = useState(existing?.slug ?? "");
  const [name, setName] = useState(existing?.name ?? "");
  const [description, setDescription] = useState(existing?.description ?? "");
  const [access, setAccess] = useState<AccessMode>(existing?.defaultAccess ?? "private");
  const [password, setPassword] = useState("");
  const [indexEnabled, setIndexEnabled] = useState(existing?.indexEnabled ?? false);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    try {
      if (existing) {
        const { repo } = await api.updateRepo(existing.slug, {
          name: name || undefined,
          description: description || null,
          access,
          indexEnabled,
          password: password ? password : undefined,
        });
        toast(`Updated ${repo.slug}`);
        onSaved(repo);
      } else {
        const { repo } = await api.createRepo({
          slug,
          name: name || undefined,
          description: description || undefined,
          access,
          indexEnabled,
          password: password || undefined,
        } as never);
        toast(`Created ${repo.slug}`);
        onSaved(repo);
      }
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={existing ? "Repository settings" : "New repository"}
      hint={existing ? existing.slug : "Slugs are lowercase, hyphenated, and used in URLs."}
      onClose={onClose}
    >
      {!existing && (
        <div className="field">
          <label>Slug</label>
          <input
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            placeholder="revenue"
            autoFocus
          />
        </div>
      )}
      <div className="field">
        <label>Display name</label>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Revenue reports" />
      </div>
      <div className="field">
        <label>Description</label>
        <textarea
          rows={2}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </div>
      <div className="field">
        <label>Default access</label>
        <div className="seg">
          {ACCESS.map((a) => (
            <button
              key={a}
              className={access === a ? "on" : ""}
              onClick={() => setAccess(a)}
              type="button"
            >
              {a}
            </button>
          ))}
        </div>
      </div>
      {access === "password" && (
        <div className="field">
          <label>{existing ? "Set / change password" : "Password"}</label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={existing?.hasPassword ? "•••••• (unchanged)" : "Choose a password"}
          />
        </div>
      )}
      <div className="field">
        <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
          <input
            type="checkbox"
            style={{ width: "auto" }}
            checked={indexEnabled}
            onChange={(e) => setIndexEnabled(e.target.checked)}
          />
          Enable public repository index (/r/{slug || "repo"}/)
        </label>
      </div>
      <div className="modal-actions">
        <button className="btn ghost" onClick={onClose}>
          Cancel
        </button>
        <button className="btn primary" onClick={submit} disabled={busy || (!existing && !slug)}>
          {busy ? "Saving…" : existing ? "Save changes" : "Create repository"}
        </button>
      </div>
    </Modal>
  );
}
