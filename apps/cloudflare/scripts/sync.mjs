#!/usr/bin/env node
// Keeps apps/cloudflare self-contained so it can be deployed on its own (the
// "Deploy to Cloudflare" button copies only this directory into a new repo).
//
// It copies the pure, runtime-agnostic source it shares with the rest of the
// monorepo (API schemas, slug rules, OpenAPI description) into src/vendor/.
//
//   node scripts/sync.mjs          # refresh vendored sources
//   node scripts/sync.mjs --check  # fail if vendored sources are stale
import fs from "node:fs";
import path from "node:path";

const here = path.resolve(import.meta.dirname, "..");
const repoRoot = path.resolve(here, "../..");
const args = new Set(process.argv.slice(2));
const check = args.has("--check");

/** [source relative to repo root, destination relative to apps/cloudflare] */
const VENDORED = [
  ["packages/shared/src/constants.ts", "src/vendor/shared/constants.ts"],
  ["packages/shared/src/schemas.ts", "src/vendor/shared/schemas.ts"],
  ["packages/shared/src/slug.ts", "src/vendor/shared/slug.ts"],
  ["packages/shared/src/types.ts", "src/vendor/shared/types.ts"],
  ["packages/shared/src/index.ts", "src/vendor/shared/index.ts"],
  ["apps/server/src/routes/openapi.ts", "src/vendor/openapi.ts"],
];

const header = (src) =>
  `// GENERATED from ${src} by apps/cloudflare/scripts/sync.mjs — do not edit.\n` +
  `// Run \`pnpm --filter @maradocs/cloudflare sync\` after changing the source.\n`;

// A standalone copy of this folder (e.g. a repo created by the Deploy button)
// ships the generated src/vendor/ and has no monorepo sources to compare with.
if (!VENDORED.every(([src]) => fs.existsSync(path.join(repoRoot, src)))) {
  const msg =
    "The MaraDocs monorepo sources (packages/shared, apps/server) were not found next to this folder.\n" +
    "This looks like a standalone copy: src/vendor/ is already generated and needs no sync.";
  if (check) {
    console.log(`${msg}\nSkipping the vendored-sources check.`);
    process.exit(0);
  }
  console.error(`${msg}\nRun the sync from a clone of the monorepo instead.`);
  process.exit(1);
}

let stale = [];
for (const [src, dest] of VENDORED) {
  const srcPath = path.join(repoRoot, src);
  const destPath = path.join(here, dest);
  const expected = header(src) + fs.readFileSync(srcPath, "utf8");
  const actual = fs.existsSync(destPath) ? fs.readFileSync(destPath, "utf8") : null;
  if (actual === expected) continue;
  if (check) {
    stale.push(dest);
  } else {
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.writeFileSync(destPath, expected);
    console.log(`vendored ${src} -> ${dest}`);
  }
}

if (check) {
  if (stale.length) {
    console.error(
      `Vendored sources are out of date:\n  ${stale.join("\n  ")}\n` +
        "Run `pnpm --filter @maradocs/cloudflare sync`.",
    );
    process.exit(1);
  }
  console.log("Vendored sources are up to date.");
  process.exit(0);
}
