import { z } from "zod";
import { badRequest } from "../errors.js";
import type { Actor, AppContext } from "../types.js";
import { parsePublishFields, parseUpload, publishDocument } from "../services/publish.js";
import { getBundle } from "../services/docs.js";

const bundleQuerySchema = z.object({ version: z.coerce.number().int().positive().optional() });

/** POST (create) / PUT (replace) a document from a multipart upload. */
export async function handlePublish(
  c: AppContext,
  repo: string,
  actor: Actor,
  mode: "create" | "replace",
  docSlug?: string,
): Promise<Response> {
  const { fields, file } = await parseUpload(c);
  if (!file) throw badRequest("Missing document bundle (field 'file')");
  const input = parsePublishFields(fields, docSlug);
  const result = await publishDocument(c, repo, input, file, actor, mode);
  return c.json(result, mode === "create" ? 201 : 200);
}

/** Header values must be printable ASCII (ByteStrings); file names can be any Unicode. */
const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;

/**
 * Zip download of a version, with the same headers as the Node server. The
 * entrypoint is also sent percent-encoded in `x-maradocs-entrypoint-encoded`
 * (always), and the raw `x-maradocs-entrypoint` only when it is printable
 * ASCII, so a Unicode entrypoint can't turn the download into a 500.
 */
export async function handleBundle(c: AppContext, repo: string, doc: string): Promise<Response> {
  const { version } = bundleQuerySchema.parse({ version: c.req.query("version") });
  const bundle = await getBundle(c, repo, doc, version);
  const headers = new Headers({
    "content-type": "application/zip",
    "content-length": String(bundle.length),
    "content-disposition": `attachment; filename="${repo}-${doc}-v${bundle.versionNumber}.zip"`,
    "x-maradocs-version-number": String(bundle.versionNumber),
    "x-maradocs-checksum": bundle.checksum,
    "x-maradocs-entrypoint-encoded": encodeURIComponent(bundle.entrypoint),
    "cache-control": "no-store",
  });
  if (PRINTABLE_ASCII.test(bundle.entrypoint)) headers.set("x-maradocs-entrypoint", bundle.entrypoint);
  return new Response(bundle.body, { status: 200, headers });
}
