import fs from "node:fs";
import path from "node:path";

/**
 * Filesystem layout helper. All document bytes live under:
 *   {repositoriesDir}/{repo}/{doc}/versions/{n}/...
 * The metadata DB is authoritative for listings; the filesystem is
 * authoritative for bytes. Paths are always rebuilt from validated slugs and
 * version numbers — never from user-supplied path strings.
 */
export class Storage {
  constructor(private repositoriesDir: string) {}

  docDir(repoSlug: string, docSlug: string): string {
    return path.join(this.repositoriesDir, repoSlug, docSlug);
  }

  versionDir(repoSlug: string, docSlug: string, versionNumber: number): string {
    return path.join(this.docDir(repoSlug, docSlug), "versions", String(versionNumber));
  }

  ensureDir(dir: string): void {
    fs.mkdirSync(dir, { recursive: true });
  }

  removeDir(dir: string): void {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  /**
   * Resolve a request path within a version directory, rejecting any escape
   * outside the root (path traversal, absolute paths, symlink games).
   * Returns the absolute file path or null if the resolution escapes the root.
   */
  resolveWithin(rootDir: string, requestPath: string): string | null {
    // Strip query/hash already removed by caller; decode percent-encoding.
    let decoded: string;
    try {
      decoded = decodeURIComponent(requestPath);
    } catch {
      return null;
    }
    if (decoded.includes("\0")) return null;
    // Normalise and strip leading slashes so join stays relative.
    const rel = decoded.replace(/^\/+/, "");
    const candidate = path.resolve(rootDir, rel);
    const rootResolved = path.resolve(rootDir);
    if (candidate !== rootResolved && !candidate.startsWith(rootResolved + path.sep)) {
      return null;
    }
    // Guard against symlinks pointing outside the root.
    try {
      const real = fs.realpathSync(candidate);
      const realRoot = fs.realpathSync(rootResolved);
      if (real !== realRoot && !real.startsWith(realRoot + path.sep)) {
        return null;
      }
    } catch {
      // Missing file: candidate is already inside root, so let caller 404.
    }
    return candidate;
  }
}
