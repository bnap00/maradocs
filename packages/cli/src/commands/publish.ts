import { Command } from "commander";
import type { AccessMode } from "@maradocs/shared";
import { resolveConfig } from "../config.js";
import { MaraClient } from "../client.js";
import { zipFolder, hasEntrypoint } from "../zip.js";
import { accessBadge, formatBytes, ui } from "../output.js";
import pc from "picocolors";

export function registerPublish(program: Command): void {
  program
    .command("publish <path>")
    .description("Publish a static report folder as a new document version")
    .requiredOption("-r, --repo <repo>", "Repository slug")
    .requiredOption("-d, --doc <doc>", "Document slug")
    .option("-t, --title <title>", "Document title")
    .option("-a, --access <mode>", "public | password | private")
    .option("-p, --password <password>", "Password (for password access)")
    .option("-e, --entrypoint <file>", "Entry HTML file (default index.html)")
    .option("--replace", "Replace an existing document (PUT semantics)")
    .option("--json", "Print the raw JSON result")
    .action(async (folder: string, opts: Record<string, unknown>) => {
      const entrypoint = (opts.entrypoint as string) ?? "index.html";
      if (!hasEntrypoint(folder, entrypoint)) {
        ui.warn(`No ${entrypoint} found in ${folder} — publishing anyway.`);
      }
      ui.info(`Packaging ${pc.bold(folder)} …`);
      const { buffer, fileCount } = zipFolder(folder);
      ui.info(`Uploading ${fileCount} files (${formatBytes(buffer.length)}) …`);

      const client = new MaraClient(resolveConfig());
      const result = await client.publish(
        opts.repo as string,
        {
          doc: opts.doc as string,
          title: opts.title as string | undefined,
          access: opts.access as AccessMode | undefined,
          password: opts.password as string | undefined,
          entrypoint: opts.entrypoint as string | undefined,
        },
        buffer,
        Boolean(opts.replace),
      );

      if (opts.json) {
        ui.raw(JSON.stringify(result, null, 2));
        return;
      }
      ui.success(
        `Published ${pc.bold(`${result.repo}/${result.doc}`)} ` +
          `v${result.versionNumber} (${accessBadge(result.access)})`,
      );
      ui.url("URL    ", result.url);
      ui.url("Version", result.versionUrl);
      ui.kv("Files", String(result.fileCount));
      ui.kv("Size", formatBytes(result.sizeBytes));
      ui.kv("Checksum", result.checksum.slice(0, 16));
    });
}
