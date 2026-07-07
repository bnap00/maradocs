// Validation that the skill bundle is well-formed: required files present,
// scripts executable and syntactically valid bash, frontmatter complete.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

const requiredFiles = ["skill/SKILL.md"];
const scripts = [
  "skill/scripts/common.sh",
  "skill/scripts/publish.sh",
  "skill/scripts/download.sh",
];
const executableScripts = ["skill/scripts/publish.sh", "skill/scripts/download.sh"];

let ok = true;
const problem = (msg) => {
  console.error(msg);
  ok = false;
};

for (const rel of [...requiredFiles, ...scripts]) {
  if (!fs.existsSync(path.join(root, rel))) {
    problem(`missing skill file: ${rel}`);
  }
}

const mdPath = path.join(root, "skill/SKILL.md");
if (fs.existsSync(mdPath)) {
  const md = fs.readFileSync(mdPath, "utf8");
  if (!md.startsWith("---")) {
    problem("SKILL.md must start with YAML frontmatter");
  }
  const frontmatter = md.split("\n---")[0];
  for (const key of ["name:", "description:"]) {
    if (!frontmatter.includes(key)) {
      problem(`SKILL.md frontmatter is missing '${key}'`);
    }
  }
}

for (const rel of executableScripts) {
  const file = path.join(root, rel);
  if (!fs.existsSync(file)) continue;
  if ((fs.statSync(file).mode & 0o111) === 0) {
    problem(`${rel} must be executable`);
  }
}

for (const rel of scripts) {
  const file = path.join(root, rel);
  if (!fs.existsSync(file)) continue;
  const res = spawnSync("bash", ["-n", file], { encoding: "utf8" });
  if (res.status !== 0) {
    problem(`${rel} has a bash syntax error:\n${res.stderr}`);
  }
}

if (!ok) process.exit(1);
console.log("skill bundle OK");
