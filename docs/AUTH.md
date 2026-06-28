# Authentication and Access Control

MaraDocs uses a single dashboard admin password and scoped per-machine API keys. No external auth service is required.

## First-time setup

Set `ADMIN_PASSWORD` in `.env` before starting the server:

```env
ADMIN_PASSWORD=your-strong-password-here
```

The password is hashed with bcrypt (12 rounds) at startup and never written to disk.

## Dashboard login

Open `http://localhost:8787/dashboard/` and enter your `ADMIN_PASSWORD`.

On successful login, MaraDocs creates a 7-day admin session. The dashboard receives a bearer token for API calls and the server also sets an `HttpOnly` `__session` cookie so private report links can be opened directly in the same browser.

## Creating API keys

Once signed in to the dashboard:

1. Go to **API Keys** → **New key**
2. Give it a name (e.g. `ci-runner`)
3. Copy the key — it is shown **once only** (only the SHA-256 hash is stored server-side)

API keys can be scoped:

- `read`: fetch private reports and list metadata
- `publish`: create/update/delete repositories and documents, and read private reports
- `admin`: all machine API operations

Use the narrowest scope that works. For example, a CI job that publishes reports needs `publish`; a service that only reads private report URLs should use `read`.

Set the key as `MARADOCS_API_KEY` in your publishing environment:

```env
MARADOCS_API_KEY=mdo_...
```

## Using the CLI

```bash
export MARADOCS_SERVER_URL="https://docs.example.com"
export MARADOCS_API_KEY="mdo_..."

maradocs publish ./dist/report --repo my-project --doc my-report
```

Or save credentials locally first:

```bash
maradocs auth login --server https://docs.example.com --api-key mdo_...
maradocs publish ./dist/report --repo my-project --doc my-report
```

Or with the bash skill:

```bash
report_path="./dist/report" \
repo="my-project" \
doc="my-report" \
bash ./scripts/publish.sh
```

The bash skill reuses `~/.maradocs/config.json` from `maradocs auth login`. Set `MARADOCS_SERVER_URL` and `MARADOCS_API_KEY` only to override saved CLI credentials.

## Revoking a key

Dashboard → **API Keys** → trash icon next to the key.

## Changing the admin password

Update `ADMIN_PASSWORD` in `.env` and restart the server.

> **Important:** Restarting with a new `ADMIN_PASSWORD` does **not** immediately revoke active dashboard sessions. Sessions are stored in the `admin_sessions` table and are validated independently of the password hash — they expire naturally 7 days after creation.
>
> To immediately revoke all sessions (e.g. after a suspected breach):
> 1. Stop the container.
> 2. Either delete `data/docs.db` entirely **or** run `DELETE FROM admin_sessions;` directly against the database.
> 3. Restart with the new `ADMIN_PASSWORD`.

## Private reports

Reports set to `private` access can be viewed after dashboard login or fetched programmatically using an API key with `read`, `publish`, or `admin` scope:

```
Authorization: Bearer <your-api-key>
```

Dashboard login also sets an `HttpOnly` session cookie, so direct browser navigation to private report URLs (e.g. `/r/:repo/:doc/`) works in the same browser until logout or session expiry.

## Password-gated reports

Repositories and documents can use `password` access. Passwords are hashed with bcrypt before storage. When a viewer enters the correct password, MaraDocs sets a signed, document-scoped cookie. The cookie value is bound to the current password hash, so changing the password invalidates older password-gate cookies.

## Session revocation

Logout deletes the current session. To revoke every dashboard session immediately, stop the server and delete rows from `admin_sessions` in SQLite:

```sql
DELETE FROM admin_sessions;
```

If you suspect API key exposure, delete the key from the dashboard and create a replacement.
