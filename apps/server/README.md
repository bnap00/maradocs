# @maradocs/server

Self-hosted MaraDocs server: agents, CLIs, and CI jobs publish static HTML
reports to it and get durable, access-controlled URLs back.

## Run standalone (no Docker)

Requires Node 22+.

```bash
npx @maradocs/server
```

On first run it creates `~/maradocs/data`, generates and persists an admin
password and cookie secret, and serves the dashboard at
`http://localhost:8787/dashboard/`. Defaults can be overridden with
environment variables (`PORT`, `HOST`, `DATA_DIR`, `PUBLIC_BASE_URL`,
`ADMIN_PASSWORD`, `COOKIE_SECRET`).

The server binds to `127.0.0.1` by default. Set `HOST=0.0.0.0` and a real
`PUBLIC_BASE_URL` to expose it beyond the local machine — behind TLS.

See the main repository for the Docker deployment path, CLI, agent skill,
and full documentation: https://github.com/bnap00/maradocs#readme
