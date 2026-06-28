// Lightweight validation that the skill bundle is well-formed.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const required = ["skill/SKILL.md", "skill/scripts/publish.sh"];

let ok = true;
for (const rel of required) {
  if (!fs.existsSync(path.join(root, rel))) {
    console.error(`missing skill file: ${rel}`);
    ok = false;
  }
}
const md = fs.readFileSync(path.join(root, "skill/SKILL.md"), "utf8");
if (!md.startsWith("---")) {
  console.error("SKILL.md must start with YAML frontmatter");
  ok = false;
}
if (!ok) process.exit(1);
console.log("skill bundle OK");
