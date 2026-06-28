# REST API

The REST API is designed for CLI clients, agents, and CI jobs. All `/api/v1/*` endpoints require a MaraDocs API key in the `Authorization` header.

```http
Authorization: Bearer mdo_...
```

The `/health` endpoint is public and intended for container health checks.

## Authentication

Create API keys in the dashboard under **API Keys**. Keys are shown once. The server stores only a SHA-256 hash and a short display prefix.

Scopes:

- `read`: list metadata and fetch private reports.
- `publish`: create/update/delete repositories and documents, roll back versions, and fetch private reports.
- `admin`: all machine API operations.

## Endpoints

| Method | Endpoint | Scope | Purpose |
|--------|----------|-------|---------|
| GET | `/health` | none | Health check |
| GET | `/api/v1/repos` | any valid key | List repositories |
| POST | `/api/v1/repos` | `publish` or `admin` | Create repository |
| PATCH | `/api/v1/repos/:repo` | `publish` or `admin` | Update repository metadata/access |
| GET | `/api/v1/repos/:repo/docs` | any valid key | List repository documents |
| POST | `/api/v1/repos/:repo/docs` | `publish` or `admin` | Publish a new document |
| PUT | `/api/v1/repos/:repo/docs/:doc` | `publish` or `admin` | Replace an existing document with a new version |
| DELETE | `/api/v1/repos/:repo/docs/:doc` | `publish` or `admin` | Delete a document and all versions |
| GET | `/api/v1/repos/:repo/docs/:doc/versions` | any valid key | List document versions |
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
