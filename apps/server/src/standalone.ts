#!/usr/bin/env node
/**
 * Standalone entry for running MaraDocs directly on a personal machine
 * (`npx @maradocs/server`) — no Docker required. Fills in safe defaults
 * before handing off to the normal server entrypoint:
 *
 * - DATA_DIR defaults to ~/maradocs/data
 * - No secrets are required: accounts are created in the dashboard (the first
 *   visitor creates the owner account) and the cookie-signing secret is
 *   generated and stored in the database.
 * - Upgraded installs keep the values in DATA_DIR/standalone-secrets.json: the
 *   old generated admin password becomes the claim password the first account
 *   must enter, so a stranger cannot claim an instance that already has data.
 * - PUBLIC_BASE_URL defaults to http://localhost:<port>
 * - HOST defaults to 127.0.0.1 (local-only; set HOST=0.0.0.0 to expose)
 *
 * Explicit environment variables always win over these defaults.
 */
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
    console.error(`warning: could not parse ${secretsPath}; ignoring it`);
  }
}

// Earlier releases generated these; keep using them so existing password-gate
// cookies stay valid and the old admin password protects the first sign-up.
if (!process.env.COOKIE_SECRET && secrets.cookieSecret) {
  process.env.COOKIE_SECRET = secrets.cookieSecret;
}
const claimFromFile = !process.env.ADMIN_PASSWORD && Boolean(secrets.adminPassword);
if (claimFromFile) {
  process.env.ADMIN_PASSWORD = secrets.adminPassword;
}

console.log(`MaraDocs standalone`);
console.log(`  Dashboard: ${process.env.PUBLIC_BASE_URL}/dashboard/`);
if (claimFromFile) {
  // Never print the password itself: stdout ends up in process-manager and
  // container logs. Point at the 0600 secrets file instead.
  console.log(
    `  Claim password for creating the first account (old admin password): see ${secretsPath}`,
  );
}
console.log(`  Data dir: ${dataDir}`);

await import("./index.js");
