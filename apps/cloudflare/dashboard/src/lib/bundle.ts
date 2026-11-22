// Turn whatever the user picked (a .zip, a folder via <input webkitdirectory>,
// or a drag-and-drop of files/folders) into a zip Blob ready to publish.
//
// Zipping runs on the main thread with fflate's streaming `Zip` class, in
// small chunks with yields in between, so the UI stays responsive and we can
// report progress. fflate's async API is avoided on purpose: it spawns
// workers from blob: URLs, which the dashboard CSP (`script-src 'self'`) blocks.
import { Zip, ZipDeflate, ZipPassThrough, unzipSync } from "fflate";

export const MAX_FILES = 2000;
const MAX_PATH = 240;
const MAX_SEGMENTS = 20;
const CHUNK = 512 * 1024;

const IGNORED_NAMES = new Set([".DS_Store", "Thumbs.db", "desktop.ini"]);
const IGNORED_DIRS = new Set(["__MACOSX", ".git", ".svn", ".hg"]);
/** Already-compressed formats are stored instead of deflated. */
const STORED_EXT = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "avif", "ico", "mp4", "webm", "mov", "mp3", "ogg",
  "m4a", "woff", "woff2", "zip", "gz", "br", "zst", "7z", "pdf",
]);

export interface PickedFile {
  path: string;
  file: File;
}

export interface PreparedBundle {
  kind: "zip" | "folder";
  /** Display name: zip filename or folder name. */
  name: string;
  fileCount: number;
  /** Uncompressed size (folder) or declared uncompressed size (zip). */
  totalBytes: number;
  htmlFiles: string[];
  hasIndex: boolean;
  /** The original zip, for kind === "zip". */
  zip?: File;
  /** Files to zip, for kind === "folder". */
  files?: PickedFile[];
}

export class BundleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BundleError";
  }
}

/** Normalise and validate a bundle path the same way the Worker does. */
/** Same shape the Worker reserves for report access tokens in URLs (src/services/reportToken.ts). */
const TOKEN_SEGMENT = /^~(?:p\.[0-9a-z]{1,8}|s\.[0-9a-z]{1,8}\.[0-9a-f]{16})\.[A-Za-z0-9_-]{22}$/;

/** Mirrors the Worker's safeEntryName: ".." may step back inside the bundle but never out of it. */
export function normalisePath(raw: string): string {
  const p = raw.replace(/\\/g, "/");
  // eslint-disable-next-line no-control-regex -- rejecting control characters is the point
  if (/[\u0000-\u001f\u007f]/.test(p)) throw new BundleError(`Unsafe file name: ${JSON.stringify(raw)}`);
  if (p.startsWith("/") || /^[a-zA-Z]:/.test(p)) {
    throw new BundleError(`Absolute paths are not allowed: ${raw}`);
  }
  const parts: string[] = [];
  for (const part of p.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (!parts.length) throw new BundleError(`Path escapes the bundle: ${raw}`);
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  const out = parts.join("/");
  if (!out) throw new BundleError("Empty file name in bundle");
  if (TOKEN_SEGMENT.test(parts[0]!)) throw new BundleError(`Unsupported file name in bundle: ${raw}`);
  if (out.length > MAX_PATH) throw new BundleError(`Path is longer than ${MAX_PATH} characters: ${out.slice(0, 60)}…`);
  if (parts.length > MAX_SEGMENTS) throw new BundleError(`Path is nested more than ${MAX_SEGMENTS} levels deep: ${out.slice(0, 60)}…`);
  return out;
}

function isIgnored(path: string): boolean {
  const parts = path.split("/");
  const name = parts[parts.length - 1] ?? "";
  if (IGNORED_NAMES.has(name) || name.startsWith("._")) return true;
  return parts.slice(0, -1).some((d) => IGNORED_DIRS.has(d));
}

function isHtml(path: string): boolean {
  return /\.html?$/i.test(path);
}

function depth(path: string): number {
  return path.split("/").length;
}

/** Same order the Worker uses to pick an entrypoint: index.html, else the shallowest .html. */
export function defaultEntrypoint(htmlFiles: string[]): string | null {
  if (htmlFiles.includes("index.html")) return "index.html";
  const sorted = [...htmlFiles].sort((a, b) => depth(a) - depth(b) || a.localeCompare(b));
  return sorted[0] ?? null;
}

/** Drop a shared single top-level folder ("report/index.html" → "index.html"). */
function stripCommonRoot(files: PickedFile[]): { files: PickedFile[]; root: string | null } {
  if (!files.length) return { files, root: null };
  const first = files[0]!.path.split("/")[0]!;
  const allShare = files.every((f) => f.path.includes("/") && f.path.split("/")[0] === first);
  if (!allShare) return { files, root: null };
  return {
    files: files.map((f) => ({ path: f.path.slice(first.length + 1), file: f.file })),
    root: first,
  };
}

function finaliseFolder(raw: PickedFile[], fallbackName: string): PreparedBundle {
  const cleaned = raw.filter((f) => !isIgnored(f.path.replace(/\\/g, "/")));
  const { files: stripped, root } = stripCommonRoot(
    cleaned.map((f) => ({ path: f.path.replace(/\\/g, "/").replace(/^\/+/, ""), file: f.file })),
  );
  const seen = new Set<string>();
  const files: PickedFile[] = [];
  for (const f of stripped) {
    const path = normalisePath(f.path);
    if (seen.has(path)) throw new BundleError(`Duplicate file in bundle: ${path}`);
    seen.add(path);
    files.push({ path, file: f.file });
  }
  if (!files.length) throw new BundleError("The folder is empty (nothing to publish).");
  if (files.length > MAX_FILES) {
    throw new BundleError(`Too many files: ${files.length} (the limit is ${MAX_FILES}).`);
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const htmlFiles = files.map((f) => f.path).filter(isHtml);
  return {
    kind: "folder",
    name: root ?? fallbackName,
    fileCount: files.length,
    totalBytes: files.reduce((n, f) => n + f.file.size, 0),
    htmlFiles,
    hasIndex: htmlFiles.includes("index.html"),
    files,
  };
}

/** Zips larger than this (declared, uncompressed) are never unpacked in the browser. */
const REPACK_LIMIT = 256 * 1024 * 1024;

/**
 * Inspect a .zip: list entries and validate names without inflating. Most zips
 * are uploaded byte-for-byte as picked. Two cases are unpacked and re-zipped in
 * the browser so the published bundle has the same shape as a folder upload:
 *  - every file sits under one top-level folder (what "Compress folder" in
 *    macOS/Windows produces), which would otherwise serve `report/index.html`
 *    at the document root and break its relative links;
 *  - the archive contains junk entries (__MACOSX/, .DS_Store, .git/ …).
 */
export async function prepareZip(file: File): Promise<PreparedBundle> {
  const buf = new Uint8Array(await file.arrayBuffer());
  const names: string[] = [];
  let declared = 0;
  try {
    unzipSync(buf, {
      filter(info) {
        if (!info.name.endsWith("/")) {
          names.push(info.name);
          declared += info.originalSize;
        }
        return false; // list only, never inflate here
      },
    });
  } catch {
    throw new BundleError("That file isn't a valid zip archive.");
  }
  const seen = new Set<string>();
  const paths: string[] = [];
  const keep = new Set<string>();
  let ignored = 0;
  for (const raw of names) {
    const path = normalisePath(raw);
    if (isIgnored(path)) {
      ignored++;
      continue;
    }
    if (seen.has(path)) throw new BundleError(`Duplicate file in zip: ${path}`);
    seen.add(path);
    paths.push(path);
    keep.add(raw);
  }
  if (!paths.length) throw new BundleError("The zip archive is empty.");
  if (paths.length > MAX_FILES) {
    throw new BundleError(`Too many files: ${paths.length} (the limit is ${MAX_FILES}).`);
  }

  const first = paths[0]!.split("/")[0]!;
  const singleRoot = paths.every((p) => p.includes("/") && p.split("/")[0] === first);
  if ((singleRoot || ignored > 0) && declared <= REPACK_LIMIT) {
    let inflated: Record<string, Uint8Array>;
    try {
      inflated = unzipSync(buf, { filter: (info) => keep.has(info.name) });
    } catch {
      throw new BundleError("That zip archive could not be extracted (corrupt or unsupported compression).");
    }
    const now = Date.now();
    const files: PickedFile[] = Object.entries(inflated).map(([name, data]) => ({
      path: name,
      file: new File([data as BlobPart], name.slice(name.lastIndexOf("/") + 1) || "file", { lastModified: now }),
    }));
    const repacked = finaliseFolder(files, file.name.replace(/\.zip$/i, ""));
    // Keep the zip's own name for display and the suggested document slug.
    return { ...repacked, name: file.name };
  }

  const htmlFiles = paths.filter(isHtml);
  return {
    kind: "zip",
    name: file.name,
    fileCount: paths.length,
    totalBytes: declared,
    htmlFiles,
    hasIndex: htmlFiles.includes("index.html"),
    zip: file,
  };
}

/** From <input type="file" webkitdirectory>. */
export function prepareFileList(list: FileList | File[]): PreparedBundle {
  const files = Array.from(list).map((file) => ({
    path: file.webkitRelativePath || file.name,
    file,
  }));
  return finaliseFolder(files, "folder");
}

// ── Drag and drop ─────────────────────────────────────────────────────────

function readEntries(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  return new Promise((resolve, reject) => reader.readEntries(resolve, reject));
}

function entryFile(entry: FileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

async function walk(entry: FileSystemEntry, prefix: string, out: PickedFile[]): Promise<void> {
  if (out.length > MAX_FILES) return;
  const path = prefix ? `${prefix}/${entry.name}` : entry.name;
  if (entry.isFile) {
    out.push({ path, file: await entryFile(entry as FileSystemFileEntry) });
    return;
  }
  if (entry.isDirectory) {
    if (IGNORED_DIRS.has(entry.name)) return;
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    // readEntries returns results in batches (100 in Chrome) until empty.
    for (;;) {
      const batch = await readEntries(reader);
      if (!batch.length) break;
      for (const child of batch) await walk(child, path, out);
      if (out.length > MAX_FILES) return;
    }
  }
}

/**
 * Resolve a drop. Must be called synchronously from the drop handler: the
 * DataTransfer items are only readable during the event, so entries are
 * captured before the first await.
 */
export function prepareDrop(dt: DataTransfer): Promise<PreparedBundle> {
  const entries: FileSystemEntry[] = [];
  const looseFiles: File[] = [];
  for (const item of Array.from(dt.items)) {
    if (item.kind !== "file") continue;
    const entry = typeof item.webkitGetAsEntry === "function" ? item.webkitGetAsEntry() : null;
    if (entry) entries.push(entry);
    else {
      const f = item.getAsFile();
      if (f) looseFiles.push(f);
    }
  }
  if (!entries.length && !looseFiles.length) {
    for (const f of Array.from(dt.files)) looseFiles.push(f);
  }

  return (async () => {
    // A single dropped .zip is published as-is.
    if (entries.length === 1 && entries[0]!.isFile && /\.zip$/i.test(entries[0]!.name)) {
      return prepareZip(await entryFile(entries[0] as FileSystemFileEntry));
    }
    if (!entries.length && looseFiles.length === 1 && /\.zip$/i.test(looseFiles[0]!.name)) {
      return prepareZip(looseFiles[0]!);
    }
    const out: PickedFile[] = looseFiles.map((file) => ({ path: file.name, file }));
    for (const e of entries) await walk(e, "", out);
    if (out.length > MAX_FILES) {
      throw new BundleError(`Too many files (the limit is ${MAX_FILES}).`);
    }
    const name = entries.length === 1 && entries[0]!.isDirectory ? entries[0]!.name : "files";
    return finaliseFolder(out, name);
  })();
}

// ── Zipping ───────────────────────────────────────────────────────────────

/** Yield to the event loop at most every ~16ms so the UI can repaint. */
function makeYielder(): () => Promise<void> {
  let last = performance.now();
  return async () => {
    const now = performance.now();
    if (now - last < 16) return;
    await new Promise<void>((r) => setTimeout(r, 0));
    last = performance.now();
  };
}

function extOf(path: string): string {
  const i = path.lastIndexOf(".");
  return i === -1 ? "" : path.slice(i + 1).toLowerCase();
}

/** Zip a prepared folder. `onProgress` receives a 0..1 fraction of bytes processed. */
export async function zipBundle(
  bundle: PreparedBundle,
  onProgress?: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<Blob> {
  if (bundle.kind === "zip" && bundle.zip) return bundle.zip;
  const files = bundle.files ?? [];
  const total = Math.max(1, bundle.totalBytes);
  let done = 0;
  const chunks: Uint8Array[] = [];
  let failure: Error | null = null;
  let finished = false;
  const tick = makeYielder();

  const zip = new Zip((err, chunk, final) => {
    if (err) {
      failure = err;
      return;
    }
    chunks.push(chunk);
    if (final) finished = true;
  });

  for (const { path, file } of files) {
    if (signal?.aborted) {
      zip.terminate();
      throw new DOMException("Cancelled", "AbortError");
    }
    const entry = STORED_EXT.has(extOf(path))
      ? new ZipPassThrough(path)
      : new ZipDeflate(path, { level: 6 });
    entry.mtime = file.lastModified || Date.now();
    zip.add(entry);
    const data = new Uint8Array(await file.arrayBuffer());
    if (data.length === 0) {
      entry.push(new Uint8Array(0), true);
      await tick();
    } else {
      for (let off = 0; off < data.length; off += CHUNK) {
        const end = Math.min(off + CHUNK, data.length);
        entry.push(data.subarray(off, end), end === data.length);
        done += end - off;
        onProgress?.(Math.min(1, done / total));
        if (failure) throw failure;
        await tick();
      }
    }
  }
  zip.end();
  if (failure) throw failure;
  if (!finished) throw new BundleError("Failed to build the zip archive.");
  onProgress?.(1);
  return new Blob(chunks as unknown as BlobPart[], { type: "application/zip" });
}
