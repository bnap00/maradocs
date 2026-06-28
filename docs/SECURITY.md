# Security Model

MaraDocs is a static publishing service. It accepts zip uploads, extracts them into versioned directories, and serves the files back over HTTP. Uploaded files are never executed server-side.

## Trust Boundaries

There are three important actors:

- **Dashboard admin**: signs in with `ADMIN_PASSWORD`, manages repositories and API keys.
- **Machine publisher**: uses a scoped API key from CLI, CI, or an agent.
- **Report viewer**: opens public, password-gated, or private report URLs.

## Access Modes

| Mode | Who can view |
|------|--------------|
| `public` | Anyone with the URL |
| `password` | Anyone with the document/repository password |
| `private` | Dashboard session cookie or API key with `read`, `publish`, or `admin` scope |

Document access overrides repository defaults. If a document has no override, it inherits the repository access mode.

## API Keys

API keys are generated as `mdo_` plus 32 random bytes encoded with base64url. The server stores only a SHA-256 hash and a short display prefix.

Scopes:

- `read`: read metadata and private reports.
- `publish`: publish and manage reports; also reads private reports.
- `admin`: machine-admin scope for all API operations.

Treat `publish` and `admin` keys as secrets. A leaked publish key can replace or delete documents in the server.

## Dashboard Sessions

Successful dashboard login returns a bearer token and sets an `HttpOnly` `__session` cookie. The bearer token is used by the dashboard API client; the cookie lets browser navigation to private report URLs work.

Sessions expire after 7 days. Changing `ADMIN_PASSWORD` does not automatically delete existing sessions; clear the `admin_sessions` table if immediate revocation is required.

## Upload Safety

The server rejects unsafe zip entries:

- absolute paths
- Windows drive paths
- `..` traversal
- null bytes
- paths that are too long or too deep
- duplicate paths
- bundles exceeding `MAX_UPLOAD_MB`
- bundles with more than 2,000 files

Serving performs a second path-resolution check and rejects symlink escapes.

## Content Security Policy

HTML report responses are served with a sandbox CSP:

```http
Content-Security-Policy: sandbox allow-downloads allow-forms allow-popups allow-scripts
```

Published reports may still contain JavaScript. Because reports and the dashboard share the same origin by default, a JavaScript-enabled report can make credentialed requests to the dashboard API using the browser session cookie. For externally shared or untrusted reports, use a dedicated domain or subdomain to enforce origin separation.

## Session Revocation

Changing `ADMIN_PASSWORD` does not automatically invalidate existing sessions. To revoke all sessions immediately, delete all rows from the `admin_sessions` table:

```bash
sqlite3 /data/docs.db "DELETE FROM admin_sessions;"
```

## Operational Recommendations

- Use HTTPS in production.
- Set a long random `COOKIE_SECRET`.
- Keep `DEFAULT_REPO_ACCESS=private` unless public-by-default is intentional.
- Back up `DATA_DIR` regularly; the database and `repositories/` tree are both required.
- Rotate API keys used by CI or agents periodically.
- Use read-only keys when consumers only need private report access.
- Serve externally shared reports from a dedicated subdomain when possible.
- `BCRYPT_ROUNDS` defaults to 12 and must be at least 10 in production.
