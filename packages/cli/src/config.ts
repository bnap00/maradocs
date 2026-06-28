import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface CliConfig {
  server: string;
  apiKey: string | null;
}

const CONFIG_DIR = path.join(os.homedir(), ".maradocs");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");

export function configPath(): string {
  return CONFIG_FILE;
}

export function loadConfig(): CliConfig | null {
  try {
    const raw = fs.readFileSync(CONFIG_FILE, "utf8");
    const parsed = JSON.parse(raw) as Partial<CliConfig>;
    if (!parsed.server) return null;
    return { server: parsed.server, apiKey: parsed.apiKey ?? null };
  } catch {
    return null;
  }
}

export function saveConfig(config: CliConfig): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), { mode: 0o600 });
}

export function clearConfig(): void {
  try {
    fs.rmSync(CONFIG_FILE);
  } catch {
    /* ignore */
  }
}

/** Resolve config, allowing env overrides for scripting/CI. */
export function resolveConfig(): CliConfig {
  const stored = loadConfig();
  const server = process.env.MARADOCS_SERVER_URL ?? stored?.server;
  const apiKey = process.env.MARADOCS_API_KEY ?? stored?.apiKey ?? null;
  if (!server) {
    throw new Error(
      "Not logged in. Run `maradocs auth login --server <url> --api-key <key>` first.",
    );
  }
  return { server: server.replace(/\/$/, ""), apiKey };
}
