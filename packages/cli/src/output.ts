import pc from "picocolors";

export const ui = {
  success: (msg: string) => console.log(`${pc.green("✔")} ${msg}`),
  info: (msg: string) => console.log(`${pc.cyan("ℹ")} ${msg}`),
  warn: (msg: string) => console.log(`${pc.yellow("⚠")} ${msg}`),
  error: (msg: string) => console.error(`${pc.red("✖")} ${msg}`),
  url: (label: string, url: string) =>
    console.log(`  ${pc.dim(label)} ${pc.underline(pc.cyan(url))}`),
  kv: (key: string, value: string) =>
    console.log(`  ${pc.dim(key.padEnd(12))} ${value}`),
  heading: (msg: string) => console.log(pc.bold(`\n${msg}`)),
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
