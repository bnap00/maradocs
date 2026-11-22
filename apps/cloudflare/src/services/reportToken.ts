// Capability path tokens for protected reports.
//
// Reports are served with a CSP sandbox (opaque origin), so every subresource
// request a report makes is cross-site: browsers that block third-party
// cookies drop the unlock/session cookies, and CORS-mode loads (module
// scripts, fonts, fetch) never carry cookies from an opaque origin at all.
// When a cookie-authenticated browser navigates to a protected report, the
// Worker redirects it to a URL carrying a short-lived token as one path
// segment (/r/<repo>/<doc>/[v/<n>/]~<token>/…). Relative URLs in the report
// resolve under that segment, and the token authorises those subresource
// requests — but never a document navigation, so a copied address-bar URL
// opens nothing in a browser without the cookie.
//
// The token is a bearer secret for non-browser clients until it expires
// (Sec-Fetch-* headers are trivially forged outside a browser): its limits
// are the short TTL and the credential binding (password salt or the owner's
// session), which revoke it on rotation, access change or logout.

import { hmacSha256, hmacSha256Hex, timingSafeEqual, toBase64Url } from "../crypto.js";

/** Token lifetime. Must stay within 1–12 hours. */
export const REPORT_TOKEN_TTL_SECONDS = 4 * 60 * 60;
/** Lifetime of the one-hop token handing the owner's session to the reports host (REPORTS_HOST). */
export const HANDOFF_TOKEN_TTL_SECONDS = 120;
/** Clock skew tolerated on the expiry upper bound. */
const MAX_SKEW_SECONDS = 60;

const TOKEN_P = /^~p\.([0-9a-z]{1,8})\.([A-Za-z0-9_-]{22})$/;
const TOKEN_S = /^~s\.([0-9a-z]{1,8})\.([0-9a-f]{16})\.([A-Za-z0-9_-]{22})$/;

export type ReportTokenKind = "p" | "s";

export interface ParsedReportToken {
  kind: ReportTokenKind;
  exp: number;
  /** First 16 hex chars of sessions.token_hash (kind "s" only). */
  sid: string | null;
  mac: string;
}

/** What a token is bound to. `binding` is the password salt (kind p) or the full session token hash (kind s). */
export interface ReportTokenContext {
  docId: string;
  repo: string;
  doc: string;
  /** "latest", "v<n>" for pinned paths, or "cookie" for the view cookie. */
  scope: string;
  binding: string;
}

/** Strict, regex-only match: a path segment of this shape is always treated as a token. */
export function isReportTokenSegment(segment: string): boolean {
  return TOKEN_P.test(segment) || TOKEN_S.test(segment);
}

export function parseReportToken(value: string): ParsedReportToken | null {
  const p = TOKEN_P.exec(value);
  if (p) return { kind: "p", exp: parseInt(p[1]!, 36), sid: null, mac: p[2]! };
  const s = TOKEN_S.exec(value);
  if (s) return { kind: "s", exp: parseInt(s[1]!, 36), sid: s[2]!, mac: s[3]! };
  return null;
}

// K = HMAC(cookieSecret, "maradocs/report-token/v1"): separate from the
// unlock-cookie MACs. Cached per isolate, keyed by the secret.
const derivedKeys = new Map<string, Promise<string>>();

function tokenKey(cookieSecret: string): Promise<string> {
  let key = derivedKeys.get(cookieSecret);
  if (!key) {
    key = hmacSha256Hex(cookieSecret, "maradocs/report-token/v1");
    if (derivedKeys.size > 8) derivedKeys.clear();
    derivedKeys.set(cookieSecret, key);
  }
  return key;
}

async function tokenMac(cookieSecret: string, kind: ReportTokenKind, ctx: ReportTokenContext, exp: number): Promise<string> {
  const msg = ["rt1", kind, ctx.docId, ctx.repo, ctx.doc, ctx.scope, ctx.binding, String(exp)].join("\n");
  const mac = await hmacSha256(await tokenKey(cookieSecret), msg);
  return toBase64Url(mac.subarray(0, 16));
}

export const nowSeconds = (): number => Math.floor(Date.now() / 1000);

/** Mint a token. For kind "s", ctx.binding must be the session's full token hash. */
export async function mintReportToken(
  cookieSecret: string,
  kind: ReportTokenKind,
  ctx: ReportTokenContext,
  now = nowSeconds(),
  ttlSeconds = REPORT_TOKEN_TTL_SECONDS,
): Promise<string> {
  const exp = now + Math.min(ttlSeconds, REPORT_TOKEN_TTL_SECONDS);
  const mac = await tokenMac(cookieSecret, kind, ctx, exp);
  const expPart = exp.toString(36);
  return kind === "p" ? `~p.${expPart}.${mac}` : `~s.${expPart}.${ctx.binding.slice(0, 16)}.${mac}`;
}

/** Whether a parsed token is unexpired, well-formed for its kind, and MACs over `ctx`. */
export async function verifyReportToken(
  cookieSecret: string,
  token: ParsedReportToken,
  ctx: ReportTokenContext,
  now = nowSeconds(),
): Promise<boolean> {
  if (token.exp <= now || token.exp > now + REPORT_TOKEN_TTL_SECONDS + MAX_SKEW_SECONDS) return false;
  if (token.kind === "s" && token.sid !== ctx.binding.slice(0, 16)) return false;
  return timingSafeEqual(await tokenMac(cookieSecret, token.kind, ctx, token.exp), token.mac);
}

/** Whether a valid token has more than half its lifetime left (otherwise re-mint on navigation). */
export function isFresh(token: ParsedReportToken, now = nowSeconds()): boolean {
  return token.exp - now > REPORT_TOKEN_TTL_SECONDS / 2;
}
