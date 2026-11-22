import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// wrangler.jsonc points the ASSETS binding at ./public (the dashboard build
// output). Make sure it exists so tests run without building the dashboard.
mkdirSync(fileURLToPath(new URL("./public", import.meta.url)), { recursive: true });

// Run tests on the same workerd binary wrangler uses (the plugin's own
// miniflare may resolve an older workerd that rejects our compatibility date).
if (!process.env.MINIFLARE_WORKERD_PATH) {
  try {
    const fromWrangler = createRequire(createRequire(import.meta.url).resolve("wrangler/package.json"));
    const workerd = fromWrangler("workerd") as { default: string };
    process.env.MINIFLARE_WORKERD_PATH = workerd.default;
  } catch {
    // Fall back to whatever workerd miniflare resolves itself.
  }
}

export const TEST_ADMIN_PASSWORD = "test-admin-password-0123";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          // The claim password for the first account in each test file.
          ADMIN_PASSWORD: TEST_ADMIN_PASSWORD,
          // Tests create several accounts per file (the default is "first").
          REGISTRATION: "open",
          // Same as the production default (10k); keeps tests fast.
          PBKDF2_ITERATIONS: "10000",
          MAX_UPLOAD_MB: "2",
        },
      },
    }),
  ],
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 30_000,
  },
});
