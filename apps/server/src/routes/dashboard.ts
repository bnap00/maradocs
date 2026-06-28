import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import fs from "node:fs";
import http from "node:http";
import { Readable } from "node:stream";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { contentTypeFor } from "../util/mime.js";

const here = path.dirname(fileURLToPath(import.meta.url));

/** Locate the built dashboard SPA directory across dev and Docker layouts. */
function resolveDashboardDir(): string | null {
  const candidates = [
    process.env.DASHBOARD_DIR,
    path.resolve(here, "../../public/dashboard"), // bundled into server (Docker)
    path.resolve(here, "../../../dashboard/dist"), // monorepo dev (apps/server/dist -> apps/dashboard/dist)
    path.resolve(here, "../../../../apps/dashboard/dist"),
  ].filter(Boolean) as string[];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, "index.html"))) return dir;
  }
  return null;
}

const FALLBACK_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>MaraDocs Dashboard</title>
<style>body{font-family:system-ui,sans-serif;max-width:560px;margin:80px auto;padding:0 20px;color:#334155}
code{background:#f1f5f9;padding:2px 6px;border-radius:4px}</style></head>
<body><h1>MaraDocs</h1><p>The dashboard build was not found. Build it with
<code>pnpm --filter @maradocs/dashboard build</code> or run the server via Docker.</p>
<p>The API is live at <code>/api/v1</code> and <code>/health</code>.</p></body></html>`;

function registerDashboardDevWebsocketProxy(app: FastifyInstance, upstream: URL): void {
  app.server.on("upgrade", (req, socket, head) => {
    if (!req.url?.startsWith("/dashboard")) return;

    const proxyReq = http.request({
      hostname: upstream.hostname,
      port: upstream.port,
      path: req.url,
      method: req.method,
      headers: req.headers,
    });

    proxyReq.on("upgrade", (res, proxySocket, proxyHead) => {
      socket.write(
        `HTTP/${req.httpVersion} ${res.statusCode} ${res.statusMessage}\r\n` +
          Object.entries(res.headers)
            .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(", ") : value}`)
            .join("\r\n") +
          "\r\n\r\n",
      );
      if (proxyHead.length) socket.write(proxyHead);
      if (head.length) proxySocket.write(head);
      proxySocket.pipe(socket).pipe(proxySocket);
    });

    proxyReq.on("error", () => socket.destroy());
    proxyReq.end();
  });
}

async function proxyDashboardDevRequest(
  req: FastifyRequest,
  reply: FastifyReply,
  upstream: string,
) {
  const url = `${upstream}${req.raw.url ?? "/dashboard/"}`;
  const res = await fetch(url, { headers: { accept: "*/*" } });

  for (const [key, value] of res.headers) {
    if (!["content-encoding", "content-length", "transfer-encoding"].includes(key)) {
      reply.header(key, value);
    }
  }

  return reply
    .code(res.status)
    .send(res.body ? Readable.fromWeb(res.body) : undefined);
}

export async function dashboardRoutes(app: FastifyInstance): Promise<void> {
  const ctx = app.ctx;
  const dashboardDir = resolveDashboardDir();
  const dashboardDevServerUrl = ctx.config.dashboardDevServerUrl;
  const dashboardDevServer = dashboardDevServerUrl ? new URL(dashboardDevServerUrl) : null;

  if (dashboardDevServer) {
    registerDashboardDevWebsocketProxy(app, dashboardDevServer);
  }

  app.get("/dashboard", async (_req, reply) => reply.redirect("/dashboard/", 308));

  app.get<{ Params: { "*": string } }>("/dashboard/*", async (req, reply) => {
    if (dashboardDevServerUrl) {
      return proxyDashboardDevRequest(req, reply, dashboardDevServerUrl);
    }

    if (!dashboardDir) {
      return reply.type("text/html").send(FALLBACK_HTML);
    }
    const assetPath = req.params["*"] || "index.html";
    const resolved = ctx.storage.resolveWithin(dashboardDir, assetPath);
    if (resolved && fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
      return reply
        .type(contentTypeFor(resolved))
        .send(fs.createReadStream(resolved));
    }
    // SPA fallback: serve index.html for client-side routes.
    return reply
      .type("text/html")
      .send(fs.createReadStream(path.join(dashboardDir, "index.html")));
  });
}
