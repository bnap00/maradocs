import { Command } from "commander";
import fs from "node:fs";
import path from "node:path";
import { resolveConfig } from "../config.js";
import { MaraClient } from "../client.js";
import { extractZip } from "../zip.js";
import { accessBadge, formatBytes, printJson, setJsonMode, ui } from "../output.js";
import pc from "picocolors";

function client(): MaraClient {
  return new MaraClient(resolveConfig());
}

function parseTarget(target: string): { repo: string; doc: string } {
  const parts = target.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`Expected <repo>/<doc>, got '${target}'`);
  }
  return { repo: parts[0], doc: parts[1] };
}

export function registerDoc(program: Command): void {
  const doc = program.command("doc").description("Manage documents");

  doc
    .command("list <repo>")
    .alias("ls")
    .description("List documents in a repository")
    .option("--json", "Print documents as JSON")
    .action(async (repo: string, opts: { json?: boolean }) => {
      setJsonMode(Boolean(opts.json));
      const { docs } = await client().listDocs(repo);
      if (opts.json) {
        printJson(docs);
        return;
      }
      if (docs.length === 0) {
        ui.info(`No documents in ${repo}.`);
        return;
      }
      ui.heading(`Documents in ${repo}`);
      for (const d of docs) {
        const ver = d.latestVersionNumber ? `v${d.latestVersionNumber}` : "—";
        ui.raw(`  ${d.slug.padEnd(24)} ${accessBadge(d.access).padEnd(18)} ${ver}`);
        if (d.url) ui.raw(`    ${pc.dim(d.url)}`);
      }
    });

  doc
    .command("versions <target>")
    .description("List versions of a document (repo/doc)")
    .option("--json", "Print versions as JSON")
    .action(async (target: string, opts: { json?: boolean }) => {
      setJsonMode(Boolean(opts.json));
      const { repo, doc: docSlug } = parseTarget(target);
      const { versions } = await client().listVersions(repo, docSlug);
      if (opts.json) {
        printJson(versions);
        return;
      }
      ui.heading(`Versions of ${repo}/${docSlug}`);
      for (const v of versions) {
        const tag = v.isLatest ? pc.green(" (latest)") : "";
        ui.raw(
          `  v${String(v.versionNumber).padEnd(4)} ` +
            `${formatBytes(v.sizeBytes).padEnd(10)} ${String(v.fileCount).padEnd(4)} files  ` +
            `${pc.dim(v.createdAt)}${tag}`,
        );
        ui.raw(`    ${pc.dim("by")} ${v.publishedByLabel ?? v.publishedByType}  ${pc.dim(v.checksum.slice(0, 16))}`);
      }
    });

  doc
    .command("download <target>")
    .description("Download a document version's files (repo/doc)")
    .option("-v, --version <n>", "Version number (default: latest)")
    .option("-o, --out <dir>", "Directory to extract into (default: ./<doc>)")
    .option("--zip <file>", "Save the raw zip archive instead of extracting")
    .option("-f, --force", "Extract into a non-empty directory")
    .option("--json", "Print the download result as JSON")
    .action(
      async (
        target: string,
        opts: { version?: string; out?: string; zip?: string; force?: boolean; json?: boolean },
      ) => {
        setJsonMode(Boolean(opts.json));
        const { repo, doc: docSlug } = parseTarget(target);
        let version: number | undefined;
        if (opts.version !== undefined) {
          version = Number(opts.version);
          if (!Number.isInteger(version) || version < 1) {
            throw new Error(`--version must be a positive integer, got '${opts.version}'`);
          }
        }
        ui.info(`Downloading ${pc.bold(`${repo}/${docSlug}`)}${version ? ` v${version}` : ""} …`);
        const result = await client().downloadBundle(repo, docSlug, version);

        if (opts.zip) {
          fs.mkdirSync(path.dirname(path.resolve(opts.zip)), { recursive: true });
          fs.writeFileSync(opts.zip, result.buffer);
          if (opts.json) {
            printJson({
              repo,
              doc: docSlug,
              versionNumber: result.versionNumber,
              checksum: result.checksum,
              zip: path.resolve(opts.zip),
            });
            return;
          }
          ui.success(
            `Saved ${repo}/${docSlug} v${result.versionNumber} to ${pc.bold(opts.zip)} ` +
              `(${formatBytes(result.buffer.length)})`,
          );
          return;
        }

        const outDir = opts.out ?? `./${docSlug}`;
        if (!opts.force && fs.existsSync(outDir) && fs.readdirSync(outDir).length > 0) {
          throw new Error(
            `Directory '${outDir}' is not empty. Use --force to extract anyway or --out <dir>.`,
          );
        }
        const fileCount = extractZip(result.buffer, outDir);
        if (opts.json) {
          printJson({
            repo,
            doc: docSlug,
            versionNumber: result.versionNumber,
            checksum: result.checksum,
            entrypoint: result.entrypoint,
            fileCount,
            out: path.resolve(outDir),
          });
          return;
        }
        ui.success(
          `Downloaded ${repo}/${docSlug} v${result.versionNumber} ` +
            `(${fileCount} files) to ${pc.bold(outDir)}`,
        );
        ui.kv("Checksum", (result.checksum ?? "").slice(0, 16));
        ui.info(`Edit and republish with: maradocs publish ${outDir} --repo ${repo} --doc ${docSlug}`);
      },
    );

  doc
    .command("rollback <target>")
    .description("Promote a previous version to latest (repo/doc)")
    .requiredOption("-v, --version <n>", "Version number to promote")
    .option("--json", "Print the updated document as JSON")
    .action(async (target: string, opts: { version: string; json?: boolean }) => {
      setJsonMode(Boolean(opts.json));
      const { repo, doc: docSlug } = parseTarget(target);
      const { doc: updated } = await client().rollback(
        repo,
        docSlug,
        Number(opts.version),
      );
      if (opts.json) {
        printJson(updated);
        return;
      }
      ui.success(
        `Rolled ${repo}/${docSlug} back to v${opts.version} ` +
          `(now latest: v${updated.latestVersionNumber}).`,
      );
    });

  doc
    .command("delete <target>")
    .alias("rm")
    .description("Delete a document and all versions (repo/doc)")
    .option("-y, --yes", "Skip confirmation")
    .option("--json", "Print the deletion result as JSON")
    .action(async (target: string, opts: { yes?: boolean; json?: boolean }) => {
      setJsonMode(Boolean(opts.json));
      const { repo, doc: docSlug } = parseTarget(target);
      if (!opts.yes) {
        if (opts.json) {
          printJson({ deleted: false, reason: "confirmation_required", hint: "re-run with --yes" });
          process.exitCode = 1;
          return;
        }
        ui.warn(`This permanently deletes ${repo}/${docSlug}. Re-run with --yes to confirm.`);
        return;
      }
      await client().deleteDoc(repo, docSlug);
      if (opts.json) {
        printJson({ deleted: true, repo, doc: docSlug });
        return;
      }
      ui.success(`Deleted ${repo}/${docSlug}.`);
    });
}
