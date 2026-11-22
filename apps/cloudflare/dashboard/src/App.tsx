import { useCallback, useEffect, useRef, useState } from "react";
import { RotateCw, WifiOff } from "lucide-react";
import { ApiError, api, errorMessage, setReauthHandler, setUnauthorizedHandler } from "./api";
import { Layout, Logo } from "./components/Layout";
import { ReauthDialog } from "./components/ReauthDialog";
import { Button, PageSpinner, ToastProvider, useToast } from "./components/ui";
import { AppProvider } from "./lib/app";
import { followNext, loginPath, matchPath, navigate, useLocation } from "./lib/router";
import { ActivityPage } from "./pages/Activity";
import { ConnectPage } from "./pages/Connect";
import { DocDetailPage } from "./pages/DocDetail";
import { KeysPage } from "./pages/Keys";
import { LoginPage } from "./pages/Login";
import { NotFoundPage } from "./pages/NotFound";
import { OverviewPage } from "./pages/Overview";
import { RepoDetailPage } from "./pages/RepoDetail";
import { ReposPage } from "./pages/Repos";
import { SettingsPage } from "./pages/Settings";
import type { User } from "./types";

type AuthState =
  | { kind: "checking" }
  | { kind: "in"; user: User }
  | { kind: "out" }
  | { kind: "error"; error: unknown };

export function App() {
  return (
    <ToastProvider>
      <Root />
    </ToastProvider>
  );
}

function Root() {
  const { pathname } = useLocation();
  const onLogin = pathname === "/login" || pathname === "/login/";
  const [auth, setAuth] = useState<AuthState>({ kind: "checking" });
  const toast = useToast();
  const authRef = useRef(auth);
  authRef.current = auth;

  // The last signed-in account, for the re-auth prompt after the session expires.
  const lastUser = useRef<User | null>(null);
  if (auth.kind === "in") lastUser.current = auth.user;

  // A 401 while signed in first asks for the password in place (ReauthDialog);
  // the failed request is retried, so forms and uploads survive. Only if the
  // user declines do we go to the login page, saying why and where we were.
  const [reauth, setReauth] = useState<{ resolve: (ok: boolean) => void } | null>(null);
  useEffect(() => {
    setReauthHandler(() => {
      if (authRef.current.kind !== "in") return Promise.resolve(false);
      return new Promise<boolean>((resolve) => setReauth({ resolve }));
    });
    setUnauthorizedHandler(() => {
      const wasSignedIn = authRef.current.kind === "in";
      setAuth({ kind: "out" });
      const path = window.location.pathname;
      if (!/\/login\/?$/.test(path)) navigate(loginPath(undefined, wasSignedIn ? "expired" : undefined), { replace: true });
    });
    return () => {
      setReauthHandler(null);
      setUnauthorizedHandler(null);
    };
  }, []);

  const reauthDialog = (
    <ReauthDialog
      open={reauth !== null}
      email={lastUser.current?.email ?? ""}
      onDone={(ok) => {
        reauth?.resolve(ok);
        setReauth(null);
      }}
    />
  );

  const check = useCallback(async (signal?: AbortSignal) => {
    setAuth({ kind: "checking" });
    try {
      const me = await api.me(signal);
      setAuth({ kind: "in", user: me.user });
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      if (err instanceof ApiError && err.status === 401) setAuth({ kind: "out" });
      else setAuth({ kind: "error", error: err });
    }
  }, []);

  useEffect(() => {
    if (onLogin || auth.kind !== "checking") return;
    const controller = new AbortController();
    void check(controller.signal);
    return () => controller.abort();
    // Only on first load (or after returning from the login page).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onLogin]);

  const signOut = useCallback(async () => {
    try {
      await api.logout();
    } catch (err) {
      // An already-expired session is already signed out: that's the goal state.
      if (!(err instanceof ApiError && err.status === 401)) toast.error(err);
    }
    setAuth({ kind: "out" });
    navigate("/login", { replace: true });
  }, [toast]);

  if (onLogin) {
    return (
      <LoginPage
        onSignedIn={(user, next) => {
          setAuth({ kind: "in", user });
          followNext(next);
        }}
      />
    );
  }

  if (auth.kind === "out") {
    return <RedirectToLogin />;
  }

  if (auth.kind === "checking") {
    return (
      <main className="boot" aria-busy="true" aria-label="Loading MaraDocs">
        <Logo size={32} />
        <PageSpinner />
      </main>
    );
  }

  if (auth.kind === "error") {
    return (
      <main className="auth-page">
        <div className="auth-card stack-4">
          <div className="auth-brand">
            <WifiOff size={22} aria-hidden />
            <div>
              <h1 className="auth-title">Can't reach MaraDocs</h1>
              <p className="auth-subtitle">{errorMessage(auth.error)}</p>
            </div>
          </div>
          <Button variant="primary" icon={<RotateCw size={15} aria-hidden />} onClick={() => void check()} block>
            Try again
          </Button>
        </div>
      </main>
    );
  }

  return (
    <AppProvider user={auth.user} onUserChange={(user) => setAuth({ kind: "in", user })}>
      {reauthDialog}
      <Layout onSignOut={signOut}>
        <Routes
          pathname={pathname}
          onAccountDeleted={() => {
            setAuth({ kind: "out" });
            navigate("/login", { replace: true });
          }}
        />
      </Layout>
    </AppProvider>
  );
}

/** Initial session check came back 401: go to /login?next=<here>. */
function RedirectToLogin() {
  useEffect(() => {
    navigate(loginPath(), { replace: true });
  }, []);
  return <PageSpinner />;
}

function Routes({ pathname, onAccountDeleted }: { pathname: string; onAccountDeleted: () => void }) {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  if (path === "/") return <OverviewPage />;
  if (path === "/repos") return <ReposPage />;
  if (path === "/keys") return <KeysPage />;
  if (path === "/connect") return <ConnectPage />;
  if (path === "/activity") return <ActivityPage />;
  if (path === "/settings") return <SettingsPage onAccountDeleted={onAccountDeleted} />;
  const doc = matchPath("/repos/:repo/:doc", path);
  if (doc) return <DocDetailPage key={`${doc.repo}/${doc.doc}`} repoSlug={doc.repo!} docSlug={doc.doc!} />;
  const repo = matchPath("/repos/:repo", path);
  if (repo) return <RepoDetailPage key={repo.repo} repoSlug={repo.repo!} />;
  return <NotFoundPage />;
}
