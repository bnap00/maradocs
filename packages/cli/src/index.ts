import { Command } from "commander";
import { ApiError } from "./client.js";
import { ui } from "./output.js";
import { registerAuth } from "./commands/auth.js";
import { registerRepo } from "./commands/repo.js";
import { registerPublish } from "./commands/publish.js";
import { registerDoc } from "./commands/doc.js";
import { registerOpen } from "./commands/open.js";

const program = new Command();
declare const __VERSION__: string;
const VERSION = __VERSION__;

if (process.argv.length === 3 && ["--version", "-V"].includes(process.argv[2]!)) {
  ui.raw(VERSION);
  process.exit(0);
}

program
  .name("maradocs")
  .description("Publish static HTML reports to a MaraDocs server and get durable URLs.")
  .version(VERSION, "--cli-version", "display CLI version");

registerAuth(program);
registerRepo(program);
registerPublish(program);
registerDoc(program);
registerOpen(program);

async function main(): Promise<void> {
  try {
    await program.parseAsync(process.argv);
  } catch (err) {
    if (err instanceof ApiError) {
      ui.error(`${err.message}${err.status ? ` (${err.status})` : ""}`);
    } else {
      ui.error((err as Error).message);
    }
    process.exit(1);
  }
}

void main();
