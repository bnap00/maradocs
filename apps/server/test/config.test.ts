import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { loadConfig } from "../src/config.js";

test("resolves relative DATA_DIR from the original command directory", () => {
  const config = loadConfig({
    DATA_DIR: "./.maradocs-data",
    INIT_CWD: "/workspace/maradocs",
  } as NodeJS.ProcessEnv);

  assert.equal(config.dataDir, path.resolve("/workspace/maradocs", ".maradocs-data"));
});

test("leaves absolute DATA_DIR unchanged", () => {
  const config = loadConfig({ DATA_DIR: "/var/lib/maradocs" } as NodeJS.ProcessEnv);
  assert.equal(config.dataDir, "/var/lib/maradocs");
});

test("rejects BCRYPT_ROUNDS < 10 in production", () => {
  assert.throws(
    () =>
      loadConfig({
        NODE_ENV: "production",
        PUBLIC_BASE_URL: "https://example.com",
        BCRYPT_ROUNDS: "4",
      } as NodeJS.ProcessEnv),
    /BCRYPT_ROUNDS/,
  );
});

test("TRUST_PROXY: production trusts private-network proxies by default", () => {
  const prod = {
    NODE_ENV: "production",
    COOKIE_SECRET: "x".repeat(32),
    PUBLIC_BASE_URL: "https://example.com",
    ADMIN_PASSWORD: "test-password",
  };
  assert.equal(
    loadConfig(prod as NodeJS.ProcessEnv).trustProxy,
    "loopback,linklocal,uniquelocal",
  );
  assert.equal(
    loadConfig({ ...prod, TRUST_PROXY: "10.0.0.5" } as NodeJS.ProcessEnv).trustProxy,
    "10.0.0.5",
  );
  assert.equal(loadConfig({ ...prod, TRUST_PROXY: "false" } as NodeJS.ProcessEnv).trustProxy, false);
  assert.equal(
    loadConfig({ ADMIN_PASSWORD: "test-password" } as NodeJS.ProcessEnv).trustProxy,
    false,
  );
});

test("ADMIN_PASSWORD and COOKIE_SECRET are optional; REGISTRATION defaults to first", () => {
  const config = loadConfig({
    NODE_ENV: "production",
    PUBLIC_BASE_URL: "https://example.com",
  } as NodeJS.ProcessEnv);
  assert.equal(config.adminPassword, null);
  assert.equal(config.cookieSecret, null);
  assert.equal(config.registration, "first");
  assert.equal(config.cookieSecure, true);
});

test("REGISTRATION accepts open/first/closed and rejects anything else", () => {
  for (const mode of ["open", "first", "closed"]) {
    assert.equal(loadConfig({ REGISTRATION: mode } as NodeJS.ProcessEnv).registration, mode);
  }
  assert.throws(() => loadConfig({ REGISTRATION: "yes" } as NodeJS.ProcessEnv), /REGISTRATION/);
});

test("cookies are not Secure on plain-http deployments or in development", () => {
  assert.equal(
    loadConfig({ NODE_ENV: "production", PUBLIC_BASE_URL: "http://localhost:8787" } as NodeJS.ProcessEnv)
      .cookieSecure,
    false,
  );
  assert.equal(loadConfig({} as NodeJS.ProcessEnv).cookieSecure, false);
});
