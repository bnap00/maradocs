// Minimal multipart/form-data parser over one in-memory body.
//
// The runtime's formData() keeps its own copy of the body and File.arrayBuffer()
// makes another; parsing here keeps the uploaded zip as a view into the single
// request buffer, which matters inside a 128 MB isolate.

import { badRequest } from "../errors.js";

export interface MultipartFile {
  filename: string;
  /** A view into the request body (not a copy). */
  data: Uint8Array;
}

export interface MultipartBody {
  fields: Record<string, string>;
  files: Map<string, MultipartFile>;
}

const encoder = new TextEncoder();
const utf8 = new TextDecoder();

/** Index of `needle` in `hay` at or after `from`, or -1 (native first-byte scan, then compare). */
export function indexOfBytes(hay: Uint8Array, needle: Uint8Array, from = 0): number {
  const first = needle[0]!;
  const last = hay.length - needle.length;
  let i = from;
  while (i <= last) {
    i = hay.indexOf(first, i);
    if (i < 0 || i > last) return -1;
    let j = 1;
    while (j < needle.length && hay[i + j] === needle[j]) j += 1;
    if (j === needle.length) return i;
    i += 1;
  }
  return -1;
}

export function multipartBoundary(contentType: string): string | null {
  if (!/^multipart\/form-data/i.test(contentType)) return null;
  const match = /;\s*boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
  const boundary = match?.[1] ?? match?.[2];
  return boundary && boundary.length <= 200 ? boundary : null;
}

function headerParam(header: string, name: string): string | null {
  const match = new RegExp(`;\\s*${name}=(?:"((?:[^"\\\\]|\\\\.)*)"|([^;\\s]*))`, "i").exec(header);
  if (!match) return null;
  return match[1] !== undefined ? match[1].replace(/\\(.)/g, "$1") : (match[2] ?? "");
}

const invalid = () => badRequest("Expected a multipart upload");

export function parseMultipart(body: Uint8Array, contentType: string): MultipartBody {
  const boundary = multipartBoundary(contentType);
  if (!boundary) throw invalid();
  const delimiter = encoder.encode(`--${boundary}`);
  const nextDelimiter = encoder.encode(`\r\n--${boundary}`);
  const headerEnd = encoder.encode("\r\n\r\n");
  const fields: Record<string, string> = {};
  const files = new Map<string, MultipartFile>();

  let pos = indexOfBytes(body, delimiter, 0);
  if (pos < 0) throw invalid();
  pos += delimiter.length;
  for (;;) {
    // "--" after a delimiter closes the body.
    if (body[pos] === 0x2d && body[pos + 1] === 0x2d) break;
    // Skip optional transport padding, then the CRLF ending the delimiter line.
    while (body[pos] === 0x20 || body[pos] === 0x09) pos += 1;
    if (body[pos] !== 0x0d || body[pos + 1] !== 0x0a) throw invalid();
    pos += 2;
    const end = indexOfBytes(body, nextDelimiter, pos);
    if (end < 0) throw invalid();
    const part = body.subarray(pos, end);
    const split = indexOfBytes(part, headerEnd, 0);
    if (split < 0) throw invalid();
    const headers = utf8.decode(part.subarray(0, split));
    const data = part.subarray(split + headerEnd.length);
    const disposition = headers.split("\r\n").find((line) => /^content-disposition:/i.test(line));
    const name = disposition ? headerParam(disposition, "name") : null;
    if (name !== null) {
      const filename = headerParam(disposition!, "filename");
      if (filename !== null) files.set(name, { filename, data });
      else fields[name] = utf8.decode(data);
    }
    pos = end + nextDelimiter.length;
  }
  return { fields, files };
}
