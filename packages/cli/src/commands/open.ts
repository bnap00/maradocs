import { Command } from "commander";
import { spawn } from "node:child_process";
import { resolveConfig } from "../config.js";
import { printJson, setJsonMode, ui } from "../output.js";

function openInBrowser(url: string): void {
  const platform = process.platform;
  const cmd = platform === "darwin" ? "open" : platform === "win32" ? "start" : "xdg-open";
  try {
    spawn(cmd, [url], { detached: true, stdio: "ignore", shell: platform === "win32" });
  } catch {
    /* ignore — URL is printed regardless */
  }
}

export function registerOpen(program: Command): void {
  program
    .command("open <target>")
    .description("Print and open a document URL in the browser (repo/doc)")
    .option("--no-browser", "Only print the URL")
    .option("--json", "Print the URL as JSON (implies --no-browser)")
    .action((target: string, opts: { browser?: boolean; json?: boolean }) => {
      setJsonMode(Boolean(opts.json));
      const parts = target.split("/");
      if (parts.length !== 2 || !parts[0] || !parts[1]) {
        throw new Error(`Expected <repo>/<doc>, got '${target}'`);
      }
      const cfg = resolveConfig();
      const url = `${cfg.server}/r/${parts[0]}/${parts[1]}/`;
      if (opts.json) {
        printJson({ repo: parts[0], doc: parts[1], url });
        return;
      }
      ui.url("URL", url);
      if (opts.browser !== false) openInBrowser(url);
    });
}
