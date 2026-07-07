import type { FastifyInstance } from "fastify";
import { openapiSpec } from "./openapi.js";

export async function systemRoutes(app: FastifyInstance): Promise<void> {
  const ctx = app.ctx;

  app.get("/health", async () => ({
    status: "ok",
    service: "maradocs",
    time: new Date().toISOString(),
  }));

  // Machine-discoverable API description for agents and tooling.
  app.get("/api/v1/openapi.json", async () => openapiSpec);

  app.get("/api/v1/public-config", async () => ({
    defaultRepoAccess: ctx.config.defaultRepoAccess,
  }));
}
