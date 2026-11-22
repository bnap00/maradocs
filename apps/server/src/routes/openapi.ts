/**
 * Hand-maintained OpenAPI 3.1 description of the machine-facing API, served
 * at /api/v1/openapi.json so agents and tooling can discover the surface
 * without reading markdown. Keep in sync with routes/api.ts and routes/auth.ts.
 */

const accessMode = { type: "string", enum: ["public", "password", "private"] } as const;

const errorSchema = {
  type: "object",
  required: ["error", "message"],
  properties: {
    error: { type: "string", description: "Stable machine-readable error code" },
    message: { type: "string", description: "Human-readable explanation" },
    details: { description: "Optional structured context (e.g. validation issues)" },
  },
} as const;

const repository = {
  type: "object",
  properties: {
    id: { type: "string" },
    slug: { type: "string" },
    name: { type: "string" },
    description: { type: ["string", "null"] },
    defaultAccess: accessMode,
    indexEnabled: { type: "boolean" },
    hasPassword: { type: "boolean" },
    createdAt: { type: "string", format: "date-time" },
    updatedAt: { type: "string", format: "date-time" },
  },
} as const;

const documentSummary = {
  type: "object",
  properties: {
    id: { type: "string" },
    repositorySlug: { type: "string" },
    slug: { type: "string" },
    title: { type: "string" },
    access: accessMode,
    accessOverride: { oneOf: [accessMode, { type: "null" }] },
    entrypoint: { type: "string" },
    latestVersionNumber: { type: ["integer", "null"] },
    hasPassword: { type: "boolean" },
    url: { type: ["string", "null"] },
    createdAt: { type: "string", format: "date-time" },
    updatedAt: { type: "string", format: "date-time" },
  },
} as const;

const documentVersion = {
  type: "object",
  properties: {
    id: { type: "string" },
    documentId: { type: "string" },
    versionNumber: { type: "integer" },
    checksum: { type: "string" },
    fileCount: { type: "integer" },
    sizeBytes: { type: "integer" },
    entrypoint: { type: "string" },
    publishedByType: { type: "string", enum: ["machine", "user"] },
    publishedById: { type: ["string", "null"] },
    publishedByLabel: { type: ["string", "null"] },
    isLatest: { type: "boolean" },
    createdAt: { type: "string", format: "date-time" },
  },
} as const;

const publishResult = {
  type: "object",
  properties: {
    repo: { type: "string" },
    doc: { type: "string" },
    versionNumber: { type: "integer" },
    access: accessMode,
    url: { type: "string", description: "Stable latest-version URL" },
    versionUrl: { type: "string", description: "Immutable pinned-version URL" },
    fileCount: { type: "integer" },
    sizeBytes: { type: "integer" },
    checksum: { type: "string" },
  },
} as const;

const publishRequestBody = {
  required: true,
  content: {
    "multipart/form-data": {
      schema: {
        type: "object",
        required: ["doc", "file"],
        properties: {
          doc: { type: "string", description: "Document slug" },
          title: { type: "string" },
          access: accessMode,
          password: {
            type: "string",
            description: "Required when effective access is 'password' and no repository password exists",
          },
          entrypoint: { type: "string", description: "HTML file served at the document root (default index.html)" },
          file: { type: "string", format: "binary", description: "Zip archive of the static report folder" },
        },
      },
    },
  },
} as const;

function errorResponse(description: string) {
  return {
    description,
    content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
  };
}

const user = {
  type: "object",
  properties: {
    id: { type: "string" },
    email: { type: "string" },
    createdAt: { type: "string", format: "date-time" },
  },
};

function sessionResponse(description: string) {
  return {
    description: `${description}. Sets the maradocs_session cookie; non-browser clients (no Origin / Sec-Fetch-Site) also get the token.`,
    content: {
      "application/json": {
        schema: {
          type: "object",
          properties: {
            user: { $ref: "#/components/schemas/User" },
            token: { type: "string", description: "Session token (non-browser clients only)" },
          },
        },
      },
    },
  };
}

export const openapiSpec = {
  openapi: "3.1.0",
  info: {
    title: "MaraDocs API",
    version: "0.1.0",
    description:
      "Machine API for publishing static HTML reports and managing repositories, documents, and versions. " +
      "Machine endpoints (/api/v1/repos…) require a MaraDocs API key sent as a bearer token; every key belongs to a user account " +
      "and only sees that account's repositories. Account endpoints (/api/v1/auth…) use a session: the session token returned by " +
      "register/login as a bearer token (CLI), or the `maradocs_session` cookie (browser; unsafe requests must send `x-maradocs: 1`).",
    license: { name: "MIT", url: "https://github.com/bnap00/maradocs/blob/main/LICENSE" },
  },
  externalDocs: {
    description: "MaraDocs documentation",
    url: "https://github.com/bnap00/maradocs/tree/main/docs",
  },
  components: {
    securitySchemes: {
      apiKey: {
        type: "http",
        scheme: "bearer",
        description: "MaraDocs API key (mdo_…) created in the dashboard or via POST /api/v1/auth/keys",
      },
      session: {
        type: "http",
        scheme: "bearer",
        description:
          "Session token returned by POST /api/v1/auth/login or /register (non-browser clients). Browsers use the maradocs_session cookie instead and must send `x-maradocs: 1` on unsafe requests.",
      },
    },
    schemas: {
      Error: errorSchema,
      Repository: repository,
      DocumentSummary: documentSummary,
      DocumentVersion: documentVersion,
      PublishResult: publishResult,
      User: user,
    },
  },
  security: [{ apiKey: [] }],
  paths: {
    "/health": {
      get: {
        summary: "Health check",
        security: [],
        responses: {
          "200": {
            description: "Server is healthy",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    status: { type: "string" },
                    service: { type: "string" },
                    time: { type: "string", format: "date-time" },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/api/v1/auth/config": {
      get: {
        summary: "Account sign-up configuration",
        security: [],
        responses: {
          "200": {
            description: "Whether registration is currently allowed and whether the first account needs the claim password",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    registration: { type: "boolean" },
                    claimRequired: { type: "boolean" },
                    firstAccount: { type: "boolean", description: "No account exists yet" },
                    minPasswordLength: { type: "integer" },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/api/v1/auth/register": {
      post: {
        summary: "Create an account",
        description:
          "Allowed according to REGISTRATION (open | first | closed; default first = only while no account exists). " +
          "When ADMIN_PASSWORD is configured and no account exists yet, claimPassword must equal it. " +
          "The first account adopts repositories and keys created before accounts existed. Rate limited to 5 per hour per IP.",
        security: [],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["email", "password"],
                properties: {
                  email: { type: "string", format: "email", maxLength: 254 },
                  password: { type: "string", minLength: 12, maxLength: 1024 },
                  claimPassword: { type: "string" },
                },
              },
            },
          },
        },
        responses: {
          "201": sessionResponse("Account created and signed in"),
          "400": errorResponse("Validation failed"),
          "403": errorResponse("registration_closed or claim_required"),
          "409": errorResponse("Email already registered"),
          "429": errorResponse("Too many attempts"),
        },
      },
    },
    "/api/v1/auth/login": {
      post: {
        summary: "Sign in with email and password",
        description:
          "Rate limited to 5 attempts per 15 minutes per IP. Non-browser clients receive the session token in the body; use it as a bearer token for /api/v1/auth/keys to bootstrap an API key headlessly. Sessions last 30 days, extended while in use.",
        security: [],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["email", "password"],
                properties: { email: { type: "string" }, password: { type: "string" } },
              },
            },
          },
        },
        responses: {
          "200": sessionResponse("Signed in"),
          "401": errorResponse("Invalid email or password"),
          "429": errorResponse("Too many attempts"),
        },
      },
    },
    "/api/v1/auth/me": {
      get: {
        summary: "Current account",
        security: [{ session: [] }],
        responses: {
          "200": {
            description: "The signed-in user",
            content: {
              "application/json": {
                schema: { type: "object", properties: { user: { $ref: "#/components/schemas/User" } } },
              },
            },
          },
          "401": errorResponse("Missing or invalid session"),
        },
      },
    },
    "/api/v1/auth/logout": {
      post: {
        summary: "Sign out this session",
        security: [{ session: [] }],
        responses: { "204": { description: "Signed out" }, "401": errorResponse("Missing or invalid session") },
      },
    },
    "/api/v1/auth/logout-others": {
      post: {
        summary: "Sign out every other session of this account",
        security: [{ session: [] }],
        responses: {
          "200": {
            description: "Number of sessions revoked",
            content: {
              "application/json": {
                schema: { type: "object", properties: { revoked: { type: "integer" } } },
              },
            },
          },
          "401": errorResponse("Missing or invalid session"),
        },
      },
    },
    "/api/v1/auth/change-password": {
      post: {
        summary: "Change the account password",
        description: "Revokes all other sessions of the account. Rate limited to 10 per hour per account.",
        security: [{ session: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["currentPassword", "newPassword"],
                properties: {
                  currentPassword: { type: "string" },
                  newPassword: { type: "string", minLength: 12, maxLength: 1024 },
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Password changed",
            content: {
              "application/json": {
                schema: { type: "object", properties: { user: { $ref: "#/components/schemas/User" } } },
              },
            },
          },
          "401": errorResponse("Current password is incorrect, or no session"),
        },
      },
    },
    "/api/v1/auth/account": {
      delete: {
        summary: "Delete the account and everything it owns",
        description:
          "Deletes the account, its sessions, API keys, machines, repositories, documents, versions, stored files and audit log.",
        security: [{ session: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { type: "object", required: ["password"], properties: { password: { type: "string" } } },
            },
          },
        },
        responses: {
          "204": { description: "Account deleted" },
          "401": errorResponse("Password is incorrect, or no session"),
        },
      },
    },
    "/api/v1/auth/keys": {
      get: {
        summary: "List your API keys (metadata only)",
        security: [{ session: [] }],
        responses: {
          "200": {
            description: "API key metadata; secrets are never returned",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { keys: { type: "array", items: { type: "object" } } },
                },
              },
            },
          },
          "401": errorResponse("Missing or invalid session"),
        },
      },
      post: {
        summary: "Create an API key",
        description: "The raw key (mdo_…) is returned once and never stored server-side.",
        security: [{ session: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["name"],
                properties: {
                  name: { type: "string", minLength: 1, maxLength: 100 },
                  scopes: {
                    type: "array",
                    items: { type: "string", enum: ["read", "publish", "admin"] },
                    default: ["publish"],
                  },
                },
              },
            },
          },
        },
        responses: {
          "201": {
            description: "New API key",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    key: { type: "string", description: "The raw API key — shown once" },
                    id: { type: "string" },
                    name: { type: "string" },
                    prefix: { type: "string" },
                    scopes: { type: "array", items: { type: "string" } },
                  },
                },
              },
            },
          },
          "401": errorResponse("Missing or invalid session"),
        },
      },
    },
    "/api/v1/auth/keys/{id}": {
      delete: {
        summary: "Revoke an API key",
        security: [{ session: [] }],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "204": { description: "Key revoked" },
          "401": errorResponse("Missing or invalid session"),
          "404": errorResponse("Key not found (or owned by another account)"),
        },
      },
    },
    "/api/v1/repos": {
      get: {
        summary: "List repositories",
        responses: {
          "200": {
            description: "Repositories owned by the API key's account",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    repos: { type: "array", items: { $ref: "#/components/schemas/Repository" } },
                  },
                },
              },
            },
          },
          "401": errorResponse("Missing or invalid API key"),
        },
      },
      post: {
        summary: "Create a repository",
        description: "Requires the 'publish' or 'admin' scope.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["slug"],
                properties: {
                  slug: { type: "string", pattern: "^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$" },
                  name: { type: "string" },
                  description: { type: "string" },
                  access: accessMode,
                  indexEnabled: { type: "boolean" },
                  password: { type: "string", description: "Required when access is 'password'" },
                },
              },
            },
          },
        },
        responses: {
          "201": {
            description: "Created repository",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { repo: { $ref: "#/components/schemas/Repository" } },
                },
              },
            },
          },
          "400": errorResponse("Validation failed"),
          "401": errorResponse("Missing or invalid API key"),
          "403": errorResponse("Insufficient scope"),
          "409": errorResponse("Repository already exists, or the slug is taken by another account"),
        },
      },
    },
    "/api/v1/repos/{repo}": {
      patch: {
        summary: "Update repository metadata or access",
        description: "Requires the 'publish' or 'admin' scope.",
        parameters: [{ name: "repo", in: "path", required: true, schema: { type: "string" } }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  name: { type: "string" },
                  description: { type: ["string", "null"] },
                  access: accessMode,
                  indexEnabled: { type: "boolean" },
                  password: { type: ["string", "null"], description: "String sets, null clears" },
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Updated repository",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { repo: { $ref: "#/components/schemas/Repository" } },
                },
              },
            },
          },
          "401": errorResponse("Missing or invalid API key"),
          "403": errorResponse("Insufficient scope"),
          "404": errorResponse("Repository not found"),
        },
      },
    },
    "/api/v1/repos/{repo}/docs": {
      get: {
        summary: "List documents in a repository",
        parameters: [{ name: "repo", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "200": {
            description: "Documents",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    docs: { type: "array", items: { $ref: "#/components/schemas/DocumentSummary" } },
                  },
                },
              },
            },
          },
          "401": errorResponse("Missing or invalid API key"),
          "404": errorResponse("Repository not found"),
        },
      },
      post: {
        summary: "Publish a new document",
        description:
          "Creates the document and its first immutable version. Fails with 409 if the document exists — use PUT /api/v1/repos/{repo}/docs/{doc} to publish a new version. Requires the 'publish' or 'admin' scope.",
        parameters: [{ name: "repo", in: "path", required: true, schema: { type: "string" } }],
        requestBody: publishRequestBody,
        responses: {
          "201": {
            description: "Publish result",
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/PublishResult" } },
            },
          },
          "400": errorResponse("Validation failed or missing bundle"),
          "401": errorResponse("Missing or invalid API key"),
          "403": errorResponse("Insufficient scope"),
          "404": errorResponse("Repository not found"),
          "409": errorResponse("Document already exists"),
          "413": errorResponse("Upload too large"),
        },
      },
    },
    "/api/v1/repos/{repo}/docs/{doc}": {
      put: {
        summary: "Publish a new version of an existing document",
        description: "Requires the 'publish' or 'admin' scope.",
        parameters: [
          { name: "repo", in: "path", required: true, schema: { type: "string" } },
          { name: "doc", in: "path", required: true, schema: { type: "string" } },
        ],
        requestBody: publishRequestBody,
        responses: {
          "200": {
            description: "Publish result",
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/PublishResult" } },
            },
          },
          "400": errorResponse("Validation failed or missing bundle"),
          "401": errorResponse("Missing or invalid API key"),
          "403": errorResponse("Insufficient scope"),
          "404": errorResponse("Repository or document not found"),
          "413": errorResponse("Upload too large"),
        },
      },
      delete: {
        summary: "Delete a document and all its versions",
        description: "Requires the 'publish' or 'admin' scope.",
        parameters: [
          { name: "repo", in: "path", required: true, schema: { type: "string" } },
          { name: "doc", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          "200": {
            description: "Deletion result",
            content: {
              "application/json": {
                schema: { type: "object", properties: { deleted: { type: "boolean" } } },
              },
            },
          },
          "401": errorResponse("Missing or invalid API key"),
          "403": errorResponse("Insufficient scope"),
          "404": errorResponse("Repository or document not found"),
        },
      },
    },
    "/api/v1/repos/{repo}/docs/{doc}/bundle": {
      get: {
        summary: "Download a version's files as a zip bundle",
        description:
          "Returns the stored files of a version (latest when no version is given) so an artifact can be fetched, modified, and republished. Requires the 'read', 'publish', or 'admin' scope.",
        parameters: [
          { name: "repo", in: "path", required: true, schema: { type: "string" } },
          { name: "doc", in: "path", required: true, schema: { type: "string" } },
          {
            name: "version",
            in: "query",
            required: false,
            schema: { type: "integer", minimum: 1 },
            description: "Pinned version number; defaults to the latest version",
          },
        ],
        responses: {
          "200": {
            description: "Zip archive of the version's files",
            headers: {
              "x-maradocs-version-number": {
                schema: { type: "string" },
                description: "Version number contained in the bundle",
              },
              "x-maradocs-checksum": {
                schema: { type: "string" },
                description: "Checksum of the version (compare before republishing to detect concurrent updates)",
              },
              "x-maradocs-entrypoint": {
                schema: { type: "string" },
                description: "Entry HTML file of the version",
              },
            },
            content: {
              "application/zip": { schema: { type: "string", format: "binary" } },
            },
          },
          "401": errorResponse("Missing or invalid API key"),
          "403": errorResponse("Insufficient scope"),
          "404": errorResponse("Repository, document, or version not found"),
        },
      },
    },
    "/api/v1/repos/{repo}/docs/{doc}/versions": {
      get: {
        summary: "List versions of a document",
        parameters: [
          { name: "repo", in: "path", required: true, schema: { type: "string" } },
          { name: "doc", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          "200": {
            description: "Versions, newest first",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    versions: {
                      type: "array",
                      items: { $ref: "#/components/schemas/DocumentVersion" },
                    },
                  },
                },
              },
            },
          },
          "401": errorResponse("Missing or invalid API key"),
          "404": errorResponse("Repository or document not found"),
        },
      },
    },
    "/api/v1/repos/{repo}/docs/{doc}/rollback": {
      post: {
        summary: "Promote a previous version to latest",
        description:
          "Does not delete later versions. Requires the 'publish' or 'admin' scope.",
        parameters: [
          { name: "repo", in: "path", required: true, schema: { type: "string" } },
          { name: "doc", in: "path", required: true, schema: { type: "string" } },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["version"],
                properties: { version: { type: "integer", minimum: 1 } },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Updated document",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { doc: { $ref: "#/components/schemas/DocumentSummary" } },
                },
              },
            },
          },
          "401": errorResponse("Missing or invalid API key"),
          "403": errorResponse("Insufficient scope"),
          "404": errorResponse("Repository, document, or version not found"),
        },
      },
    },
    "/api/v1/public-config": {
      get: {
        summary: "Public server configuration",
        security: [],
        responses: {
          "200": {
            description: "Non-sensitive defaults",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { defaultRepoAccess: accessMode },
                },
              },
            },
          },
        },
      },
    },
  },
} as const;
