import AdmZip from "adm-zip";
import fs from "node:fs";
import path from "node:path";

/**
 * Zip a report folder into an in-memory buffer, preserving relative paths.
 * The folder must contain an entrypoint (index.html by default).
 */
export function zipFolder(folder: string): { buffer: Buffer; fileCount: number } {
  const root = path.resolve(folder);
  const stat = fs.statSync(root);
  if (!stat.isDirectory()) {
    throw new Error(`Not a directory: ${folder}`);
  }
  const zip = new AdmZip();
  let fileCount = 0;

  const walk = (dir: string, prefix: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".") && entry.name !== ".well-known") continue;
      if (entry.name === "node_modules") continue;
      const abs = path.join(dir, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(abs, rel);
      } else if (entry.isFile()) {
        zip.addLocalFile(abs, prefix);
        fileCount += 1;
      }
    }
  };
  walk(root, "");

  if (fileCount === 0) {
    throw new Error(`No files found in ${folder}`);
  }
  return { buffer: zip.toBuffer(), fileCount };
}

export function hasEntrypoint(folder: string, entrypoint = "index.html"): boolean {
  return fs.existsSync(path.join(path.resolve(folder), entrypoint));
}

/**
 * Extract a zip buffer into a directory, refusing entries that would escape
 * it (absolute paths, `..` segments — zip-slip). Returns the file count.
 */
export function extractZip(buffer: Buffer, outDir: string): number {
  const root = path.resolve(outDir);
  fs.mkdirSync(root, { recursive: true });
  const zip = new AdmZip(buffer);
  let fileCount = 0;

  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue;
    const name = entry.entryName.replace(/\\/g, "/");
    const target = path.resolve(root, name);
    if (path.isAbsolute(name) || (target !== root && !target.startsWith(root + path.sep))) {
      throw new Error(`Refusing to extract unsafe path: ${entry.entryName}`);
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, entry.getData());
    fileCount += 1;
  }
  return fileCount;
}
