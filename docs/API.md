# REST API

The REST API is designed for CLI clients, agents, and CI jobs. All `/api/v1/*` endpoints (except `/api/v1/auth/login`, `/api/v1/public-config`, and `/api/v1/openapi.json`) require a MaraDocs API key in the `Authorization` header.

```http
Authorization: Bearer mdo_...
```

The `/health` endpoint is public and intended for container health checks.

## OpenAPI Spec

The server describes its own API: `GET /api/v1/openapi.json` returns an OpenAPI 3.1 document covering every endpoint, schema, and error shape below. Point agents, code generators, or API explorers at it directly.

## Authentication

Create API keys in the dashboard under **API Keys**, or headlessly via the admin API (see below). Keys are shown once. The server stores only a SHA-256 hash and a short display prefix.

Scopes:

- `read`: list metadata and fetch private reports.
- `publish`: create/update/delete repositories and documents, roll back versions, and fetch private reports.
- `admin`: all machine API operations.

### Headless API key bootstrap

For CI, scripts, and fully automated setups, exchange the dashboard admin password for a session token, then mint an API key — no browser needed:

```bash
# 1. Log in with the admin password (rate limited: 5 attempts / 15 minutes).
token=$(curl -sS -X POST "$SERVER/api/v1/auth/login" \
  -H 'content-type: application/json' \
  -d '{"password":"'"$ADMIN_PASSWORD"'"}' | jq -r .token)

# 2. Create a scoped API key. The raw key is returned once and never stored.
curl -sS -X POST "$SERVER/api/v1/auth/keys" \
  -H "Authorization: Bearer $token" \
  -H 'content-type: application/json' \
  -d '{"name":"ci-publisher","scopes":["publish"]}'
# → {"key":"mdo_...","id":"akey_...","name":"ci-publisher","prefix":"mdo_...","scopes":["publish"]}
```

The CLI wraps this flow as `maradocs auth bootstrap --server <url>`.

## Endpoints

| Method | Endpoint | Scope | Purpose |
|--------|----------|-------|---------|
| GET | `/health` | none | Health check |
| GET | `/api/v1/openapi.json` | none | OpenAPI 3.1 description of this API |
| POST | `/api/v1/auth/login` | none (admin password) | Exchange admin password for a session token |
| GET | `/api/v1/auth/keys` | admin session | List API key metadata |
| POST | `/api/v1/auth/keys` | admin session | Create an API key (raw key shown once) |
| DELETE | `/api/v1/auth/keys/:id` | admin session | Revoke an API key |
| GET | `/api/v1/repos` | any valid key | List repositories |
| POST | `/api/v1/repos` | `publish` or `admin` | Create repository |
| PATCH | `/api/v1/repos/:repo` | `publish` or `admin` | Update repository metadata/access |
| GET | `/api/v1/repos/:repo/docs` | any valid key | List repository documents |
| POST | `/api/v1/repos/:repo/docs` | `publish` or `admin` | Publish a new document |
| PUT | `/api/v1/repos/:repo/docs/:doc` | `publish` or `admin` | Replace an existing document with a new version |
| DELETE | `/api/v1/repos/:repo/docs/:doc` | `publish` or `admin` | Delete a document and all versions |
| GET | `/api/v1/repos/:repo/docs/:doc/versions` | any valid key | List document versions |
| GET | `/api/v1/repos/:repo/docs/:doc/bundle` | `read`, `publish`, or `admin` | Download a version's files as a zip |
| POST | `/api/v1/repos/:repo/docs/:doc/rollback` | `publish` or `admin` | Promote a previous version to latest |

## Publishing

Publishing uses `multipart/form-data` with one zip file and string fields.

Required fields:

- `doc`: document slug.
- `file` or `bundle`: zip archive containing the static report.

Optional fields:

- `title`: display title.
- `access`: `public`, `password`, or `private`.
- `password`: required when effective access is `password` and no repository password exists.
- `entrypoint`: HTML file to serve for the document root. Defaults to `index.html` when present.

Example:

```bash
zip -r report.zip report
curl -sS -X POST "https://docs.example.com/api/v1/repos/demo/docs" \
  -H "Authorization: Bearer $MARADOCS_API_KEY" \
  -F doc=hello \
  -F title="Hello report" \
  -F access=private \
  -F file=@report.zip
```

Response shape:

```json
{
  "repo": "demo",
  "doc": "hello",
  "versionNumber": 1,
  "access": "private",
  "url": "https://docs.example.com/r/demo/hello/",
  "versionUrl": "https://docs.example.com/r/demo/hello/v/1/",
  "fileCount": 3,
  "sizeBytes": 12456,
  "checksum": "..."
}
```

## Downloading Bundles

`GET /api/v1/repos/:repo/docs/:doc/bundle` returns a zip of a version's stored files — the latest version by default, or a pinned one with `?version=N`. This is the retrieval half of the update loop: download an artifact, modify it, republish it as a new version.

```bash
curl -sS -o report.zip "https://docs.example.com/api/v1/repos/demo/docs/hello/bundle" \
  -H "Authorization: Bearer $MARADOCS_API_KEY"
```

Response headers carry version metadata:

- `X-MaraDocs-Version-Number`: version contained in the bundle.
- `X-MaraDocs-Checksum`: checksum of that version. Compare it against the latest version before republishing to detect a concurrent publish.
- `X-MaraDocs-Entrypoint`: the version's entry HTML file.

The CLI wraps this as `maradocs doc download <repo>/<doc>`.

## Read URLs

| Pattern | Meaning |
|---------|---------|
| `/r/:repo/` | Repository index, when enabled |
| `/r/:repo/:doc/` | Latest document entrypoint |
| `/r/:repo/:doc/v/:version/` | Pinned immutable version |
| `/r/:repo/:doc/*` | Static asset path within latest version |
| `/dashboard/` | Dashboard SPA |

Private read URLs accept either a dashboard session cookie or a bearer API key with `read`, `publish`, or `admin` scope.

## Error Format

Errors use JSON where possible:

```json
{
  "error": "validation_error",
  "message": "Request validation failed",
  "details": []
}
```

Common statuses:

- `400`: invalid input, invalid zip, unsafe path, missing required fields.
- `401`: missing or invalid authentication.
- `403`: authenticated key lacks the required scope.
- `404`: repository, document, version, or asset not found.
- `409`: create-only publish attempted for an existing document.
- `413`: upload exceeds `MAX_UPLOAD_MB`.
