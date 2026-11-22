import { type FormEvent, useEffect, useRef, useState } from "react";
import { AlertTriangle, ArrowRight, Clock, Info, KeyRound } from "lucide-react";
import { ApiError, api, errorMessage } from "../api";
import { Logo } from "../components/Layout";
import { Button, Field, Input, PasswordInput, Segmented } from "../components/ui";
import { formatCountdown, useCountdown } from "../lib/countdown";
import { safeNext, useSearchParam } from "../lib/router";
import { useDocumentTitle } from "../lib/useDocumentTitle";
import type { AuthConfig, User } from "../types";

type Mode = "signin" | "register";

type FormError =
  | { kind: "invalid"; message: string }
  | { kind: "rate_limited"; message: string }
  | { kind: "other"; message: string };

/** Used when a 429 arrives without Retry-After (the server's window is 15 minutes). */
const DEFAULT_LOCKOUT_SECONDS = 15 * 60;
const MAX_PASSWORD_LENGTH = 1024;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function LoginPage({ onSignedIn }: { onSignedIn: (user: User, next: string | null) => void }) {
  const next = safeNext(useSearchParam("next"));
  const expired = useSearchParam("reason") === "expired";
  const [config, setConfig] = useState<AuthConfig | null>(null);
  const [mode, setMode] = useState<Mode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [claim, setClaim] = useState("");
  const [attempted, setAttempted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<FormError | null>(null);
  const [lockedUntil, setLockedUntil] = useState<number | null>(null);
  const [lockMinutes, setLockMinutes] = useState(0);
  const remaining = useCountdown(lockedUntil);
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const signedInRef = useRef(onSignedIn);
  signedInRef.current = onSignedIn;

  const registering = mode === "register";
  // No account exists yet and this visitor is creating the owner account.
  const firstAccount = registering && config?.claimRequired === true;
  useDocumentTitle(registering ? "Create account" : "Sign in");

  useEffect(() => {
    const controller = new AbortController();
    api
      .authConfig()
      .then((c) => {
        if (controller.signal.aborted) return;
        setConfig(c);
        // A fresh deployment: the first visitor is here to create the owner account.
        if (c.registration && (c.firstAccount || c.claimRequired)) setMode("register");
      })
      .catch(() => undefined);
    // Already signed in (e.g. a bookmarked /dashboard/login): skip the form.
    api
      .me(controller.signal)
      .then((me) => !controller.signal.aborted && signedInRef.current(me.user, next))
      .catch(() => undefined);
    return () => controller.abort();
    // `next` is read once on mount, like the form does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // When the lockout runs out, clear it and put the cursor back in the form.
  useEffect(() => {
    if (lockedUntil !== null && remaining === 0) {
      setLockedUntil(null);
      setError(null);
      requestAnimationFrame(() => passwordRef.current?.focus());
    }
  }, [lockedUntil, remaining]);

  const locked = lockedUntil !== null && remaining > 0;
  const minLength = config?.minPasswordLength ?? 12;
  const trimmedEmail = email.trim();
  const emailErr = !trimmedEmail ? "Required" : !EMAIL_RE.test(trimmedEmail) ? "Enter a valid email address" : null;
  const passwordErr = !password
    ? "Required"
    : registering && password.length < minLength
      ? `Use at least ${minLength} characters`
      : password.length > MAX_PASSWORD_LENGTH
        ? `At most ${MAX_PASSWORD_LENGTH} characters`
        : null;
  const confirmErr = registering && confirm !== password ? "Passwords don't match" : null;
  const claimErr = firstAccount && !claim ? "Required to create the first account" : null;

  function switchMode(value: Mode) {
    setMode(value);
    setError(null);
    setAttempted(false);
    setConfirm("");
    requestAnimationFrame(() => emailRef.current?.focus());
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setAttempted(true);
    if (busy || locked || emailErr || passwordErr || confirmErr || claimErr) return;
    setBusy(true);
    setError(null);
    try {
      const user = registering
        ? await api.register(trimmedEmail, password, firstAccount ? claim : undefined)
        : await api.login(trimmedEmail, password);
      onSignedIn(user, next);
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.status === 429) {
          const seconds = err.retryAfter ?? DEFAULT_LOCKOUT_SECONDS;
          setLockedUntil(Date.now() + seconds * 1000);
          setLockMinutes(Math.max(1, Math.ceil(seconds / 60)));
          setError({ kind: "rate_limited", message: err.message });
        } else if (!registering && err.status === 401) {
          setError({ kind: "invalid", message: "That email and password don't match." });
          // Only a wrong password is cleared; anything else keeps what was typed.
          setPassword("");
        } else if (err.code === "claim_required") {
          setError({ kind: "invalid", message: err.message });
          setClaim("");
        } else if (err.code === "registration_closed") {
          setError({ kind: "other", message: err.message });
          setConfig((c) => (c ? { ...c, registration: false, claimRequired: false, firstAccount: false } : c));
          setMode("signin");
        } else if (err.status === 409) {
          setError({ kind: "other", message: "An account with this email already exists. Sign in instead." });
        } else setError({ kind: "other", message: errorMessage(err) });
      } else {
        setError({ kind: "other", message: errorMessage(err) });
      }
      requestAnimationFrame(() => passwordRef.current?.focus());
    } finally {
      setBusy(false);
    }
  }

  const canRegister = config?.registration === true;
  const subtitle = firstAccount
    ? "Create the owner account for this deployment."
    : registering
      ? "Create your account."
      : next?.startsWith("/r/")
        ? "Sign in to view this private document."
        : "Manage your published reports.";

  return (
    <main className="auth-page">
      <div className="auth-card">
        <div className="auth-brand">
          <Logo size={36} />
          <div>
            <h1 className="auth-title">{registering ? "Create your MaraDocs account" : "Sign in to MaraDocs"}</h1>
            <p className="auth-subtitle">{subtitle}</p>
          </div>
        </div>

        <form onSubmit={submit} className="stack-4" noValidate>
          {canRegister && !firstAccount && (
            <Segmented<Mode>
              label="Sign in or create an account"
              value={mode}
              onChange={switchMode}
              options={[
                { value: "signin", label: "Sign in" },
                { value: "register", label: "Create account" },
              ]}
            />
          )}
          {expired && !error && !registering && (
            <div className="callout" role="status">
              <Info size={16} aria-hidden />
              <div>Your session expired. Sign in again to continue where you left off.</div>
            </div>
          )}
          {firstAccount && (
            <div className="callout" role="status">
              <KeyRound size={16} aria-hidden />
              <div>
                No account exists yet. The first account owns this deployment and adopts everything already in it. To
                prove you run it, enter the <strong>claim password</strong>: the <code>ADMIN_PASSWORD</code> secret of
                this Worker (or the admin password you used before accounts existed).
              </div>
            </div>
          )}
          <Field label="Email" error={attempted ? emailErr : null}>
            {({ id, describedBy, invalid }) => (
              <Input
                id={id}
                ref={emailRef}
                type="email"
                aria-describedby={describedBy}
                invalid={invalid}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete={registering ? "email" : "username"}
                autoFocus
                spellCheck={false}
                autoCapitalize="off"
              />
            )}
          </Field>
          <Field
            label="Password"
            hint={registering ? `At least ${minLength} characters. A passphrase works well.` : undefined}
            error={attempted ? passwordErr : null}
          >
            {({ id, describedBy, invalid }) => (
              <PasswordInput
                id={id}
                ref={passwordRef}
                aria-describedby={describedBy}
                invalid={invalid || error?.kind === "invalid"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete={registering ? "new-password" : "current-password"}
              />
            )}
          </Field>
          {registering && (
            <Field label="Confirm password" error={attempted ? confirmErr : null}>
              {({ id, describedBy, invalid }) => (
                <PasswordInput
                  id={id}
                  aria-describedby={describedBy}
                  invalid={invalid}
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  autoComplete="new-password"
                />
              )}
            </Field>
          )}
          {firstAccount && (
            <Field label="Claim password" error={attempted ? claimErr : null}>
              {({ id, describedBy, invalid }) => (
                <PasswordInput
                  id={id}
                  aria-describedby={describedBy}
                  invalid={invalid}
                  value={claim}
                  onChange={(e) => setClaim(e.target.value)}
                  autoComplete="off"
                />
              )}
            </Field>
          )}
          {error && (
            <div id="login-error" className={`callout callout-${error.kind === "rate_limited" ? "warning" : "danger"}`} role="alert">
              {error.kind === "rate_limited" ? <Clock size={16} aria-hidden /> : <AlertTriangle size={16} aria-hidden />}
              <div>
                {error.kind === "rate_limited" ? (
                  <>
                    <strong>Too many attempts.</strong> For your security, this is paused for your network.{" "}
                    {locked ? (
                      <>
                        Try again in{" "}
                        <span className="mono tabular" aria-hidden>
                          {formatCountdown(remaining)}
                        </span>
                        {/* Static for screen readers: a ticking value in an alert would be re-read. */}
                        <span className="sr-only">about {lockMinutes} {lockMinutes === 1 ? "minute" : "minutes"}</span>.
                      </>
                    ) : (
                      "You can try again now."
                    )}
                  </>
                ) : (
                  error.message
                )}
              </div>
            </div>
          )}
          <Button
            type="submit"
            variant="primary"
            block
            loading={busy}
            disabled={locked}
            iconRight={!busy && !locked ? <ArrowRight size={15} aria-hidden /> : undefined}
          >
            {locked ? `Try again in ${formatCountdown(remaining)}` : registering ? "Create account" : "Sign in"}
          </Button>
          <p className="auth-footnote">
            {config && !config.registration && !registering ? (
              <>New accounts can't be created on this deployment; ask its operator if you need one. </>
            ) : null}
            MaraDocs only asks for your password on this page (<code>/dashboard/login</code>), never inside a report
            (<code>/r/…</code>).
          </p>
        </form>
      </div>
    </main>
  );
}
