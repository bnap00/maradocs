import { ACCESS_MODES, DEFAULTS, type AccessMode } from "@maradocs/shared";
import path from "node:path";

function accessEnv(value: string | undefined, fallback: AccessMode): AccessMode {
  if (value && (ACCESS_MODES as readonly string[]).includes(value)) {
    return value as AccessMode;
  }
  return fallback;
}

const PLACEHOLDER_VALUES = new Set([
  "change-me-to-a-long-random-string",
  "change-me-before-exposing-to-internet",
  "maradocs-insecure-dev-cookie-secret-change-me",
]);

function resolveDataDir(env: NodeJS.ProcessEnv): string {
  const configured = env.DATA_DIR ?? DEFAULTS.DATA_DIR;
  if (path.isAbsolute(configured)) return configured;
  return path.resolve(env.INIT_CWD ?? process.cwd(), configured);
}

export const REGISTRATION_MODES = ["open", "first", "closed"] as const;
export type RegistrationMode = (typeof REGISTRATION_MODES)[number];

export interface ServerConfig {
  port: number;
  host: string;
  dataDir: string;
  dbPath: string;
  repositoriesDir: string;
  publicBaseUrl: string | null;
  defaultRepoAccess: AccessMode;
  maxUploadBytes: number;
  /**
   * Secret for signing password-gate cookies. Null when COOKIE_SECRET is not
   * set: the app then generates one and persists it in the settings table.
   */
  cookieSecret: string | null;
  /**
   * Legacy ADMIN_PASSWORD. No longer a login: only the claim password the
   * first account must present when set and no accounts exist yet.
   */
  adminPassword: string | null;
  /** Who may create accounts: open (anyone), first (only the first), closed. */
  registration: RegistrationMode;
  /** Whether session/password cookies get the Secure attribute. */
  cookieSecure: boolean;
  bcryptRounds: number;
  dashboardDevServerUrl: string | null;
  /** Fastify `trustProxy`: which peers may set X-Forwarded-* (false = none). */
  trustProxy: string | false;
  isProduction: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const isProduction = env.NODE_ENV === "production";
  const dataDir = resolveDataDir(env);
  const adminPassword = env.ADMIN_PASSWORD || null;
  const cookieSecret = env.COOKIE_SECRET || null;
  const publicBaseUrl = env.PUBLIC_BASE_URL?.replace(/\/$/, "") ?? null;

  const registrationRaw = (env.REGISTRATION || "first").trim().toLowerCase();
  if (!(REGISTRATION_MODES as readonly string[]).includes(registrationRaw)) {
    throw new Error(
      `REGISTRATION must be one of ${REGISTRATION_MODES.join(", ")} (got '${env.REGISTRATION}')`,
    );
  }
  const registration = registrationRaw as RegistrationMode;

  const bcryptRounds = Number(env.BCRYPT_ROUNDS ?? 12);

  if (isProduction) {
    // Values that shipped as .env.example placeholders in earlier releases.
    // They satisfy the length checks but are publicly known, so refuse them.
    if (adminPassword && PLACEHOLDER_VALUES.has(adminPassword)) {
      throw new Error(
        "ADMIN_PASSWORD is still the .env.example placeholder — unset it or set a real claim password",
      );
    }
    if (cookieSecret !== null) {
      if (PLACEHOLDER_VALUES.has(cookieSecret)) {
        throw new Error(
          "COOKIE_SECRET is still the .env.example placeholder — unset it (one is generated) or use `openssl rand -hex 32`",
        );
      }
      if (cookieSecret.length < 32) {
        throw new Error("COOKIE_SECRET must be at least 32 characters in production (or unset)");
      }
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
    registration,
    // Secure everywhere except plain-http deployments (local standalone, dev).
    cookieSecure: isProduction && !(publicBaseUrl ?? "").startsWith("http://"),
    bcryptRounds,
    dashboardDevServerUrl: isProduction
      ? null
      : (env.DASHBOARD_DEV_SERVER_URL ?? "http://localhost:5273").replace(/\/$/, ""),
    trustProxy: trustProxyEnv(env.TRUST_PROXY, isProduction),
    isProduction,
  };
}

/**
 * Production default trusts reverse proxies on loopback or private networks
 * (same host / Docker network, e.g. Dokploy's Traefik). Fastify no longer
 * honours hop counts, since those let direct clients spoof X-Forwarded-For.
 */
function trustProxyEnv(value: string | undefined, isProduction: boolean): string | false {
  const trimmed = value?.trim();
  if (!trimmed) return isProduction ? "loopback,linklocal,uniquelocal" : false;
  if (trimmed === "false" || trimmed === "0") return false;
  return trimmed;
}

export type { AccessMode };
