// Web Crypto helpers. Everything here runs on the Workers runtime (and on
// Node 22+, which the unit tests use).

const encoder = new TextEncoder();

export function toHex(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let out = "";
  for (const b of view) out += b.toString(16).padStart(2, "0");
  return out;
}

export function toBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64Url(value: string): Uint8Array {
  const b64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export function randomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

export function randomToken(length = 32): string {
  return toBase64Url(randomBytes(length));
}

const ID_PREFIXES = {
  repo: "repo",
  doc: "doc",
  ver: "ver",
  mach: "mach",
  audit: "aud",
  apikey: "akey",
  user: "usr",
} as const;

/** Short, prefixed identifier (same shape as the Node server's ids). */
export function newId(kind: keyof typeof ID_PREFIXES): string {
  return `${ID_PREFIXES[kind]}_${toHex(randomBytes(12))}`;
}

export async function sha256Hex(value: string | Uint8Array): Promise<string> {
  const data = typeof value === "string" ? encoder.encode(value) : value;
  return toHex(await crypto.subtle.digest("SHA-256", data));
}

/** Constant-time string comparison. */
export function timingSafeEqual(a: string, b: string): boolean {
  const x = encoder.encode(a);
  const y = encoder.encode(b);
  let diff = x.length ^ y.length;
  const len = Math.max(x.length, y.length);
  for (let i = 0; i < len; i += 1) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

// Imported HMAC keys are cached per isolate (keyed by the secret), so repeated
// signing with the same secret costs one sign() call, not an import as well.
const hmacKeys = new Map<string, Promise<CryptoKey>>();

function hmacKey(secret: string | Uint8Array): Promise<CryptoKey> {
  const raw = typeof secret === "string" ? encoder.encode(secret) : secret;
  const cacheable = typeof secret === "string";
  if (cacheable) {
    const hit = hmacKeys.get(secret);
    if (hit) return hit;
  }
  const key = crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  if (cacheable) {
    if (hmacKeys.size > 64) hmacKeys.clear();
    hmacKeys.set(secret, key);
    key.catch(() => hmacKeys.delete(secret));
  }
  return key;
}

export async function hmacSha256(secret: string | Uint8Array, message: string | Uint8Array): Promise<Uint8Array> {
  const data = typeof message === "string" ? encoder.encode(message) : message;
  return new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(secret), data));
}

export async function hmacSha256Hex(secret: string | Uint8Array, message: string): Promise<string> {
  return toHex(await hmacSha256(secret, message));
}

// ---- Password hashing (PBKDF2-SHA256) ---------------------------------------
// bcrypt is too CPU-heavy for Workers, so report passwords use PBKDF2 from Web
// Crypto. Stored format: pbkdf2$sha256$<iterations>$<salt b64url>$<hash b64url>

async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    key,
    256,
  );
  return new Uint8Array(bits);
}

export async function hashPassword(password: string, iterations: number, salt = randomBytes(16)): Promise<string> {
  const hash = await pbkdf2(password, salt, iterations);
  return `pbkdf2$sha256$${iterations}$${toBase64Url(salt)}$${toBase64Url(hash)}`;
}

/**
 * Stable identity of a stored password: its random salt. Setting a password
 * (even the same one) always draws a new salt, while rehashing at a new
 * iteration count keeps it — so cookies, tokens and sessions bound to this
 * value die on rotation but survive a cost change.
 */
export function passwordBinding(stored: string): string {
  const parts = stored.split("$");
  return parts.length === 5 && parts[3] ? parts[3] : stored;
}

/** Re-derive a verified password at a new iteration count, keeping its salt (see passwordBinding). */
export function rehashPassword(password: string, stored: string, iterations: number): Promise<string> {
  const parts = stored.split("$");
  return hashPassword(password, iterations, fromBase64Url(parts[3] ?? ""));
}

/** Iteration count embedded in a stored hash, or null for an unknown format. */
export function passwordHashIterations(stored: string): number | null {
  const parts = stored.split("$");
  if (parts.length !== 5 || parts[0] !== "pbkdf2" || parts[1] !== "sha256") return null;
  const iterations = Number(parts[2]);
  return Number.isInteger(iterations) && iterations >= 1 && iterations <= 100_000 ? iterations : null;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const iterations = passwordHashIterations(stored);
  if (iterations === null) return false;
  const parts = stored.split("$");
  const actual = await pbkdf2(password, fromBase64Url(parts[3]!), iterations);
  return timingSafeEqual(toBase64Url(actual), parts[4]!);
}
