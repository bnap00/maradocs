import type { FastifyInstance } from "fastify";
import {
  createRepoSchema,
  publishDocSchema,
  rollbackSchema,
  updateRepoSchema,
} from "@maradocs/shared";
import { badRequest } from "../util/errors.js";
import { parseUpload } from "../util/multipart.js";
import { requireMachine, requireScope } from "../auth/middleware.js";
import {
  createRepo,
  listDocs,
  listRepos,
  updateRepo,
} from "../services/repoService.js";
import {
  deleteDocument,
  listVersions,
  publishDocument,
  rollbackDocument,
} from "../services/docService.js";
import { machineActor, requestOrigin } from "./helpers.js";

/** REST API for agents/CLI, authenticated with a MaraDocs API key. */
export async function apiRoutes(app: FastifyInstance): Promise<void> {
  const ctx = app.ctx;
  app.addHook("preHandler", requireMachine(ctx));

  app.get("/repos", async (req) => ({
    repos: listRepos(ctx),
  }));

  app.post("/repos", { preHandler: requireScope("publish") }, async (req, reply) => {
    const input = createRepoSchema.parse(req.body);
    const repo = await createRepo(ctx, input, machineActor(req));
    reply.code(201);
    return { repo };
  });

  app.patch<{ Params: { repo: string } }>(
    "/repos/:repo",
    { preHandler: requireScope("publish") },
    async (req) => {
      const input = updateRepoSchema.parse(req.body);
      const repo = await updateRepo(ctx, req.params.repo, input, machineActor(req));
      return { repo };
    },
  );

  app.get<{ Params: { repo: string } }>("/repos/:repo/docs", async (req) => ({
    docs: listDocs(ctx, req.params.repo, requestOrigin(req)),
  }));

  // Publish a new document (multipart: zip + fields).
  app.post<{ Params: { repo: string } }>(
    "/repos/:repo/docs",
    { preHandler: requireScope("publish") },
    async (req, reply) => {
      const { fields, file } = await parseUpload(req);
      if (!file) throw badRequest("Missing document bundle (field 'file')");
      const input = publishDocSchema.parse(coerceFields(fields));
      const result = await publishDocument(
        ctx,
        req.params.repo,
        input,
        file,
        machineActor(req),
        { origin: requestOrigin(req), mustNotExist: true },
      );
      reply.code(201);
      return result;
    },
  );

  // Replace an existing document with a new version.
  app.put<{ Params: { repo: string; doc: string } }>(
    "/repos/:repo/docs/:doc",
    { preHandler: requireScope("publish") },
    async (req) => {
      const { fields, file } = await parseUpload(req);
      if (!file) throw badRequest("Missing document bundle (field 'file')");
      const input = publishDocSchema.parse({
        ...coerceFields(fields),
        doc: req.params.doc,
      });
      return publishDocument(ctx, req.params.repo, input, file, machineActor(req), {
        origin: requestOrigin(req),
        mustExist: true,
      });
    },
  );

  app.delete<{ Params: { repo: string; doc: string } }>(
    "/repos/:repo/docs/:doc",
    { preHandler: requireScope("publish") },
    async (req) => {
      deleteDocument(ctx, req.params.repo, req.params.doc, machineActor(req));
      return { deleted: true };
    },
  );

  app.get<{ Params: { repo: string; doc: string } }>(
    "/repos/:repo/docs/:doc/versions",
    async (req) => ({
      versions: listVersions(ctx, req.params.repo, req.params.doc),
    }),
  );

  app.post<{ Params: { repo: string; doc: string } }>(
    "/repos/:repo/docs/:doc/rollback",
    { preHandler: requireScope("publish") },
    async (req) => {
      const { version } = rollbackSchema.parse(req.body);
      const doc = rollbackDocument(
        ctx,
        req.params.repo,
        req.params.doc,
        version,
        machineActor(req),
        requestOrigin(req),
      );
      return { doc };
    },
  );
}

/** Multipart fields arrive as strings; coerce booleans/known shapes. */
function coerceFields(fields: Record<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...fields };
  if (typeof out.indexEnabled === "string") {
    out.indexEnabled = out.indexEnabled === "true";
  }
  return out;
}
