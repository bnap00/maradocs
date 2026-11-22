import { env, exports } from "cloudflare:workers";
import { zipSync, type Zippable } from "fflate";
import { expect } from "vitest";
import { migrate } from "../src/schema";

/** The ADMIN_PASSWORD binding (vitest.config.ts): the claim password for the first account. */
export const CLAIM_PASSWORD = "test-admin-password-0123";
/** Password of the default test account (see login()). */
export const PASSWORD = "owner-password-0123456";
export const OWNER_EMAIL = "owner@maradocs.test";
export const ORIGIN = "https://maradocs.test";

const worker = (exports as unknown as { default: Fetcher }).default;

/** A fresh client IP per call keeps rate-limit buckets independent between tests. */
export function freshIp(): string {
  return `test-ip-${crypto.randomUUID()}`;
}

export function fetchApp(path: string, init: RequestInit = {}): Promise<Response> {
  return worker.fetch(new Request(`${ORIGIN}${path}`, { redirect: "manual", ...init }));
}

let slugCounter = 0;
export function uniqueSlug(prefix = "t"): string {
  slugCounter += 1;
  return `${prefix}-${slugCounter}-${crypto.randomUUID().slice(0, 8)}`;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests assert on loosely-typed JSON
export async function json<T = any>(res: Response): Promise<T> {
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`Expected JSON (status ${res.status}): ${text.slice(0, 300)}`);
  }
}

export interface Account {
  token: string;
  cookie: string;
  userId: string;
  email: string;
  password: string;
}

function sessionFrom(res: Response): { cookie: string } {
  const setCookie = res.headers.get("set-cookie") ?? "";
  return { cookie: setCookie.split(";")[0]! };
}

export function registerRequest(body: Record<string, unknown>, extra: Record<string, string> = {}): Promise<Response> {
  return fetchApp("/api/v1/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": freshIp(), ...extra },
    body: JSON.stringify(body),
  });
}

export function loginRequest(email: string, password: string, ip = freshIp(), extra: Record<string, string> = {}) {
  return fetchApp("/api/v1/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": ip, ...extra },
    body: JSON.stringify({ email, password }),
  });
}

let emailCounter = 0;
export function uniqueEmail(prefix = "user"): string {
  emailCounter += 1;
  return `${prefix}-${emailCounter}-${crypto.randomUUID().slice(0, 8)}@maradocs.test`;
}

/** Create an account (sending the claim password, which is ignored once accounts exist) and sign it in. */
export async function register(email = uniqueEmail(), password = PASSWORD): Promise<Account> {
  const res = await registerRequest({ email, password, claimPassword: CLAIM_PASSWORD });
  expect(res.status, await res.clone().text()).toBe(201);
  const { cookie } = sessionFrom(res);
  const body = await json<{ token: string; user: { id: string } }>(res);
  return { token: body.token, cookie, userId: body.user.id, email, password };
}

/** Sign in to an existing account. */
export async function signIn(email: string, password = PASSWORD, ip = freshIp()): Promise<Account> {
  const res = await loginRequest(email, password, ip);
  expect(res.status, await res.clone().text()).toBe(200);
  const { cookie } = sessionFrom(res);
  const body = await json<{ token: string; user: { id: string } }>(res);
  return { token: body.token, cookie, userId: body.user.id, email, password };
}

/**
 * A new session for this test file's default account (the owner, created on
 * first use; storage is isolated per test file).
 */
export async function login(): Promise<Account> {
  await migrate(env.DB);
  const exists = await env.DB.prepare(`SELECT 1 FROM users WHERE email = ?`).bind(OWNER_EMAIL).first();
  return exists ? signIn(OWNER_EMAIL) : register(OWNER_EMAIL);
}

export function bearer(token: string, extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${token}`, ...extra };
}

/** Headers for a browser-style, cookie-authenticated same-origin request (as the dashboard sends them). */
export function browser(cookie: string, extra: Record<string, string> = {}): Record<string, string> {
  return { cookie, origin: ORIGIN, "x-maradocs": "1", ...extra };
}

export async function createApiKey(sessionToken: string, scopes: string[] = ["publish"], name = "test-key"): Promise<string> {
  const res = await fetchApp("/api/v1/auth/keys", {
    method: "POST",
    headers: bearer(sessionToken, { "content-type": "application/json" }),
    body: JSON.stringify({ name, scopes }),
  });
  expect(res.status, await res.clone().text()).toBe(201);
  return (await json<{ key: string }>(res)).key;
}

export type FileMap = Record<string, string | Uint8Array>;

const encoder = new TextEncoder();

export function toBytes(value: string | Uint8Array): Uint8Array {
  return typeof value === "string" ? encoder.encode(value) : value;
}

/** Build a zip in-memory. Keys are used verbatim as entry names (so tests can craft unsafe ones). */
export function makeZip(files: FileMap): Uint8Array {
  const zippable: Zippable = {};
  for (const [name, content] of Object.entries(files)) zippable[name] = [toBytes(content), { level: 6 }];
  return zipSync(zippable);
}

export async function machineJson(key: string, method: string, path: string, body?: unknown): Promise<Response> {
  return fetchApp(`/api/v1${path}`, {
    method,
    headers: bearer(key, body !== undefined ? { "content-type": "application/json" } : {}),
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

export async function createRepo(key: string, slug: string, extra: Record<string, unknown> = {}): Promise<void> {
  const res = await machineJson(key, "POST", "/repos", { slug, access: "public", ...extra });
  expect(res.status, await res.clone().text()).toBe(201);
}

export function uploadForm(fields: Record<string, string | undefined>, zip?: Uint8Array, fileField = "file"): FormData {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) form.append(k, v);
  if (zip) form.append(fileField, new Blob([zip], { type: "application/zip" }), "bundle.zip");
  return form;
}

export interface PublishOptions {
  title?: string;
  access?: string;
  password?: string;
  entrypoint?: string;
  replace?: boolean;
  headers?: Record<string, string>;
  /** Defaults to the machine API; pass "/api/v1/dashboard" for browser uploads. */
  apiBase?: string;
}

export async function publishRaw(
  auth: Record<string, string>,
  repo: string,
  doc: string,
  zip: Uint8Array,
  opts: PublishOptions = {},
): Promise<Response> {
  const base = opts.apiBase ?? "/api/v1";
  const form = uploadForm(
    { doc, title: opts.title, access: opts.access, password: opts.password, entrypoint: opts.entrypoint },
    zip,
  );
  return fetchApp(opts.replace ? `${base}/repos/${repo}/docs/${doc}` : `${base}/repos/${repo}/docs`, {
    method: opts.replace ? "PUT" : "POST",
    headers: { ...auth, ...opts.headers },
    body: form,
  });
}

export async function publish(
  key: string,
  repo: string,
  doc: string,
  files: FileMap,
  opts: PublishOptions = {},
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests assert on loosely-typed JSON
): Promise<any> {
  const res = await publishRaw(bearer(key), repo, doc, makeZip(files), opts);
  const expected = opts.replace ? 200 : 201;
  expect(res.status, await res.clone().text()).toBe(expected);
  return json(res);
}

/** Independent implementation of the Node server's checksum: sha256(path \0 bytes ...), sorted by path. */
export async function nodeChecksum(files: FileMap): Promise<string> {
  const entries = Object.entries(files)
    .map(([p, c]) => [p, toBytes(c)] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const parts: Uint8Array[] = [];
  for (const [p, data] of entries) parts.push(encoder.encode(p), new Uint8Array([0]), data);
  const total = parts.reduce((n, p) => n + p.length, 0);
  const buf = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    buf.set(p, off);
    off += p.length;
  }
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function auditEvents(filter: { repo?: string; event?: string } = {}): Promise<string[]> {
  const where: string[] = [];
  const params: string[] = [];
  if (filter.repo) {
    where.push("repository_slug = ?");
    params.push(filter.repo);
  }
  if (filter.event) {
    where.push("event = ?");
    params.push(filter.event);
  }
  const { results } = await env.DB
    .prepare(`SELECT event FROM audit_log ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at, id`)
    .bind(...params)
    .all<{ event: string }>();
  return results.map((r) => r.event);
}

export async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, timeoutMs = 3000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
}

export { env };
