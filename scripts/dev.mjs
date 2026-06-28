import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");

function readEnvFile(file) {
  if (!fs.existsSync(file)) return {};

  const env = {};
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const separator = trimmed.indexOf("=");
    if (separator === -1) continue;

    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

const env = {
  ...process.env,
  ...readEnvFile(path.join(root, ".env")),
};

env.NODE_ENV ??= "development";
env.PORT ??= "8787";
env.HOST ??= "127.0.0.1";
env.PUBLIC_BASE_URL ??= `http://127.0.0.1:${env.PORT}`;
env.DATA_DIR ??= ".maradocs-data";
env.DASHBOARD_DEV_SERVER_URL ??= "http://localhost:5273";
env.INIT_CWD ??= root;

const children = [];

function run(name, args) {
  const child = spawn("pnpm", args, {
    cwd: root,
    env,
    stdio: ["inherit", "pipe", "pipe"],
  });
  children.push(child);

  child.stdout.on("data", (chunk) => process.stdout.write(`[${name}] ${chunk}`));
  child.stderr.on("data", (chunk) => process.stderr.write(`[${name}] ${chunk}`));

  child.on("exit", (code, signal) => {
    if (shuttingDown) return;
    console.error(`[${name}] exited ${signal ?? code}`);
    shutdown(code ?? 1);
  });
}

let shuttingDown = false;
function shutdown(code = 0) {
  shuttingDown = true;
  for (const child of children) {
    if (!child.killed) child.kill("SIGTERM");
  }
  setTimeout(() => process.exit(code), 200).unref();
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

run("shared", ["--filter", "@maradocs/shared", "dev"]);
run("server", ["--filter", "@maradocs/server", "dev"]);
run("dashboard", ["--filter", "@maradocs/dashboard", "dev"]);
