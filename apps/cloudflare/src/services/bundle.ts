// Zip bundle handling: safe extraction, packing all files of a version into a
// single R2 blob (+ byte-range manifest), checksum, and rebuilding a zip for
// download.
//
// The zip's central directory is parsed here (no JS inflate library):
//   - every entry is validated (path, size budget, overlap) before any byte is
//     inflated, using the sizes the archive declares;
//   - deflated entries are inflated by the runtime's native
//     DecompressionStream, counting output bytes: an entry producing more than
//     it declared is rejected at once (no silent truncation, no CPU spent on
//     a bomb), one producing less is rejected at the end, and CRC-32s are
//     verified;
//   - files are written straight into one preallocated blob (no per-file
//     copies), which is uploaded only once every entry has been verified.

import { crc32 } from "node:zlib";
import { HttpError, badRequest, payloadTooLarge } from "../errors.js";
import { toHex } from "../crypto.js";
import { isReportTokenSegment } from "./reportToken.js";

export const MAX_BUNDLE_FILES = 2000;
export const MAX_ENTRY_PATH_LENGTH = 240;
export const MAX_ENTRY_DEPTH = 20;

/**
 * `{ "<path>": [offset, length, crc32?] }`, stored as JSON in
 * document_versions.manifest. The CRC-32 lets downloads stream a zip without
 * reading the files first; manifests written before it was recorded lack it.
 */
export type Manifest = Record<string, [number, number] | [number, number, number]>;

const invalidZip = (): HttpError => badRequest("Uploaded bundle is not a valid zip archive");

/**
 * Normalise a zip entry name into a safe relative posix path, like the Node
 * server (normalise, then reject anything escaping the root). Returns "" for
 * directory-like names and null for anything unsafe (absolute paths, drive
 * letters, NUL or other control characters, `..` above the root).
 */
export function safeEntryName(rawName: string): string | null {
  const name = rawName.replace(/\\/g, "/");
  // eslint-disable-next-line no-control-regex -- rejecting control characters is the point
  if (/[\u0000-\u001f\u007f]/.test(name)) return null;
  if (name.startsWith("/") || /^[a-zA-Z]:/.test(name)) return null;
  const out: string[] = [];
  for (const segment of name.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (out.length === 0) return null;
      out.pop();
      continue;
    }
    out.push(segment);
  }
  return out.join("/");
}

const compareStrings = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export interface BundleEntry {
  /** Entry name as stored in the archive. */
  name: string;
  /** Normalised relative path. */
  path: string;
  method: 0 | 8;
  compressedSize: number;
  size: number;
  crc: number;
  localOffset: number;
  dataStart: number;
}

export interface ParsedBundle {
  /** File entries, sorted by path. */
  entries: BundleEntry[];
  /** Total uncompressed size (as declared, and verified while packing). */
  sizeBytes: number;
  files: string[];
}

const utf8Fatal = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const utf8 = new TextDecoder("utf-8");

function decodeName(bytes: Uint8Array, flags: number): string {
  if (flags & 0x800) return utf8.decode(bytes);
  try {
    // Many tools write UTF-8 names without setting the language-encoding flag.
    return utf8Fatal.decode(bytes);
  } catch {
    let out = "";
    for (const b of bytes) out += String.fromCharCode(b);
    return out;
  }
}

/** Parse and validate a zip's central directory. Nothing is inflated. */
export function parseBundle(zip: Uint8Array, maxBytes: number): ParsedBundle {
  if (zip.byteLength < 22) throw invalidZip();
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const len = zip.byteLength;
  const u16 = (o: number): number => view.getUint16(o, true);
  const u32 = (o: number): number => view.getUint32(o, true);
  const u64 = (o: number): number => {
    const lo = u32(o);
    const hi = u32(o + 4);
    if (hi > 0x1fffff) throw invalidZip();
    return hi * 2 ** 32 + lo;
  };
  const inBounds = (offset: number, size: number): boolean => offset >= 0 && size >= 0 && offset + size <= len;

  let eocd = -1;
  for (let i = len - 22; i >= Math.max(0, len - 22 - 0xffff); i -= 1) {
    if (u32(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw invalidZip();
  let total = u16(eocd + 10);
  let cdSize = u32(eocd + 12);
  let cdOffset = u32(eocd + 16);
  if (total === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    const locator = eocd - 20;
    if (locator < 0 || u32(locator) !== 0x07064b50) throw invalidZip();
    const z64 = u64(locator + 8);
    if (!inBounds(z64, 56) || u32(z64) !== 0x06064b50) throw invalidZip();
    total = u64(z64 + 32);
    cdSize = u64(z64 + 40);
    cdOffset = u64(z64 + 48);
  }
  if (!inBounds(cdOffset, cdSize)) throw invalidZip();

  const entries: BundleEntry[] = [];
  const seen = new Set<string>();
  let declaredBytes = 0;
  let p = cdOffset;
  const cdEnd = cdOffset + cdSize;
  for (let i = 0; i < total; i += 1) {
    if (p + 46 > cdEnd || u32(p) !== 0x02014b50) throw invalidZip();
    const flags = u16(p + 8);
    const method = u16(p + 10);
    const crc = u32(p + 16);
    let compressedSize = u32(p + 20);
    let size = u32(p + 24);
    const nameLen = u16(p + 28);
    const extraLen = u16(p + 30);
    const commentLen = u16(p + 32);
    let localOffset = u32(p + 42);
    if (p + 46 + nameLen + extraLen + commentLen > cdEnd) throw invalidZip();
    const name = decodeName(zip.subarray(p + 46, p + 46 + nameLen), flags);
    if (size === 0xffffffff || compressedSize === 0xffffffff || localOffset === 0xffffffff) {
      // Zip64 extended information: present values follow in this order.
      let q = p + 46 + nameLen;
      const extraEnd = q + extraLen;
      let found = false;
      while (q + 4 <= extraEnd) {
        const id = u16(q);
        const dataLen = u16(q + 2);
        if (id === 0x0001) {
          let r = q + 4;
          const take = (): number => {
            if (r + 8 > q + 4 + dataLen) throw invalidZip();
            const v = u64(r);
            r += 8;
            return v;
          };
          if (size === 0xffffffff) size = take();
          if (compressedSize === 0xffffffff) compressedSize = take();
          if (localOffset === 0xffffffff) localOffset = take();
          found = true;
          break;
        }
        q += 4 + dataLen;
      }
      if (!found) throw invalidZip();
    }
    p += 46 + nameLen + extraLen + commentLen;

    if (name.endsWith("/") || name.endsWith("\\")) continue; // directory entry
    const rel = safeEntryName(name);
    if (rel === null) throw badRequest(`Unsafe path in bundle: ${name}`);
    if (rel === "") continue;
    if (rel.length > MAX_ENTRY_PATH_LENGTH || rel.split("/").length > MAX_ENTRY_DEPTH) {
      throw badRequest(`Path is too deep or too long in bundle: ${name}`);
    }
    // A top-level directory shaped like a capability token would be shadowed
    // by the token segment of report URLs (see services/reportToken.ts).
    if (isReportTokenSegment(rel.split("/")[0]!)) throw badRequest(`Unsupported file name in bundle: ${name}`);
    if (seen.has(rel)) throw badRequest(`Duplicate path in bundle: ${rel}`);
    seen.add(rel);
    if (seen.size > MAX_BUNDLE_FILES) throw badRequest(`Bundle contains more than ${MAX_BUNDLE_FILES} files`);
    if (flags & 0x1) throw badRequest(`Encrypted bundle entries are not supported: ${name}`);
    if (method !== 0 && method !== 8) {
      throw badRequest(`Unsupported compression method in bundle entry: ${name}`);
    }
    if (method === 0 && compressedSize !== size) throw badRequest(`Bundle entry size mismatch: ${name}`);
    declaredBytes += size;
    if (declaredBytes > maxBytes) throw payloadTooLarge("Bundle exceeds the maximum upload size");

    if (!inBounds(localOffset, 30) || u32(localOffset) !== 0x04034b50) throw invalidZip();
    const dataStart = localOffset + 30 + u16(localOffset + 26) + u16(localOffset + 28);
    // Entry data must lie before the central directory.
    if (!inBounds(dataStart, compressedSize) || dataStart + compressedSize > cdOffset) throw invalidZip();
    entries.push({ name, path: rel, method, compressedSize, size, crc, localOffset, dataStart });
  }
  if (entries.length === 0) throw badRequest("Bundle is empty");

  // Overlapping entries (several names pointing at the same compressed data)
  // are a classic zip-bomb amplifier and never occur in a well-formed archive.
  const byOffset = [...entries].sort((a, b) => a.localOffset - b.localOffset);
  for (let i = 1; i < byOffset.length; i += 1) {
    const prev = byOffset[i - 1]!;
    if (prev.dataStart + prev.compressedSize > byOffset[i]!.localOffset) {
      throw badRequest(`Bundle entries overlap: ${prev.name}, ${byOffset[i]!.name}`);
    }
  }

  entries.sort((a, b) => compareStrings(a.path, b.path));
  return { entries, sizeBytes: declaredBytes, files: entries.map((e) => e.path) };
}

/** Inflate one entry with the native decompressor, enforcing its declared size and CRC. */
async function inflateEntry(
  zip: Uint8Array,
  entry: BundleEntry,
  onChunk: (chunk: Uint8Array) => Promise<void>,
): Promise<void> {
  const compressed = zip.subarray(entry.dataStart, entry.dataStart + entry.compressedSize);
  const ds = new DecompressionStream("deflate-raw");
  const writer = ds.writable.getWriter();
  const feeding = writer
    .write(compressed)
    .then(() => writer.close())
    .catch(() => undefined);
  const reader = ds.readable.getReader();
  let produced = 0;
  let crc = 0;
  try {
    for (;;) {
      let next: ReadableStreamReadResult<Uint8Array>;
      try {
        next = await reader.read();
      } catch {
        throw badRequest(`Bundle entry is corrupt: ${entry.name}`);
      }
      if (next.done) break;
      const chunk = next.value;
      produced += chunk.byteLength;
      if (produced > entry.size) throw badRequest(`Bundle entry is larger than declared: ${entry.name}`);
      crc = crc32(chunk, crc);
      await onChunk(chunk);
    }
  } catch (err) {
    reader.cancel().catch(() => undefined);
    throw err;
  }
  await feeding;
  if (produced !== entry.size) throw badRequest(`Bundle entry is smaller than declared: ${entry.name}`);
  if (crc >>> 0 !== entry.crc) throw badRequest(`Bundle entry is corrupt (CRC mismatch): ${entry.name}`);
}

export interface PackResult {
  /** All file bytes concatenated in path order. */
  blob: Uint8Array;
  manifest: Manifest;
  checksum: string;
  sizeBytes: number;
  fileCount: number;
  files: string[];
}

/**
 * Inflate/copy every file, in path order, straight into one preallocated blob
 * (sized from the validated declarations), verifying each entry's size and
 * CRC, and compute the checksum: SHA-256 over, for each entry sorted by path:
 * path, "\0", bytes — identical to the Node server's checksum. Everything is
 * verified before anything is uploaded.
 */
export async function packBundle(zip: Uint8Array, bundle: ParsedBundle): Promise<PackResult> {
  const blob = new Uint8Array(bundle.sizeBytes);
  // Null prototype: a file named "__proto__" is an ordinary key.
  const manifest = Object.create(null) as Manifest;
  let offset = 0;
  for (const entry of bundle.entries) {
    if (entry.method === 0) {
      const data = zip.subarray(entry.dataStart, entry.dataStart + entry.size);
      if (crc32(data) >>> 0 !== entry.crc) {
        throw badRequest(`Bundle entry is corrupt (CRC mismatch): ${entry.name}`);
      }
      blob.set(data, offset);
    } else {
      let at = offset;
      // inflateEntry guarantees the entry never exceeds its declared size, so
      // writes stay inside this entry's slice of the blob.
      await inflateEntry(zip, entry, async (chunk) => {
        blob.set(chunk, at);
        at += chunk.byteLength;
      });
    }
    manifest[entry.path] = [offset, entry.size, entry.crc];
    offset += entry.size;
  }

  const digest = new crypto.DigestStream("SHA-256");
  const hash = digest.getWriter();
  const encoder = new TextEncoder();
  const nul = new Uint8Array([0]);
  for (const entry of bundle.entries) {
    const [start, length] = manifest[entry.path]!;
    await hash.write(encoder.encode(entry.path));
    await hash.write(nul);
    if (length > 0) await hash.write(blob.subarray(start, start + length));
  }
  await hash.close();
  return {
    blob,
    manifest,
    checksum: toHex(await digest.digest),
    sizeBytes: offset,
    fileCount: bundle.entries.length,
    files: bundle.files,
  };
}

/** Pick the entrypoint: explicit choice if present, else index.html, else the shallowest .html file. */
export function resolveEntrypoint(files: string[], requested?: string): string {
  if (requested && files.includes(requested)) return requested;
  if (files.includes("index.html")) return "index.html";
  const html = files
    .filter((f) => f.toLowerCase().endsWith(".html"))
    .sort((a, b) => a.split("/").length - b.split("/").length);
  return html[0] ?? "index.html";
}

export function parseManifest(raw: string): Manifest {
  const value = JSON.parse(raw) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid manifest");
  // JSON.parse defines "__proto__" as an own key; copy into a null-prototype object anyway.
  return Object.assign(Object.create(null), value) as Manifest;
}

// ---- Zip writing (download) ----------------------------------------------------------
// Downloads are stored (uncompressed) zips: deflating in JavaScript would cost
// far more CPU than the Free plan allows, and the transfer is a one-off.

export interface ZipPlanEntry {
  path: string;
  name: Uint8Array;
  offset: number;
  length: number;
  crc: number | null;
}

export interface ZipPlan {
  entries: ZipPlanEntry[];
  /** Exact byte length of the zip. */
  zipLength: number;
  /** Bytes of the packed blob covered by the manifest. */
  blobLength: number;
  time: number;
  date: number;
}

function dosDateTime(when: Date): { time: number; date: number } {
  const d = when.getUTCFullYear() >= 1980 && when.getUTCFullYear() < 2099 ? when : new Date();
  return {
    time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1),
    date: ((d.getUTCFullYear() - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
  };
}

export function planZip(manifest: Manifest, mtime: Date): ZipPlan {
  const encoder = new TextEncoder();
  const entries = Object.keys(manifest)
    .map((path) => {
      const value = manifest[path]!;
      const crc = value[2] ?? (value[1] === 0 ? 0 : null);
      return { path, name: encoder.encode(path), offset: value[0], length: value[1], crc };
    })
    .sort((a, b) => a.offset - b.offset || compareStrings(a.path, b.path));
  let zipLength = 22;
  let blobLength = 0;
  for (const e of entries) {
    zipLength += 30 + e.name.byteLength + e.length + 46 + e.name.byteLength;
    blobLength = Math.max(blobLength, e.offset + e.length);
  }
  return { entries, zipLength, blobLength, ...dosDateTime(mtime) };
}

function localHeader(plan: ZipPlan, e: ZipPlanEntry, crc: number): Uint8Array {
  const buf = new Uint8Array(30 + e.name.byteLength);
  const v = new DataView(buf.buffer);
  v.setUint32(0, 0x04034b50, true);
  v.setUint16(4, 20, true);
  v.setUint16(6, 0x0800, true); // UTF-8 names
  v.setUint16(8, 0, true); // stored
  v.setUint16(10, plan.time, true);
  v.setUint16(12, plan.date, true);
  v.setUint32(14, crc, true);
  v.setUint32(18, e.length, true);
  v.setUint32(22, e.length, true);
  v.setUint16(26, e.name.byteLength, true);
  v.setUint16(28, 0, true);
  buf.set(e.name, 30);
  return buf;
}

function centralDirectory(plan: ZipPlan, crcs: number[]): Uint8Array {
  let size = 22;
  for (const e of plan.entries) size += 46 + e.name.byteLength;
  const buf = new Uint8Array(size);
  const v = new DataView(buf.buffer);
  let p = 0;
  let localOffset = 0;
  plan.entries.forEach((e, i) => {
    v.setUint32(p, 0x02014b50, true);
    v.setUint16(p + 4, (3 << 8) | 20, true); // made by: Unix, zip 2.0
    v.setUint16(p + 6, 20, true);
    v.setUint16(p + 8, 0x0800, true);
    v.setUint16(p + 10, 0, true);
    v.setUint16(p + 12, plan.time, true);
    v.setUint16(p + 14, plan.date, true);
    v.setUint32(p + 16, crcs[i]!, true);
    v.setUint32(p + 20, e.length, true);
    v.setUint32(p + 24, e.length, true);
    v.setUint16(p + 28, e.name.byteLength, true);
    v.setUint32(p + 38, (0o100644 << 16) >>> 0, true); // regular file, rw-r--r--
    v.setUint32(p + 42, localOffset, true);
    buf.set(e.name, p + 46);
    localOffset += 30 + e.name.byteLength + e.length;
    p += 46 + e.name.byteLength;
  });
  const cdSize = p;
  v.setUint32(p, 0x06054b50, true);
  v.setUint16(p + 8, plan.entries.length, true);
  v.setUint16(p + 10, plan.entries.length, true);
  v.setUint32(p + 12, cdSize, true);
  v.setUint32(p + 16, localOffset, true);
  return buf;
}

/** Reads exact byte counts from a stream, chunk by chunk. */
class ByteReader {
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private pending: Uint8Array = new Uint8Array(0);

  constructor(stream: ReadableStream<Uint8Array>) {
    this.reader = stream.getReader();
  }

  async read(n: number, onChunk: (chunk: Uint8Array) => Promise<void>): Promise<void> {
    let left = n;
    while (left > 0) {
      if (this.pending.byteLength === 0) {
        const next = await this.reader.read();
        if (next.done) throw new Error("stored blob is shorter than its manifest");
        this.pending = next.value;
        continue;
      }
      const take = this.pending.subarray(0, Math.min(left, this.pending.byteLength));
      this.pending = this.pending.subarray(take.byteLength);
      left -= take.byteLength;
      await onChunk(take);
    }
  }

  cancel(): void {
    this.reader.cancel().catch(() => undefined);
  }
}

/**
 * Write a stored zip of the packed blob to `sink`. `blob` is the blob's byte
 * stream (read sequentially) or its bytes; entries without a recorded CRC need
 * the bytes (legacy manifests).
 */
export async function writeZip(
  plan: ZipPlan,
  blob: ReadableStream<Uint8Array> | Uint8Array | null,
  sink: WritableStream<Uint8Array>,
): Promise<void> {
  const out = sink.getWriter();
  const reader = blob && !(blob instanceof Uint8Array) ? new ByteReader(blob) : null;
  const bytes = blob instanceof Uint8Array ? blob : null;
  const crcs: number[] = [];
  let position = 0;
  try {
    for (const e of plan.entries) {
      const data = bytes ? bytes.subarray(e.offset, e.offset + e.length) : null;
      const crc = e.crc ?? (data ? crc32(data) >>> 0 : null);
      if (crc === null) throw new Error(`no CRC for ${e.path}`);
      crcs.push(crc);
      await out.write(localHeader(plan, e, crc));
      if (data) {
        if (data.byteLength) await out.write(data);
      } else if (reader && e.length > 0) {
        if (e.offset > position) await reader.read(e.offset - position, async () => undefined);
        await reader.read(e.length, (chunk) => out.write(chunk));
        position = e.offset + e.length;
      }
    }
    await out.write(centralDirectory(plan, crcs));
    await out.close();
  } catch (err) {
    reader?.cancel();
    await out.abort(err).catch(() => undefined);
    throw err;
  }
}

/** Build a stored zip in memory (tests and small tools). Keys are used verbatim as entry names. */
export async function buildStoredZip(files: [string, Uint8Array][], mtime = new Date()): Promise<Uint8Array> {
  const manifest = Object.create(null) as Manifest;
  const parts: Uint8Array[] = [];
  let offset = 0;
  for (const [name, data] of files) {
    manifest[name] = [offset, data.byteLength];
    parts.push(data);
    offset += data.byteLength;
  }
  const blob = new Uint8Array(offset);
  let o = 0;
  for (const part of parts) {
    blob.set(part, o);
    o += part.byteLength;
  }
  const plan = planZip(manifest, mtime);
  const chunks: Uint8Array[] = [];
  await writeZip(plan, blob, new WritableStream({ write: (chunk) => void chunks.push(chunk.slice()) }));
  const zip = new Uint8Array(plan.zipLength);
  let p = 0;
  for (const chunk of chunks) {
    zip.set(chunk, p);
    p += chunk.byteLength;
  }
  return zip;
}
