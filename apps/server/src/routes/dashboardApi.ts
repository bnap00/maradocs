import type { FastifyInstance } from "fastify";
import {
  createRepoSchema,
  rollbackSchema,
  updateRepoSchema,
} from "@maradocs/shared";
import { requireUser } from "../auth/middleware.js";
import {
  createRepo,
  listDocs,
  listRepos,
  updateRepo,
} from "../services/repoService.js";
import {
  deleteDocument,
  listVersions,
  rollbackDocument,
} from "../services/docService.js";
import { requestOrigin, userActor } from "./helpers.js";

/** Authenticated data + management API consumed by the dashboard SPA. */
export async function dashboardApiRoutes(app: FastifyInstance): Promise<void> {
  const ctx = app.ctx;
  app.addHook("preHandler", requireUser(ctx));

  app.get("/me", async (req) => ({ user: req.user }));

  app.get("/repos", async () => ({
    repos: listRepos(ctx),
  }));

  app.post("/repos", async (req, reply) => {
    const input = createRepoSchema.parse(req.body);
    const repo = await createRepo(ctx, input, userActor(req));
    reply.code(201);
    return { repo };
  });

  app.patch<{ Params: { repo: string } }>("/repos/:repo", async (req) => {
    const input = updateRepoSchema.parse(req.body);
    const repo = await updateRepo(ctx, req.params.repo, input, userActor(req));
    return { repo };
  });

  app.get<{ Params: { repo: string } }>("/repos/:repo/docs", async (req) => ({
    docs: listDocs(ctx, req.params.repo, requestOrigin(req)),
  }));

  app.get<{ Params: { repo: string; doc: string } }>(
    "/repos/:repo/docs/:doc/versions",
    async (req) => ({
      versions: listVersions(ctx, req.params.repo, req.params.doc),
    }),
  );

  app.post<{ Params: { repo: string; doc: string } }>(
    "/repos/:repo/docs/:doc/rollback",
    async (req) => {
      const { version } = rollbackSchema.parse(req.body);
      const doc = rollbackDocument(
        ctx,
        req.params.repo,
        req.params.doc,
        version,
        userActor(req),
        requestOrigin(req),
      );
      return { doc };
    },
  );

  app.delete<{ Params: { repo: string; doc: string } }>(
    "/repos/:repo/docs/:doc",
    async (req) => {
      deleteDocument(ctx, req.params.repo, req.params.doc, userActor(req));
      return { deleted: true };
    },
  );

  app.get("/machines", async () => ({ machines: ctx.store.listMachines() }));

  app.get("/audit", async () => ({ audit: ctx.store.listAudit(200) }));
}
