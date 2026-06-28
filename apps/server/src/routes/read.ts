import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import fs from "node:fs";
import path from "node:path";
import { passwordUnlockSchema } from "@maradocs/shared";
import type { AppContext } from "../context.js";
import type { DocRecord, RepoRecord } from "../db/store.js";
import {
  effectiveAccess,
  effectivePasswordHash,
  passwordCookieName,
  signPasswordCookie,
  verifyPassword,
  verifyPasswordCookie,
} from "../services/access.js";
import { contentTypeFor } from "../util/mime.js";
import { notFound } from "../util/errors.js";
import { passwordGateHtml, signInHtml } from "./passwordGate.js";

interface Resolved {
  repo: RepoRecord;
  doc: DocRecord;
}

function resolve(ctx: AppContext, repoSlug: string, docSlug: string): Resolved | null {
  const repo = ctx.store.getRepo(repoSlug);
  if (!repo) return null;
  const doc = ctx.store.getDoc(repo.id, docSlug);
  if (!doc) return null;
  return { repo, doc };
}

function sessionToken(req: FastifyRequest): string | null {
  const auth = req.headers.authorization;
  if (auth) {
    const m = /^Bearer\s+(.+)$/i.exec(auth);
    if (m) return m[1]!.trim();
  }
  const cookie = req.cookies["__session"];
  return cookie ?? null;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case "'": return "&#39;";
      default: return "&quot;";
    }
  });
}

/**
 * Enforce the document's effective access mode. Returns true when the request
 * may proceed; otherwise it writes the appropriate response and returns false.
 */
async function gate(
  ctx: AppContext,
  req: FastifyRequest,
  reply: FastifyReply,
  { repo, doc }: Resolved,
): Promise<boolean> {
  const access = effectiveAccess(repo, doc);
  if (access === "public") return true;

  if (access === "password") {
    const hash = effectivePasswordHash(repo, doc);
    if (!hash) return true; // misconfigured: no password set, treat as public
    const cookie = req.cookies[passwordCookieName(repo.slug, doc.slug)];
    if (verifyPasswordCookie(ctx.config.cookieSecret, hash, cookie)) return true;
    reply.code(401).type("text/html").send(passwordGateHtml({ repo: repo.slug, doc: doc.slug }));
    return false;
  }

  // private
  const token = sessionToken(req);
  if (token) {
    const identity = await ctx.auth.verifySession(token);
    if (identity) return true;
    const machine = await ctx.auth.verifyApiKey(token);
    if (
      machine &&
      (machine.scopes.includes("read") ||
        machine.scopes.includes("publish") ||
        machine.scopes.includes("admin"))
    ) {
      return true;
    }
  }
  reply.code(401).type("text/html").send(signInHtml({ repo: repo.slug, doc: doc.slug }));
  return false;
}

/** Serve a file from a version directory, applying directory-index fallback. */
function serveAsset(
  ctx: AppContext,
  reply: FastifyReply,
  versionDir: string,
  entrypoint: string,
  assetPath: string,
  isPublic = false,
): FastifyReply {
  let rel = assetPath;
  if (rel === "" ) rel = entrypoint;
  else if (rel.endsWith("/")) rel = rel + "index.html";

  const resolved = ctx.storage.resolveWithin(versionDir, rel);
  if (!resolved) throw notFound("Not found");

  let target = resolved;
  if (fs.existsSync(target) && fs.statSync(target).isDirectory()) {
    target = path.join(target, "index.html");
  }
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
    throw notFound("Not found");
  }
  const contentType = contentTypeFor(target);
  // Apply CSP sandbox to all served asset types. SVG and XML documents can
  // execute scripts as top-level browser pages; the sandbox forces a null
  // origin so they cannot read the parent domain's localStorage or cookies.
  reply
    .type(contentType)
    .header("cache-control", isPublic ? "public, max-age=60" : "private, max-age=60")
    .header("x-content-type-options", "nosniff")
    .header("content-security-policy", "sandbox allow-downloads allow-forms allow-popups allow-scripts");
  return reply.send(fs.createReadStream(target));
}

function repoIndexHtml(ctx: AppContext, repo: RepoRecord): string {
  const docs = ctx.store
    .listDocs(repo.id)
    .filter((d) => d.latestVersionId && effectiveAccess(repo, d) === "public");
  const items = docs
    .map(
      (d) =>
        `<li><a href="/r/${repo.slug}/${d.slug}/">${escapeHtml(d.title)}</a> <span class="slug">${d.slug}</span></li>`,
    )
    .join("\n");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(repo.name)}</title>
<style>
  body { font-family: ui-sans-serif, system-ui, sans-serif; max-width: 720px; margin: 48px auto; padding: 0 20px; color:#0f172a; }
  @media (prefers-color-scheme: dark){ body{ color:#e2e8f0; background:#0b1120 } a{color:#a5b4fc} .slug{color:#64748b} }
  h1 { font-size: 22px; } p { color:#64748b; }
  ul { list-style:none; padding:0; } li { padding:12px 0; border-bottom:1px solid rgba(148,163,184,.2); }
  a { font-weight:600; text-decoration:none; } .slug { color:#94a3b8; font-size:13px; margin-left:8px; }
</style></head>
<body>
  <h1>${escapeHtml(repo.name)}</h1>
  ${repo.description ? `<p>${escapeHtml(repo.description)}</p>` : ""}
  <ul>${items || "<li>No documents published yet.</li>"}</ul>
</body></html>`;
}

/** Public read surface for published documents. */
export async function readRoutes(app: FastifyInstance): Promise<void> {
  const ctx = app.ctx;

  // Repository index
  app.get<{ Params: { repo: string } }>("/r/:repo", async (req, reply) => {
    reply.redirect(`/r/${req.params.repo}/`, 308);
  });
  app.get<{ Params: { repo: string } }>("/r/:repo/", async (req, reply) => {
    const repo = ctx.store.getRepo(req.params.repo);
    if (!repo) throw notFound(`Repository '${req.params.repo}' not found`);
    if (!repo.indexEnabled) throw notFound("Repository index is not enabled");
    return reply.type("text/html").send(repoIndexHtml(ctx, repo));
  });

  const unlockAttempts = new Map<string, { count: number; resetAt: number }>();
  const UNLOCK_WINDOW_MS = 15 * 60 * 1000;
  const UNLOCK_MAX = 10;

  function passwordAttemptAllowed(req: FastifyRequest, repo: string, doc: string): boolean {
    const key = `${req.ip}:${repo}:${doc}`;
    const now = Date.now();
    const current = unlockAttempts.get(key);
    if (!current || current.resetAt <= now) {
      // Evict any expired entries (bounded sweep — Map preserves insertion order).
      if (unlockAttempts.size > 5000) {
        for (const [k, v] of unlockAttempts) {
          if (v.resetAt <= now) unlockAttempts.delete(k);
          if (unlockAttempts.size <= 2500) break;
        }
      }
      unlockAttempts.set(key, { count: 1, resetAt: now + UNLOCK_WINDOW_MS });
      return true;
    }
    current.count += 1;
    return current.count <= UNLOCK_MAX;
  }

  // Password unlock handler
  app.post<{ Params: { repo: string; doc: string } }>(
    "/r/:repo/:doc/__unlock",
    async (req, reply) => {
      const found = resolve(ctx, req.params.repo, req.params.doc);
      if (!found) throw notFound("Not found");
      const hash = effectivePasswordHash(found.repo, found.doc);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const parsed = passwordUnlockSchema.safeParse(body);
      if (!passwordAttemptAllowed(req, found.repo.slug, found.doc.slug)) {
        return reply.code(429).send({ error: "rate_limited", message: "Too many password attempts" });
      }
      if (!hash || !parsed.success) {
        return reply
          .code(401)
          .type("text/html")
          .send(passwordGateHtml({ repo: found.repo.slug, doc: found.doc.slug, error: true }));
      }
      const ok = await verifyPassword(parsed.data.password, hash);
      if (!ok) {
        return reply
          .code(401)
          .type("text/html")
          .send(passwordGateHtml({ repo: found.repo.slug, doc: found.doc.slug, error: true }));
      }
      reply.setCookie(
        passwordCookieName(found.repo.slug, found.doc.slug),
        signPasswordCookie(ctx.config.cookieSecret, hash),
        { path: `/r/${found.repo.slug}/${found.doc.slug}`, httpOnly: true, sameSite: "lax", secure: ctx.config.isProduction },
      );
      return reply.redirect(`/r/${found.repo.slug}/${found.doc.slug}/`, 303);
    },
  );

  // Pinned immutable version
  app.get<{ Params: { repo: string; doc: string; version: string; "*": string } }>(
    "/r/:repo/:doc/v/:version/*",
    async (req, reply) => {
      const found = resolve(ctx, req.params.repo, req.params.doc);
      if (!found) throw notFound("Not found");
      if (!(await gate(ctx, req, reply, found))) return reply;
      const versionNumber = Number(req.params.version);
      const version = Number.isInteger(versionNumber)
        ? ctx.store.getVersionByNumber(found.doc.id, versionNumber)
        : null;
      if (!version) throw notFound(`Version ${req.params.version} not found`);
      return serveAsset(ctx, reply, version.storage_path, version.entrypoint, req.params["*"], effectiveAccess(found.repo, found.doc) === "public");
    },
  );
  app.get<{ Params: { repo: string; doc: string; version: string } }>(
    "/r/:repo/:doc/v/:version",
    async (req, reply) =>
      reply.redirect(`/r/${req.params.repo}/${req.params.doc}/v/${req.params.version}/`, 308),
  );

  // Latest version (and assets)
  app.get<{ Params: { repo: string; doc: string } }>(
    "/r/:repo/:doc",
    async (req, reply) =>
      reply.redirect(`/r/${req.params.repo}/${req.params.doc}/`, 308),
  );
  app.get<{ Params: { repo: string; doc: string; "*": string } }>(
    "/r/:repo/:doc/*",
    async (req, reply) => {
      const found = resolve(ctx, req.params.repo, req.params.doc);
      if (!found) throw notFound("Not found");
      if (!found.doc.latestVersionId) throw notFound("No published version");
      if (!(await gate(ctx, req, reply, found))) return reply;
      const version = ctx.store.getVersionById(found.doc.latestVersionId);
      if (!version) throw notFound("No published version");
      return serveAsset(ctx, reply, version.storage_path, version.entrypoint, req.params["*"], effectiveAccess(found.repo, found.doc) === "public");
    },
  );
}
