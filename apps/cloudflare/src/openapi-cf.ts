// Cloudflare overlay for the OpenAPI document vendored from the Node server
// (src/vendor/openapi.ts, generated — never edited by hand). It describes
// what this Worker answers differently, so agents discovering the API from
// /api/v1/openapi.json see the real shapes. The account endpoints
// (/api/v1/auth/*) are described here in full, so the overlay does not depend
// on how the vendored copy describes them.

import { openapiSpec } from "./vendor/openapi.js";

type Json = Record<string, unknown>;

const errorResponse = (description: string): Json => ({
  description,
  content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
});

const json = (schema: Json, description: string): Json => ({
  description,
  content: { "application/json": { schema } },
});

const body = (schema: Json): Json => ({ required: true, content: { "application/json": { schema } } });

const rateLimitedResponse: Json = {
  ...errorResponse("Too many attempts"),
  headers: { "Retry-After": { schema: { type: "integer" }, description: "Seconds until the next attempt is allowed" } },
};

const session = [{ adminSession: [] }];
const unauthorizedResponse = errorResponse("Missing or invalid session");

/** Object at a path, or null when the vendored document doesn't have it. */
function find(root: Json, ...path: string[]): Json | null {
  let node: Json = root;
  for (const key of path) {
    const next = node[key];
    if (!next || typeof next !== "object") return null;
    node = next as Json;
  }
  return node;
}

const userSchema: Json = {
  type: "object",
  required: ["id", "email", "createdAt"],
  properties: { id: { type: "string" }, email: { type: "string" }, createdAt: { type: "string", format: "date-time" } },
};

const userWithToken: Json = {
  type: "object",
  required: ["user"],
  properties: {
    user: { $ref: "#/components/schemas/User" },
    token: {
      type: "string",
      description:
        "Session token, only for clients that send no Origin/Sec-Fetch-Site header (CLIs). Browsers get the HttpOnly `maradocs_session` cookie only.",
    },
  },
};

function authPaths(): Json {
  return {
    "/api/v1/auth/config": {
      get: {
        summary: "Account registration settings",
        security: [],
        responses: {
          "200": json(
            {
              type: "object",
              properties: {
                registration: { type: "boolean", description: "Whether POST /api/v1/auth/register is currently allowed" },
                claimRequired: { type: "boolean", description: "Whether the first account needs `claimPassword`" },
                firstAccount: { type: "boolean", description: "No account exists yet" },
                minPasswordLength: { type: "integer" },
              },
            },
            "Registration settings",
          ),
        },
      },
    },
    "/api/v1/auth/register": {
      post: {
        summary: "Create an account",
        description:
          "REGISTRATION=first (default) allows only the first account, `open` anyone, `closed` nobody. While no account exists " +
          "and a claim password (the ADMIN_PASSWORD secret, or the legacy dashboard password) is configured, `claimPassword` " +
          "must match it. The first account adopts every repository, key and audit entry created before accounts existed. " +
          "Rate limited to 5 per hour per client network.",
        security: [],
        requestBody: body({
          type: "object",
          required: ["email", "password"],
          properties: {
            email: { type: "string", format: "email", maxLength: 254 },
            password: { type: "string", minLength: 12, maxLength: 1024 },
            claimPassword: { type: "string" },
          },
        }),
        responses: {
          "201": json(userWithToken, "Account created and signed in (session cookie set)"),
          "400": errorResponse("Body is not valid JSON or fails validation"),
          "403": errorResponse("registration_closed, claim_required, or a cross-site request"),
          "409": errorResponse("An account with this email already exists"),
          "429": rateLimitedResponse,
        },
      },
    },
    "/api/v1/auth/login": {
      post: {
        summary: "Sign in with email and password",
        description:
          "Rate limited to 5 attempts per 15 minutes per client network, plus a global ceiling on failures. Sessions last 30 " +
          "days and slide with use. Use the token as a bearer token for /api/v1/auth/keys to bootstrap an API key headlessly, " +
          "then revoke it with POST /api/v1/auth/logout.",
        security: [],
        requestBody: body({
          type: "object",
          required: ["email", "password"],
          properties: { email: { type: "string" }, password: { type: "string" } },
        }),
        responses: {
          "200": json(userWithToken, "Signed in (session cookie set)"),
          "400": errorResponse("Body is not valid JSON or fails validation"),
          "401": errorResponse("Invalid email or password"),
          "403": errorResponse("Cross-site request (Origin does not match this server)"),
          "429": rateLimitedResponse,
        },
      },
    },
    "/api/v1/auth/me": {
      get: {
        summary: "The signed-in account",
        security: session,
        responses: {
          "200": json({ type: "object", properties: { user: { $ref: "#/components/schemas/User" } } }, "Current account"),
          "401": unauthorizedResponse,
        },
      },
    },
    "/api/v1/auth/logout": {
      post: {
        summary: "Sign out this session",
        security: session,
        responses: { "204": { description: "Session revoked" }, "401": unauthorizedResponse },
      },
    },
    "/api/v1/auth/logout-others": {
      post: {
        summary: "Sign out every other session of this account",
        security: session,
        responses: {
          "200": json({ type: "object", properties: { revoked: { type: "integer" } } }, "Sessions revoked"),
          "401": unauthorizedResponse,
        },
      },
    },
    "/api/v1/auth/change-password": {
      post: {
        summary: "Change the account password",
        description: "Signs out every other session. Rate limited to 10 attempts per hour per account.",
        security: session,
        requestBody: body({
          type: "object",
          required: ["currentPassword", "newPassword"],
          properties: { currentPassword: { type: "string" }, newPassword: { type: "string", minLength: 12, maxLength: 1024 } },
        }),
        responses: {
          "200": json({ type: "object", properties: { user: { $ref: "#/components/schemas/User" } } }, "Password changed"),
          "401": errorResponse("Missing session, or the current password is wrong"),
          "429": rateLimitedResponse,
        },
      },
    },
    "/api/v1/auth/account": {
      delete: {
        summary: "Delete the account",
        description: "Deletes the account with its repositories, documents, stored files, API keys, machines, sessions and audit log.",
        security: session,
        requestBody: body({ type: "object", required: ["password"], properties: { password: { type: "string" } } }),
        responses: {
          "204": { description: "Account deleted" },
          "401": errorResponse("Missing session, or the password is wrong"),
          "429": rateLimitedResponse,
        },
      },
    },
    "/api/v1/auth/keys": {
      get: {
        summary: "List your API keys (metadata only)",
        security: session,
        responses: {
          "200": json(
            { type: "object", properties: { keys: { type: "array", items: { type: "object" } } } },
            "API key metadata; secrets are never returned",
          ),
          "401": unauthorizedResponse,
        },
      },
      post: {
        summary: "Create an API key for your account",
        description: "The raw key (mdo_…) is returned once and never stored server-side.",
        security: session,
        requestBody: body({
          type: "object",
          required: ["name"],
          properties: {
            name: { type: "string", minLength: 1, maxLength: 100 },
            scopes: { type: "array", items: { type: "string", enum: ["read", "publish", "admin"] }, default: ["publish"] },
          },
        }),
        responses: {
          "201": json(
            {
              type: "object",
              properties: {
                key: { type: "string", description: "The raw API key — shown once" },
                id: { type: "string" },
                name: { type: "string" },
                prefix: { type: "string" },
                scopes: { type: "array", items: { type: "string" } },
              },
            },
            "New API key",
          ),
          "401": unauthorizedResponse,
        },
      },
    },
    "/api/v1/auth/keys/{id}": {
      delete: {
        summary: "Revoke one of your API keys",
        security: session,
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "204": { description: "Key revoked" },
          "401": unauthorizedResponse,
          "404": errorResponse("Unknown key, or a key of another account"),
        },
      },
    },
  };
}

function build(): Json {
  const spec = JSON.parse(JSON.stringify(openapiSpec)) as Json;
  const paths = (spec.paths ??= {}) as Json;
  const components = (spec.components ??= {}) as Json;
  const schemas = (components.schemas ??= {}) as Json;
  schemas.Error ??= {
    type: "object",
    required: ["error", "message"],
    properties: { error: { type: "string" }, message: { type: "string" }, details: {} },
  };
  schemas.User = userSchema;

  const healthProps = find(paths, "/health", "get", "responses", "200", "content", "application/json", "schema", "properties");
  if (healthProps) {
    Object.assign(healthProps, {
      runtime: { type: "string", const: "cloudflare" },
      configured: { type: "boolean", description: "Always true (accounts need no configuration)." },
    });
  }
  const publicProps = find(paths, "/api/v1/public-config", "get", "responses", "200", "content", "application/json", "schema", "properties");
  if (publicProps) Object.assign(publicProps, { configured: { type: "boolean" }, version: { type: "string" } });

  for (const key of Object.keys(paths)) if (key.startsWith("/api/v1/auth/")) delete paths[key];
  Object.assign(paths, authPaths());

  for (const [path, method] of [
    ["/api/v1/repos/{repo}/docs", "post"],
    ["/api/v1/repos/{repo}/docs/{doc}", "put"],
  ] as const) {
    const responses = find(paths, path, method, "responses");
    if (responses) responses["411"] = errorResponse("Content-Length header missing (required for uploads)");
  }

  const bundleHeaders = find(paths, "/api/v1/repos/{repo}/docs/{doc}/bundle", "get", "responses", "200", "headers");
  if (bundleHeaders) {
    const entry = find(bundleHeaders, "x-maradocs-entrypoint");
    if (entry) {
      entry.description =
        "Entry HTML file of the version. Omitted when the name is not printable ASCII; use x-maradocs-entrypoint-encoded.";
    }
    bundleHeaders["x-maradocs-entrypoint-encoded"] = {
      schema: { type: "string" },
      description: "Entry HTML file, percent-encoded (encodeURIComponent). Always present.",
    };
  }

  const securitySchemes = (components.securitySchemes ??= {}) as Json;
  securitySchemes.adminSession = {
    type: "http",
    scheme: "bearer",
    description:
      "Account session token returned by POST /api/v1/auth/login or /register (browsers use the HttpOnly " +
      "`maradocs_session` cookie instead; cookie-authenticated writes must be same-origin and send `x-maradocs: 1`).",
  };
  return spec;
}

export const cloudflareOpenapiSpec = build();
