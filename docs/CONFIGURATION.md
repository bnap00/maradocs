# Configuration

MaraDocs is configured through environment variables. Docker Compose reads these from `.env`.

## Required Production Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `ADMIN_PASSWORD` | yes | none | Dashboard login password. Hashed in memory at startup. |
| `COOKIE_SECRET` | yes in production | dev-only fallback | Secret used to sign password-gate cookies. Must be at least 32 characters in production. |
| `PUBLIC_BASE_URL` | yes in production | none | External base URL used in publish responses. |

Generate a cookie secret:

```bash
openssl rand -hex 32
```

## Core Settings

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8787` | HTTP port inside the process/container. |
| `HOST` | `127.0.0.1` in development, `0.0.0.0` in production | Bind address. |
| `DATA_DIR` | `/data` in Docker | Directory for SQLite metadata and report files. |
| `DEFAULT_REPO_ACCESS` | `private` | Default access for newly created repositories. Must be `public`, `password`, or `private`. |
| `MAX_UPLOAD_MB` | `50` | Per-upload bundle limit in megabytes. |
| `BCRYPT_ROUNDS` | `12` | bcrypt cost for admin and password-gate hashes. Must be ≥ 10 in production. Lower values are used only in tests. |
| `LOG_LEVEL` | `info` | Fastify/Pino log level. |
| `NO_PRETTY_LOG` | unset | Disable pretty logs in development/test runs. |

## Development-Only Settings

| Variable | Default | Description |
|----------|---------|-------------|
| `DASHBOARD_DEV_SERVER_URL` | `http://localhost:5273` | Vite dev server proxied by the API server at `/dashboard/`. Ignored in production. |
| `DASHBOARD_DIR` | auto-detected | Override the path to the built dashboard SPA directory. Useful for custom build layouts. Ignored if `DASHBOARD_DEV_SERVER_URL` is set. |

## Data Layout

MaraDocs stores all persistent state under `DATA_DIR`:

```text
DATA_DIR/
├── docs.db
└── repositories/
    └── <repo>/<doc>/versions/<n>/...
```

Back up the full directory, not just the database. The database records metadata and version pointers; the `repositories/` tree stores the report bytes.

## Public Base URL

`PUBLIC_BASE_URL` controls URLs returned by publish responses. Set it to the HTTPS URL users will open:

```env
PUBLIC_BASE_URL=https://docs.example.com
```

If this is wrong, publishing still succeeds, but returned links point at the wrong host. See [Deployment](DEPLOY.md) and [Cloudflare Tunnel setup](CLOUDFLARE-TUNNEL.md).
