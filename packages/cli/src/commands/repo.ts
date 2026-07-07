import { Command } from "commander";
import type { AccessMode } from "@maradocs/shared";
import { resolveConfig } from "../config.js";
import { MaraClient } from "../client.js";
import { accessBadge, printJson, setJsonMode, ui } from "../output.js";

function client(): MaraClient {
  return new MaraClient(resolveConfig());
}

export function registerRepo(program: Command): void {
  const repo = program.command("repo").description("Manage repositories");

  repo
    .command("create <slug>")
    .description("Create a repository")
    .option("-a, --access <mode>", "public | password | private")
    .option("-n, --name <name>", "Display name")
    .option("-d, --description <text>", "Description")
    .option("-p, --password <password>", "Password (for password access)")
    .option("--index", "Enable the public repository index")
    .option("--json", "Print the created repository as JSON")
    .action(async (slug: string, opts: Record<string, string | boolean>) => {
      setJsonMode(Boolean(opts.json));
      const { repo: created } = await client().createRepo({
        slug,
        access: opts.access as AccessMode | undefined,
        name: opts.name as string | undefined,
        description: opts.description as string | undefined,
        password: opts.password as string | undefined,
        indexEnabled: Boolean(opts.index),
      });
      if (opts.json) {
        printJson(created);
        return;
      }
      ui.success(`Created repository ${created.slug} (${accessBadge(created.defaultAccess)})`);
    });

  repo
    .command("list")
    .alias("ls")
    .description("List repositories")
    .option("--json", "Print repositories as JSON")
    .action(async (opts: { json?: boolean }) => {
      setJsonMode(Boolean(opts.json));
      const { repos } = await client().listRepos();
      if (opts.json) {
        printJson(repos);
        return;
      }
      if (repos.length === 0) {
        ui.info("No repositories yet. Create one with `maradocs repo create <slug>`.");
        return;
      }
      ui.heading("Repositories");
      for (const r of repos) {
        const idx = r.indexEnabled ? " · index" : "";
        ui.raw(`  ${r.slug.padEnd(24)} ${accessBadge(r.defaultAccess)}${idx}`);
      }
    });

  repo
    .command("update <slug>")
    .description("Update repository metadata or access")
    .option("-a, --access <mode>", "public | password | private")
    .option("-n, --name <name>", "Display name")
    .option("-d, --description <text>", "Description")
    .option("-p, --password <password>", "Set password")
    .option("--clear-password", "Remove the password")
    .option("--index", "Enable the public repository index")
    .option("--no-index", "Disable the public repository index")
    .option("--json", "Print the updated repository as JSON")
    .action(async (slug: string, opts: Record<string, unknown>) => {
      setJsonMode(Boolean(opts.json));
      const { repo: updated } = await client().updateRepo(slug, {
        access: opts.access as AccessMode | undefined,
        name: opts.name as string | undefined,
        description: opts.description as string | undefined,
        password: opts.clearPassword ? null : (opts.password as string | undefined),
        indexEnabled: opts.index as boolean | undefined,
      });
      if (opts.json) {
        printJson(updated);
        return;
      }
      ui.success(`Updated repository ${updated.slug} (${accessBadge(updated.defaultAccess)})`);
    });
}
