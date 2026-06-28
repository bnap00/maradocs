# MaraDocs Dashboard

React dashboard served by the MaraDocs server at `/dashboard/`.

## Development

```bash
pnpm --filter @maradocs/dashboard dev
```

The API server proxies dashboard requests to the Vite dev server in development. See the root [development guide](../../docs/DEVELOPMENT.md) for the full local workflow.

## Build

```bash
pnpm --filter @maradocs/dashboard build
```

The Docker build copies `apps/dashboard/dist` into `apps/server/public/dashboard` so one container serves both the dashboard and API.
