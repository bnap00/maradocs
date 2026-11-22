import { type FormEvent, useEffect, useState } from "react";
import { LogOut, Monitor, Moon, Sun, Trash2 } from "lucide-react";
import { ApiError, api, errorMessage } from "../api";
import { AccessPicker, type AccessChoice } from "../components/AccessPicker";
import { PageHeader } from "../components/Layout";
import {
  Button,
  ConfirmDialog,
  CopyButton,
  Dialog,
  ErrorState,
  Field,
  PasswordInput,
  RelativeTime,
  Segmented,
  Skeleton,
  useToast,
} from "../components/ui";
import { useApp } from "../lib/app";
import { formatBytes } from "../lib/format";
import { type ThemePref, useTheme } from "../lib/theme";
import { useDocumentTitle } from "../lib/useDocumentTitle";

const MIN_PASSWORD = 12;
const MAX_PASSWORD = 1024;

export function SettingsPage({ onAccountDeleted }: { onAccountDeleted: () => void }) {
  useDocumentTitle("Settings");
  const { settings, settingsError, publicConfig, refreshSettings, serverUrl } = useApp();

  return (
    <>
      <PageHeader title="Settings" description="Your account, defaults and information about this deployment." />
      {settingsError && !settings ? (
        <ErrorState error={settingsError} onRetry={() => void refreshSettings()} />
      ) : (
        <div className="settings-stack">
          <AccountSection />
          <DefaultsSection />
          <AppearanceSection />
          <PasswordSection />
          <SessionsSection />
          <section className="card settings-section" aria-labelledby="deploy-title">
            <div className="settings-section-head">
              <h2 id="deploy-title" className="card-title">
                Deployment
              </h2>
              <p className="card-text">Read-only details about this MaraDocs Worker.</p>
            </div>
            <dl className="info-list">
              <div>
                <dt>Server URL</dt>
                <dd>
                  <span className="mono">{serverUrl}</span>
                  <CopyButton text={serverUrl} label="Copy server URL" />
                </dd>
              </div>
              {settings?.publicBaseUrl && (
                <div>
                  <dt>Public base URL</dt>
                  <dd className="mono">{settings.publicBaseUrl}</dd>
                </div>
              )}
              <div>
                <dt>Upload limit</dt>
                <dd>{settings ? formatBytes(settings.maxUploadMb * 1024 * 1024) : <Skeleton width={60} />}</dd>
              </div>
              <div>
                <dt>Runtime</dt>
                <dd>Cloudflare Workers · D1 · R2</dd>
              </div>
              <div>
                <dt>Version</dt>
                <dd className="mono">{publicConfig?.version ?? "—"}</dd>
              </div>
            </dl>
          </section>
          <DeleteAccountSection onDeleted={onAccountDeleted} />
        </div>
      )}
    </>
  );
}

function DefaultsSection() {
  const toast = useToast();
  const { settings, setSettings, refreshSettings } = useApp();
  const [access, setAccess] = useState<AccessChoice>(settings?.defaultRepoAccess ?? "private");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (settings) setAccess(settings.defaultRepoAccess);
  }, [settings]);

  const dirty = settings != null && access !== settings.defaultRepoAccess;

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!settings || !dirty || access === "inherit") return;
    setBusy(true);
    try {
      await api.updateSettings({ defaultRepoAccess: access });
      setSettings({ ...settings, defaultRepoAccess: access });
      void refreshSettings();
      toast.success("Default access updated");
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card settings-section" aria-labelledby="defaults-title">
      <div className="settings-section-head">
        <h2 id="defaults-title" className="card-title">
          Default access
        </h2>
        <p className="card-text">
          Applied to repositories you create without an explicit access mode — including ones the CLI creates on first
          publish. Existing repositories keep their setting. Other accounts have their own default.
        </p>
      </div>
      {!settings ? (
        <Skeleton height={120} />
      ) : (
        <form onSubmit={save} className="stack-4">
          <AccessPicker label="New repositories default to" value={access} onChange={setAccess} compact />
          <div className="row-end">
            <Button type="submit" variant="primary" loading={busy} disabled={!dirty}>
              Save
            </Button>
          </div>
        </form>
      )}
    </section>
  );
}

function AppearanceSection() {
  const [pref, setPref] = useTheme();
  return (
    <section className="card settings-section" aria-labelledby="appearance-title">
      <div className="settings-section-head">
        <h2 id="appearance-title" className="card-title">
          Appearance
        </h2>
        <p className="card-text">Stored in this browser only.</p>
      </div>
      <Segmented<ThemePref>
        label="Theme"
        value={pref}
        onChange={setPref}
        options={[
          { value: "light", label: "Light", icon: <Sun size={14} aria-hidden /> },
          { value: "system", label: "System", icon: <Monitor size={14} aria-hidden /> },
          { value: "dark", label: "Dark", icon: <Moon size={14} aria-hidden /> },
        ]}
      />
    </section>
  );
}

function AccountSection() {
  const { user } = useApp();
  return (
    <section className="card settings-section" aria-labelledby="account-title">
      <div className="settings-section-head">
        <h2 id="account-title" className="card-title">
          Account
        </h2>
        <p className="card-text">
          Your repositories, documents, API keys and activity belong to this account and are invisible to other accounts.
        </p>
      </div>
      <dl className="info-list">
        <div>
          <dt>Email</dt>
          <dd>{user.email}</dd>
        </div>
        <div>
          <dt>Created</dt>
          <dd>
            <RelativeTime iso={user.createdAt} />
          </dd>
        </div>
      </dl>
    </section>
  );
}

function PasswordSection() {
  const toast = useToast();
  const { user, setUser } = useApp();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const nextErr =
    next.length < MIN_PASSWORD
      ? `Use at least ${MIN_PASSWORD} characters`
      : next.length > MAX_PASSWORD
        ? `At most ${MAX_PASSWORD} characters`
        : next === current
          ? "Choose a password different from the current one"
          : null;
  const confirmErr = confirm !== next ? "Passwords don't match" : null;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setAttempted(true);
    if (!current || nextErr || confirmErr || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.changePassword(current, next);
      setUser(res.user);
      setCurrent("");
      setNext("");
      setConfirm("");
      setAttempted(false);
      toast.success("Password changed", "Your other sessions were signed out.");
    } catch (err) {
      setError(err instanceof ApiError && err.status === 401 ? "The current password is incorrect." : errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card settings-section" aria-labelledby="password-title">
      <div className="settings-section-head">
        <h2 id="password-title" className="card-title">
          Password
        </h2>
        <p className="card-text">Changing your password signs out every other session of this account. API keys keep working.</p>
      </div>
      <form onSubmit={submit} className="stack-4 narrow-form" noValidate>
        <input type="email" name="email" value={user.email} autoComplete="username" readOnly hidden />
        <Field label="Current password" error={attempted && !current ? "Required" : null}>
          {({ id, describedBy, invalid }) => (
            <PasswordInput id={id} aria-describedby={describedBy} invalid={invalid} value={current} autoComplete="current-password" onChange={(e) => setCurrent(e.target.value)} />
          )}
        </Field>
        <Field label="New password" hint={`At least ${MIN_PASSWORD} characters. A passphrase works well.`} error={attempted ? nextErr : null}>
          {({ id, describedBy, invalid }) => (
            <PasswordInput id={id} aria-describedby={describedBy} invalid={invalid} value={next} autoComplete="new-password" onChange={(e) => setNext(e.target.value)} />
          )}
        </Field>
        <Field label="Confirm new password" error={attempted ? confirmErr : null}>
          {({ id, describedBy, invalid }) => (
            <PasswordInput id={id} aria-describedby={describedBy} invalid={invalid} value={confirm} autoComplete="new-password" onChange={(e) => setConfirm(e.target.value)} />
          )}
        </Field>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="row-end">
          <Button type="submit" variant="primary" loading={busy}>
            Change password
          </Button>
        </div>
      </form>
    </section>
  );
}

function SessionsSection() {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  return (
    <section className="card settings-section" aria-labelledby="sessions-title">
      <div className="settings-section-head">
        <h2 id="sessions-title" className="card-title">
          Sessions
        </h2>
        <p className="card-text">
          Sign out every other browser and CLI session of your account; this one stays signed in. API keys are not
          affected — revoke those on the API keys page.
        </p>
      </div>
      <div>
        <Button variant="secondary" icon={<LogOut size={15} aria-hidden />} onClick={() => setOpen(true)}>
          Sign out other sessions
        </Button>
      </div>
      <ConfirmDialog
        open={open}
        onClose={() => setOpen(false)}
        title="Sign out other sessions?"
        description="Every other session of your account ends immediately. This browser stays signed in."
        confirmLabel="Sign out others"
        tone="default"
        onConfirm={async () => {
          const { revoked } = await api.logoutOthers();
          toast.success(
            revoked === 0 ? "No other sessions" : `Signed out ${revoked} other ${revoked === 1 ? "session" : "sessions"}`,
          );
        }}
      />
    </section>
  );
}

function DeleteAccountSection({ onDeleted }: { onDeleted: () => void }) {
  const { user } = useApp();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setTyped("");
    setPassword("");
    setError(null);
    setBusy(false);
  }, [open]);

  const ready = typed.trim().toLowerCase() === user.email && password.length > 0;

  async function submit(e?: FormEvent) {
    e?.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.deleteAccount(password);
      setOpen(false);
      onDeleted();
    } catch (err) {
      setError(err instanceof ApiError && err.status === 401 ? "The password is incorrect." : errorMessage(err));
      setPassword("");
      setBusy(false);
    }
  }

  return (
    <section className="card settings-section" aria-labelledby="delete-title">
      <div className="settings-section-head">
        <h2 id="delete-title" className="card-title">
          Delete account
        </h2>
        <p className="card-text">
          Permanently deletes your account with all of its repositories, documents and stored files, API keys, machines and
          activity. Published links stop working. This cannot be undone.
        </p>
      </div>
      <div>
        <Button variant="danger" icon={<Trash2 size={15} aria-hidden />} onClick={() => setOpen(true)}>
          Delete account
        </Button>
      </div>
      <Dialog
        open={open}
        onClose={() => !busy && setOpen(false)}
        dismissible={!busy}
        size="sm"
        tone="danger"
        icon={<Trash2 size={18} aria-hidden />}
        title="Delete your account?"
        description="Everything you published is removed immediately, including every stored version."
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
              Cancel
            </Button>
            <Button variant="danger" type="submit" form="delete-account-form" loading={busy} disabled={!ready}>
              Delete account
            </Button>
          </>
        }
      >
        <form id="delete-account-form" onSubmit={submit} className="stack-3" noValidate>
          <input type="email" name="email" value={user.email} autoComplete="username" readOnly hidden />
          <Field label={<>Type <code className="kbd-inline">{user.email}</code> to confirm</>}>
            {({ id, describedBy }) => (
              <input
                id={id}
                className="input"
                aria-describedby={describedBy}
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                autoComplete="off"
                spellCheck={false}
                autoCapitalize="off"
                data-autofocus
              />
            )}
          </Field>
          <Field label="Password">
            {({ id, describedBy }) => (
              <PasswordInput
                id={id}
                aria-describedby={describedBy}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
              />
            )}
          </Field>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
        </form>
      </Dialog>
    </section>
  );
}
