/** Error carrying an HTTP status code and a stable machine-readable code. */
export class HttpError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
    public details?: unknown,
    /** Extra response headers (e.g. Retry-After). */
    public headers?: Record<string, string>,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export const badRequest = (msg: string, details?: unknown) =>
  new HttpError(400, "bad_request", msg, details);
export const unauthorized = (msg = "Authentication required") =>
  new HttpError(401, "unauthorized", msg);
export const forbidden = (msg = "Forbidden") => new HttpError(403, "forbidden", msg);
export const notFound = (msg = "Not found") => new HttpError(404, "not_found", msg);
export const conflict = (msg: string) => new HttpError(409, "conflict", msg);
export const payloadTooLarge = (msg: string) => new HttpError(413, "payload_too_large", msg);
export const lengthRequired = (msg: string) => new HttpError(411, "length_required", msg);
export const rateLimited = (msg = "Too many requests", retryAfterSeconds?: number) =>
  new HttpError(
    429,
    "rate_limited",
    msg,
    undefined,
    retryAfterSeconds ? { "retry-after": String(retryAfterSeconds) } : undefined,
  );
