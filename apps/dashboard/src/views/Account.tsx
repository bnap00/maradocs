import { useState } from "react";
import { KeyRound, LogOut, Trash2 } from "lucide-react";
import type { Api, User } from "../api";
import { Modal } from "../components/ui";

const MIN_PASSWORD_LENGTH = 12;

export function Account({
  api,
  user,
  toast,
  onUserChange,
  onAccountDeleted,
}: {
  api: Api;
  user: User;
  toast: (m: string, e?: boolean) => void;
  onUserChange: (user: User) => void;
  onAccountDeleted: () => void;
}) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [pwError, setPwError] = useState<string | null>(null);
  const [savingPw, setSavingPw] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const [deleting, setDeleting] = useState(false);

  async function handleChangePassword(e: React.FormEvent) {
    e.preventDefault();
    setPwError(null);
    if (next.length < MIN_PASSWORD_LENGTH) {
      setPwError(`New password must be at least ${MIN_PASSWORD_LENGTH} characters`);
      return;
    }
    if (next !== confirm) {
      setPwError("New passwords don't match");
      return;
    }
    setSavingPw(true);
    try {
      const res = await api.changePassword(current, next);
      onUserChange(res.user);
      setCurrent("");
      setNext("");
      setConfirm("");
      toast("Password changed. Other sessions were signed out.");
    } catch (err) {
      setPwError((err as Error).message);
    } finally {
      setSavingPw(false);
    }
  }

  async function handleLogoutOthers() {
    setRevoking(true);
    try {
      const { revoked } = await api.logoutOthers();
      toast(revoked === 1 ? "Signed out 1 other session" : `Signed out ${revoked} other sessions`);
    } catch (err) {
      toast((err as Error).message, true);
    } finally {
      setRevoking(false);
    }
  }

  return (
    <>
      <div className="topbar">
        <div>
          <h1>Account</h1>
          <p>
            Signed in as <b>{user.email}</b> · member since {new Date(user.createdAt).toLocaleDateString()}
          </p>
        </div>
      </div>

      <div className="card settings-card">
        <div className="settings-head">
          <KeyRound size={18} color="var(--accent)" />
          <div>
            <h2>Change password</h2>
            <p>Changing your password signs out every other session.</p>
          </div>
        </div>
        <form onSubmit={handleChangePassword} className="settings-body">
          <div className="field">
            <label htmlFor="pw-current">Current password</label>
            <input
              id="pw-current"
              type="password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
              autoComplete="current-password"
              required
            />
          </div>
          <div className="field">
            <label htmlFor="pw-new">New password</label>
            <input
              id="pw-new"
              type="password"
              value={next}
              onChange={(e) => setNext(e.target.value)}
              autoComplete="new-password"
              placeholder={`At least ${MIN_PASSWORD_LENGTH} characters`}
              required
            />
          </div>
          <div className="field">
            <label htmlFor="pw-confirm">Confirm new password</label>
            <input
              id="pw-confirm"
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              autoComplete="new-password"
              required
            />
          </div>
          {pwError && <div className="auth-error" role="alert">{pwError}</div>}
          <button type="submit" className="btn primary" disabled={savingPw}>
            {savingPw ? "Saving..." : "Change password"}
          </button>
        </form>
      </div>

      <div className="card settings-card">
        <div className="settings-head">
          <LogOut size={18} color="var(--accent)" />
          <div className="grow">
            <h2>Sessions</h2>
            <p>Sign out of MaraDocs on every other browser and device. This one stays signed in.</p>
          </div>
          <button className="btn" onClick={handleLogoutOthers} disabled={revoking}>
            {revoking ? "Signing out..." : "Sign out other sessions"}
          </button>
        </div>
      </div>

      <div className="card settings-card danger-zone">
        <div className="settings-head">
          <Trash2 size={18} color="var(--red)" />
          <div className="grow">
            <h2>Delete account</h2>
            <p>
              Permanently deletes your account, repositories, documents, versions, API keys and audit
              log. Published links stop working. This cannot be undone.
            </p>
          </div>
          <button className="btn danger" onClick={() => setDeleting(true)}>
            Delete account
          </button>
        </div>
      </div>

      {deleting && (
        <DeleteAccountModal
          api={api}
          email={user.email}
          onClose={() => setDeleting(false)}
          onDeleted={onAccountDeleted}
        />
      )}
    </>
  );
}

function DeleteAccountModal({
  api,
  email,
  onClose,
  onDeleted,
}: {
  api: Api;
  email: string;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const [typed, setTyped] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const confirmed = typed.trim().toLowerCase() === email;

  async function handleDelete(e: React.FormEvent) {
    e.preventDefault();
    if (!confirmed) return;
    setBusy(true);
    setError(null);
    try {
      await api.deleteAccount(password);
      onDeleted();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Delete your account?"
      hint="Everything you own on this server is deleted immediately and cannot be recovered."
      onClose={onClose}
    >
      <form onSubmit={handleDelete}>
        <div className="field">
          <label htmlFor="del-email">
            Type <span className="mono">{email}</span> to confirm
          </label>
          <input
            id="del-email"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            autoComplete="off"
          />
        </div>
        <div className="field">
          <label htmlFor="del-password">Password</label>
          <input
            id="del-password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
        </div>
        {error && <div className="auth-error" role="alert">{error}</div>}
        <div className="modal-actions">
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn danger" disabled={!confirmed || !password || busy}>
            <Trash2 size={14} /> {busy ? "Deleting..." : "Delete account"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
