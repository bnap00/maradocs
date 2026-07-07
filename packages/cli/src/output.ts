import pc from "picocolors";

/**
 * When a command runs with --json, human-readable progress goes to stderr so
 * stdout carries only the JSON payload (safe to pipe into jq or a parser).
 */
let jsonMode = false;

export function setJsonMode(on: boolean): void {
  jsonMode = on;
}

export function isJsonMode(): boolean {
  return jsonMode;
}

export function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function out(msg: string): void {
  if (jsonMode) console.error(msg);
  else console.log(msg);
}

export const ui = {
  success: (msg: string) => out(`${pc.green("✔")} ${msg}`),
  info: (msg: string) => out(`${pc.cyan("ℹ")} ${msg}`),
  warn: (msg: string) => out(`${pc.yellow("⚠")} ${msg}`),
  error: (msg: string) => console.error(`${pc.red("✖")} ${msg}`),
  url: (label: string, url: string) =>
    out(`  ${pc.dim(label)} ${pc.underline(pc.cyan(url))}`),
  kv: (key: string, value: string) =>
    out(`  ${pc.dim(key.padEnd(12))} ${value}`),
  heading: (msg: string) => out(pc.bold(`\n${msg}`)),
  raw: (msg: string) => console.log(msg),
};

export function accessBadge(access: string): string {
  switch (access) {
    case "public":
      return pc.green("public");
    case "password":
      return pc.yellow("password");
    case "private":
      return pc.magenta("private");
    default:
      return access;
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}
