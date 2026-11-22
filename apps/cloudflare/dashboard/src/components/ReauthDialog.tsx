import { type FormEvent, useEffect, useRef, useState } from "react";
import { LockKeyhole } from "lucide-react";
import { ApiError, api, errorMessage } from "../api";
import { formatCountdown, useCountdown } from "../lib/countdown";
import { Button, Dialog, Input, PasswordInput } from "./ui";

/**
 * Shown when the session expires while the dashboard is open. Signing in here
 * sets a fresh session cookie and the request that failed is retried, so open
 * drawers, half-filled forms and uploads keep their state. It asks for the
 * password of the account that was signed in.
 */
export function ReauthDialog({
  open,
  email: knownEmail,
  onDone,
}: {
  open: boolean;
  /** The account that was signed in ("" if unknown: then the email is asked too). */
  email: string;
  onDone: (signedIn: boolean) => void;
}) {
  const [email, setEmail] = useState(knownEmail);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lockedUntil, setLockedUntil] = useState<number | null>(null);
  const remaining = useCountdown(lockedUntil);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setEmail(knownEmail);
    setPassword("");
    setError(null);
    setBusy(false);
  }, [open, knownEmail]);

  useEffect(() => {
    if (lockedUntil !== null && remaining === 0) {
      setLockedUntil(null);
      setError(null);
    }
  }, [lockedUntil, remaining]);

  const locked = lockedUntil !== null && remaining > 0;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!email || !password || busy || locked) return;
    setBusy(true);
    setError(null);
    try {
      await api.login(email, password);
      onDone(true);
    } catch (err) {
      if (err instanceof ApiError && (err.status === 401 || err.status === 400)) {
        setError(knownEmail ? "That password isn't right." : "That email and password don't match.");
        setPassword("");
      } else if (err instanceof ApiError && err.status === 429) {
        setLockedUntil(Date.now() + (err.retryAfter ?? 15 * 60) * 1000);
        setError("Too many attempts from this network.");
      } else {
        setError(errorMessage(err));
      }
      requestAnimationFrame(() => inputRef.current?.focus());
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={() => onDone(false)}
      dismissible={!busy}
      size="sm"
      icon={<LockKeyhole size={18} aria-hidden />}
      title="Your session expired"
      description={
        knownEmail ? (
          <>
            Sign in again as <strong>{knownEmail}</strong> to continue. Nothing you were working on is lost.
          </>
        ) : (
          "Sign in again to continue. Nothing you were working on is lost."
        )
      }
      initialFocus={inputRef}
      footer={
        <>
          <Button variant="ghost" onClick={() => onDone(false)} disabled={busy}>
            Go to sign-in page
          </Button>
          <Button variant="primary" type="submit" form="reauth-form" loading={busy} disabled={!email || !password || locked}>
            Sign in
          </Button>
        </>
      }
    >
      <form id="reauth-form" onSubmit={submit} className="stack-3" noValidate>
        {knownEmail ? (
          // For password managers: which account this password belongs to.
          <input type="email" name="email" value={knownEmail} autoComplete="username" readOnly hidden />
        ) : (
          <div className="field">
            <label htmlFor="reauth-email" className="field-label">
              Email
            </label>
            <Input
              id="reauth-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="username"
              spellCheck={false}
              autoCapitalize="off"
            />
          </div>
        )}
        <div className="field">
          <label htmlFor="reauth-password" className="field-label">
            Password
          </label>
          <PasswordInput
            id="reauth-password"
            ref={inputRef}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            invalid={Boolean(error) && !locked}
            aria-describedby={error ? "reauth-error" : undefined}
          />
        </div>
        {error && (
          <p id="reauth-error" className="form-error" role="alert">
            {error}
            {locked && ` Try again in ${formatCountdown(remaining)}.`}
          </p>
        )}
      </form>
    </Dialog>
  );
}
