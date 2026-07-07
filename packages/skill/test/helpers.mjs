import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function runScript(script, env) {
  const scriptPath = path.join(root, "skill/scripts", script);
  return new Promise((resolve) => {
    const child = spawn("bash", [scriptPath], {
      cwd: root,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    // Settle on spawn failure too (e.g. bash missing) instead of hanging.
    child.on("error", (err) => resolve({ code: -1, stdout, stderr: stderr + String(err) }));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

/** Merge env overrides into process.env; `undefined` deletes a variable. */
export function scriptEnv(env) {
  const next = { ...process.env, ...env };
  for (const key of Object.keys(next)) {
    if (next[key] === undefined) delete next[key];
  }
  return next;
}

export function tmpdir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Build a zip buffer from {name: content} using the system `zip` binary. */
export function zipBuffer(files) {
  const dir = tmpdir("maradocs-skill-zip-");
  try {
    for (const [name, content] of Object.entries(files)) {
      const file = path.join(dir, name);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
    }
    const out = path.join(dir, "..", path.basename(dir) + ".zip");
    const res = spawnSync("zip", ["-q", "-r", out, "."], { cwd: dir });
    if (res.status !== 0) throw new Error("zip failed");
    const buffer = fs.readFileSync(out);
    fs.rmSync(out, { force: true });
    return buffer;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
