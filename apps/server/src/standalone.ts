#!/usr/bin/env node
/**
 * Standalone entry for running MaraDocs directly on a personal machine
 * (`npx @maradocs/server`) — no Docker required. Fills in safe defaults
 * before handing off to the normal server entrypoint:
 *
 * - DATA_DIR defaults to ~/maradocs/data
 * - COOKIE_SECRET and ADMIN_PASSWORD are generated on first run and
 *   persisted (mode 0600) in DATA_DIR/standalone-secrets.json
 * - PUBLIC_BASE_URL defaults to http://localhost:<port>
 * - HOST defaults to 127.0.0.1 (local-only; set HOST=0.0.0.0 to expose)
 *
 * Explicit environment variables always win over these defaults.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const port = process.env.PORT ?? "8787";
process.env.NODE_ENV ??= "production";
process.env.HOST ??= "127.0.0.1";
process.env.PUBLIC_BASE_URL ??= `http://localhost:${port}`;
process.env.DATA_DIR ??= path.join(os.homedir(), "maradocs", "data");

const dataDir = process.env.DATA_DIR;
fs.mkdirSync(dataDir, { recursive: true });

interface StandaloneSecrets {
  cookieSecret?: string;
  adminPassword?: string;
}

const secretsPath = path.join(dataDir, "standalone-secrets.json");
let secrets: StandaloneSecrets = {};
if (fs.existsSync(secretsPath)) {
  try {
    secrets = JSON.parse(fs.readFileSync(secretsPath, "utf8")) as StandaloneSecrets;
  } catch {
    console.error(`warning: could not parse ${secretsPath}; regenerating secrets`);
  }
}

const passwordFromEnv = Boolean(process.env.ADMIN_PASSWORD);
let changed = false;
let passwordGenerated = false;

if (!process.env.COOKIE_SECRET) {
  if (!secrets.cookieSecret) {
    secrets.cookieSecret = crypto.randomBytes(32).toString("hex");
    changed = true;
  }
  process.env.COOKIE_SECRET = secrets.cookieSecret;
}

if (!passwordFromEnv) {
  if (!secrets.adminPassword) {
    secrets.adminPassword = crypto.randomBytes(12).toString("hex");
    changed = true;
    passwordGenerated = true;
  }
  process.env.ADMIN_PASSWORD = secrets.adminPassword;
}

if (changed) {
  fs.writeFileSync(secretsPath, JSON.stringify(secrets, null, 2) + "\n", { mode: 0o600 });
}

console.log(`MaraDocs standalone`);
console.log(`  Dashboard: ${process.env.PUBLIC_BASE_URL}/dashboard/`);
if (passwordGenerated) {
  console.log(`  Admin password: ${secrets.adminPassword}`);
  console.log(`  (persisted in ${secretsPath})`);
} else if (!passwordFromEnv) {
  console.log(`  Admin password: stored in ${secretsPath}`);
}
console.log(`  Data dir: ${dataDir}`);

await import("./index.js");
