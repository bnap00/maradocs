// Fixed-window rate limiting backed by D1 (Workers have no shared memory).
// One atomic upsert per check; no read-modify-write race.
//
// Buckets are keyed by the client's network, not its exact address: an IPv6
// client controls at least a /64, so per-address buckets would give it 2^64
// fresh windows. Global per-target counters (failures only) cap guessing
// from many networks at once.

export interface RateLimitRule {
  /** Maximum hits allowed per window. */
  max: number;
  windowMs: number;
}

const WINDOW_MS = 15 * 60 * 1000;

export const LOGIN_LIMIT: RateLimitRule = { max: 5, windowMs: WINDOW_MS };
export const UNLOCK_LIMIT: RateLimitRule = { max: 10, windowMs: WINDOW_MS };
/** Account registrations per client network. */
export const REGISTER_LIMIT: RateLimitRule = { max: 5, windowMs: 60 * 60 * 1000 };
/** Password checks (change password, delete account) per account. */
export const ACCOUNT_PASSWORD_LIMIT: RateLimitRule = { max: 10, windowMs: 60 * 60 * 1000 };
/** Failed logins from all networks combined. */
export const LOGIN_GLOBAL_LIMIT: RateLimitRule = { max: 100, windowMs: WINDOW_MS };
/** Failed unlocks of one password (shared by every document using it), from all networks combined. */
export const UNLOCK_GLOBAL_LIMIT: RateLimitRule = { max: 100, windowMs: WINDOW_MS };

export interface RateLimitResult {
  allowed: boolean;
  count: number;
  retryAfterSeconds: number;
  /** True for the first rejected hit in a window (audit it once, not on every retry). */
  firstRejection: boolean;
}

function expandIpv6(ip: string): number[] | null {
  let addr = ip.toLowerCase();
  const zone = addr.indexOf("%");
  if (zone >= 0) addr = addr.slice(0, zone);
  let tail: number[] = [];
  // Embedded IPv4 (e.g. ::ffff:192.0.2.1).
  const lastColon = addr.lastIndexOf(":");
  const maybeV4 = addr.slice(lastColon + 1);
  if (maybeV4.includes(".")) {
    const octets = maybeV4.split(".").map(Number);
    if (octets.length !== 4 || octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) return null;
    tail = [(octets[0]! << 8) | octets[1]!, (octets[2]! << 8) | octets[3]!];
    addr = `${addr.slice(0, lastColon + 1)}0:0`;
  }
  const halves = addr.split("::");
  if (halves.length > 2) return null;
  const parse = (part: string): number[] | null => {
    if (part === "") return [];
    const groups = part.split(":");
    const out: number[] = [];
    for (const g of groups) {
      if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  const head = parse(halves[0]!);
  const rest = halves.length === 2 ? parse(halves[1]!) : [];
  if (!head || !rest) return null;
  let groups: number[];
  if (halves.length === 2) {
    const fill = 8 - head.length - rest.length;
    if (fill < 1) return null;
    groups = [...head, ...new Array<number>(fill).fill(0), ...rest];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;
  if (tail.length) groups.splice(6, 2, ...tail);
  return groups;
}

/**
 * The rate-limit identity of a client address: IPv4 as-is, IPv6 reduced to
 * its /64 prefix (IPv4-mapped IPv6 becomes the IPv4 address).
 */
export function rateLimitClientKey(ip: string): string {
  const value = ip.trim();
  if (!value.includes(":")) return value || "unknown";
  const groups = expandIpv6(value);
  if (!groups) return value.toLowerCase();
  const isMapped = groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff;
  if (isMapped) {
    return [groups[6]! >> 8, groups[6]! & 255, groups[7]! >> 8, groups[7]! & 255].join(".");
  }
  return `${groups
    .slice(0, 4)
    .map((g) => g.toString(16))
    .join(":")}::/64`;
}

/** Statement that records one hit and returns the window's count (for batching). */
export function rateLimitHitStmt(
  db: D1Database,
  key: string,
  rule: RateLimitRule,
  now = Date.now(),
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO rate_limits (key, count, reset_at) VALUES (?1, 1, ?2)
       ON CONFLICT(key) DO UPDATE SET
         count = CASE WHEN rate_limits.reset_at <= ?3 THEN 1 ELSE rate_limits.count + 1 END,
         reset_at = CASE WHEN rate_limits.reset_at <= ?3 THEN ?2 ELSE rate_limits.reset_at END
       RETURNING count, reset_at`,
    )
    .bind(key, now + rule.windowMs, now);
}

/** Statement reading a counter without recording a hit (for failure-only global counters). */
export function rateLimitPeekStmt(db: D1Database, key: string, now = Date.now()): D1PreparedStatement {
  return db.prepare(`SELECT count, reset_at FROM rate_limits WHERE key = ? AND reset_at > ?`).bind(key, now);
}

export function evaluateRateLimit(
  row: { count: number; reset_at: number } | undefined,
  rule: RateLimitRule,
  now = Date.now(),
): RateLimitResult {
  const count = row?.count ?? 1;
  const resetAt = row?.reset_at ?? now + rule.windowMs;
  return {
    allowed: count <= rule.max,
    count,
    retryAfterSeconds: Math.max(1, Math.ceil((resetAt - now) / 1000)),
    firstRejection: count === rule.max + 1,
  };
}

/** Evaluate a peeked failure counter: blocked once `max` failures were recorded in the window. */
export function evaluateGlobalLimit(
  row: { count: number; reset_at: number } | undefined,
  rule: RateLimitRule,
  now = Date.now(),
): RateLimitResult {
  const count = row?.count ?? 0;
  const resetAt = row?.reset_at ?? now + rule.windowMs;
  return {
    allowed: count < rule.max,
    count,
    retryAfterSeconds: Math.max(1, Math.ceil((resetAt - now) / 1000)),
    firstRejection: false,
  };
}

export function rateLimitResetStmt(db: D1Database, key: string): D1PreparedStatement {
  return db.prepare(`DELETE FROM rate_limits WHERE key = ?`).bind(key);
}

/** Drop expired windows; run opportunistically off the request path. */
export function rateLimitPurgeStmt(db: D1Database, now = Date.now()): D1PreparedStatement {
  return db.prepare(`DELETE FROM rate_limits WHERE reset_at <= ?`).bind(now);
}
