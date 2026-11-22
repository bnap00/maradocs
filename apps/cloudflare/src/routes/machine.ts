// Machine API (`/api/v1`, API key). Wire-compatible with the Node server:
// same paths, status codes, JSON shapes and error codes.

import { Hono } from "hono";
import { createRepoSchema, rollbackSchema, updateRepoSchema } from "../vendor/shared/index.js";
import { readJson } from "../http.js";
import {
  docParam,
  machineActor,
  repoParam,
  requireAnyScope,
  requireMachine,
  requireScope,
} from "../middleware.js";
import { createRepo, listRepos, updateRepo } from "../services/repos.js";
import { deleteDocument, listDocs, listVersions, rollbackDocument } from "../services/docs.js";
import type { AppEnv } from "../types.js";
import { handleBundle, handlePublish } from "./shared.js";

export const machineRoutes = new Hono<AppEnv>();

// Scoped to /repos so the middleware never leaks onto sibling /api/v1 routes.
machineRoutes.use("/repos", requireMachine);
machineRoutes.use("/repos/*", requireMachine);

machineRoutes.get("/repos", async (c) => c.json({ repos: await listRepos(c) }));

machineRoutes.post("/repos", requireScope("publish"), async (c) => {
  const input = await readJson(c, createRepoSchema);
  return c.json({ repo: await createRepo(c, input, machineActor(c)) }, 201);
});

machineRoutes.patch("/repos/:repo", requireScope("publish"), async (c) => {
  const repo = repoParam(c);
  const input = await readJson(c, updateRepoSchema);
  return c.json({ repo: await updateRepo(c, repo, input, machineActor(c)) });
});

machineRoutes.get("/repos/:repo/docs", async (c) => c.json({ docs: await listDocs(c, repoParam(c)) }));

machineRoutes.post("/repos/:repo/docs", requireScope("publish"), async (c) =>
  handlePublish(c, repoParam(c), machineActor(c), "create"),
);

machineRoutes.put("/repos/:repo/docs/:doc", requireScope("publish"), async (c) => {
  const repo = repoParam(c);
  return handlePublish(c, repo, machineActor(c), "replace", docParam(c, repo));
});

machineRoutes.delete("/repos/:repo/docs/:doc", requireScope("publish"), async (c) => {
  const repo = repoParam(c);
  await deleteDocument(c, repo, docParam(c, repo), machineActor(c));
  return c.json({ deleted: true });
});

machineRoutes.get("/repos/:repo/docs/:doc/versions", async (c) => {
  const repo = repoParam(c);
  return c.json({ versions: await listVersions(c, repo, docParam(c, repo)) });
});

machineRoutes.get("/repos/:repo/docs/:doc/bundle", requireAnyScope("read", "publish"), async (c) => {
  const repo = repoParam(c);
  return handleBundle(c, repo, docParam(c, repo));
});

machineRoutes.post("/repos/:repo/docs/:doc/rollback", requireScope("publish"), async (c) => {
  const repo = repoParam(c);
  const doc = docParam(c, repo);
  const { version } = await readJson(c, rollbackSchema);
  return c.json({ doc: await rollbackDocument(c, repo, doc, version, machineActor(c)) });
});
