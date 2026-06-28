# Development Guide

MaraDocs is a pnpm monorepo with a Fastify server, Vite dashboard, bundled Node CLI, shared TypeScript package, and skills.sh package.

## Prerequisites

- Node.js 22+
- pnpm 10.33.0+
- Docker, if you want to test the production container

Install dependencies:

```bash
pnpm install
```

## Run Locally

Create local environment settings:

```bash
cp .env.example .env
# Set ADMIN_PASSWORD. The development COOKIE_SECRET fallback is allowed outside production.
```

Start the server and dashboard in separate terminals:

```bash
pnpm dev:server
pnpm dev:dashboard
```

Open `http://localhost:8787/dashboard/`. The server proxies dashboard requests to Vite through `DASHBOARD_DEV_SERVER_URL`.

## Build and Test

Common checks:

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm e2e:smoke
```

What each command covers:

| Command | Coverage |
|---------|----------|
| `pnpm typecheck` | TypeScript across workspace packages |
| `pnpm lint` | Dashboard ESLint rules |
| `pnpm test` | Server integration and unit tests with real SQLite |
| `pnpm build` | Shared package, CLI bundle, skill validation, server, dashboard |
| `pnpm e2e:smoke` | Built server + built CLI publish flow against temporary data |

## Project Layout

```text
apps/server       Fastify routes, auth, SQLite store, upload/extraction, static reads
apps/dashboard    React dashboard SPA served at /dashboard/
packages/cli      Commander CLI bundled with esbuild
packages/shared   Zod schemas, shared types, slug validation
packages/skill    skills.sh package and publish script
docs              User and operator documentation
```

## Server Notes

- `apps/server/src/app.ts` wires plugins and routes.
- `apps/server/src/routes/api.ts` exposes machine-authenticated REST endpoints.
- `apps/server/src/routes/auth.ts` handles dashboard login, logout, and API key CRUD.
- `apps/server/src/routes/read.ts` serves public, password-gated, and private report URLs.
- `apps/server/src/services/publish.ts` validates and extracts zip bundles.
- `apps/server/src/db/store.ts` owns SQLite schema access and lightweight migrations.

## CLI Notes

The CLI is bundled into `packages/cli/dist/index.js`:

```bash
pnpm --filter ./packages/cli build
node packages/cli/dist/index.js --help
```

During local testing, either run `maradocs auth login ...` or set:

```bash
MARADOCS_SERVER_URL=http://localhost:8787
MARADOCS_API_KEY=mdo_...
```

## Docker Verification

Build the production image:

```bash
docker build -t maradocs:local .
```

Run it with explicit production settings:

```bash
docker run --rm -p 8787:8787 \
  -e NODE_ENV=production \
  -e PUBLIC_BASE_URL=http://localhost:8787 \
  -e COOKIE_SECRET=$(openssl rand -hex 32) \
  -e ADMIN_PASSWORD=change-me \
  maradocs:local
```

## Release Notes

The publish workflow releases `@maradocs/cli` and `@maradocs/skill` to npm on `v*` tags. Both package tarballs intentionally include only the package payload plus README and LICENSE files.
