# Contributing to MaraDocs

Thanks for your interest! Here's how to get set up and make a contribution.

## Prerequisites

- Node 22+
- pnpm 10+ (`npm install -g pnpm`)
- Docker (for running the full stack or integration tests)

## Setup

```bash
git clone https://github.com/bnap00/maradocs
cd maradocs
pnpm install
cp .env.example .env   # fill in ADMIN_PASSWORD + COOKIE_SECRET
```

## Running locally

```bash
# Build the shared package first (required by server, CLI, dashboard)
pnpm --filter @maradocs/shared build

# Start the API server (hot reload)
pnpm dev:server        # http://localhost:8787

# Start the dashboard (hot reload, in a second terminal)
pnpm dev:dashboard     # http://localhost:5273/dashboard/
```

## Typechecking

```bash
pnpm typecheck
```

## Building

```bash
pnpm build
```

## Tests

```bash
pnpm test
```

The test suite runs server integration tests against a real SQLite database and
a real server instance. No mocks.

## Building and testing the CLI

```bash
pnpm --filter @maradocs/shared build
pnpm --filter ./packages/cli build
node packages/cli/dist/index.js --help
```

## Pull requests

1. Fork the repo and create a branch: `git checkout -b my-feature`
2. Make your changes — keep them focused and atomic
3. Run `pnpm typecheck && pnpm lint && pnpm build && pnpm test` — all must pass
4. Commit with a clear message describing the *why*, not just the *what*
5. Open a PR against `main` with a description of what you changed and why

## Project layout

See the [Repository Layout section in README.md](./README.md#repository-layout).

## Releasing

Releases are triggered by pushing a `v*` tag:

```bash
git tag v0.2.0
git push origin v0.2.0
```

GitHub Actions publishes `@maradocs/cli` and `@maradocs/skill` to npm automatically.
