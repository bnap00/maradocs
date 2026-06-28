import { randomBytes, randomUUID } from "node:crypto";

const PREFIXES = {
  repo: "repo",
  doc: "doc",
  ver: "ver",
  mach: "mach",
  audit: "aud",
  apikey: "akey",
} as const;

export type IdKind = keyof typeof PREFIXES;

/** Short, sortable-ish, prefixed identifier. */
export function newId(kind: IdKind): string {
  return `${PREFIXES[kind]}_${randomBytes(12).toString("hex")}`;
}

export function uuid(): string {
  return randomUUID();
}
