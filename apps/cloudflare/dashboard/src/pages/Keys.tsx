import { type FormEvent, useEffect, useState } from "react";
import { AlertTriangle, KeyRound, Plus, Trash2 } from "lucide-react";
import { api, errorMessage } from "../api";
import { PageHeader } from "../components/Layout";
import {
  Badge,
  Button,
  Checkbox,
  CodeBlock,
  ConfirmDialog,
  CopyField,
  Dialog,
  EmptyState,
  ErrorState,
  Field,
  Input,
  RelativeTime,
  SkeletonRows,
  Tooltip,
  useToast,
} from "../components/ui";
import { useApp } from "../lib/app";
import { Link } from "../lib/router";
import { useDocumentTitle } from "../lib/useDocumentTitle";
import { useResource } from "../lib/useResource";
import { API_KEY_SCOPES, type ApiKeyInfo, type ApiKeyScope, type CreatedApiKey } from "../types";

const SCOPE_INFO: Record<ApiKeyScope, { label: string; text: string }> = {
  publish: {
    label: "Publish",
    text: "Create repositories, publish and replace documents, roll back and delete documents. Also views private and password-protected documents and downloads bundles.",
  },
  read: {
    label: "Read",
    text: "View private documents and download bundles. Useful for agents that fetch reports but never publish.",
  },
  admin: {
    label: "Admin",
    text: "Everything above, on every endpoint the API exposes. Only grant to fully trusted automation.",
  },
};

export function KeysPage() {
  useDocumentTitle("API keys");
  const toast = useToast();
  const res = useResource(() => api.listKeys().then((r) => r.keys), []);
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<CreatedApiKey | null>(null);
  const [revoking, setRevoking] = useState<ApiKeyInfo | null>(null);
  const keys = res.data;

  return (
    <>
      <PageHeader
        title="API keys"
        description="Keys let the CLI, agents and CI publish to your account without your password. Each key is shown once."
        actions={
          <Button variant="primary" icon={<Plus size={15} aria-hidden />} onClick={() => setCreating(true)}>
            Create key
          </Button>
        }
      />

      {res.error && !keys ? (
        <ErrorState error={res.error} onRetry={res.reload} />
      ) : !keys ? (
        <div className="card">
          <SkeletonRows rows={3} cols={4} />
        </div>
      ) : keys.length === 0 ? (
        <div className="card">
          <EmptyState
            icon={<KeyRound size={20} aria-hidden />}
            title="No API keys yet"
            actions={
              <>
                <Button variant="primary" icon={<Plus size={15} aria-hidden />} onClick={() => setCreating(true)}>
                  Create key
                </Button>
                <Link to="/connect" className="btn btn-ghost">
                  <span className="btn-label">Setup guide</span>
                </Link>
              </>
            }
          >
            Create a <strong>publish</strong> key for each agent or machine so you can revoke them individually. Or run{" "}
            <code>maradocs auth bootstrap</code>, which mints one for you.
          </EmptyState>
        </div>
      ) : (
        <div className="card card-flush">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Key</th>
                <th scope="col">Scopes</th>
                <th scope="col">Created</th>
                <th scope="col">Last used</th>
                <th scope="col" className="th-actions">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {keys.map((k) => (
                <tr key={k.id}>
                  <td data-label="Name" className="cell-primary">
                    <span className="cell-title-plain">{k.name}</span>
                  </td>
                  <td data-label="Key">
                    <code className="key-prefix">{k.prefix}…</code>
                  </td>
                  <td data-label="Scopes">
                    <span className="badge-list">
                      {k.scopes.map((s) => (
                        <Badge key={s} tone={s === "admin" ? "warning" : s === "publish" ? "accent" : "neutral"}>
                          {s}
                        </Badge>
                      ))}
                    </span>
                  </td>
                  <td data-label="Created">
                    <RelativeTime iso={k.createdAt} />
                  </td>
                  <td data-label="Last used">
                    <RelativeTime iso={k.lastUsedAt} fallback="Never used" />
                  </td>
                  <td className="cell-actions">
                    <div className="row-actions">
                      <Tooltip content="Revoke key">
                        <button
                          type="button"
                          className="btn btn-danger-ghost btn-icon btn-sm"
                          onClick={() => setRevoking(k)}
                          aria-label={`Revoke ${k.name}`}
                        >
                          <Trash2 size={14} aria-hidden />
                        </button>
                      </Tooltip>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <CreateKeyDialog
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(k) => {
          setCreating(false);
          setCreated(k);
          void res.reload();
        }}
      />
      <RevealKeyDialog created={created} onClose={() => setCreated(null)} />
      <ConfirmDialog
        open={Boolean(revoking)}
        onClose={() => setRevoking(null)}
        title={`Revoke “${revoking?.name ?? ""}”?`}
        description="Anything using this key stops working immediately. This can't be undone."
        confirmLabel="Revoke key"
        onConfirm={async () => {
          if (!revoking) return;
          await api.revokeKey(revoking.id);
          res.setData((prev) => prev?.filter((k) => k.id !== revoking.id));
          toast.success("API key revoked", revoking.name);
        }}
      />
    </>
  );
}

function CreateKeyDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (k: CreatedApiKey) => void;
}) {
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<ApiKeyScope[]>(["publish"]);
  const [busy, setBusy] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName("");
    setScopes(["publish"]);
    setAttempted(false);
    setError(null);
  }, [open]);

  const nameErr = !name.trim() ? "Give the key a name so you can recognise it later" : name.length > 100 ? "At most 100 characters" : null;
  const scopeErr = scopes.length === 0 ? "Choose at least one scope" : null;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setAttempted(true);
    if (nameErr || scopeErr || busy) return;
    setBusy(true);
    setError(null);
    try {
      onCreated(await api.createKey(name.trim(), scopes));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      dismissible={!busy}
      title="Create API key"
      description="Use one key per agent or machine, with the fewest scopes it needs."
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form="create-key" loading={busy}>
            Create key
          </Button>
        </>
      }
    >
      <form id="create-key" onSubmit={submit} className="stack-5" noValidate>
        <Field label="Name" hint="For example “Claude Code on laptop” or “CI – nightly reports”." error={attempted ? nameErr : null}>
          {({ id, describedBy, invalid }) => (
            <Input
              id={id}
              aria-describedby={describedBy}
              invalid={invalid}
              value={name}
              maxLength={100}
              data-autofocus
              onChange={(e) => setName(e.target.value)}
            />
          )}
        </Field>
        <fieldset className="fieldset">
          <legend className="field-label">Scopes</legend>
          <div className="stack-2">
            {(["publish", "read", "admin"] as const).filter((s) => API_KEY_SCOPES.includes(s)).map((s) => (
              <Checkbox
                key={s}
                checked={scopes.includes(s)}
                onChange={(on) => setScopes((prev) => (on ? [...prev, s] : prev.filter((x) => x !== s)))}
                label={SCOPE_INFO[s].label}
                description={SCOPE_INFO[s].text}
              />
            ))}
          </div>
          {attempted && scopeErr && (
            <p className="field-error" role="alert">
              {scopeErr}
            </p>
          )}
        </fieldset>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
      </form>
    </Dialog>
  );
}

function RevealKeyDialog({ created, onClose }: { created: CreatedApiKey | null; onClose: () => void }) {
  const { serverUrl } = useApp();
  // Keep the last key around during the close animation, then drop it from memory.
  const [shown, setShown] = useState<CreatedApiKey | null>(created);
  const [copied, setCopied] = useState(false);
  const [confirming, setConfirming] = useState(false);
  useEffect(() => {
    if (created) {
      setShown(created);
      setCopied(false);
      setConfirming(false);
      return;
    }
    const t = setTimeout(() => setShown(null), 300);
    return () => clearTimeout(t);
  }, [created]);
  const k = created ?? shown;

  // The key can't be shown again, so the only way out is the explicit button
  // (no Esc, backdrop click or X), and closing before copying asks once more.
  function done() {
    if (!copied && !confirming) {
      setConfirming(true);
      return;
    }
    onClose();
  }

  return (
    <Dialog
      open={Boolean(created)}
      onClose={done}
      dismissible={false}
      title="Your new API key"
      description={k ? `${k.name} · ${k.scopes.join(", ")}` : undefined}
      icon={<KeyRound size={18} aria-hidden />}
      footer={
        <Button variant={confirming ? "danger" : "primary"} onClick={done}>
          {confirming ? "Close without copying" : "I've saved it"}
        </Button>
      }
    >
      {k && (
        <div className="stack-4">
          {confirming ? (
            <div className="callout callout-danger" role="alert">
              <AlertTriangle size={16} aria-hidden />
              <div>
                <strong>You haven't copied the key yet.</strong> Once this dialog closes it can't be shown again; you would
                have to revoke it and create a new one.
              </div>
            </div>
          ) : (
            <div className="callout callout-warning">
              <AlertTriangle size={16} aria-hidden />
              <div>Copy it now — for your security it won't be shown again.</div>
            </div>
          )}
          <div className="stack-1">
            <label className="section-label" htmlFor="new-api-key">
              API key
            </label>
            <CopyField id="new-api-key" value={k.key} label="API key" copyLabel="Copy API key" onCopied={() => setCopied(true)} />
          </div>
          <div className="stack-2">
            <span className="section-label">Sign the CLI in</span>
            <p className="field-hint">
              Run this, enter the server URL and paste the key when asked. The key is read without echo, so it stays out
              of your shell history.
            </p>
            <CodeBlock code="maradocs auth setup" label="Copy command" />
            <p className="field-hint">
              Server URL: <code>{serverUrl}</code>
            </p>
          </div>
          <div className="stack-2">
            <span className="section-label">CI and scripts</span>
            <p className="field-hint">
              Store the key as a secret in your CI system and expose it as environment variables:
            </p>
            <CodeBlock code={`MARADOCS_SERVER_URL=${serverUrl}\nMARADOCS_API_KEY=<the key above>`} label="Copy variable names" />
          </div>
        </div>
      )}
    </Dialog>
  );
}
