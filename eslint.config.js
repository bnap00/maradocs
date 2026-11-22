// Root ESLint config for the server, CLI, shared package, the Cloudflare
// Worker and its dashboard SPA, and repo scripts. The original dashboard keeps
// its own config in apps/dashboard/eslint.config.js and is ignored here, as are
// the Cloudflare build output and generated vendored sources.
//
// The Cloudflare dashboard's lint tooling lives here (not in
// apps/cloudflare/package.json) so the Deploy-button copy of that folder
// doesn't install linters.
import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";
import { defineConfig, globalIgnores } from "eslint/config";

export default defineConfig([
  globalIgnores([
    "**/dist/",
    "**/node_modules/",
    "apps/dashboard/",
    "apps/cloudflare/public/",
    "apps/cloudflare/.wrangler/",
    "apps/cloudflare/src/vendor/",
  ]),
  {
    files: ["apps/server/**/*.ts", "packages/cli/**/*.ts", "packages/shared/**/*.ts"],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    languageOptions: {
      globals: globals.node,
    },
    rules: {
      // TypeScript itself checks undefined identifiers; the ESLint rule only
      // produces false positives on ambient types (per typescript-eslint FAQ).
      "no-undef": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" },
      ],
    },
  },
  {
    // Cloudflare Worker source and its workerd-hosted tests: Workers runtime
    // globals (fetch, Request, Response, crypto, caches, …), not Node's.
    files: ["apps/cloudflare/src/**/*.ts", "apps/cloudflare/test/**/*.ts"],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    languageOptions: {
      globals: { ...globals.serviceworker, ...globals.es2024 },
    },
    rules: {
      "no-undef": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" },
      ],
    },
  },
  {
    // Cloudflare dashboard SPA (React 19, browser). Classic hooks rules only:
    // rules-of-hooks catches real bugs; the compiler-oriented rules in the
    // plugin's "recommended" preset are not used.
    files: ["apps/cloudflare/dashboard/**/*.{ts,tsx}"],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    plugins: { "react-hooks": reactHooks },
    languageOptions: {
      globals: globals.browser,
    },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "error",
    },
  },
  {
    files: ["apps/cloudflare/dashboard/vite.config.ts"],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    files: [
      "scripts/**/*.mjs",
      "packages/*/scripts/**/*.mjs",
      "packages/*/test/**/*.mjs",
      "apps/cloudflare/scripts/**/*.mjs",
      "apps/cloudflare/test/**/*.mjs",
    ],
    extends: [js.configs.recommended],
    languageOptions: {
      globals: globals.node,
    },
  },
]);
