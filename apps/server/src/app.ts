import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import { ZodError } from "zod";
import type { ServerConfig } from "./config.js";
import type { AppContext } from "./context.js";
import { Store } from "./db/store.js";
import { Storage } from "./services/storage.js";
import crypto from "node:crypto";
import { LocalAuth } from "./auth/local.js";
import { HttpError } from "./util/errors.js";
import { systemRoutes } from "./routes/system.js";
import { apiRoutes } from "./routes/api.js";
import { authRoutes } from "./routes/auth.js";
import { dashboardApiRoutes } from "./routes/dashboardApi.js";
import { readRoutes } from "./routes/read.js";
import { dashboardRoutes } from "./routes/dashboard.js";

export interface BuiltApp {
  app: FastifyInstance;
  ctx: AppContext;
}

export async function buildApp(config: ServerConfig): Promise<BuiltApp> {
  const store = new Store(config.dbPath);
  store.purgeExpiredSessions();
  const storage = new Storage(config.repositoriesDir);
  const auth = new LocalAuth(store, config.bcryptRounds);
  // No secrets are required to run: without COOKIE_SECRET, generate one on
  // first start and persist it so signed cookies survive restarts.
  const cookieSecret =
    config.cookieSecret ??
    store.getOrCreateSetting("cookie_secret", () => crypto.randomBytes(32).toString("hex"));
  const ctx: AppContext = { config, store, storage, auth, cookieSecret };

  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? "info",
      transport:
        config.isProduction || process.env.NO_PRETTY_LOG
          ? undefined
          : { target: "pino-pretty", options: { translateTime: "HH:MM:ss", ignore: "pid,hostname" } },
    },
    bodyLimit: config.maxUploadBytes + 1024 * 1024,
    trustProxy: config.trustProxy,
  });

  app.decorate("ctx", ctx);

  const userCount = store.countUsers();
  if (config.adminPassword) {
    if (userCount > 0) {
      app.log.warn(
        "ADMIN_PASSWORD is set but accounts already exist: it is no longer used for sign-in and can be removed",
      );
    } else {
      app.log.info("ADMIN_PASSWORD is set: creating the first account requires it as the claim password");
    }
  }
  if (userCount === 0 && config.registration !== "closed") {
    app.log.info("No accounts yet: open the dashboard to create the owner account");
  }

  await app.register(cookie);
  await app.register(multipart, {
    limits: { fileSize: config.maxUploadBytes, files: 1 },
  });
  await app.register(rateLimit, { global: false });

  app.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "string" },
    (_req, body, done) => {
      done(null, Object.fromEntries(new URLSearchParams(body as string)));
    },
  );

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) {
      reply.code(err.statusCode).send({
        error: err.code,
        message: err.message,
        details: err.details,
      });
      return;
    }
    if (err instanceof ZodError) {
      reply.code(400).send({
        error: "validation_error",
        message: "Request validation failed",
        details: err.issues,
      });
      return;
    }
    if ((err as { statusCode?: number }).statusCode === 413) {
      reply.code(413).send({ error: "payload_too_large", message: "Upload too large" });
      return;
    }
    if ((err as { statusCode?: number }).statusCode === 429) {
      reply.code(429).send({ error: "rate_limited", message: "Too many requests" });
      return;
    }
    req.log.error({ err }, "Unhandled error");
    reply.code(500).send({ error: "internal_error", message: "Internal server error" });
  });

  // Routes
  await app.register(systemRoutes);
  await app.register(apiRoutes, { prefix: "/api/v1" });
  await app.register(authRoutes, { prefix: "/api/v1/auth" });
  await app.register(dashboardApiRoutes, { prefix: "/api/v1/dashboard" });
  await app.register(readRoutes);
  await app.register(dashboardRoutes);

  // Root: friendly redirect to the dashboard.
  app.get("/", async (_req, reply) => reply.redirect("/dashboard/", 302));

  return { app, ctx };
}
