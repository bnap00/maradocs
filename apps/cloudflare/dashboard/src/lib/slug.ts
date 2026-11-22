// Mirrors src/vendor/shared/slug.ts (the dashboard is bundled separately).
export const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

export function isValidSlug(value: string): boolean {
  return SLUG_PATTERN.test(value);
}

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");
}

export function slugError(value: string): string | null {
  if (!value) return "Required";
  if (value.length > 64) return "At most 64 characters";
  if (!isValidSlug(value)) return "Lowercase letters, numbers and single hyphens only";
  return null;
}
