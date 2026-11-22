import { ACCESS_MODES, type AccessMode } from "./vendor/shared/index.js";

/** Worker bindings declared in wrangler.jsonc (plus secrets). */
export interface Env {
  DB: D1Database;
  BUCKET: R2Bucket;
  ASSETS?: Fetcher;
  /**
   * Optional secret. Claim password: while no account exists, registering the
   * first account requires it (protects upgraded deployments that already
   * hold data). Ignored once any account exists; never used to sign in.
   */
  ADMIN_PASSWORD?: string;
  /** Optional. Who may create accounts: `first` (default; only while none exist), `open` or `closed`. */
  REGISTRATION?: string;
  /** Optional secret. When unset a random one is generated and kept in D1. */
  COOKIE_SECRET?: string;
  /** Optional. External URL for links in API responses; defaults to the request origin. */
  PUBLIC_BASE_URL?: string;
  DEFAULT_REPO_ACCESS?: string;
  MAX_UPLOAD_MB?: string;
  /** Optional. PBKDF2 iterations for stored passwords (10000–100000, default 10000). */
  PBKDF2_ITERATIONS?: string;
  /**
   * Optional. Serve PDFs inline (without the report sandbox, which Chromium's
   * PDF viewer refuses to run in). Default: PDFs are served as downloads.
   */
  PDF_INLINE?: string;
  /**
   * Optional. Serve reports from a separate hostname (e.g. reports.example.com
   * or https://reports.example.com), so a report can never pose as the
   * dashboard on the same address. Requires PUBLIC_BASE_URL (the dashboard's
   * origin); both hostnames must route to this Worker.
   */
  REPORTS_HOST?: string;
}

export type RegistrationMode = "open" | "first" | "closed";
export const REGISTRATION_MODES: readonly RegistrationMode[] = ["open", "first", "closed"];

export interface Config {
  registration: RegistrationMode;
  defaultRepoAccess: AccessMode;
  maxUploadBytes: number;
  pbkdf2Iterations: number;
  publicBaseUrl: string | null;
  pdfInline: boolean;
  /** Origin reports are served from when REPORTS_HOST is set (with PUBLIC_BASE_URL). */
  reportsOrigin: string | null;
}

/** Account password length limits. */
export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 1024;

/**
 * Upper bound for MAX_UPLOAD_MB. Publishing keeps the request body plus one
 * buffer of the uncompressed files in memory; Workers isolates have 128 MB,
 * so larger values would run out of memory.
 */
export const MAX_UPLOAD_MB_CAP = 25;

/**
 * Default PBKDF2 cost. Each derivation is CPU time on the request; at 10k
 * iterations one costs ~4 ms, which keeps logins and report unlocks inside
 * the Workers Free plan's 10 ms CPU budget. Raise it on Workers Paid.
 */
export const DEFAULT_PBKDF2_ITERATIONS = 10_000;

/** Placeholder values that must never be accepted as a claim password. */
const PLACEHOLDERS = new Set([
  "",
  "change-me",
  "changeme",
  "password",
  "change-me-to-a-long-random-string",
  "change-me-before-exposing-to-internet",
]);

/** The ADMIN_PASSWORD secret as a claim password, or null when unset (or a placeholder). */
export function claimSecret(env: Env): string | null {
  const value = (env.ADMIN_PASSWORD ?? "").trim();
  return PLACEHOLDERS.has(value.toLowerCase()) ? null : value;
}

let warnedRegistration = false;

function parseRegistration(raw: string | undefined): RegistrationMode {
  const value = (raw ?? "").trim().toLowerCase();
  if (value === "") return "first";
  if ((REGISTRATION_MODES as readonly string[]).includes(value)) return value as RegistrationMode;
  if (!warnedRegistration) {
    warnedRegistration = true;
    console.warn(`REGISTRATION=${raw} is not one of open, first, closed; using "first".`);
  }
  return "first";
}

/** Application version reported by /api/v1/public-config and the dashboard. */
export const APP_VERSION = "0.1.0";

let warnedUploadCap = false;
let warnedReportsHost = false;
let warnedIterations = false;

export const MIN_PBKDF2_ITERATIONS = 10_000;
export const MAX_PBKDF2_ITERATIONS = 100_000;

/** PBKDF2_ITERATIONS clamped to 10k–100k; unset or non-numeric uses the default. */
function parseIterations(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_PBKDF2_ITERATIONS;
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n)) {
    warnIterations(`PBKDF2_ITERATIONS=${raw} is not a number; using ${DEFAULT_PBKDF2_ITERATIONS}.`);
    return DEFAULT_PBKDF2_ITERATIONS;
  }
  const clamped = Math.max(MIN_PBKDF2_ITERATIONS, Math.min(n, MAX_PBKDF2_ITERATIONS));
  if (clamped !== n) {
    warnIterations(
      `PBKDF2_ITERATIONS=${raw} is outside ${MIN_PBKDF2_ITERATIONS}–${MAX_PBKDF2_ITERATIONS}; using ${clamped}.`,
    );
  }
  return clamped;
}

function warnIterations(message: string): void {
  if (warnedIterations) return;
  warnedIterations = true;
  console.warn(message);
}

function parseReportsOrigin(env: Env, publicBaseUrl: string | null): string | null {
  const raw = env.REPORTS_HOST?.trim();
  if (!raw) return null;
  let origin: string;
  try {
    origin = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`).origin;
  } catch {
    origin = "";
  }
  const dashboard = publicBaseUrl ? safeOrigin(publicBaseUrl) : null;
  if (!origin || !dashboard || dashboard === origin) {
    if (!warnedReportsHost) {
      warnedReportsHost = true;
      console.warn(
        "REPORTS_HOST is ignored: it must be a valid hostname different from PUBLIC_BASE_URL, " +
          "and PUBLIC_BASE_URL (the dashboard origin) must be set.",
      );
    }
    return null;
  }
  return origin;
}

function safeOrigin(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

export function loadConfig(env: Env): Config {
  const access = env.DEFAULT_REPO_ACCESS;
  const maxMbRaw = Number(env.MAX_UPLOAD_MB ?? MAX_UPLOAD_MB_CAP);
  let maxMb = Number.isFinite(maxMbRaw) && maxMbRaw > 0 ? maxMbRaw : MAX_UPLOAD_MB_CAP;
  if (maxMb > MAX_UPLOAD_MB_CAP) {
    if (!warnedUploadCap) {
      warnedUploadCap = true;
      console.warn(
        `MAX_UPLOAD_MB=${env.MAX_UPLOAD_MB} exceeds the ${MAX_UPLOAD_MB_CAP} MB the Worker can safely process ` +
          `within 128 MB of memory; using ${MAX_UPLOAD_MB_CAP}.`,
      );
    }
    maxMb = MAX_UPLOAD_MB_CAP;
  }
  const publicBaseUrl = env.PUBLIC_BASE_URL?.trim().replace(/\/+$/, "") || null;
  return {
    registration: parseRegistration(env.REGISTRATION),
    defaultRepoAccess:
      access && (ACCESS_MODES as readonly string[]).includes(access)
        ? (access as AccessMode)
        : "private",
    maxUploadBytes: Math.floor(maxMb * 1024 * 1024),
    pbkdf2Iterations: parseIterations(env.PBKDF2_ITERATIONS),
    publicBaseUrl,
    pdfInline: /^(1|true|yes|on)$/i.test(env.PDF_INLINE?.trim() ?? ""),
    reportsOrigin: parseReportsOrigin(env, publicBaseUrl),
  };
}
