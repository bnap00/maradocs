import type { ServerConfig } from "../config.js";

/** Builds public-facing URLs using PUBLIC_BASE_URL when configured. */
export function buildBaseUrl(config: ServerConfig, requestOrigin?: string): string {
  if (config.publicBaseUrl) return config.publicBaseUrl;
  if (config.isProduction) throw new Error("PUBLIC_BASE_URL must be set in production");
  if (requestOrigin) return requestOrigin.replace(/\/$/, "");
  return `http://localhost:${config.port}`;
}

export function docUrl(base: string, repo: string, doc: string): string {
  return `${base}/r/${repo}/${doc}/`;
}

export function versionUrl(
  base: string,
  repo: string,
  doc: string,
  version: number,
): string {
  return `${base}/r/${repo}/${doc}/v/${version}/`;
}
