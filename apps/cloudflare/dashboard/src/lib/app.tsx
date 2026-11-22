// App-wide state: the signed-in account, deployment settings (server URL,
// upload limit…) and the public config. Loaded once after sign-in and shared
// by every page.
import { type ReactNode, createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { api } from "../api";
import type { PublicConfig, Settings, User } from "../types";

interface AppState {
  /** The signed-in account. */
  user: User;
  setUser: (user: User) => void;
  settings: Settings | null;
  settingsError: unknown;
  publicConfig: PublicConfig | null;
  /** Origin CLI/agents should use: configured public base URL, else this page's origin. */
  serverUrl: string;
  maxUploadBytes: number | null;
  refreshSettings: () => Promise<void>;
  setSettings: (s: Settings) => void;
}

const Ctx = createContext<AppState | null>(null);

export function useApp(): AppState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useApp must be used inside <AppProvider>");
  return ctx;
}

function trimSlash(u: string): string {
  return u.replace(/\/+$/, "");
}

export function AppProvider({
  children,
  user,
  onUserChange,
}: {
  children: ReactNode;
  user: User;
  onUserChange: (user: User) => void;
}) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [settingsError, setSettingsError] = useState<unknown>(null);
  const [publicConfig, setPublicConfig] = useState<PublicConfig | null>(null);

  const refreshSettings = useCallback(async () => {
    try {
      setSettings(await api.settings());
      setSettingsError(null);
    } catch (err) {
      // Pages that need settings show the error; the shell stays usable.
      setSettingsError(err);
    }
  }, []);

  useEffect(() => {
    void refreshSettings();
    api.publicConfig().then(setPublicConfig).catch(() => undefined);
  }, [refreshSettings]);

  const value = useMemo<AppState>(() => {
    const configured = settings?.publicBaseUrl || settings?.serverUrl;
    return {
      user,
      setUser: onUserChange,
      settings,
      settingsError,
      publicConfig,
      serverUrl: trimSlash(configured || window.location.origin),
      maxUploadBytes: settings ? settings.maxUploadMb * 1024 * 1024 : null,
      refreshSettings,
      setSettings,
    };
  }, [user, onUserChange, settings, settingsError, publicConfig, refreshSettings]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
