import { useState } from "react";
import { Dashboard } from "./Dashboard";

function LoginForm({ onLogin }: { onLogin: () => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/v1/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (!res.ok) {
        const data = (await res.json()) as { message?: string };
        setError(data.message ?? "Login failed");
        return;
      }
      const { token } = (await res.json()) as { token: string };
      localStorage.setItem("maradocs_token", token);
      onLogin();
    } catch {
      setError("Network error");
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
        <form
          onSubmit={handleSubmit}
          style={{ display: "flex", flexDirection: "column", gap: 12, marginTop: 16 }}
        >
          <label className="sr-only" htmlFor="admin-password">
            Admin password
          </label>
          <input
            id="admin-password"
            type="password"
            placeholder="Admin password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="form-input"
            autoFocus
            autoComplete="current-password"
          />
          {error && (
            <div style={{ color: "var(--danger, #f87171)", fontSize: 13 }}>{error}</div>
          )}
          <button type="submit" className="btn primary" disabled={loading}>
            {loading ? "Signing in..." : "Sign in"}
          </button>
        </form>
      </div>
    </div>
  );
}

function LogoutButton({ onLogout }: { onLogout: () => void }) {
  async function handleLogout() {
    const token = localStorage.getItem("maradocs_token");
    if (token) {
      await fetch("/api/v1/auth/logout", {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      }).catch(() => {});
    }
    localStorage.removeItem("maradocs_token");
    onLogout();
  }

  return (
    <button onClick={handleLogout} className="btn ghost" style={{ fontSize: 13 }}>
      Sign out
    </button>
  );
}

export function App() {
  const [signedIn, setSignedIn] = useState(
    () => localStorage.getItem("maradocs_token") !== null,
  );

  if (!signedIn) {
    return <LoginForm onLogin={() => setSignedIn(true)} />;
  }

  function handleSessionExpired() {
    localStorage.removeItem("maradocs_token");
    setSignedIn(false);
  }

  return (
    <Dashboard
      getToken={() => Promise.resolve(localStorage.getItem("maradocs_token"))}
      account={<LogoutButton onLogout={() => setSignedIn(false)} />}
      onSessionExpired={handleSessionExpired}
    />
  );
}
