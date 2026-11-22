// Read surface for published reports: /r/:repo/:doc/... with access gating.
// One D1 batch resolves the document, the requested manifest entries and the
// caller's credentials; serving a file is then one ranged R2 read.
//
// URL shape: /r/<repo>/<doc>/[v/<n>/][~<token>/]<path>
// The optional token segment is a capability for subresource requests of a
// protected report (see services/reportToken.ts).

import { Hono } from "hono";
import type { AccessMode } from "../vendor/shared/index.js";
import { isValidSlug, passwordUnlockSchema } from "../vendor/shared/index.js";
import { passwordBinding, passwordHashIterations, rehashPassword, sha256Hex, verifyPassword } from "../crypto.js";
import { SESSION_COOKIE, clientIp, defer, parseCookies, serializeCookie, setCookie } from "../http.js";
import { contentTypeFor } from "../mime.js";
import { PAGE_CSP, notFoundPage, passwordGatePage, repoIndexPage, signInPage } from "../pages.js";
import {
  SETTING_COOKIE_SECRET,
  cookieSecretSync,
  getCookieSecret,
  rememberCookieSecret,
  settingStmt,
} from "../db/settings.js";
import {
  effectiveAccess,
  effectivePasswordHash,
  signUnlock,
  unlockCookieName,
  unlockCookiePath,
  verifyUnlock,
  viewCookieName,
} from "../services/access.js";
import { auditStmt } from "../services/audit.js";
import {
  apiKeyLookupStmt,
  credentialFromHeader,
  hasScope,
  isApiKeyToken,
  machineFromRow,
  sessionExpired,
  sessionLookupStmt,
  shouldTouch,
  touchApiKey,
  type ApiKeyLookupRow,
  type SessionUserRow,
} from "../services/auth.js";
import {
  UNLOCK_GLOBAL_LIMIT,
  UNLOCK_LIMIT,
  evaluateGlobalLimit,
  evaluateRateLimit,
  rateLimitClientKey,
  rateLimitHitStmt,
  rateLimitPeekStmt,
  rateLimitPurgeStmt,
} from "../services/ratelimit.js";
import {
  HANDOFF_TOKEN_TTL_SECONDS,
  REPORT_TOKEN_TTL_SECONDS,
  isFresh,
  isReportTokenSegment,
  mintReportToken,
  nowSeconds,
  parseReportToken,
  verifyReportToken,
  type ParsedReportToken,
  type ReportTokenContext,
} from "../services/reportToken.js";
import type { AppContext, AppEnv } from "../types.js";

/** Applied to every uploaded file: opaque origin, so report JS can't touch dashboard cookies or APIs. */
export const REPORT_CSP = "sandbox allow-downloads allow-forms allow-popups allow-scripts";

const VERSION_SEGMENT = /^[1-9][0-9]{0,8}$/;
const SYSTEM_ACTOR = { type: "system" as const, id: null, label: null };

/**
 * CORS for report files. The sandboxed report has an opaque ("null") origin,
 * so its module scripts, fonts and fetch() calls to its own files are
 * cross-origin. `*` (never with Allow-Credentials) is safe: browsers refuse
 * `*` for credentialed requests, so a cookie-authorised response can't be
 * read cross-site, and a credential-less request only reaches public content
 * or content authorised by a capability token in the URL.
 */
const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-expose-headers": "accept-ranges, content-range, content-length, etag",
};

export const readRoutes = new Hono<AppEnv>();

function htmlPage(c: AppContext, body: string, status: number, extra: Record<string, string> = {}): Response {
  return c.body(body, status as 200, {
    "content-type": "text/html; charset=utf-8",
    "content-security-policy": PAGE_CSP,
    "cache-control": "private, no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    ...extra,
  });
}

function notFoundHtml(c: AppContext, message?: string): Response {
  return htmlPage(c, notFoundPage(message), 404);
}

/** Decode a percent-encoded path; null on invalid encoding or NUL bytes. */
function decodePath(raw: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null;
  }
  if (decoded.includes("\0")) return null;
  return decoded.replace(/^\/+/, "");
}

// ---- Request classification (Fetch Metadata) -----------------------------------

const NAVIGATION_MODES = new Set(["navigate", "nested-navigate"]);
const NAVIGATION_DESTS = new Set(["document", "iframe", "frame", "embed", "object", "fencedframe"]);
/** Navigations that get redirected to a token URL (so their subresources work). */
const MINT_DESTS = new Set(["document", "iframe", "frame"]);

interface FetchMetadata {
  /** Conservative: requests without Sec-Fetch-* headers count as navigations. */
  isNavigation: boolean;
  dest: string;
}

function fetchMetadata(c: AppContext): FetchMetadata {
  const mode = c.req.header("sec-fetch-mode") ?? "";
  const dest = c.req.header("sec-fetch-dest") ?? "";
  const user = c.req.header("sec-fetch-user");
  // Sec-Fetch-Site is deliberately ignored: requests from an opaque origin are always "cross-site".
  const isNavigation = !mode || !dest || NAVIGATION_MODES.has(mode) || NAVIGATION_DESTS.has(dest) || user === "?1";
  return { isNavigation, dest };
}

// ---- Document resolution ----------------------------------------------------------

interface ResolvedDoc {
  doc_id: string;
  /** The account that owns the repository: the only one whose session or keys open private reports. */
  owner_id: string | null;
  repo_name: string;
  default_access: AccessMode;
  repo_password_hash: string | null;
  access_override: AccessMode | null;
  doc_password_hash: string | null;
  version_id: string | null;
  storage_path: string | null;
  entrypoint: string | null;
  version_number: number | null;
}

interface ManifestHit {
  path: string;
  off: number;
  len: number;
  is_entrypoint: number;
}

interface ReadTarget {
  repo: string;
  doc: string;
  pinned: number | null;
  /** Raw token segment from the URL (without slashes), if any. */
  token: string | null;
  /** The path after the version/token prefix, exactly as in the request URL (still percent-encoded). */
  rawRest: string;
  /** "/r/<repo>/<doc>/" or "/r/<repo>/<doc>/v/<n>/". */
  prefix: string;
}

type Via = "public" | "header" | "token" | "session" | "view" | "unlock";

/** Live sessions whose hash starts with a 16-hex-char session id (prefix range over lowercase hex). */
function sessionsBySidStmt(db: D1Database, sid: string): D1PreparedStatement {
  return db
    .prepare(`SELECT token_hash, user_id FROM sessions WHERE token_hash >= ?1 AND token_hash < ?2 AND expires_at > ?3`)
    .bind(sid, `${sid}g`, new Date().toISOString());
}

/** Whether a session row is live and belongs to the repository's owner. */
function ownerSession(row: SessionUserRow | undefined, ownerId: string | null): boolean {
  return Boolean(row && ownerId && row.user_id === ownerId && !sessionExpired(row));
}

function unauthorizedPlain(c: AppContext): Response {
  return c.body("Unauthorized", 401, {
    "content-type": "text/plain; charset=utf-8",
    "x-content-type-options": "nosniff",
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    vary: "cookie, authorization",
    ...CORS_HEADERS,
  });
}

/** Weak comparison (RFC 9110 §13.1.2): `W/` prefixes are ignored and `*` matches any representation. */
export function etagMatches(header: string, etag: string): boolean {
  const want = etag.replace(/^W\//, "");
  return header.split(",").some((raw) => {
    const tag = raw.trim();
    return tag === "*" || tag.replace(/^W\//, "") === want;
  });
}

type RangeResult = { kind: "full" } | { kind: "partial"; start: number; end: number } | { kind: "unsatisfiable" };

/** Parse a single `bytes=` range; multi-range or malformed headers are ignored (full response). */
export function parseRange(header: string | undefined, length: number): RangeResult {
  if (!header) return { kind: "full" };
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (match[1] === "" && match[2] === "")) return { kind: "full" };
  let start: number;
  let end: number;
  if (match[1] === "") {
    const suffix = Number(match[2]);
    if (suffix === 0 || length === 0) return { kind: "unsatisfiable" };
    start = Math.max(0, length - suffix);
    end = length - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === "" ? length - 1 : Number(match[2]);
    if (match[2] !== "" && end < start) return { kind: "full" };
    if (start >= length) return { kind: "unsatisfiable" };
    end = Math.min(end, length - 1);
  }
  return { kind: "partial", start, end };
}

function contentDispositionAttachment(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1) || "download";
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

async function serveDocument(c: AppContext, t: ReadTarget): Promise<Response> {
  const { repo, doc, pinned } = t;
  const rel = decodePath(t.rawRest);
  if (rel === null) return notFoundHtml(c);
  const url = new URL(c.req.url);
  const meta = fetchMetadata(c);
  const now = nowSeconds();
  const urlToken = t.token ? parseReportToken(t.token) : null;

  // Candidate manifest keys: "" -> entrypoint; "dir/" -> "dir/index.html";
  // otherwise the exact path, falling back to "<path>/index.html" (redirect).
  const wantEntrypoint = rel === "" ? 1 : 0;
  const exact = rel === "" ? "" : rel.endsWith("/") ? `${rel}index.html` : rel;
  const fallback = rel === "" || rel.endsWith("/") ? "" : `${rel}/index.html`;

  // ---- Credentials ----
  const header = credentialFromHeader(c.req.header("authorization"));
  const headerIsKey = header ? isApiKeyToken(header) : false;
  const cookies = parseCookies(c.req.header("cookie"));
  // An Authorization header replaces the session cookie (as before); the
  // per-document cookies and URL tokens still apply.
  const sessionToken = header ? (headerIsKey ? null : header) : (cookies.get(SESSION_COOKIE) ?? null);
  const sessionHash = sessionToken ? await sha256Hex(sessionToken) : null;
  const apiKeyHash = header && headerIsKey ? await sha256Hex(header) : null;
  const unlockCookie = cookies.get(unlockCookieName(repo, doc));
  const viewToken = (() => {
    const raw = cookies.get(viewCookieName(repo, doc));
    const parsed = raw ? parseReportToken(raw) : null;
    return parsed?.kind === "s" ? parsed : null;
  })();

  const db = c.env.DB;
  const versionJoin = pinned != null ? "v.document_id = d.id AND v.version_number = ?3" : "v.id = d.latest_version_id";
  const docParams = pinned != null ? [repo, doc, pinned] : [repo, doc];
  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `SELECT d.id AS doc_id, r.owner_id, r.name AS repo_name, r.default_access, r.password_hash AS repo_password_hash,
                d.access_override, d.password_hash AS doc_password_hash,
                v.id AS version_id, v.storage_path, v.entrypoint, v.version_number
         FROM repositories r
         JOIN documents d ON d.repository_id = r.id AND d.slug = ?2
         LEFT JOIN document_versions v ON ${versionJoin}
         WHERE r.slug = ?1`,
      )
      .bind(...docParams),
    db
      .prepare(
        `SELECT j.key AS path, json_extract(j.value, '$[0]') AS off, json_extract(j.value, '$[1]') AS len,
                CASE WHEN j.key = v.entrypoint THEN 1 ELSE 0 END AS is_entrypoint
         FROM repositories r
         JOIN documents d ON d.repository_id = r.id AND d.slug = ?2
         JOIN document_versions v ON ${versionJoin},
              json_each(v.manifest) j
         WHERE r.slug = ?1 AND (j.key IN (?4, ?5) OR (?6 = 1 AND j.key = v.entrypoint))`,
      )
      .bind(repo, doc, pinned ?? 0, exact, fallback, wantEntrypoint),
  ];
  const slot = (stmt: D1PreparedStatement): number => statements.push(stmt) - 1;
  const sessionSlot = sessionHash ? slot(sessionLookupStmt(db, sessionHash)) : -1;
  const apiKeySlot = apiKeyHash ? slot(apiKeyLookupStmt(db, apiKeyHash)) : -1;
  const sids = new Set<string>();
  if (urlToken?.kind === "s") sids.add(urlToken.sid!);
  if (viewToken) sids.add(viewToken.sid!);
  const sidSlots = [...sids].map((sid) => slot(sessionsBySidStmt(db, sid)));
  // Fetch the cookie secret in the same batch on a cold isolate, but only
  // when something needs verifying or minting.
  let cookieSecret = cookieSecretSync(c.env);
  const needSecret = Boolean(urlToken || unlockCookie || viewToken || sessionToken);
  const secretSlot = needSecret && !cookieSecret ? slot(settingStmt(db, SETTING_COOKIE_SECRET)) : -1;

  const results = await db.batch(statements);
  const rowsAt = <T>(i: number): T[] => (i >= 0 ? ((results[i]?.results ?? []) as T[]) : []);
  const found = rowsAt<ResolvedDoc>(0)[0];
  if (!found) return notFoundHtml(c);
  if (secretSlot >= 0) {
    const stored = rowsAt<{ value: string }>(secretSlot)[0]?.value;
    if (stored) {
      cookieSecret = stored;
      rememberCookieSecret(c.env, stored);
    }
  }

  // ---- Access gate (before anything about versions or files is revealed) ----
  const access = effectiveAccess(found);
  const passwordHash = effectivePasswordHash(found);
  const scope = pinned != null ? `v${pinned}` : "latest";
  const tokenCtx = (binding: string, tokenScope = scope): ReportTokenContext => ({
    docId: found.doc_id,
    repo,
    doc,
    scope: tokenScope,
    binding,
  });
  // Only the owner's sessions can stand behind a kind-s token.
  const sessionRowsBySid = new Map<string, string[]>();
  [...sids].forEach((sid, i) => {
    sessionRowsBySid.set(
      sid,
      rowsAt<{ token_hash: string; user_id: string }>(sidSlots[i]!)
        .filter((r) => found.owner_id != null && r.user_id === found.owner_id)
        .map((r) => r.token_hash),
    );
  });
  /** Verify a kind-s token against the owner's live sessions sharing its id; returns the matching session hash. */
  const verifySessionToken = async (token: ParsedReportToken, tokenScope: string): Promise<string | null> => {
    if (!cookieSecret) return null;
    for (const hash of sessionRowsBySid.get(token.sid!) ?? []) {
      if (await verifyReportToken(cookieSecret, token, tokenCtx(hash, tokenScope), now)) return hash;
    }
    return null;
  };

  let via: Via | null = access === "public" ? "public" : null;
  /** The owner's session behind the access (cookie, view cookie or kind-s token), for minting. */
  let viewerSessionHash: string | null = null;
  if (!via) {
    if (header) {
      if (apiKeyHash) {
        const row = rowsAt<ApiKeyLookupRow>(apiKeySlot)[0];
        const machine = row ? machineFromRow(row) : null;
        if (row && machine) {
          // Only the owner's keys open private and password-protected reports.
          if (machine.userId === found.owner_id && hasScope(machine, "read", "publish")) {
            via = "header";
            if (shouldTouch(row.last_used_at)) defer(c, touchApiKey(db, machine));
          }
        }
      } else if (validSession()) {
        via = "header";
      }
    }
    // Capability token: subresource requests only; navigations ignore it.
    if (!via && urlToken && !meta.isNavigation && cookieSecret) {
      if (urlToken.kind === "p") {
        if (
          access === "password" &&
          passwordHash &&
          (await verifyReportToken(cookieSecret, urlToken, tokenCtx(passwordBinding(passwordHash)), now))
        ) {
          via = "token";
        }
      } else if (access === "private" || access === "password") {
        const hash = await verifySessionToken(urlToken, scope);
        if (hash) {
          via = "token";
          viewerSessionHash = hash;
        }
      }
    }
    if (!via && !header && validSession()) {
      via = "session";
      viewerSessionHash = sessionHash;
    }
    if (!via && viewToken) {
      const hash = await verifySessionToken(viewToken, "cookie");
      if (hash) {
        via = "view";
        viewerSessionHash = hash;
      }
    }
    if (
      !via &&
      access === "password" &&
      passwordHash &&
      unlockCookie &&
      cookieSecret &&
      (await verifyUnlock(cookieSecret, repo, doc, passwordHash, unlockCookie))
    ) {
      via = "unlock";
    }
  }

  /** A session opens the report only when it belongs to the repository's owner. */
  function validSession(): boolean {
    return ownerSession(rowsAt<SessionUserRow>(sessionSlot)[0], found!.owner_id);
  }

  if (!via) {
    if (!meta.isNavigation) return unauthorizedPlain(c);
    const next = `${t.prefix}${t.rawRest}`; // canonical: never carries a token
    if (access === "password" && passwordHash) {
      return htmlPage(c, passwordGatePage({ repo, doc, next }), 401);
    }
    // On a separate reports host, sign-in happens on the dashboard origin; the
    // dashboard then sends the browser back here through a session handoff.
    const dashboardOrigin = c.get("config").reportsOrigin ? c.get("config").publicBaseUrl : null;
    return htmlPage(c, signInPage({ repo, doc, next, dashboardOrigin }), 401);
  }

  // ---- Version and file ----
  if (!found.version_id || !found.storage_path) {
    return notFoundHtml(c, pinned != null ? `Version ${pinned} not found.` : "This document has no published version yet.");
  }
  const hits = (results[1]?.results ?? []) as ManifestHit[];
  const hit = wantEntrypoint ? hits.find((h) => h.is_entrypoint === 1) : hits.find((h) => h.path === exact);
  // "<path>" that is a directory: redirect to "<path>/" so relative URLs in its index resolve correctly.
  const isDirectory = !hit && fallback !== "" && hits.some((h) => h.path === fallback);
  if (!hit && !isDirectory) return notFoundHtml(c, "This file does not exist in the published report.");

  // ---- Token minting for cookie-authenticated document navigations ----
  const cookieAuthed = via === "session" || via === "view" || via === "unlock";
  // A fresh deployment may not have created its cookie secret yet.
  if (cookieAuthed && !cookieSecret) cookieSecret = await getCookieSecret(c.env);
  let mintedToken: string | null = null;
  if (cookieAuthed && cookieSecret && (c.req.method === "GET" || c.req.method === "HEAD") && MINT_DESTS.has(meta.dest)) {
    const kind = via === "unlock" ? "p" : "s";
    const binding = kind === "p" ? passwordBinding(passwordHash!) : viewerSessionHash!;
    const current =
      urlToken && urlToken.kind === kind && isFresh(urlToken, now)
        ? await verifyReportToken(cookieSecret, urlToken, tokenCtx(binding), now)
        : false;
    if (!current) mintedToken = await mintReportToken(cookieSecret, kind, tokenCtx(binding), now);
  }

  // View cookie: lets absolute-path subresources (/r/<repo>/<doc>/x.css) of a
  // session viewer load in browsers that allow third-party cookies. The
  // session cookie itself stays SameSite=Lax.
  const extraCookies: string[] = [];
  if (via === "session" && meta.isNavigation && cookieSecret && sessionHash) {
    const fresh =
      viewToken && viewToken.sid === sessionHash.slice(0, 16) && isFresh(viewToken, now)
        ? await verifyReportToken(cookieSecret, viewToken, tokenCtx(sessionHash, "cookie"), now)
        : false;
    if (!fresh) {
      const value = await mintReportToken(cookieSecret, "s", tokenCtx(sessionHash, "cookie"), now);
      extraCookies.push(
        serializeCookie(c, viewCookieName(repo, doc), value, {
          path: unlockCookiePath(repo, doc),
          maxAge: REPORT_TOKEN_TTL_SECONDS,
          sameSite: "None",
        }),
      );
    }
  }

  if (mintedToken || isDirectory) {
    const location = mintedToken
      ? `${t.prefix}${mintedToken}/${t.rawRest}${isDirectory ? "/" : ""}${url.search}`
      : `${url.pathname}/${url.search}`;
    const headers = new Headers({
      location,
      "cache-control": access === "public" ? "public, max-age=60" : "no-store",
      "referrer-policy": "no-referrer",
    });
    if (access !== "public") headers.set("vary", "cookie, authorization");
    for (const cookie of extraCookies) headers.append("set-cookie", cookie);
    return new Response(null, { status: mintedToken ? 302 : 308, headers });
  }

  return serveFile(c, found, hit!, access, extraCookies);
}

async function serveFile(
  c: AppContext,
  found: ResolvedDoc,
  hit: ManifestHit,
  access: AccessMode,
  extraCookies: string[],
): Promise<Response> {
  const isPublic = access === "public";
  const contentType = contentTypeFor(hit.path);
  const etag = `"${found.version_id}-${hit.off}-${hit.len}"`;
  const headers = new Headers({
    "content-type": contentType,
    "content-length": String(hit.len),
    "content-security-policy": REPORT_CSP,
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    // Short-lived even for pinned versions: tightening access must take effect
    // quickly in browsers and shared caches (the ETag makes revalidation cheap).
    "cache-control": isPublic ? "public, max-age=60" : "private, no-store",
    "accept-ranges": "bytes",
    etag,
    ...CORS_HEADERS,
  });
  if (!isPublic) headers.set("vary", "cookie, authorization");
  if (contentType.startsWith("application/pdf")) {
    // Chromium's PDF viewer refuses to run in a sandboxed document, which
    // would show a blank page. Default to a predictable download; PDF_INLINE
    // serves PDFs inline without the sandbox (the viewer runs in its own
    // origin, never ours, and nosniff pins the type).
    if (c.get("config").pdfInline) headers.delete("content-security-policy");
    else headers.set("content-disposition", contentDispositionAttachment(hit.path));
  }
  for (const cookie of extraCookies) headers.append("set-cookie", cookie);

  const ifNoneMatch = c.req.header("if-none-match");
  if (ifNoneMatch && etagMatches(ifNoneMatch, etag)) {
    headers.delete("content-length");
    return new Response(null, { status: 304, headers });
  }

  // Range requests (Safari needs 206 to play media). If-Range must match the strong ETag.
  const ifRange = c.req.header("if-range");
  const range = ifRange && ifRange.trim() !== etag ? { kind: "full" as const } : parseRange(c.req.header("range"), hit.len);
  if (range.kind === "unsatisfiable") {
    headers.set("content-range", `bytes */${hit.len}`);
    headers.set("content-length", "0");
    return new Response(null, { status: 416, headers });
  }
  let offset = hit.off;
  let length = hit.len;
  let status = 200;
  if (range.kind === "partial") {
    offset = hit.off + range.start;
    length = range.end - range.start + 1;
    status = 206;
    headers.set("content-range", `bytes ${range.start}-${range.end}/${hit.len}`);
    headers.set("content-length", String(length));
  }
  if (c.req.method === "HEAD") return new Response(null, { status, headers });
  if (length === 0) return new Response(new Uint8Array(0), { status, headers });

  const object = await c.env.BUCKET.get(found.storage_path!, { range: { offset, length } });
  if (!object) {
    console.error(`missing blob ${found.storage_path}`);
    return notFoundHtml(c, "The stored files for this version are missing.");
  }
  // Pipe through a FixedLengthStream so the response carries Content-Length.
  const { readable, writable } = new FixedLengthStream(length);
  defer(c, object.body.pipeTo(writable));
  return new Response(readable, { status, headers });
}

function preflight(c: AppContext): Response {
  return c.body(null, 204, {
    ...CORS_HEADERS,
    "access-control-allow-methods": "GET, HEAD",
    "access-control-allow-headers": "range, if-range, if-none-match, if-modified-since",
    "access-control-max-age": "600",
    "cache-control": "public, max-age=600",
  });
}

async function repoIndex(c: AppContext, repo: string): Promise<Response> {
  const db = c.env.DB;
  const [repoRes, docsRes] = await db.batch([
    db.prepare(`SELECT slug, name, description, index_enabled, default_access FROM repositories WHERE slug = ?`).bind(repo),
    db
      .prepare(
        `SELECT d.slug, d.title FROM documents d JOIN repositories r ON r.id = d.repository_id
         WHERE r.slug = ? AND d.latest_version_id IS NOT NULL
           AND COALESCE(d.access_override, r.default_access) = 'public'
         ORDER BY d.title COLLATE NOCASE`,
      )
      .bind(repo),
  ]);
  const row = repoRes?.results[0] as
    | { slug: string; name: string; description: string | null; index_enabled: number; default_access: AccessMode }
    | undefined;
  const docs = (docsRes?.results ?? []) as { slug: string; title: string }[];
  // A private/password repository's name and description are not published,
  // unless it actually contains public documents to list.
  if (!row || row.index_enabled !== 1 || (row.default_access !== "public" && docs.length === 0)) {
    return notFoundHtml(c);
  }
  return htmlPage(c, repoIndexPage(row, docs), 200, { "cache-control": "public, max-age=60" });
}

/**
 * Only same-document relative paths are accepted as post-unlock redirect
 * targets. A capability token segment is stripped: the next navigation (now
 * carrying the unlock cookie) mints a fresh one.
 */
export function safeNext(next: string | undefined, repo: string, doc: string): string {
  const prefix = `/r/${repo}/${doc}/`;
  if (!next || !next.startsWith(prefix) || /[\\\r\n\t]/.test(next) || next.includes("//")) return prefix;
  let rest = next.slice(prefix.length);
  const pinned = /^v\/[^/]+\//.exec(rest)?.[0] ?? "";
  const afterPinned = rest.slice(pinned.length);
  const slash = afterPinned.indexOf("/");
  const segment = slash < 0 ? afterPinned : afterPinned.slice(0, slash);
  if (isReportTokenSegment(segment)) rest = pinned + (slash < 0 ? "" : afterPinned.slice(slash + 1));
  return prefix + rest;
}

async function unlock(c: AppContext, repo: string, doc: string): Promise<Response> {
  let password: string | undefined;
  let next: string | undefined;
  try {
    const form = await c.req.parseBody();
    if (typeof form.password === "string") password = form.password;
    if (typeof form.next === "string") next = form.next;
  } catch {
    /* treated as a missing password below */
  }
  const target = safeNext(next, repo, doc);
  const db = c.env.DB;
  const found = await db
    .prepare(
      `SELECT r.id AS repo_id, d.id AS doc_id, r.default_access, r.password_hash AS repo_password_hash,
              d.access_override, d.password_hash AS doc_password_hash
       FROM repositories r JOIN documents d ON d.repository_id = r.id AND d.slug = ?2
       WHERE r.slug = ?1`,
    )
    .bind(repo, doc)
    .first<
      Pick<ResolvedDoc, "doc_id" | "default_access" | "repo_password_hash" | "access_override" | "doc_password_hash"> & {
        repo_id: string;
      }
    >();
  if (!found) return notFoundHtml(c);
  const hash = effectivePasswordHash(found);
  if (effectiveAccess(found) !== "password" || !hash) return c.redirect(target, 303);

  // Rate limits are keyed on the secret being guessed — a repository password
  // shared by many documents gets one budget, not one per document — per
  // client network, plus a failure ceiling across all networks.
  const ip = clientIp(c);
  const secretId = (await sha256Hex(passwordBinding(hash))).slice(0, 24);
  const ipKey = `unlock:${rateLimitClientKey(ip)}:${secretId}`;
  const globalKey = `unlock:global:${secretId}`;
  const [hit, globalRow] = await db.batch([rateLimitHitStmt(db, ipKey, UNLOCK_LIMIT), rateLimitPeekStmt(db, globalKey)]);
  defer(c, rateLimitPurgeStmt(db).run());
  const limit = evaluateRateLimit(hit?.results[0] as { count: number; reset_at: number } | undefined, UNLOCK_LIMIT);
  const global = evaluateGlobalLimit(
    globalRow?.results[0] as { count: number; reset_at: number } | undefined,
    UNLOCK_GLOBAL_LIMIT,
  );
  if (!limit.allowed || !global.allowed) {
    if (limit.firstRejection) {
      defer(
        c,
        auditStmt(db, { event: "auth.rate_limited", actor: SYSTEM_ACTOR, repo, doc, detail: `scope=unlock ip=${ip}` }).run(),
      );
    }
    const retryAfter = Math.max(limit.allowed ? 0 : limit.retryAfterSeconds, global.allowed ? 0 : global.retryAfterSeconds);
    return htmlPage(
      c,
      passwordGatePage({ repo, doc, next: target, error: "Too many attempts. Wait a few minutes and try again." }),
      429,
      { "retry-after": String(retryAfter) },
    );
  }

  const parsed = passwordUnlockSchema.safeParse({ password });
  if (!parsed.success || !(await verifyPassword(parsed.data.password, hash))) {
    defer(
      c,
      db.batch([
        auditStmt(db, { event: "report.unlock_failed", actor: SYSTEM_ACTOR, repo, doc, detail: `ip=${ip}` }),
        rateLimitHitStmt(db, globalKey, UNLOCK_GLOBAL_LIMIT),
        auditStmt(
          db,
          { event: "auth.rate_limited", actor: SYSTEM_ACTOR, repo, doc, detail: "scope=unlock-global (all networks)" },
          { sql: "(SELECT count FROM rate_limits WHERE key = ?) = ?", params: [globalKey, UNLOCK_GLOBAL_LIMIT.max] },
        ),
      ]),
    );
    return htmlPage(c, passwordGatePage({ repo, doc, next: target, error: "Incorrect password. Try again." }), 401);
  }

  const followUp: D1PreparedStatement[] = [
    auditStmt(db, { event: "report.unlock", actor: SYSTEM_ACTOR, repo, doc, detail: `ip=${ip}` }),
  ];
  const iterations = c.get("config").pbkdf2Iterations;
  if (passwordHashIterations(hash) !== iterations) {
    // Move the stored hash to the configured cost. The salt is kept, so
    // cookies and tokens bound to this password stay valid.
    const rehashed = await rehashPassword(parsed.data.password, hash, iterations);
    followUp.push(
      found.doc_password_hash
        ? db.prepare(`UPDATE documents SET password_hash = ? WHERE id = ? AND password_hash = ?`).bind(rehashed, found.doc_id, hash)
        : db.prepare(`UPDATE repositories SET password_hash = ? WHERE id = ? AND password_hash = ?`).bind(rehashed, found.repo_id, hash),
    );
  }
  defer(c, db.batch(followUp));
  const secret = await getCookieSecret(c.env);
  // SameSite=None: the report is a sandboxed (opaque-origin) document, so its
  // own subresource requests are cross-site and a Lax cookie would be dropped.
  setCookie(c, unlockCookieName(repo, doc), await signUnlock(secret, repo, doc, hash), {
    path: unlockCookiePath(repo, doc),
    sameSite: "None",
  });
  c.header("cache-control", "no-store");
  return c.redirect(target, 303);
}

// ---- Separate reports host (REPORTS_HOST) -----------------------------------------

function slugsFromPath(pathname: string): { repo: string; doc: string } | null {
  const match = /^\/r\/([^/]+)\/([^/]+)(?:\/|$)/.exec(pathname);
  if (!match || !isValidSlug(match[1]!) || !isValidSlug(match[2]!)) return null;
  return { repo: match[1]!, doc: match[2]! };
}

/**
 * /r/* requested on the dashboard host: send it to the reports host. The
 * signed-in owner navigating to a protected report gets a short-lived,
 * session-bound handoff token that the reports host exchanges for its own
 * view cookie (the session cookie never leaves the dashboard host).
 */
async function toReportsHost(c: AppContext, url: URL, reportsOrigin: string): Promise<Response> {
  if (c.req.method !== "GET" && c.req.method !== "HEAD") return notFoundHtml(c);
  const plain = `${reportsOrigin}${url.pathname}${url.search}`;
  const slugs = slugsFromPath(url.pathname);
  const sessionToken = parseCookies(c.req.header("cookie")).get(SESSION_COOKIE);
  if (!slugs || !sessionToken || !fetchMetadata(c).isNavigation) return c.redirect(plain, 308);

  const db = c.env.DB;
  const sessionHash = await sha256Hex(sessionToken);
  const [docRes, sessionRes] = await db.batch([
    db
      .prepare(
        `SELECT d.id AS doc_id, r.owner_id, COALESCE(d.access_override, r.default_access) AS access
         FROM repositories r JOIN documents d ON d.repository_id = r.id AND d.slug = ?2 WHERE r.slug = ?1`,
      )
      .bind(slugs.repo, slugs.doc),
    sessionLookupStmt(db, sessionHash),
  ]);
  const found = docRes?.results[0] as { doc_id: string; owner_id: string | null; access: AccessMode } | undefined;
  const session = sessionRes?.results[0] as SessionUserRow | undefined;
  // Only the owner gets a handoff; anyone else continues as an anonymous visitor.
  if (!found || found.access === "public" || !ownerSession(session, found.owner_id)) return c.redirect(plain, 308);
  const secret = await getCookieSecret(c.env);
  const ctx = { docId: found.doc_id, repo: slugs.repo, doc: slugs.doc, scope: "handoff", binding: sessionHash };
  const token = await mintReportToken(secret, "s", ctx, nowSeconds(), HANDOFF_TOKEN_TTL_SECONDS);
  const next = safeNext(`${url.pathname}${url.search}`, slugs.repo, slugs.doc);
  const location = `${reportsOrigin}/r/${slugs.repo}/${slugs.doc}/__view?t=${encodeURIComponent(token)}&next=${encodeURIComponent(next)}`;
  return new Response(null, {
    status: 302,
    headers: { location, "cache-control": "no-store", "referrer-policy": "no-referrer" },
  });
}

/** Reports host: exchange a handoff token for this host's view cookie, then go to the report. */
async function viewHandoff(c: AppContext, repo: string, doc: string): Promise<Response> {
  const target = safeNext(c.req.query("next"), repo, doc);
  const token = parseReportToken(c.req.query("t") ?? "");
  const headers = new Headers({ location: target, "cache-control": "no-store", "referrer-policy": "no-referrer" });
  if (token?.kind === "s") {
    const db = c.env.DB;
    const [docRes, sessions] = await db.batch([
      db
        .prepare(
          `SELECT d.id AS doc_id, r.owner_id FROM repositories r JOIN documents d ON d.repository_id = r.id AND d.slug = ?2
           WHERE r.slug = ?1`,
        )
        .bind(repo, doc),
      sessionsBySidStmt(db, token.sid!),
    ]);
    const found = docRes?.results[0] as { doc_id: string; owner_id: string | null } | undefined;
    if (found) {
      const secret = await getCookieSecret(c.env);
      const now = nowSeconds();
      for (const row of (sessions?.results ?? []) as { token_hash: string; user_id: string }[]) {
        if (!found.owner_id || row.user_id !== found.owner_id) continue;
        const ctx = { docId: found.doc_id, repo, doc, scope: "handoff", binding: row.token_hash };
        if (!(await verifyReportToken(secret, token, ctx, now))) continue;
        const value = await mintReportToken(secret, "s", { ...ctx, scope: "cookie" }, now);
        headers.append(
          "set-cookie",
          serializeCookie(c, viewCookieName(repo, doc), value, {
            path: unlockCookiePath(repo, doc),
            maxAge: REPORT_TOKEN_TTL_SECONDS,
            sameSite: "None",
          }),
        );
        break;
      }
    }
  }
  return new Response(null, { status: 303, headers });
}

readRoutes.all("/r/*", async (c) => {
  const url = new URL(c.req.url);
  const reportsOrigin = c.get("config").reportsOrigin;
  if (reportsOrigin && url.host !== new URL(reportsOrigin).host) return toReportsHost(c, url, reportsOrigin);
  const rest = url.pathname.slice(3); // after "/r/"
  const firstSlash = rest.indexOf("/");
  const repo = firstSlash < 0 ? rest : rest.slice(0, firstSlash);
  if (!isValidSlug(repo)) return notFoundHtml(c);
  const method = c.req.method;
  const isRead = method === "GET" || method === "HEAD";

  if (firstSlash < 0) {
    return isRead ? c.redirect(`/r/${repo}/${url.search}`, 308) : notFoundHtml(c);
  }
  const afterRepo = rest.slice(firstSlash + 1);
  if (afterRepo === "") return isRead ? repoIndex(c, repo) : notFoundHtml(c);

  const docSlash = afterRepo.indexOf("/");
  const doc = docSlash < 0 ? afterRepo : afterRepo.slice(0, docSlash);
  if (!isValidSlug(doc)) return notFoundHtml(c);
  if (docSlash < 0) {
    return isRead ? c.redirect(`/r/${repo}/${doc}/${url.search}`, 308) : notFoundHtml(c);
  }
  const filePath = afterRepo.slice(docSlash + 1);

  if (method === "POST" && filePath === "__unlock") return unlock(c, repo, doc);
  if (reportsOrigin && isRead && filePath === "__view") return viewHandoff(c, repo, doc);
  if (method === "OPTIONS") return preflight(c);

  // Pinned version: v/<n> (redirect) and v/<n>/<path>.
  let prefix = `/r/${repo}/${doc}/`;
  let pinned: number | null = null;
  let afterPrefix = filePath;
  const pinnedMatch = /^v\/([^/]+)(\/.*)?$/.exec(filePath);
  if (pinnedMatch) {
    const segment = pinnedMatch[1]!;
    if (!isRead) return methodNotAllowed(c);
    if (!VERSION_SEGMENT.test(segment)) return notFoundHtml(c, `Version ${segment} not found.`);
    if (pinnedMatch[2] === undefined) {
      return c.redirect(`/r/${repo}/${doc}/v/${segment}/${url.search}`, 308);
    }
    pinned = Number(segment);
    prefix += `v/${segment}/`;
    afterPrefix = pinnedMatch[2].slice(1);
  }

  // Capability token segment (regex-only match; see services/reportToken.ts).
  let token: string | null = null;
  const tokenSlash = afterPrefix.indexOf("/");
  const candidate = tokenSlash < 0 ? afterPrefix : afterPrefix.slice(0, tokenSlash);
  if (isReportTokenSegment(candidate)) {
    if (!isRead) return notFoundHtml(c);
    if (tokenSlash < 0) return c.redirect(`${prefix}${candidate}/${url.search}`, 308);
    token = candidate;
    afterPrefix = afterPrefix.slice(tokenSlash + 1);
  }

  if (!isRead) return methodNotAllowed(c);
  return serveDocument(c, { repo, doc, pinned, token, rawRest: afterPrefix, prefix });
});

function methodNotAllowed(c: AppContext): Response {
  return c.body("Method Not Allowed", 405, { allow: "GET, HEAD, OPTIONS", "content-type": "text/plain; charset=utf-8" });
}
