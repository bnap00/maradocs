import { Command } from "commander";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { ApiError } from "../client.js";
import { clearConfig, configPath, loadConfig, saveConfig } from "../config.js";
import { MaraClient } from "../client.js";
import { ui } from "../output.js";

async function promptSecret(question: string): Promise<string> {
  if (!input.isTTY || !output.isTTY) {
    const rl = createInterface({ input, output });
    try {
      return (await rl.question(question)).trim();
    } finally {
      rl.close();
    }
  }

  return new Promise((resolve, reject) => {
    let value = "";
    const wasRaw = input.isRaw;

    const cleanup = () => {
      input.off("data", onData);
      input.setRawMode(wasRaw);
      input.pause();
    };

    const onData = (chunk: Buffer) => {
      for (const char of chunk.toString("utf8")) {
        if (char === "\u0003" || char === "\u0004") {
          cleanup();
          output.write("\n");
          reject(new Error("Cancelled."));
          return;
        }
        if (char === "\r" || char === "\n") {
          cleanup();
          output.write("\n");
          resolve(value.trim());
          return;
        }
        if (char === "\u007f" || char === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        if (char >= " ") value += char;
      }
    };

    output.write(question);
    input.setRawMode(true);
    input.resume();
    input.on("data", onData);
  });
}

async function promptCredentials(defaultServer?: string): Promise<{ server: string; apiKey: string | null }> {
  const rl = createInterface({ input, output });
  try {
    const serverPrompt = defaultServer ? `Server URL (${defaultServer}): ` : "Server URL: ";
    const serverAnswer = (await rl.question(serverPrompt)).trim();
    const server = (serverAnswer || defaultServer || "").replace(/\/$/, "");
    if (!server) throw new Error("Server URL is required.");

    rl.close();

    const apiKey = await promptSecret("MaraDocs API key: ");
    if (!apiKey) throw new Error("API key is required.");

    return { server, apiKey };
  } finally {
    rl.close();
  }
}

async function verifyCredentials(server: string, apiKey: string | null): Promise<void> {
  const client = new MaraClient({ server, apiKey });
  await client.health();
  ui.info(`Server ${server} is reachable.`);

  if (!apiKey) {
    ui.warn("No API key provided — read-only or dev-bypass only.");
    return;
  }

  try {
    await client.listRepos();
    ui.success("API key verified.");
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      ui.warn("Server is reachable, but the API key was rejected.");
      return;
    }
    throw err;
  }
}

export function registerAuth(program: Command): void {
  const auth = program.command("auth").description("Manage authentication");

  auth
    .command("setup")
    .description("Guided setup for server URL and MaraDocs API key")
    .action(async () => {
      const existing = loadConfig();
      const { server, apiKey } = await promptCredentials(existing?.server);
      saveConfig({ server, apiKey });
      ui.success(`Saved credentials to ${configPath()}`);
      await verifyCredentials(server, apiKey);
    });

  auth
    .command("login")
    .description("Log in to a MaraDocs server with a MaraDocs API key")
    .requiredOption("-s, --server <url>", "MaraDocs server base URL")
    .option("-k, --api-key <key>", "MaraDocs API key secret")
    .action(async (opts: { server: string; apiKey?: string }) => {
      const apiKey = opts.apiKey ?? null;
      const server = opts.server.replace(/\/$/, "");
      saveConfig({ server, apiKey });
      ui.success(`Saved credentials to ${configPath()}`);
      try {
        await verifyCredentials(server, apiKey);
      } catch {
        ui.warn(`Could not reach ${server} yet; credentials saved anyway.`);
      }
    });

  auth
    .command("logout")
    .description("Remove stored credentials")
    .action(() => {
      clearConfig();
      ui.success("Logged out.");
    });

  auth
    .command("status")
    .description("Show current authentication status")
    .action(async () => {
      const cfg = loadConfig();
      if (!cfg) {
        ui.warn("Not logged in.");
        return;
      }
      ui.kv("Server", cfg.server);
      ui.kv("API key", cfg.apiKey ? "set" : "none");
      try {
        await new MaraClient(cfg).health();
        ui.success("Server reachable.");
      } catch (err) {
        ui.error(`Server unreachable: ${(err as Error).message}`);
      }
    });
}
