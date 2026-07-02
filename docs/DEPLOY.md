# Deploying MaraDocs

MaraDocs ships as a single Docker container: a Fastify API, a static file
server, the SQLite metadata store, and the password-protected dashboard, all
backed by a mounted `/data` volume.

## One-command setup (macOS / Linux)

For a personal machine or single host, the setup script does everything —
generates secrets, starts the server, mints an API key, and configures the
CLI:

```bash
curl -fsSL https://raw.githubusercontent.com/bnap00/maradocs/main/scripts/setup.sh | bash
```

It prefers Docker (prebuilt `ghcr.io/bnap00/maradocs:latest` image) and
falls back to Node 22+ standalone mode when Docker is not installed. It
installs into `~/maradocs` (override with `MARADOCS_HOME`), listens on
port 8787 (`MARADOCS_PORT`), and re-running it is safe: existing secrets
and data are reused. Force a runtime with `MARADOCS_SETUP_MODE=docker` or
`MARADOCS_SETUP_MODE=node`.

## Run without Docker

The server is a single Node process backed by SQLite — Docker is optional.
With Node 22+:

```bash
npx @maradocs/server
```

Standalone mode picks personal-machine defaults: data in `~/maradocs/data`,
a cookie secret and admin password generated on first run and persisted
(mode 0600) in `~/maradocs/data/standalone-secrets.json`, and the server
bound to `127.0.0.1:8787`. Explicit environment variables (`PORT`, `HOST`,
`DATA_DIR`, `PUBLIC_BASE_URL`, `ADMIN_PASSWORD`, `COOKIE_SECRET`) override
every default.

To expose it beyond the local machine, set `HOST=0.0.0.0` and
`PUBLIC_BASE_URL` to the external URL — and put TLS in front (see the
reverse-proxy section below).

Standalone mode does not manage the process: it runs in the foreground and
does not restart on reboot. For an always-on install, either use Docker
(`restart: unless-stopped` is built in) or wrap `maradocs-server` in a
systemd unit / launchd agent.

## Prebuilt image

Every push to `main` and every `v*` tag publishes a multi-arch
(amd64 + arm64) image to GitHub Container Registry:

```text
ghcr.io/bnap00/maradocs:latest    # tracks main
ghcr.io/bnap00/maradocs:<version> # tagged releases
```

Use it anywhere you'd otherwise build from the Dockerfile.

## Quick start (Docker Compose, from source)

```bash
cp .env.example .env
# edit .env: set COOKIE_SECRET (openssl rand -hex 32) and ADMIN_PASSWORD
docker compose up -d --build
# open http://localhost:8787/dashboard/
```

`.env.example` ships with `COOKIE_SECRET` and `ADMIN_PASSWORD` empty on
purpose: `docker compose up` fails with a clear message until you set real
values, and the server refuses known placeholder values in production.

The `./maradocs-data` directory is mounted at `/data` and holds `docs.db`
plus the `repositories/` bundle tree.

## Environment

Production requires:

- `ADMIN_PASSWORD`: dashboard login password.
- `COOKIE_SECRET`: at least 32 characters; use `openssl rand -hex 32`.
- `PUBLIC_BASE_URL`: external URL returned in publish responses.

See [Configuration](CONFIGURATION.md) for the full variable reference.

## Deploying to Dokploy (auto-deploy)

[Dokploy](https://dokploy.com) is a self-hosted PaaS that builds from your
Dockerfile and redeploys on demand.

1. **Create the application.** In Dokploy → *Create Application*, connect this
   Git repository and choose **Build Type: Dockerfile** (the repo's
   `Dockerfile`). Alternatively choose **Docker Compose** and point it at
   `docker-compose.yml`.
2. **Add a volume.** Mount a persistent volume at `/data` so documents and the
   database survive redeploys.
3. **Set environment variables** (from `.env.example`):
   - `COOKIE_SECRET` (required), `ADMIN_PASSWORD` (required),
     `PUBLIC_BASE_URL` (your external URL), `DEFAULT_REPO_ACCESS`, `MAX_UPLOAD_MB`
4. **Domain & TLS.** Attach a domain in Dokploy; its built-in Traefik proxy
   terminates TLS. Set `PUBLIC_BASE_URL` to that `https://…` URL.
5. **Enable auto-deploy.** Copy the application's **Deploy webhook** URL and
   add it to GitHub as the `DOKPLOY_DEPLOY_WEBHOOK_URL` secret. The
   `.github/workflows/deploy.yml` workflow calls it on every push to the
   default branch. Dokploy also supports its own GitHub webhook — either works.

## Reverse proxy & shared-report safety

Published reports can contain JavaScript. To prevent shared reports from
reading privileged cookies, serve externally-shared documents from a
**dedicated domain or subdomain** (e.g. `reports.example.com`) separate from
your dashboard/admin domain. Set `PUBLIC_BASE_URL` accordingly.

Any reverse proxy works (Dokploy/Traefik, Caddy, Nginx, Tailscale Funnel).
Forward to the container's `PORT` (default `8787`).

Example Caddy route:

```caddyfile
docs.example.com {
  reverse_proxy 127.0.0.1:8787
}
```

When using a reverse proxy, keep `PUBLIC_BASE_URL` set to the public HTTPS origin, not the internal container address.

## Backups

Back up the whole mounted data directory:

```text
maradocs-data/
├── docs.db
└── repositories/
```

The SQLite database stores metadata, access settings, sessions, API key hashes, and version pointers. The `repositories/` tree stores the report files. Restoring only one of them can leave metadata and files out of sync.

## Production checklist

- [ ] `COOKIE_SECRET` set to a long random value (`openssl rand -hex 32`)
- [ ] `ADMIN_PASSWORD` set to a strong value
- [ ] `PUBLIC_BASE_URL` points at the external HTTPS URL
- [ ] `/data` backed by a persistent, backed-up volume
- [ ] Externally shared public reports use a dedicated host or subdomain when possible
- [ ] API keys used by CI/agents are scoped and rotated periodically
