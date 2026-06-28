import { loadConfig } from "./config.js";
import { buildApp } from "./app.js";

async function main(): Promise<void> {
  const config = loadConfig();

  const { app, ctx } = await buildApp(config);

  const shutdown = async (signal: string) => {
    app.log.info(`Received ${signal}, shutting down`);
    await app.close();
    ctx.store.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  try {
    await app.listen({ port: config.port, host: config.host });
    app.log.info(`MaraDocs listening on ${config.host}:${config.port}`);
    app.log.info(`Data dir: ${config.dataDir}`);
    app.log.info(
      `Public base URL: ${config.publicBaseUrl ?? `http://localhost:${config.port}`}`,
    );
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

void main();
