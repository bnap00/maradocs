import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { loadConfig } from "../src/config.js";

test("resolves relative DATA_DIR from the original command directory", () => {
  const config = loadConfig({
    DATA_DIR: "./.maradocs-data",
    INIT_CWD: "/workspace/maradocs",
    ADMIN_PASSWORD: "test-password",
  } as NodeJS.ProcessEnv);

  assert.equal(config.dataDir, path.resolve("/workspace/maradocs", ".maradocs-data"));
});

test("leaves absolute DATA_DIR unchanged", () => {
  const config = loadConfig({
    DATA_DIR: "/var/lib/maradocs",
    ADMIN_PASSWORD: "test-password",
  } as NodeJS.ProcessEnv);

  assert.equal(config.dataDir, "/var/lib/maradocs");
});

test("rejects BCRYPT_ROUNDS < 10 in production", () => {
  assert.throws(
    () =>
      loadConfig({
        NODE_ENV: "production",
        COOKIE_SECRET: "x".repeat(32),
        PUBLIC_BASE_URL: "https://example.com",
        ADMIN_PASSWORD: "test-password",
        BCRYPT_ROUNDS: "4",
      } as NodeJS.ProcessEnv),
    /BCRYPT_ROUNDS/,
  );
});
