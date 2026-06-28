import { useEffect, useState } from "react";
import { KeyRound, Trash2, Plus, Copy, X } from "lucide-react";
import type { Api, ApiKeyInfo, Machine } from "../api";
import { Empty, Spinner } from "../components/ui";
import { timeAgo } from "../format";

interface NewKeyModal {
  key: string;
  name: string;
}

export function ApiKeys({ api, toast }: { api: Api; toast: (m: string, e?: boolean) => void }) {
  const [keys, setKeys] = useState<ApiKeyInfo[] | null>(null);
  const [machines, setMachines] = useState<Machine[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newScope, setNewScope] = useState("publish");
  const [modal, setModal] = useState<NewKeyModal | null>(null);

  function reload() {
    api
      .listApiKeys()
      .then((r) => setKeys(r.keys))
      .catch((e: Error) => toast(e.message, true));
    api
      .listMachines()
      .then((r) => setMachines(r.machines))
      .catch((e: Error) => toast(e.message, true));
  }

  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!newName.trim()) return;
    try {
      const res = await api.createApiKey(newName.trim(), [newScope]);
      setModal({ key: res.key, name: res.name });
      setNewName("");
      setNewScope("publish");
      setCreating(false);
      reload();
    } catch (err) {
      toast((err as Error).message, true);
    }
  }

  async function handleDelete(id: string, name: string) {
    if (!confirm(`Delete API key "${name}"? Published docs remain accessible.`)) return;
    try {
      await api.deleteApiKey(id);
      reload();
    } catch (err) {
      toast((err as Error).message, true);
    }
  }

  return (
    <>
      <div className="topbar">
        <div>
          <h1>API Keys</h1>
          <p>Create API keys for CLI publishing, then monitor which keys have used this server.</p>
        </div>
        <button className="btn primary" onClick={() => setCreating(true)}>
          <Plus size={16} /> New key
        </button>
      </div>

      {creating && (
        <div className="card" style={{ marginBottom: 16 }}>
          <form
            onSubmit={handleCreate}
            style={{ display: "flex", gap: 10, alignItems: "center" }}
          >
            <input
              autoFocus
              className="form-input"
              aria-label="API key name"
              placeholder="Key name (e.g. ci-runner)"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              style={{ flex: 1 }}
            />
            <select
              className="form-input"
              aria-label="API key scope"
              value={newScope}
              onChange={(e) => setNewScope(e.target.value)}
              style={{ width: 150 }}
            >
              <option value="read">Read only</option>
              <option value="publish">Publish</option>
              <option value="admin">Admin</option>
            </select>
            <button type="submit" className="btn primary" disabled={!newName.trim()}>
              Create
            </button>
            <button
              type="button"
              className="btn ghost"
              onClick={() => {
                setCreating(false);
                setNewName("");
                setNewScope("publish");
              }}
            >
              Cancel
            </button>
          </form>
        </div>
      )}

      {modal && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.6)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 100,
          }}
        >
          <div className="card" style={{ maxWidth: 520, width: "90%", position: "relative" }}>
            <button
              className="btn ghost"
              onClick={() => setModal(null)}
              style={{ position: "absolute", top: 12, right: 12, padding: 4 }}
            >
              <X size={16} />
            </button>
            <h2 style={{ marginBottom: 8 }}>Key created: {modal.name}</h2>
            <p style={{ fontSize: 13, color: "var(--muted)", marginBottom: 12 }}>
              Copy this key now — it will not be shown again.
            </p>
            <div
              style={{
                fontFamily: "monospace",
                fontSize: 13,
                background: "var(--bg-2, #0a0e1a)",
                border: "1px solid var(--border, rgba(148,163,184,0.14))",
                borderRadius: 8,
                padding: "10px 12px",
                wordBreak: "break-all",
                marginBottom: 12,
              }}
            >
              {modal.key}
            </div>
            <button
              className="btn primary"
              onClick={() => {
                void navigator.clipboard.writeText(modal.key);
                toast("Copied to clipboard");
              }}
            >
              <Copy size={14} /> Copy key
            </button>
          </div>
        </div>
      )}

      {keys === null ? (
        <Spinner />
      ) : keys.length === 0 ? (
        <div className="card">
          <Empty icon="🔑" text="No API keys yet. Create one to start publishing." />
        </div>
      ) : (
        <div className="card">
          {keys.map((k) => (
            <div key={k.id} className="list-row static">
              <KeyRound size={20} color="var(--accent)" />
              <div className="grow">
                <div className="title">{k.name}</div>
                <div className="sub mono">{k.prefix}…</div>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 6 }}>
                  {k.scopes.map((s) => (
                    <span key={s} className="badge neutral">
                      {s}
                    </span>
                  ))}
                </div>
              </div>
              <div className="sub" style={{ minWidth: 120, textAlign: "right" }}>
                <div>{k.lastUsedAt ? `used ${timeAgo(k.lastUsedAt)}` : "never used"}</div>
                <div>created {timeAgo(k.createdAt)}</div>
              </div>
              <button
                className="btn ghost"
                onClick={() => handleDelete(k.id, k.name)}
                title="Delete key"
              >
                <Trash2 size={15} />
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="topbar" style={{ marginTop: 32 }}>
        <div>
          <h2>Machines</h2>
          <p>Keys that have published to this server.</p>
        </div>
      </div>

      {machines === null ? (
        <Spinner />
      ) : machines.length === 0 ? (
        <div className="card">
          <Empty icon="🤖" text="No machines have published yet. Publish with an API key to register one here." />
        </div>
      ) : (
        <div className="card">
          {machines.map((m) => (
            <div key={m.id} className="list-row static">
              <KeyRound size={20} color="var(--accent)" />
              <div className="grow">
                <div className="title">{m.name}</div>
                <div className="sub mono">{m.keyId}</div>
              </div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {m.scopes.length ? (
                  m.scopes.map((s) => (
                    <span key={s} className="badge neutral">
                      <KeyRound size={11} /> {s}
                    </span>
                  ))
                ) : (
                  <span className="badge neutral">all scopes</span>
                )}
              </div>
              <div className="sub" style={{ minWidth: 90, textAlign: "right" }}>
                {m.lastUsedAt ? `used ${timeAgo(m.lastUsedAt)}` : "never"}
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
