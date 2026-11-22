import type {
  CreateRepoInput,
  DocumentSummary,
  Repository,
  UpdateRepoInput,
} from "@maradocs/shared";
import type { AppContext } from "../context.js";
import type { RepoRecord } from "../db/store.js";
import { badRequest, conflict, notFound } from "../util/errors.js";
import { hashPassword } from "./access.js";
import { presentDoc, presentRepo } from "./present.js";

export interface Actor {
  type: "machine" | "user";
  id: string | null;
  label: string | null;
  /**
   * Account acting (a session's user, or the owner of the API key). Every
   * repository lookup is scoped to it. Null only for a legacy, not yet
   * adopted API key, which then only sees legacy (ownerless) repositories.
   */
  userId: string | null;
}

/** Look up a repository owned by `ownerId`; other users' repositories are invisible (404). */
export function getRepoOr404(ctx: AppContext, ownerId: string | null, slug: string): RepoRecord {
  const repo = ctx.store.getRepo(slug);
  if (!repo || repo.ownerId !== ownerId) throw notFound(`Repository '${slug}' not found`);
  return repo;
}

export function listRepos(ctx: AppContext, ownerId: string | null): Repository[] {
  return ctx.store.listRepos(ownerId).map(presentRepo);
}

export async function createRepo(
  ctx: AppContext,
  input: CreateRepoInput,
  actor: Actor,
): Promise<Repository> {
  const existing = ctx.store.getRepo(input.slug);
  if (existing) {
    // Slugs are global (reader URLs are /r/:repo/:doc), so another user's
    // repository blocks the slug too.
    throw conflict(
      existing.ownerId === actor.userId
        ? `Repository '${input.slug}' already exists`
        : `Repository slug '${input.slug}' is already taken`,
    );
  }
  const access = input.access ?? ctx.config.defaultRepoAccess;
  if (access === "password" && !input.password) {
    throw badRequest("A password is required when access is 'password'");
  }
  const passwordHash = input.password ? await hashPassword(input.password) : null;
  const repo = ctx.store.createRepo({
    ownerId: actor.userId,
    slug: input.slug,
    name: input.name ?? input.slug,
    description: input.description ?? null,
    defaultAccess: access,
    indexEnabled: input.indexEnabled ?? false,
    passwordHash,
  });
  ctx.store.addAudit({
    userId: actor.userId,
    event: "repo.create",
    actorType: actor.type,
    actorId: actor.id,
    actorLabel: actor.label,
    repositorySlug: repo.slug,
    documentSlug: null,
    detail: `access=${access}`,
  });
  return presentRepo(repo);
}

export async function updateRepo(
  ctx: AppContext,
  slug: string,
  input: UpdateRepoInput,
  actor: Actor,
): Promise<Repository> {
  const repo = getRepoOr404(ctx, actor.userId, slug);
  const fields: Parameters<typeof ctx.store.updateRepo>[1] = {};
  if (input.name !== undefined) fields.name = input.name;
  if (input.description !== undefined) fields.description = input.description;
  if (input.indexEnabled !== undefined) fields.indexEnabled = input.indexEnabled;

  const nextAccess = input.access ?? repo.defaultAccess;
  if (input.access !== undefined) fields.defaultAccess = input.access;

  if (input.password !== undefined) {
    fields.passwordHash = input.password ? await hashPassword(input.password) : null;
  }
  if (
    nextAccess === "password" &&
    !(input.password ?? repo.passwordHash)
  ) {
    throw badRequest("A password is required when access is 'password'");
  }

  ctx.store.updateRepo(repo.id, fields);
  const changedAccess = input.access !== undefined || input.password !== undefined;
  ctx.store.addAudit({
    userId: actor.userId,
    event: changedAccess ? "access.change" : "repo.update",
    actorType: actor.type,
    actorId: actor.id,
    actorLabel: actor.label,
    repositorySlug: repo.slug,
    documentSlug: null,
    detail: input.access ? `access=${input.access}` : "metadata updated",
  });
  return presentRepo(getRepoOr404(ctx, actor.userId, slug));
}

export function listDocs(
  ctx: AppContext,
  ownerId: string | null,
  slug: string,
  origin?: string,
): DocumentSummary[] {
  const repo = getRepoOr404(ctx, ownerId, slug);
  return ctx.store.listDocs(repo.id).map((doc) => presentDoc(ctx, repo, doc, origin));
}
