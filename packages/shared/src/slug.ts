/**
 * Slug validation shared by the server and CLI. Slugs are used directly in
 * URLs and as filesystem path segments, so they must be tightly constrained:
 * lowercase alphanumerics plus single internal hyphens, 1-64 chars. This also
 * blocks `..`, `.` and anything that could enable path traversal.
 */
export const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

export function isValidSlug(value: string): boolean {
  return SLUG_PATTERN.test(value);
}

/** Best-effort conversion of an arbitrary string into a valid slug. */
export function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");
}
