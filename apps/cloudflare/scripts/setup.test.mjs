// Unit tests for the pure parts of scripts/setup.mjs (node:test, no deps).
//   node --test scripts/
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  accountPlan,
  configuredResourceNames,
  parseCli,
  pickOrigin,
  readCliConfig,
  readDeployTargets,
  writeCliConfig,
} from "./setup.mjs";

test("parseCli: a leading `--` (pnpm forwards it) is ignored", () => {
  assert.equal(parseCli(["--", "--dry-run"], {}).dryRun, true);
  assert.equal(parseCli(["--", "--no-cli"], {}).cli, false);
  assert.equal(parseCli(["--help"], {}).help, true);
});

test("parseCli: positionals and unknown options are rejected", () => {
  assert.throws(() => parseCli(["--", "--", "--dry-run"]), /positional/i);
  assert.throws(() => parseCli(["--bogus"]), /Unknown option/);
});

test("parseCli: account credentials come from flags or the environment", () => {
  const fromEnv = parseCli([], {
    MARADOCS_EMAIL: " You@Example.com ",
    MARADOCS_PASSWORD: "a-long-passphrase",
    MARADOCS_CLAIM_PASSWORD: "claim-me-please",
  });
  assert.equal(fromEnv.email, "you@example.com");
  assert.equal(fromEnv.password, "a-long-passphrase");
  assert.equal(fromEnv.claimPassword, "claim-me-please");
  const flags = parseCli(["--email", "me@example.org", "--password", "another-long-one", "--claim-password", "x"], {
    MARADOCS_EMAIL: "env@example.com",
  });
  assert.equal(flags.email, "me@example.org");
  assert.equal(flags.password, "another-long-one");
  assert.equal(flags.claimPassword, "x");
  // The old admin password variable is the claim password now.
  assert.equal(parseCli([], { MARADOCS_ADMIN_PASSWORD: "old-admin-password" }).claimPassword, "old-admin-password");
  const none = parseCli([], { MARADOCS_EMAIL: "" });
  assert.equal(none.email, null);
  assert.equal(none.password, null);
  assert.equal(none.claimPassword, null);
});

test("parseCli: options of the single-admin version", () => {
  assert.equal(parseCli(["--skip-password"], {}).legacySkipPassword, true);
  assert.throws(() => parseCli(["--rotate-password"], {}), /was removed/);
  assert.throws(() => parseCli(["--reset-dashboard-password"], {}), /was removed/);
});

test("parseCli: validates the email, password, worker name and URL", () => {
  assert.throws(() => parseCli(["--email", "not-an-email"], {}), /valid email/);
  assert.throws(() => parseCli(["--password", "short"], {}), /at least 12/);
  assert.throws(() => parseCli([], { MARADOCS_PASSWORD: "short" }), /MARADOCS_PASSWORD must be at least 12/);
  assert.throws(() => parseCli(["--password", "x".repeat(1025)], {}), /at most 1024/);
  assert.throws(() => parseCli(["--name", "Bad_Name"], {}), /Invalid --name/);
  assert.equal(parseCli(["--name", "maradocs-staging"], {}).name, "maradocs-staging");
  assert.equal(parseCli(["--url", "docs.example.com/x"], {}).url, "https://docs.example.com");
  assert.throws(() => parseCli(["--url", "ftp://example.com"], {}), /http\(s\)/);
});

test("accountPlan: register while the deployment allows it, else sign in", () => {
  assert.deepEqual(accountPlan({ registration: true, claimRequired: false }, null), { action: "register", needClaim: false });
  assert.deepEqual(accountPlan({ registration: true, claimRequired: true }, null), { action: "register", needClaim: true });
  assert.deepEqual(accountPlan({ registration: true, claimRequired: true }, "claim"), { action: "register", needClaim: false });
  assert.deepEqual(accountPlan({ registration: false, claimRequired: false }, null), { action: "login", needClaim: false });
  assert.deepEqual(accountPlan(null, null), { action: "login", needClaim: false });
});

test("writeCliConfig / readCliConfig: the CLI's config file, private", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "maradocs-setup-cli-"));
  try {
    const file = path.join(dir, "nested", "config.json");
    assert.equal(readCliConfig(file), null);
    writeCliConfig({ server: "https://docs.example.com", apiKey: "mdo_x", extra: "dropped" }, file);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { server: "https://docs.example.com", apiKey: "mdo_x" });
    assert.deepEqual(readCliConfig(file), { server: "https://docs.example.com", apiKey: "mdo_x" });
    if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    fs.writeFileSync(file, "{not json");
    assert.equal(readCliConfig(file), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("pickOrigin: custom domain > route > workers.dev", () => {
  const dev = "https://maradocs.acme.workers.dev";
  assert.equal(pickOrigin([dev]), dev);
  assert.equal(pickOrigin([dev, "docs.example.com/*"]), "https://docs.example.com");
  assert.equal(pickOrigin([dev, "docs.example.com/*", "reports.example.com (custom domain)"]), "https://reports.example.com");
  assert.equal(pickOrigin(["*.example.com/*"]), null);
  assert.equal(pickOrigin([]), null);
  assert.equal(pickOrigin([42, null]), null);
});

test("readDeployTargets: reads deploy entries from Wrangler's NDJSON output", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "maradocs-setup-test-"));
  try {
    const file = path.join(dir, "out.ndjson");
    fs.writeFileSync(
      file,
      [
        JSON.stringify({ type: "wrangler-session", version: 1 }),
        "not json",
        JSON.stringify({ type: "deploy", targets: ["https://maradocs.acme.workers.dev"] }),
        "",
      ].join("\n"),
    );
    assert.deepEqual(readDeployTargets(file), ["https://maradocs.acme.workers.dev"]);
    assert.deepEqual(readDeployTargets(path.join(dir, "missing.ndjson")), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("configuredResourceNames: finds explicit D1/R2 names, ignoring comments", () => {
  const jsonc = `{
    // "database_name": "commented-out",
    "d1_databases": [{ "binding": "DB", "database_name": "maradocs" }],
    "r2_buckets": [{ "binding": "BUCKET" }]
  }`;
  assert.deepEqual(configuredResourceNames(jsonc), ['database_name "maradocs"']);
  assert.deepEqual(configuredResourceNames('{ "d1_databases": [{ "binding": "DB" }] }'), []);
});

test("the shipped wrangler.jsonc carries no account-specific resource IDs", () => {
  const text = fs.readFileSync(path.join(import.meta.dirname, "..", "wrangler.jsonc"), "utf8");
  const code = text
    .split("\n")
    .map((l) => l.replace(/\/\/.*$/, ""))
    .join("\n");
  assert.doesNotMatch(code, /"(database_id|preview_database_id)"\s*:/, "remove database_id: deploys inherit the binding");
});
