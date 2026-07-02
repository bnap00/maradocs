import { Command } from "commander";
import { resolveConfig } from "../config.js";
import { MaraClient } from "../client.js";
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
