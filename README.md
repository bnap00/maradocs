# MaraDocs

Ask an agent for a report, and it should hand back more than a wall of chat. MaraDocs lets your agent create an HTML report, publish it, and return a durable URL you can share, revisit, protect, and version.

Technically, MaraDocs is a Docker-first static HTML publishing system for agents, CLIs, CI jobs, and scripts. It accepts static report folders through a CLI or REST API, stores metadata in SQLite, stores report files on disk, and serves stable latest-version URLs plus immutable version URLs.

```bash
maradocs publish ./report --repo demo --doc hello
# https://docs.example.com/r/demo/hello/
```

## Why MaraDocs

- **Agent-friendly publishing**: install the MaraDocs skill, teach your agent your report preference once, and give OpenClaw, Hermes, Claude Code, OpenCode, skills.sh-compatible agents, CI jobs, CLIs, and scripts a shared publishing target.
- **Durable URLs**: `/r/:repo/:doc/` always points to the latest version; `/r/:repo/:doc/v/:version/` pins an immutable version.
- **Access controls**: choose `public`, `password`, or `private` at the repository or document level.
- **Static serving only**: uploaded files are served as static assets. MaraDocs does not execute uploaded code.
- **Self-hosted by default**: Docker, SQLite, and a mounted `/data` volume. No managed database or auth provider required.
- **Dashboard included**: manage repositories, documents, versions, API keys, and audit history at `/dashboard/`.

## Quick Start

### 1. Start the server

```bash
cp .env.example .env
# Set COOKIE_SECRET and ADMIN_PASSWORD in .env.
docker compose up -d --build
```

Open `http://localhost:8787/dashboard/`, sign in with `ADMIN_PASSWORD`, and create an API key under **API Keys**.

### 2. Install and authenticate the CLI

```bash
npm install -g @maradocs/cli
maradocs auth login --server http://localhost:8787 --api-key mdo_...
```

### 3. Publish a report

```bash
mkdir -p report
printf '<h1>Hello from MaraDocs</h1>\n' > report/index.html

maradocs repo create demo --access public
maradocs publish ./report --repo demo --doc hello
```

The report is available at `http://localhost:8787/r/demo/hello/`.

## Enable Agents

The intended workflow is simple: install and authenticate the MaraDocs CLI once, install the MaraDocs skill for your agent, and tell the agent to use MaraDocs whenever you ask for a report or document.

For example, you might tell an OpenClaw agent:

> Remember, when I ask you to create a report or document, create an HTML report using my preferences and share it with me using the MaraDocs skill unless I specify otherwise.

Set up the CLI first:

```bash
npm install -g @maradocs/cli
maradocs auth login --server https://docs.example.com --api-key mdo_...
```

Then let the agent publish a static report folder through one of these paths without handling raw credentials in every agent prompt:

- **Skill**: install the packaged MaraDocs skill with `npx skills add https://github.com/bnap00/maradocs --skill maradocs-publish` or your agent runtime's skills installer
- **CLI**: `maradocs publish ./report --repo demo --doc hello`
- **REST API**: upload a zip bundle to `/api/v1/repos/:repo/docs`

This works for agent systems that can run shell commands, call HTTP APIs, or use skills, including OpenClaw, Hermes, Claude Code, OpenCode, skills.sh-compatible agents, CI jobs, and custom runners.

See [Agent integration](docs/AGENTS.md) for detailed setup patterns.

## Documentation

- [CLI usage](docs/CLI.md)
- [REST API](docs/API.md)
- [Agent integration](docs/AGENTS.md)
- [Authentication and access control](docs/AUTH.md)
- [Configuration](docs/CONFIGURATION.md)
- [Deployment](docs/DEPLOY.md)
- [Cloudflare Tunnel setup](docs/CLOUDFLARE-TUNNEL.md)
- [Development guide](docs/DEVELOPMENT.md)
- [Security model](docs/SECURITY.md)

## Agent Skill

MaraDocs ships a skills.sh-compatible package for agent runtimes:

```bash
npx skills add https://github.com/bnap00/maradocs --skill maradocs-publish
```

The npm package is scoped: install the CLI as `@maradocs/cli`. The skill reuses the CLI config saved by `maradocs auth login`.

For CI or isolated agent runtimes, override the saved CLI config with environment variables:

```bash
MARADOCS_SERVER_URL="https://docs.example.com"
MARADOCS_API_KEY="mdo_..."
```

See [CLI usage](docs/CLI.md#agent-skill) for the direct script form.

## Repository Layout

```text
apps/server       Fastify API, static report serving, SQLite store
apps/dashboard    Vite + React dashboard
packages/cli      maradocs command-line client
packages/shared   shared schemas, types, and slug rules
packages/skill    skills.sh-compatible publish skill
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Before opening a PR, run:

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm e2e:smoke
```

## License

MIT. See [LICENSE](LICENSE).
