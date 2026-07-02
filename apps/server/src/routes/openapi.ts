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

export const openapiSpec = {
  openapi: "3.1.0",
  info: {
    title: "MaraDocs API",
    version: "0.1.0",
    description:
      "Machine API for publishing static HTML reports and managing repositories, documents, and versions. " +
      "All /api/v1 endpoints (except auth login and public-config) require a MaraDocs API key sent as a bearer token.",
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
      adminSession: {
        type: "http",
        scheme: "bearer",
        description: "Admin session token returned by POST /api/v1/auth/login",
      },
    },
    schemas: {
      Error: errorSchema,
      Repository: repository,
      DocumentSummary: documentSummary,
      DocumentVersion: documentVersion,
      PublishResult: publishResult,
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
    "/api/v1/auth/login": {
      post: {
        summary: "Exchange the admin password for a session token",
        description:
          "Rate limited to 5 attempts per 15 minutes. Use the returned token as a bearer token for /api/v1/auth/keys to bootstrap an API key headlessly.",
        security: [],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["password"],
                properties: { password: { type: "string" } },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Session token (also set as an httpOnly cookie)",
            content: {
              "application/json": {
                schema: { type: "object", properties: { token: { type: "string" } } },
              },
            },
          },
          "401": errorResponse("Invalid password"),
          "429": errorResponse("Too many attempts"),
        },
      },
    },
    "/api/v1/auth/keys": {
      get: {
        summary: "List API keys (metadata only)",
        security: [{ adminSession: [] }],
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
        security: [{ adminSession: [] }],
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
        security: [{ adminSession: [] }],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "204": { description: "Key revoked" },
          "401": errorResponse("Missing or invalid session"),
        },
      },
    },
    "/api/v1/repos": {
      get: {
        summary: "List repositories",
        responses: {
          "200": {
            description: "All repositories",
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
          "409": errorResponse("Repository already exists"),
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
