import type { FastifyRequest } from "fastify";
import { badRequest } from "./errors.js";

export interface ParsedUpload {
  fields: Record<string, string>;
  file: Buffer | null;
  filename: string | null;
}

/**
 * Parse a multipart request into a single file buffer plus string fields.
 * The file may be sent under the field name `file` or `bundle`.
 */
export async function parseUpload(req: FastifyRequest): Promise<ParsedUpload> {
  const fields: Record<string, string> = {};
  let file: Buffer | null = null;
  let filename: string | null = null;

  const parts = req.parts();
  for await (const part of parts) {
    if (part.type === "file") {
      if (part.fieldname === "file" || part.fieldname === "bundle") {
        file = await part.toBuffer();
        filename = part.filename;
      } else {
        // Drain unexpected file parts to keep the stream flowing.
        await part.toBuffer();
      }
    } else {
      fields[part.fieldname] = String(part.value);
    }
  }

  if (Object.keys(fields).length === 0 && !file) {
    throw badRequest("Expected a multipart upload");
  }
  return { fields, file, filename };
}
