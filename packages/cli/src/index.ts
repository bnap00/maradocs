import { Command } from "commander";
import { ApiError } from "./client.js";
import { isJsonMode, ui } from "./output.js";
import { registerAuth } from "./commands/auth.js";
import { registerRepo } from "./commands/repo.js";
import { registerPublish } from "./commands/publish.js";
import { registerDoc } from "./commands/doc.js";
import { registerOpen } from "./commands/open.js";

const program = new Command();
declare const __VERSION__: string;
const VERSION = __VERSION__;

program
  .name("maradocs")
  .description("Publish static HTML reports to a MaraDocs server and get durable URLs.")
  .version(VERSION, "-V, --version", "display CLI version");

registerAuth(program);
registerRepo(program);
registerPublish(program);
registerDoc(program);
registerOpen(program);

async function main(): Promise<void> {
  try {
    await program.parseAsync(process.argv);
  } catch (err) {
    if (isJsonMode()) {
      const payload =
        err instanceof ApiError
          ? { error: err.code, message: err.message, status: err.status }
          : { error: "error", message: (err as Error).message };
      console.error(JSON.stringify(payload));
    } else if (err instanceof ApiError) {
      ui.error(`${err.message}${err.status ? ` (${err.status})` : ""}`);
    } else {
      ui.error((err as Error).message);
    }
    process.exit(1);
  }
}

void main();
