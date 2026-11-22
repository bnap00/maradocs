// API client + shared DTO types for the MaraDocs dashboard.

export type AccessMode = "public" | "password" | "private";

export interface Repository {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  defaultAccess: AccessMode;
  indexEnabled: boolean;
  hasPassword: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface DocumentSummary {
  id: string;
  repositorySlug: string;
  slug: string;
  title: string;
  access: AccessMode;
  accessOverride: AccessMode | null;
  entrypoint: string;
  latestVersionNumber: number | null;
  hasPassword: boolean;
  url: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DocumentVersion {
  id: string;
  versionNumber: number;
  checksum: string;
  fileCount: number;
  sizeBytes: number;
  entrypoint: string;
  publishedByType: "machine" | "user";
  publishedByLabel: string | null;
  isLatest: boolean;
  createdAt: string;
}

export interface Machine {
  id: string;
  keyId: string;
  name: string;
  scopes: string[];
  subject: string | null;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface ApiKeyInfo {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  createdAt: string;
  lastUsedAt: string | null;
}

export interface AuditEntry {
  id: string;
  event: string;
  actorType: string;
  actorLabel: string | null;
  repositorySlug: string | null;
  documentSlug: string | null;
  detail: string | null;
  createdAt: string;
}

export interface PublicConfig {
  defaultRepoAccess: AccessMode;
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface User {
  id: string;
  email: string;
  createdAt: string;
}

export interface AuthConfig {
  /** Whether creating an account is currently allowed. */
  registration: boolean;
  /** Whether the first account must present the server's claim password. */
  claimRequired: boolean;
  /** No account exists yet. */
  firstAccount?: boolean;
  minPasswordLength: number;
}

const DASH = "/api/v1/dashboard";
const AUTH = "/api/v1/auth";

/**
 * Cookie-only transport: the session lives in the httpOnly `maradocs_session`
 * cookie, never in JS. Every request sends `x-maradocs: 1`, which the server
 * requires on cookie-authenticated writes (CSRF defence).
 */
async function send<T>(method: string, url: string, body?: unknown): Promise<{ status: number; data: T }> {
  const headers: Record<string, string> = { "x-maradocs": "1" };
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(url, {
    method,
    headers,
    credentials: "same-origin",
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data: unknown = null;
  try { if (text) data = JSON.parse(text); } catch { /* non-JSON body — treat as empty */ }
  if (!res.ok) {
    throw new ApiError(res.status, (data as { message?: string })?.message ?? `${res.status}`);
  }
  return { status: res.status, data: data as T };
}

/** Unauthenticated / session-bootstrap calls used by the sign-in screens. */
export const authApi = {
  config: async () => (await send<AuthConfig>("GET", `${AUTH}/config`)).data,
  me: async () => (await send<{ user: User }>("GET", `${AUTH}/me`)).data.user,
  login: async (email: string, password: string) =>
    (await send<{ user: User }>("POST", `${AUTH}/login`, { email, password })).data.user,
  register: async (email: string, password: string, claimPassword?: string) =>
    (
      await send<{ user: User }>("POST", `${AUTH}/register`, {
        email,
        password,
        ...(claimPassword ? { claimPassword } : {}),
      })
    ).data.user,
  logout: async () => {
    await send<void>("POST", `${AUTH}/logout`);
  },
};

export function createApi(onUnauthorized?: () => void) {
  /**
   * `passwordCheck` marks calls where a 401 means "wrong password" rather than
   * an expired session, so they must not sign the user out.
   */
  async function request<T>(
    method: string,
    base: string,
    path: string,
    body?: unknown,
    passwordCheck = false,
  ): Promise<T> {
    try {
      return (await send<T>(method, `${base}${path}`, body)).data;
    } catch (err) {
      if (err instanceof ApiError && err.status === 401 && !passwordCheck) onUnauthorized?.();
      throw err;
    }
  }

  const dash = <T>(method: string, path: string, body?: unknown) =>
    request<T>(method, DASH, path, body);
  const auth = <T>(method: string, path: string, body?: unknown) =>
    request<T>(method, AUTH, path, body);

  return {
    listRepos: () => dash<{ repos: Repository[] }>("GET", "/repos"),
    createRepo: (input: Partial<Repository> & { slug: string; password?: string }) =>
      dash<{ repo: Repository }>("POST", "/repos", input),
    updateRepo: (
      slug: string,
      input: Partial<{
        name: string;
        description: string | null;
        access: AccessMode;
        indexEnabled: boolean;
        password: string | null;
      }>,
    ) => dash<{ repo: Repository }>("PATCH", `/repos/${slug}`, input),
    listDocs: (repo: string) =>
      dash<{ docs: DocumentSummary[] }>("GET", `/repos/${repo}/docs`),
    listVersions: (repo: string, doc: string) =>
      dash<{ versions: DocumentVersion[] }>("GET", `/repos/${repo}/docs/${doc}/versions`),
    rollback: (repo: string, doc: string, version: number) =>
      dash<{ doc: DocumentSummary }>("POST", `/repos/${repo}/docs/${doc}/rollback`, { version }),
    deleteDoc: (repo: string, doc: string) =>
      dash<{ deleted: boolean }>("DELETE", `/repos/${repo}/docs/${doc}`),
    listMachines: () => dash<{ machines: Machine[] }>("GET", "/machines"),
    listAudit: () => dash<{ audit: AuditEntry[] }>("GET", "/audit"),
    listApiKeys: () => auth<{ keys: ApiKeyInfo[] }>("GET", "/keys"),
    createApiKey: (name: string, scopes: string[]) =>
      auth<{ key: string; id: string; name: string; prefix: string; scopes: string[] }>(
        "POST",
        "/keys",
        { name, scopes },
      ),
    deleteApiKey: (id: string) => auth<void>("DELETE", `/keys/${id}`),
    me: () => auth<{ user: User }>("GET", "/me"),
    logoutOthers: () => auth<{ revoked: number }>("POST", "/logout-others"),
    changePassword: (currentPassword: string, newPassword: string) =>
      request<{ user: User }>("POST", AUTH, "/change-password", { currentPassword, newPassword }, true),
    deleteAccount: (password: string) =>
      request<void>("DELETE", AUTH, "/account", { password }, true),
  };
}

export type Api = ReturnType<typeof createApi>;

export async function fetchPublicConfig(): Promise<PublicConfig> {
  const res = await fetch("/api/v1/public-config", { credentials: "same-origin" });
  if (!res.ok) throw new Error("Failed to load config");
  return res.json();
}
