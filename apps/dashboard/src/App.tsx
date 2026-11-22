import { useCallback, useEffect, useState } from "react";
import { Dashboard } from "./Dashboard";
import { ApiError, authApi, type AuthConfig, type User } from "./api";
import { Spinner } from "./components/ui";

type Mode = "signin" | "register";

function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  return "Network error";
}

function AuthScreen({ config, onSignedIn }: { config: AuthConfig; onSignedIn: (u: User) => void }) {
  // The claim password is only needed for the very first account, so a server
  // that asks for it has no accounts yet: start on "create account".
  const [mode, setMode] = useState<Mode>(
    config.registration && (config.claimRequired || config.firstAccount) ? "register" : "signin",
  );
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [claimPassword, setClaimPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const registering = mode === "register";

  function switchMode(next: Mode) {
    setMode(next);
    setError(null);
    setPassword("");
    setConfirm("");
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (registering) {
      if (password.length < config.minPasswordLength) {
        setError(`Password must be at least ${config.minPasswordLength} characters`);
        return;
      }
      if (password !== confirm) {
        setError("Passwords don't match");
        return;
      }
    }
    setLoading(true);
    try {
      const user = registering
        ? await authApi.register(email, password, config.claimRequired ? claimPassword : undefined)
        : await authApi.login(email, password);
      onSignedIn(user);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="signin-screen">
      <div className="signin-card">
        <div className="brand">
          <div className="logo">M</div>
          <div style={{ textAlign: "left" }}>
            <b>MaraDocs</b>
            <small>Publisher dashboard</small>
          </div>
        </div>
        <h1 className="auth-title">{registering ? "Create your account" : "Sign in"}</h1>
        <p className="auth-sub">
          {registering
            ? config.claimRequired
              ? "This server already has data. Enter its claim password (the old ADMIN_PASSWORD) to become its owner."
              : "Your repositories, documents and API keys are private to your account."
            : "Use the email and password of your MaraDocs account."}
        </p>
        <form onSubmit={handleSubmit} className="auth-form">
          <label className="sr-only" htmlFor="auth-email">Email</label>
          <input
            id="auth-email"
            type="email"
            placeholder="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="form-input"
            autoFocus
            required
            autoComplete="email"
          />
          <label className="sr-only" htmlFor="auth-password">Password</label>
          <input
            id="auth-password"
            type="password"
            placeholder={registering ? `Password (min ${config.minPasswordLength} characters)` : "Password"}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="form-input"
            required
            autoComplete={registering ? "new-password" : "current-password"}
          />
          {registering && (
            <>
              <label className="sr-only" htmlFor="auth-confirm">Confirm password</label>
              <input
                id="auth-confirm"
                type="password"
                placeholder="Confirm password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                className="form-input"
                required
                autoComplete="new-password"
              />
            </>
          )}
          {registering && config.claimRequired && (
            <>
              <label className="sr-only" htmlFor="auth-claim">Claim password</label>
              <input
                id="auth-claim"
                type="password"
                placeholder="Claim password"
                value={claimPassword}
                onChange={(e) => setClaimPassword(e.target.value)}
                className="form-input"
                required
                autoComplete="off"
              />
            </>
          )}
          {error && <div className="auth-error" role="alert">{error}</div>}
          <button type="submit" className="btn primary auth-submit" disabled={loading}>
            {loading
              ? registering ? "Creating account..." : "Signing in..."
              : registering ? "Create account" : "Sign in"}
          </button>
        </form>
        <div className="auth-switch">
          {registering ? (
            <>
              Already have an account?{" "}
              <button type="button" onClick={() => switchMode("signin")}>Sign in</button>
            </>
          ) : config.registration ? (
            <>
              No account yet?{" "}
              <button type="button" onClick={() => switchMode("register")}>Create one</button>
            </>
          ) : (
            <>Registration is closed on this server.</>
          )}
        </div>
      </div>
    </div>
  );
}

type State =
  | { kind: "loading" }
  | { kind: "signedOut"; config: AuthConfig }
  | { kind: "signedIn"; user: User }
  | { kind: "error"; message: string };

export function App() {
  const [state, setState] = useState<State>({ kind: "loading" });

  const showSignIn = useCallback(async () => {
    try {
      setState({ kind: "signedOut", config: await authApi.config() });
    } catch (err) {
      setState({ kind: "error", message: errorMessage(err) });
    }
  }, []);

  useEffect(() => {
    authApi
      .me()
      .then((user) => setState({ kind: "signedIn", user }))
      .catch(() => void showSignIn());
  }, [showSignIn]);

  const handleSignOut = useCallback(async () => {
    await authApi.logout().catch(() => {});
    await showSignIn();
  }, [showSignIn]);

  const handleSessionExpired = useCallback(() => {
    void showSignIn();
  }, [showSignIn]);

  if (state.kind === "loading") return <div className="signin-screen"><Spinner /></div>;
  if (state.kind === "error") {
    return (
      <div className="signin-screen">
        <div className="signin-card">
          <p className="auth-error">Could not reach the server: {state.message}</p>
          <button className="btn" onClick={() => window.location.reload()}>Retry</button>
        </div>
      </div>
    );
  }
  if (state.kind === "signedOut") {
    return (
      <AuthScreen
        config={state.config}
        onSignedIn={(user) => setState({ kind: "signedIn", user })}
      />
    );
  }
  return (
    <Dashboard
      user={state.user}
      onUserChange={(user) => setState({ kind: "signedIn", user })}
      onSignOut={handleSignOut}
      onSessionExpired={handleSessionExpired}
    />
  );
}
