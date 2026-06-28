import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import yauzl from "yauzl";
import { badRequest, payloadTooLarge } from "../util/errors.js";

export interface ExtractResult {
  fileCount: number;
  sizeBytes: number;
  checksum: string;
  /** Relative file paths (posix) discovered in the bundle. */
  files: string[];
}

interface BundleEntry {
  relPath: string;
  data: Buffer;
}

const MAX_BUNDLE_FILES = 2000;
const MAX_ENTRY_PATH_LENGTH = 240;
const MAX_ENTRY_DEPTH = 20;

/** Reject anything that could escape the destination directory. */
function safeEntryName(rawName: string): string | null {
  if (!rawName || rawName.endsWith("/")) return null; // directory entry
  const name = rawName.replace(/\\/g, "/");
  if (name.includes("\0")) return null;
  if (path.posix.isAbsolute(name) || /^[a-zA-Z]:/.test(name)) return null;
  const normalized = path.posix.normalize(name);
  if (normalized.startsWith("../") || normalized === ".." || normalized.includes("/../")) {
    return null;
  }
  if (normalized.startsWith("/")) return null;
  // Drop leading "./"
  return normalized.replace(/^\.\//, "");
}

/** Read a whole zip from a buffer into validated, in-memory entries. */
function readZipEntries(zip: Buffer, maxBytes: number): Promise<BundleEntry[]> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(zip, { lazyEntries: true }, (err, zipfile) => {
      if (err || !zipfile) {
        reject(badRequest("Uploaded bundle is not a valid zip archive"));
        return;
      }
      const entries: BundleEntry[] = [];
      let total = 0;

      zipfile.on("error", (e) => reject(badRequest(`Corrupt zip: ${e.message}`)));
      zipfile.on("end", () => resolve(entries));
      zipfile.readEntry();

      zipfile.on("entry", (entry: yauzl.Entry) => {
        if (/\/$/.test(entry.fileName)) {
          zipfile.readEntry();
          return;
        }
        const rel = safeEntryName(entry.fileName);
        if (rel === null) {
          reject(badRequest(`Unsafe path in bundle: ${entry.fileName}`));
          zipfile.close();
          return;
        }
        if (rel.length > MAX_ENTRY_PATH_LENGTH || rel.split("/").length > MAX_ENTRY_DEPTH) {
          reject(badRequest(`Path is too deep or too long in bundle: ${entry.fileName}`));
          zipfile.close();
          return;
        }
        zipfile.openReadStream(entry, (streamErr, stream) => {
          if (streamErr || !stream) {
            reject(badRequest(`Could not read entry ${entry.fileName}`));
            return;
          }
          const chunks: Buffer[] = [];
          stream.on("data", (chunk: Buffer) => {
            total += chunk.length;
            if (total > maxBytes) {
              reject(payloadTooLarge("Bundle exceeds the maximum upload size"));
              stream.destroy();
              zipfile.close();
              return;
            }
            chunks.push(chunk);
          });
          stream.on("end", () => {
            entries.push({ relPath: rel, data: Buffer.concat(chunks) });
            if (entries.length > MAX_BUNDLE_FILES) {
              reject(badRequest(`Bundle contains more than ${MAX_BUNDLE_FILES} files`));
              zipfile.close();
              return;
            }
            zipfile.readEntry();
          });
          stream.on("error", (e) => reject(badRequest(`Read error: ${e.message}`)));
        });
      });
    });
  });
}

/**
 * Extract a zip bundle into `destDir`, enforcing path safety and the size
 * limit, then return deterministic content statistics. The checksum is a
 * SHA-256 over the sorted (path, content) pairs so it is independent of zip
 * ordering.
 */
export async function extractBundle(
  zip: Buffer,
  destDir: string,
  maxBytes: number,
): Promise<ExtractResult> {
  const entries = await readZipEntries(zip, maxBytes);
  if (entries.length === 0) {
    throw badRequest("Bundle is empty");
  }
  entries.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
  for (let i = 1; i < entries.length; i += 1) {
    if (entries[i]!.relPath === entries[i - 1]!.relPath) {
      throw badRequest(`Duplicate path in bundle: ${entries[i]!.relPath}`);
    }
  }

  const hash = createHash("sha256");
  let sizeBytes = 0;
  fs.mkdirSync(destDir, { recursive: true });
  for (const entry of entries) {
    const target = path.join(destDir, entry.relPath);
    // Defense in depth: ensure the resolved target stays under destDir.
    const resolvedRoot = path.resolve(destDir);
    if (!path.resolve(target).startsWith(resolvedRoot + path.sep)) {
      throw badRequest(`Unsafe path in bundle: ${entry.relPath}`);
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, entry.data);
    sizeBytes += entry.data.length;
    hash.update(entry.relPath);
    hash.update("\0");
    hash.update(entry.data);
  }

  return {
    fileCount: entries.length,
    sizeBytes,
    checksum: hash.digest("hex"),
    files: entries.map((e) => e.relPath),
  };
}

/** Pick the entrypoint: explicit choice if present in bundle, else index.html. */
export function resolveEntrypoint(files: string[], requested?: string): string {
  if (requested && files.includes(requested)) return requested;
  if (files.includes("index.html")) return "index.html";
  // Fall back to the shallowest html file.
  const html = files
    .filter((f) => f.toLowerCase().endsWith(".html"))
    .sort((a, b) => a.split("/").length - b.split("/").length);
  return html[0] ?? "index.html";
}
