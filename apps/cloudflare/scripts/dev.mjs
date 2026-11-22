#!/usr/bin/env node
// `npm run dev`: local development with zero setup. Runs `wrangler dev` with
// any extra arguments you pass; open the dashboard and create the first
// account (no secrets needed). Optional settings go in .dev.vars (see
// .dev.vars.example).
//
//   npm run dev                      # http://localhost:8787/dashboard/
//   npm run dev -- --port 8790
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const APP_DIR = path.resolve(import.meta.dirname, "..");

/** node_modules/wrangler/bin/wrangler.js from here upwards (standalone copy or monorepo). */
function findWranglerBin() {
  let dir = APP_DIR;
  for (;;) {
    const candidate = path.join(dir, "node_modules", "wrangler", "bin", "wrangler.js");
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

const bin = findWranglerBin();
if (!bin) {
  console.error("Wrangler is not installed. Run `npm install` here (or `pnpm install` at the monorepo root) first.");
  process.exit(1);
}

const args = process.argv.slice(2);
if (args[0] === "--") args.shift();
const env = { ...process.env };
// pnpm exports this; npm (used by the dashboard build step) warns about it.
delete env.npm_config_verify_deps_before_run;
delete env.NPM_CONFIG_VERIFY_DEPS_BEFORE_RUN;
// wrangler.jsonc's build command calls `vite` directly. npm/pnpm scripts put
// node_modules/.bin on PATH; do the same for `node scripts/dev.mjs`.
const binDir = path.resolve(bin, "..", "..", "..", ".bin");
const pathKey = Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
env[pathKey] = [binDir, env[pathKey]].filter(Boolean).join(path.delimiter);

const child = spawn(process.execPath, [bin, "dev", ...args], { cwd: APP_DIR, stdio: "inherit", env });
// Ctrl-C already reaches wrangler (same process group); just don't die first.
process.on("SIGINT", () => {});
process.on("SIGTERM", () => {
  if (child.exitCode === null) child.kill("SIGTERM");
});
child.on("exit", (code, signal) => process.exit(signal ? 1 : (code ?? 1)));
