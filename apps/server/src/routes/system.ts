import type { FastifyInstance } from "fastify";

export async function systemRoutes(app: FastifyInstance): Promise<void> {
  const ctx = app.ctx;

  app.get("/health", async () => ({
    status: "ok",
    service: "maradocs",
    time: new Date().toISOString(),
  }));

  app.get("/api/v1/public-config", async () => ({
    defaultRepoAccess: ctx.config.defaultRepoAccess,
  }));
}
