import { ACCESS_MODES, DEFAULTS, type AccessMode } from "@maradocs/shared";
import path from "node:path";

function accessEnv(value: string | undefined, fallback: AccessMode): AccessMode {
  if (value && (ACCESS_MODES as readonly string[]).includes(value)) {
    return value as AccessMode;
  }
  return fallback;
}

function resolveDataDir(env: NodeJS.ProcessEnv): string {
  const configured = env.DATA_DIR ?? DEFAULTS.DATA_DIR;
  if (path.isAbsolute(configured)) return configured;
  return path.resolve(env.INIT_CWD ?? process.cwd(), configured);
}

export interface ServerConfig {
  port: number;
  host: string;
  dataDir: string;
  dbPath: string;
  repositoriesDir: string;
  publicBaseUrl: string | null;
  defaultRepoAccess: AccessMode;
  maxUploadBytes: number;
  cookieSecret: string;
  adminPassword: string;
  bcryptRounds: number;
  dashboardDevServerUrl: string | null;
  isProduction: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const isProduction = env.NODE_ENV === "production";
  const dataDir = resolveDataDir(env);
  const adminPassword = env.ADMIN_PASSWORD ?? "";
  const cookieSecret =
    env.COOKIE_SECRET ??
    (isProduction ? "" : "maradocs-insecure-dev-cookie-secret-change-me");
  const publicBaseUrl = env.PUBLIC_BASE_URL?.replace(/\/$/, "") ?? null;

  if (!adminPassword) {
    throw new Error("ADMIN_PASSWORD must be set");
  }

  const bcryptRounds = Number(env.BCRYPT_ROUNDS ?? 12);

  if (isProduction) {
    if (cookieSecret.length < 32) {
      throw new Error("COOKIE_SECRET must be set to at least 32 characters in production");
    }
    if (!publicBaseUrl) {
      throw new Error("PUBLIC_BASE_URL must be set in production");
    }
    if (bcryptRounds < 10) {
      throw new Error("BCRYPT_ROUNDS must be at least 10 in production");
    }
  }

  return {
    port: Number(env.PORT ?? DEFAULTS.PORT),
    host: env.HOST ?? (isProduction ? "0.0.0.0" : "127.0.0.1"),
    dataDir,
    dbPath: path.join(dataDir, "docs.db"),
    repositoriesDir: path.join(dataDir, "repositories"),
    publicBaseUrl,
    defaultRepoAccess: accessEnv(env.DEFAULT_REPO_ACCESS, DEFAULTS.DEFAULT_REPO_ACCESS),
    maxUploadBytes: Number(env.MAX_UPLOAD_MB ?? DEFAULTS.MAX_UPLOAD_MB) * 1024 * 1024,
    cookieSecret,
    adminPassword,
    bcryptRounds,
    dashboardDevServerUrl: isProduction
      ? null
      : (env.DASHBOARD_DEV_SERVER_URL ?? "http://localhost:5273").replace(/\/$/, ""),
    isProduction,
  };
}

export type { AccessMode };
