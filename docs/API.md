# REST API

The REST API is designed for CLI clients, agents, and CI jobs. The repository endpoints (`/api/v1/repos/*`) require a MaraDocs API key in the `Authorization` header. Account endpoints under `/api/v1/auth` use a session token instead (see below); `/api/v1/auth/config`, `/register`, `/login`, `/api/v1/public-config` and `/api/v1/openapi.json` need no credentials.

```http
Authorization: Bearer mdo_...
```

The `/health` endpoint is public and intended for container health checks.

## OpenAPI Spec

The server describes its own API: `GET /api/v1/openapi.json` returns an OpenAPI 3.1 document covering every endpoint, schema, and error shape below. Point agents, code generators, or API explorers at it directly.

## Authentication

MaraDocs has email + password accounts (see [AUTH.md](AUTH.md)). Each API key belongs to one account and only reaches that account's repositories. Create keys in the dashboard under **API Keys**, or headlessly (below). Keys are shown once. The server stores only a SHA-256 hash and a short display prefix.

Scopes:

- `read`: list metadata and fetch private reports.
- `publish`: create/update/delete repositories and documents, roll back versions, and fetch private reports.
- `admin`: all machine API operations.

### Headless API key bootstrap

For CI, scripts, and fully automated setups, sign in (or register) to get a session token, mint an API key, then sign the session out. No browser needed. Non-browser clients receive the session token in the response body; send it as `Authorization: Bearer <token>`.

```bash
# 0. (optional) Can this server take a new account? → {"registration":true,"claimRequired":false,"minPasswordLength":12}
curl -sS "$SERVER/api/v1/auth/config"

# 1. Sign in (or POST /api/v1/auth/register with the same body to create the account).
#    Body comes from stdin so the password stays off the command line.
token=$(jq -n --arg e "$EMAIL" --arg p "$PASSWORD" '{email:$e,password:$p}' |
  curl -sS -X POST "$SERVER/api/v1/auth/login" -H 'content-type: application/json' --data @- | jq -r .token)

# 2. Create a scoped API key. The raw key is returned once and never stored.
curl -sS -X POST "$SERVER/api/v1/auth/keys" \
  -H "Authorization: Bearer $token" \
  -H 'content-type: application/json' \
  -d '{"name":"ci-publisher","scopes":["publish"]}'
# → {"key":"mdo_...","id":"akey_...","name":"ci-publisher","prefix":"mdo_...","scopes":["publish"]}

# 3. End the temporary session.
curl -sS -X POST "$SERVER/api/v1/auth/logout" -H "Authorization: Bearer $token"
```

The CLI wraps this flow as `maradocs auth bootstrap --server <url> --email <email>` (add `--register` to create the account).

### Account endpoints

| Method | Endpoint | Auth | Purpose |
|--------|----------|------|---------|
| GET | `/api/v1/auth/config` | none | `{ registration, claimRequired, minPasswordLength }` |
| POST | `/api/v1/auth/register` | none | `{ email, password, claimPassword? }` → `201 { user, token }`. `403` when registration is closed or the claim password is missing/wrong, `409` if the email is taken. 5/hour per client. |
| POST | `/api/v1/auth/login` | none | `{ email, password }` → `{ user, token }`. `401 Invalid email or password`. 5 attempts / 15 minutes per client. |
| GET | `/api/v1/auth/me` | session | `{ user }` |
| POST | `/api/v1/auth/logout` | session | End this session (`204`) |
| POST | `/api/v1/auth/logout-others` | session | End your other sessions → `{ revoked }` |
| POST | `/api/v1/auth/change-password` | session | `{ currentPassword, newPassword }`; ends your other sessions |
| DELETE | `/api/v1/auth/account` | session | `{ password }`; deletes the account and everything it owns |
| GET | `/api/v1/auth/keys` | session | List your API keys |
| POST | `/api/v1/auth/keys` | session | `{ name, scopes? }` → create an API key (raw key shown once) |
| DELETE | `/api/v1/auth/keys/:id` | session | Revoke one of your API keys |

`user` is `{ id, email, createdAt }`. Browsers get the session as an `HttpOnly` cookie instead of a token, and cookie-authenticated writes must send `x-maradocs: 1`.

## Endpoints

| Method | Endpoint | Scope | Purpose |
|--------|----------|-------|---------|
| GET | `/health` | none | Health check |
| GET | `/api/v1/openapi.json` | none | OpenAPI 3.1 description of this API |
| GET | `/api/v1/repos` | any valid key | List your repositories |
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

Private read URLs accept the owning account's dashboard session cookie, or a bearer API key belonging to that account with `read`, `publish`, or `admin` scope.

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
- `403`: authenticated key lacks the required scope, or a cookie-authenticated write is missing `x-maradocs: 1`.
- `404`: also returned for repositories owned by another account.
- `404`: repository, document, version, or asset not found.
- `409`: create-only publish attempted for an existing document, or the repository slug belongs to another account.
- `413`: upload exceeds `MAX_UPLOAD_MB`.
