import { Command, Option } from "commander";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { ApiError, MaraClient, type AuthSession } from "../client.js";
import { clearConfig, configPath, loadConfig, resolveConfig, saveConfig } from "../config.js";
import { printJson, setJsonMode, ui } from "../output.js";

async function promptSecret(question: string): Promise<string> {
  // Prompts go to stderr so stdout stays clean for --json consumers.
  const prompt = process.stderr;
  if (!input.isTTY || !output.isTTY) {
    // Non-interactive: read one line from stdin (lets scripts pipe a secret
    // in). Fail on EOF instead of hanging or exiting silently.
    const rl = createInterface({ input, output: prompt });
    try {
      return await new Promise<string>((resolve, reject) => {
        let answered = false;
        rl.once("close", () => {
          if (!answered) reject(new Error(`No input for "${question.trim()}" (stdin closed).`));
        });
        rl.question(question).then(
          (answer) => {
            answered = true;
            resolve(answer.trim());
          },
          reject,
        );
      });
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
          prompt.write("\n");
          reject(new Error("Cancelled."));
          return;
        }
        if (char === "\r" || char === "\n") {
          cleanup();
          prompt.write("\n");
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

    prompt.write(question);
    input.setRawMode(true);
    input.resume();
    input.on("data", onData);
  });
}

function isInteractive(): boolean {
  return Boolean(input.isTTY && process.stderr.isTTY);
}

async function promptLine(question: string): Promise<string> {
  const rl = createInterface({ input, output: process.stderr });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

interface BootstrapOptions {
  server: string;
  email?: string;
  password?: string;
  register?: boolean;
  claimPassword?: string;
  adminPassword?: string;
  name: string;
  scopes: string;
  save: boolean;
  json?: boolean;
}

/** Shared options for `auth bootstrap` and its `auth register` alias. */
function bootstrapOptions(cmd: Command): Command {
  return cmd
    .requiredOption("-s, --server <url>", "MaraDocs server base URL")
    .option("-e, --email <email>", "Account email (env MARADOCS_EMAIL; prompted if omitted)")
    .option(
      "-p, --password <password>",
      "Account password (env MARADOCS_PASSWORD; prompted without echo if omitted)",
    )
    .option(
      "--claim-password <password>",
      "Claim password for the first account on a claim-protected server (env MARADOCS_CLAIM_PASSWORD)",
    )
    .addOption(new Option("--admin-password <password>").hideHelp())
    .option("-n, --name <name>", "Display name for the new API key", "cli-bootstrap")
    .option("--scopes <scopes>", "Comma-separated scopes: read,publish,admin", "publish")
    .option("--no-save", "Print the key without writing ~/.maradocs/config.json")
    .option("--json", "Print the result as JSON");
}

async function signIn(
  client: MaraClient,
  server: string,
  opts: BootstrapOptions,
  email: string,
  password: string,
): Promise<AuthSession> {
  if (!opts.register) {
    try {
      return await client.login(email, password);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        throw new ApiError(
          401,
          err.code,
          `${err.message}. No account yet? Re-run with --register to create one.`,
        );
      }
      throw err;
    }
  }

  const config = await client.authConfig();
  if (!config.registration) {
    throw new Error(
      `Registration is not allowed on ${server} (it is closed, or the first account already exists). ` +
        "Sign in with an existing account by dropping --register, or ask the server operator to set REGISTRATION=open.",
    );
  }
  if (password.length < config.minPasswordLength) {
    throw new Error(`Password must be at least ${config.minPasswordLength} characters.`);
  }
  let claimPassword = opts.claimPassword ?? process.env.MARADOCS_CLAIM_PASSWORD;
  if (config.claimRequired && !claimPassword) {
    if (!isInteractive()) {
      throw new Error(
        `${server} requires a claim password to create its first account (the server's ADMIN_PASSWORD). ` +
          "Pass --claim-password or set MARADOCS_CLAIM_PASSWORD.",
      );
    }
    claimPassword = await promptSecret("Claim password (the server's ADMIN_PASSWORD): ");
    if (!claimPassword) throw new Error("A claim password is required to create the first account.");
  }
  return client.register(email, password, claimPassword || undefined);
}

async function runBootstrap(opts: BootstrapOptions): Promise<void> {
  setJsonMode(Boolean(opts.json));
  if (opts.adminPassword !== undefined) {
    throw new Error(
      "--admin-password was removed: MaraDocs now uses email + password accounts. " +
        "Use --email <email> and --password <password> (or MARADOCS_PASSWORD). " +
        "On a fresh or upgraded server, add --register to create the first account; " +
        "if it asks for a claim password, pass the old ADMIN_PASSWORD as --claim-password.",
    );
  }
  const server = opts.server.replace(/\/$/, "");

  let email = (opts.email ?? process.env.MARADOCS_EMAIL ?? "").trim();
  if (!email && isInteractive()) email = await promptLine("Email: ");
  if (!email) throw new Error("--email is required (or set MARADOCS_EMAIL).");

  const password =
    opts.password ?? process.env.MARADOCS_PASSWORD ?? (await promptSecret("Password: "));
  if (!password) throw new Error("A password is required (--password, MARADOCS_PASSWORD, or the prompt).");

  const client = new MaraClient({ server, apiKey: null });
  const session = await signIn(client, server, opts, email, password);
  const token = session.token;
  if (!token) {
    throw new Error(
      `${server} did not return a session token (it treated this request as a browser). ` +
        "Check that no proxy adds an Origin header.",
    );
  }

  const scopes = opts.scopes
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  let created: Awaited<ReturnType<MaraClient["createApiKey"]>>;
  try {
    created = await client.createApiKey(token, { name: opts.name, scopes });
  } finally {
    // The session was only needed to mint the key: revoke it rather than
    // leave a 30-day account credential behind.
    await client.logout(token).catch(() => undefined);
  }

  if (opts.save) {
    saveConfig({ server, apiKey: created.key });
  }
  if (opts.json) {
    printJson({
      server,
      saved: opts.save,
      registered: Boolean(opts.register),
      user: session.user,
      ...created,
    });
    return;
  }
  if (opts.register) ui.success(`Created account ${session.user.email}.`);
  if (opts.save) {
    ui.success(`Saved credentials to ${configPath()}`);
  }
  ui.kv("Server", server);
  ui.kv("Account", session.user.email);
  ui.kv("Key name", created.name);
  ui.kv("Scopes", created.scopes.join(", "));
  ui.kv("API key", created.key);
  ui.warn("The API key is shown once. Store it securely.");
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

  bootstrapOptions(
    auth
      .command("bootstrap")
      .description(
        "Sign in with your MaraDocs account (email + password), mint an API key and save it locally",
      ),
  )
    .option("--register", "Create the account first (first account on a fresh server, or REGISTRATION=open)")
    .addHelpText(
      "after",
      `
Examples:
  $ maradocs auth bootstrap --server https://docs.example.com --email you@example.com
  $ maradocs auth bootstrap --server http://localhost:8787 --email you@example.com --register
  $ MARADOCS_PASSWORD=... maradocs auth bootstrap -s https://docs.example.com -e you@example.com --json`,
    )
    .action((opts: BootstrapOptions) => runBootstrap(opts));

  bootstrapOptions(
    auth
      .command("register")
      .description("Create a MaraDocs account, then mint and save an API key (alias of `auth bootstrap --register`)"),
  ).action((opts: BootstrapOptions) => runBootstrap({ ...opts, register: true }));

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
    .option("--json", "Print the status as JSON")
    .action(async (opts: { json?: boolean }) => {
      setJsonMode(Boolean(opts.json));
      // Same resolution as every other command: env overrides win.
      let cfg: ReturnType<typeof resolveConfig> | null;
      try {
        cfg = resolveConfig();
      } catch {
        cfg = null;
      }
      if (!cfg) {
        if (opts.json) {
          printJson({ loggedIn: false });
          return;
        }
        ui.warn("Not logged in.");
        return;
      }
      let reachable = false;
      let reachError: string | null = null;
      try {
        await new MaraClient(cfg).health();
        reachable = true;
      } catch (err) {
        reachError = (err as Error).message;
      }
      if (opts.json) {
        printJson({
          loggedIn: true,
          server: cfg.server,
          apiKey: cfg.apiKey ? "set" : "none",
          serverReachable: reachable,
          ...(reachError ? { error: reachError } : {}),
        });
        return;
      }
      ui.kv("Server", cfg.server);
      ui.kv("API key", cfg.apiKey ? "set" : "none");
      if (reachable) ui.success("Server reachable.");
      else ui.error(`Server unreachable: ${reachError}`);
    });
}
