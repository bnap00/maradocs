// The single typed client for the Worker's HTTP surface (CLOUDFLARE_SPEC.md).
//
// Auth is the HttpOnly `maradocs_session` cookie set by POST /api/v1/auth/login
// (or /register). The dashboard never sees or stores a token: every request is
// same-origin with `credentials: "same-origin"`, and the browser attaches the
// cookie. Every request also sends `x-maradocs: 1`: the Worker refuses
// cookie-authenticated writes without it (CSRF), on top of checking the
// Origin / Sec-Fetch-Site headers browsers add to same-origin requests.
import type {
  AccessMode,
  ApiErrorBody,
  ApiKeyInfo,
  AuditPage,
  AuthConfig,
  AuthResult,
  AuditQuery,
  CreateRepoInput,
  CreatedApiKey,
  DocumentSummary,
  DocumentVersion,
  Health,
  Machine,
  Me,
  Overview,
  PublicConfig,
  PublishResult,
  Repository,
  Settings,
  UpdateDocInput,
  UpdateRepoInput,
  UploadFields,
  UploadProgress,
  User,
} from "./types";

/** CSRF header the Worker requires on cookie-authenticated writes. */
const CSRF_HEADERS = { "x-maradocs": "1" } as const;

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;
  /** Seconds from the Retry-After header (429 responses), when present. */
  readonly retryAfter: number | null;
  constructor(status: number, code: string, message: string, details?: unknown, retryAfter: number | null = null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
    this.retryAfter = retryAfter;
  }
}

function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(0, Math.ceil((date - Date.now()) / 1000));
}

/** Human-readable message for any thrown value, including zod validation details. */
export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === "validation_error" && Array.isArray(err.details) && err.details.length) {
      const first = err.details[0] as { path?: unknown[]; message?: string };
      const field = Array.isArray(first.path) && first.path.length ? `${first.path.join(".")}: ` : "";
      if (first.message) return `${field}${first.message}`;
    }
    return err.message;
  }
  if (err instanceof Error) return err.message;
  return "Something went wrong";
}

type UnauthorizedHandler = () => void;
let onUnauthorized: UnauthorizedHandler | null = null;

/**
 * Called when the session is gone for good (a 401 the user didn't recover from
 * by signing in again). The app redirects to /login?next=…&reason=expired.
 */
export function setUnauthorizedHandler(handler: UnauthorizedHandler | null): void {
  onUnauthorized = handler;
}

/**
 * Asks the user to sign in again in place (a password dialog) and resolves to
 * true once a new session cookie is set. While it is open, forms, drawers and
 * uploads keep their state; the failed request is then retried once.
 */
type ReauthHandler = () => Promise<boolean>;
let onReauth: ReauthHandler | null = null;
let pendingReauth: Promise<boolean> | null = null;

export function setReauthHandler(handler: ReauthHandler | null): void {
  onReauth = handler;
}

/** One prompt for any number of concurrent 401s. */
function reauthenticate(): Promise<boolean> {
  if (!onReauth) return Promise.resolve(false);
  pendingReauth ??= onReauth()
    .catch(() => false)
    .finally(() => {
      pendingReauth = null;
    });
  return pendingReauth;
}

/** A 401 on an authenticated call: try to recover in place, else hand over to the redirect. */
async function recoverSession(): Promise<boolean> {
  if (await reauthenticate()) return true;
  onUnauthorized?.();
  return false;
}

const API = "/api/v1";
const DASH = `${API}/dashboard`;
const AUTH = `${API}/auth`;

const seg = (s: string) => encodeURIComponent(s);
const docPath = (repo: string, doc: string) => `${DASH}/repos/${seg(repo)}/docs/${seg(doc)}`;

function toApiError(status: number, body: unknown, fallback: string, retryAfter: number | null = null): ApiError {
  const b = (body ?? {}) as Partial<ApiErrorBody>;
  const code = typeof b.error === "string" ? b.error : statusCode(status);
  const message = typeof b.message === "string" && b.message ? b.message : fallback;
  return new ApiError(status, code, message, b.details, retryAfter);
}

function statusCode(status: number): string {
  switch (status) {
    case 400: return "bad_request";
    case 401: return "unauthorized";
    case 403: return "forbidden";
    case 404: return "not_found";
    case 409: return "conflict";
    case 413: return "payload_too_large";
    case 429: return "rate_limited";
    case 503: return "not_configured";
    default: return "internal_error";
  }
}

interface RequestOptions {
  body?: unknown;
  /** Don't trigger the 401 handling (login, public endpoints, the initial session check). */
  noAuthRedirect?: boolean;
  signal?: AbortSignal;
  /** Internal: this is the retry after an in-place sign-in. */
  retried?: boolean;
}

async function request<T>(method: string, url: string, opts: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { accept: "application/json", ...CSRF_HEADERS };
  let body: BodyInit | undefined;
  if (opts.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(opts.body);
  }
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers,
      body,
      credentials: "same-origin",
      cache: "no-store",
      signal: opts.signal,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    throw new ApiError(0, "network_error", "Network error: the server could not be reached.");
  }
  const text = res.status === 204 ? "" : await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  if (!res.ok) {
    if (res.status === 401 && !opts.noAuthRedirect && !opts.retried && !opts.signal?.aborted) {
      if (await recoverSession()) return request<T>(method, url, { ...opts, retried: true });
    }
    throw toApiError(
      res.status,
      data,
      res.statusText || `Request failed (${res.status})`,
      parseRetryAfter(res.headers.get("retry-after")),
    );
  }
  return data as T;
}

function qs(params: Record<string, string | number | null | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}

/**
 * Multipart upload with progress (fetch has no upload progress events, so XHR).
 * Fields: doc, title, access, password, entrypoint + the zip as file field `file`.
 */
async function upload(
  method: "POST" | "PUT",
  url: string,
  fields: UploadFields,
  zip: Blob,
  onProgress?: (p: UploadProgress) => void,
  signal?: AbortSignal,
): Promise<PublishResult> {
  try {
    return await uploadOnce(method, url, fields, zip, onProgress, signal);
  } catch (err) {
    // Session expired mid-upload: sign in again in place and send it once more.
    if (err instanceof ApiError && err.status === 401 && !signal?.aborted && (await recoverSession())) {
      return uploadOnce(method, url, fields, zip, onProgress, signal);
    }
    throw err;
  }
}

function uploadOnce(
  method: "POST" | "PUT",
  url: string,
  fields: UploadFields,
  zip: Blob,
  onProgress?: (p: UploadProgress) => void,
  signal?: AbortSignal,
): Promise<PublishResult> {
  const form = new FormData();
  form.append("doc", fields.doc);
  if (fields.title) form.append("title", fields.title);
  if (fields.access) form.append("access", fields.access);
  if (fields.password) form.append("password", fields.password);
  if (fields.entrypoint) form.append("entrypoint", fields.entrypoint);
  form.append("file", zip, `${fields.doc}.zip`);

  return new Promise<PublishResult>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(method, url);
    xhr.withCredentials = false; // same-origin requests always carry cookies
    xhr.responseType = "text";
    xhr.setRequestHeader("accept", "application/json");
    for (const [name, value] of Object.entries(CSRF_HEADERS)) xhr.setRequestHeader(name, value);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress?.({ loaded: e.loaded, total: e.total });
    };
    xhr.onload = () => {
      let data: unknown;
      try {
        data = xhr.responseText ? JSON.parse(xhr.responseText) : null;
      } catch {
        data = null;
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(data as PublishResult);
        return;
      }
      reject(
        toApiError(xhr.status, data, `Upload failed (${xhr.status})`, parseRetryAfter(xhr.getResponseHeader("retry-after"))),
      );
    };
    xhr.onerror = () => reject(new ApiError(0, "network_error", "Network error during upload."));
    xhr.onabort = () => reject(new DOMException("Upload cancelled", "AbortError"));
    if (signal) {
      if (signal.aborted) {
        reject(new DOMException("Upload cancelled", "AbortError"));
        return;
      }
      signal.addEventListener("abort", () => xhr.abort(), { once: true });
    }
    xhr.send(form);
  });
}

export const api = {
  // ── System ────────────────────────────────────────────────────────────
  health: () => request<Health>("GET", "/health", { noAuthRedirect: true }),
  publicConfig: () => request<PublicConfig>("GET", `${API}/public-config`, { noAuthRedirect: true }),

  // ── Auth ──────────────────────────────────────────────────────────────
  /** Whether accounts can be created, and whether the first one needs the claim password. */
  authConfig: () => request<AuthConfig>("GET", `${AUTH}/config`, { noAuthRedirect: true }),
  /** Sets the HttpOnly session cookie (browsers get no token in the body). */
  login: async (email: string, password: string): Promise<User> =>
    (await request<AuthResult>("POST", `${AUTH}/login`, { body: { email, password }, noAuthRedirect: true })).user,
  register: async (email: string, password: string, claimPassword?: string): Promise<User> =>
    (
      await request<AuthResult>("POST", `${AUTH}/register`, {
        body: { email, password, ...(claimPassword ? { claimPassword } : {}) },
        noAuthRedirect: true,
      })
    ).user,
  logout: () => request<void>("POST", `${AUTH}/logout`, { noAuthRedirect: true }),
  /** Signs out every other session of this account. */
  logoutOthers: () => request<{ revoked: number }>("POST", `${AUTH}/logout-others`),
  /** A wrong current password is a 401 here, not an expired session: no re-auth prompt. */
  changePassword: (currentPassword: string, newPassword: string) =>
    request<{ user: User }>("POST", `${AUTH}/change-password`, {
      body: { currentPassword, newPassword },
      noAuthRedirect: true,
    }),
  deleteAccount: (password: string) =>
    request<void>("DELETE", `${AUTH}/account`, { body: { password }, noAuthRedirect: true }),
  listKeys: () => request<{ keys: ApiKeyInfo[] }>("GET", `${AUTH}/keys`),
  createKey: (name: string, scopes: string[]) =>
    request<CreatedApiKey>("POST", `${AUTH}/keys`, { body: { name, scopes } }),
  revokeKey: (id: string) => request<void>("DELETE", `${AUTH}/keys/${seg(id)}`),

  // ── Dashboard ─────────────────────────────────────────────────────────
  /** Session check; the caller decides what a 401 means (boot screen, login page). */
  me: (signal?: AbortSignal) => request<Me>("GET", `${DASH}/me`, { signal, noAuthRedirect: true }),
  overview: () => request<Overview>("GET", `${DASH}/overview`),

  listRepos: () => request<{ repos: Repository[] }>("GET", `${DASH}/repos`),
  getRepo: (repo: string) => request<{ repo: Repository }>("GET", `${DASH}/repos/${seg(repo)}`),
  createRepo: (input: CreateRepoInput) =>
    request<{ repo: Repository }>("POST", `${DASH}/repos`, { body: input }),
  updateRepo: (repo: string, input: UpdateRepoInput) =>
    request<{ repo: Repository }>("PATCH", `${DASH}/repos/${seg(repo)}`, { body: input }),
  deleteRepo: (repo: string) => request<unknown>("DELETE", `${DASH}/repos/${seg(repo)}`),

  listDocs: (repo: string) =>
    request<{ docs: DocumentSummary[] }>("GET", `${DASH}/repos/${seg(repo)}/docs`),
  getDoc: (repo: string, doc: string) => request<{ doc: DocumentSummary }>("GET", docPath(repo, doc)),
  updateDoc: (repo: string, doc: string, input: UpdateDocInput) =>
    request<{ doc?: DocumentSummary }>("PATCH", docPath(repo, doc), { body: input }),
  publishDoc: (
    repo: string,
    fields: UploadFields,
    zip: Blob,
    onProgress?: (p: UploadProgress) => void,
    signal?: AbortSignal,
  ) => upload("POST", `${DASH}/repos/${seg(repo)}/docs`, fields, zip, onProgress, signal),
  replaceDoc: (
    repo: string,
    fields: UploadFields,
    zip: Blob,
    onProgress?: (p: UploadProgress) => void,
    signal?: AbortSignal,
  ) => upload("PUT", docPath(repo, fields.doc), fields, zip, onProgress, signal),
  deleteDoc: (repo: string, doc: string) =>
    request<{ deleted: boolean }>("DELETE", docPath(repo, doc)),
  listVersions: (repo: string, doc: string) =>
    request<{ versions: DocumentVersion[] }>("GET", `${docPath(repo, doc)}/versions`),
  rollback: (repo: string, doc: string, version: number) =>
    request<{ doc: DocumentSummary }>("POST", `${docPath(repo, doc)}/rollback`, {
      body: { version },
    }),
  /** URL of the zip download (cookie-authenticated GET, used as an <a href>). */
  bundleUrl: (repo: string, doc: string, version?: number) =>
    `${docPath(repo, doc)}/bundle${qs({ version })}`,

  listMachines: () => request<{ machines: Machine[] }>("GET", `${DASH}/machines`),
  listAudit: (q: AuditQuery = {}) =>
    request<AuditPage>(
      "GET",
      `${DASH}/audit${qs({ limit: q.limit, before: q.before, repo: q.repo, event: q.event })}`,
    ),

  settings: () => request<Settings>("GET", `${DASH}/settings`),
  updateSettings: (input: { defaultRepoAccess: AccessMode }) =>
    request<unknown>("PATCH", `${DASH}/settings`, { body: input }),
};

export type Api = typeof api;

// ── URL helpers for report links ──────────────────────────────────────────
export function docUrl(repo: string, doc: string): string {
  return `/r/${seg(repo)}/${seg(doc)}/`;
}
export function versionUrl(repo: string, doc: string, version: number): string {
  return `/r/${seg(repo)}/${seg(doc)}/v/${version}/`;
}
export function repoIndexUrl(repo: string): string {
  return `/r/${seg(repo)}/`;
}
export function absolute(path: string, origin: string = window.location.origin): string {
  return new URL(path, origin).toString();
}
