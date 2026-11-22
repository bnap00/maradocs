# Security Model

MaraDocs is a static publishing service. It accepts zip uploads, extracts them into versioned directories, and serves the files back over HTTP. Uploaded files are never executed server-side.

## Trust Boundaries

There are three important actors:

- **Account holder**: signs in to the dashboard with email + password, manages their own repositories and API keys. Accounts are isolated from each other.
- **Machine publisher**: uses a scoped API key from CLI, CI, or an agent.
- **Report viewer**: opens public, password-gated, or private report URLs.

## Access Modes

| Mode | Who can view |
|------|--------------|
| `public` | Anyone with the URL |
| `password` | Anyone with the document/repository password |
| `private` | The owning account only: its dashboard session cookie, or one of its API keys with `read`, `publish`, or `admin` scope |

Document access overrides repository defaults. If a document has no override, it inherits the repository access mode.

## API Keys

API keys are generated as `mdo_` plus 32 random bytes encoded with base64url. The server stores only a SHA-256 hash and a short display prefix.

Scopes:

- `read`: read metadata and private reports.
- `publish`: publish and manage reports; also reads private reports.
- `admin`: machine-admin scope for all API operations.

Each key belongs to one account and only reaches that account's repositories. Treat `publish` and `admin` keys as secrets: a leaked publish key can replace or delete that account's documents.

## Dashboard Sessions

Dashboard sign-in sets an `HttpOnly`, `SameSite=Lax` cookie named `maradocs_session` (`Secure` on HTTPS). The dashboard never sees or stores the token; the cookie also lets the same browser open its account's private report URLs. Only a SHA-256 of each token is stored server-side.

Sessions last 30 days and slide: using the dashboard extends them. Changing your password signs out your other sessions, and **Settings → Sign out other sessions** does the same on demand.

Cookie-authenticated writes must carry the `x-maradocs: 1` header (CSRF protection). See [AUTH.md](AUTH.md) for the full model.

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

Change your password, or use **Settings → Sign out other sessions**. To revoke every session for every account immediately (operator only):

```bash
sqlite3 /data/docs.db "DELETE FROM sessions;"
```

## Operational Recommendations

- Use HTTPS in production.
- Keep `REGISTRATION=first` (the default) or `closed` unless you want anyone to be able to sign up.
- Create your account right after deploying, so nobody else becomes the first account.
- Keep `DEFAULT_REPO_ACCESS=private` unless public-by-default is intentional.
- Back up `DATA_DIR` regularly; the database and `repositories/` tree are both required.
- Rotate API keys used by CI or agents periodically.
- Use read-only keys when consumers only need private report access.
- Serve externally shared reports from a dedicated subdomain when possible.
- `BCRYPT_ROUNDS` defaults to 12 and must be at least 10 in production.
