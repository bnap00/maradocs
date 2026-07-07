// Root ESLint config for the server, CLI, shared package, and repo scripts.
// The dashboard keeps its own config (React-specific rules) in
// apps/dashboard/eslint.config.js and is ignored here.
import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import { defineConfig, globalIgnores } from "eslint/config";

export default defineConfig([
  globalIgnores(["**/dist/", "**/node_modules/", "apps/dashboard/"]),
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
    files: ["scripts/**/*.mjs", "packages/*/scripts/**/*.mjs", "packages/*/test/**/*.mjs"],
    extends: [js.configs.recommended],
    languageOptions: {
      globals: globals.node,
    },
  },
]);
