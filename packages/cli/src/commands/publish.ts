import { Command } from "commander";
import type { AccessMode, PublishResult } from "@maradocs/shared";
import { resolveConfig } from "../config.js";
import { ApiError, MaraClient } from "../client.js";
import { zipFolder, hasEntrypoint } from "../zip.js";
import { accessBadge, formatBytes, printJson, setJsonMode, ui } from "../output.js";
import pc from "picocolors";

export function registerPublish(program: Command): void {
  program
    .command("publish <path>")
    .description("Publish a static report folder as a new document version")
    .requiredOption("-r, --repo <repo>", "Repository slug (created automatically if missing)")
    .requiredOption("-d, --doc <doc>", "Document slug")
    .option("-t, --title <title>", "Document title")
    .option("-a, --access <mode>", "public | password | private")
    .option("-p, --password <password>", "Password (for password access)")
    .option("-e, --entrypoint <file>", "Entry HTML file (default index.html)")
    .option("--replace", "Require the document to exist (PUT semantics)")
    .option("--no-create-repo", "Fail instead of creating a missing repository")
    .option("--json", "Print the result as JSON (progress goes to stderr)")
    .action(async (folder: string, opts: Record<string, unknown>) => {
      setJsonMode(Boolean(opts.json));
      const repo = opts.repo as string;
      const docSlug = opts.doc as string;
      const entrypoint = (opts.entrypoint as string) ?? "index.html";
      if (!hasEntrypoint(folder, entrypoint)) {
        ui.warn(`No ${entrypoint} found in ${folder} — publishing anyway.`);
      }
      ui.info(`Packaging ${pc.bold(folder)} …`);
      const { buffer, fileCount } = zipFolder(folder);
      ui.info(`Uploading ${fileCount} files (${formatBytes(buffer.length)}) …`);

      const client = new MaraClient(resolveConfig());
      const fields = {
        doc: docSlug,
        title: opts.title as string | undefined,
        access: opts.access as AccessMode | undefined,
        password: opts.password as string | undefined,
        entrypoint: opts.entrypoint as string | undefined,
      };

      const attempt = (replace: boolean): Promise<PublishResult> =>
        client.publish(repo, fields, buffer, replace);

      let result: PublishResult;
      try {
        result = await attempt(Boolean(opts.replace));
      } catch (err) {
        if (!(err instanceof ApiError) || opts.replace) throw err;
        if (err.status === 404 && opts.createRepo !== false) {
          ui.info(`Repository ${pc.bold(repo)} not found — creating it …`);
          await client.createRepo({
            slug: repo,
            access: opts.access as AccessMode | undefined,
            password: opts.password as string | undefined,
          });
          result = await attempt(false);
        } else if (err.status === 409) {
          ui.info(`Document ${pc.bold(`${repo}/${docSlug}`)} exists — publishing a new version …`);
          result = await attempt(true);
        } else if (err.status === 404) {
          throw new ApiError(
            err.status,
            err.code,
            `${err.message}. Run \`maradocs repo create ${repo}\` or drop --no-create-repo.`,
          );
        } else {
          throw err;
        }
      }

      if (opts.json) {
        printJson(result);
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
