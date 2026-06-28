import type { FastifyRequest } from "fastify";
import type { Actor } from "../services/repoService.js";

export function machineActor(req: FastifyRequest): Actor {
  const m = req.machine!;
  return { type: "machine", id: m.apiKeyId, label: m.name };
}

export function userActor(req: FastifyRequest): Actor {
  const u = req.user!;
  return { type: "user", id: u.userId, label: u.userId };
}

export function requestOrigin(req: FastifyRequest): string {
  if (req.server.ctx.config.publicBaseUrl) return req.server.ctx.config.publicBaseUrl;
  const host = req.headers.host ?? `localhost`;
  return `${req.protocol}://${host}`;
}
