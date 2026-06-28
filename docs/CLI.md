# CLI Usage

The `maradocs` CLI packages a static report folder, uploads it to a MaraDocs server, and prints the stable document URL.

## Install

```bash
npm install -g @maradocs/cli
```

For one-off use:

```bash
npx @maradocs/cli --help
```

## Authenticate

Create an API key in the dashboard first, then store it locally:

```bash
maradocs auth login --server http://localhost:8787 --api-key mdo_...
```

Credentials are saved in `~/.maradocs/config.json` with file mode `0600`. For CI or agent runners, prefer environment variables instead of a saved config file:

```bash
export MARADOCS_SERVER_URL="https://docs.example.com"
export MARADOCS_API_KEY="mdo_..."
```

Useful auth commands:

```bash
maradocs auth setup
maradocs auth status
maradocs auth logout
```

## Create and Manage Repositories

A repository is a namespace for related documents. Repository access is the default for documents published into it.

```bash
maradocs repo create demo --access public --name "Demo Reports"
maradocs repo list
maradocs repo update demo --access private
```

Access modes:

- `public`: anyone with the URL can view.
- `password`: viewers must enter a document/repository password.
- `private`: viewers need a dashboard session cookie or a scoped API key.

Repository options:

```bash
maradocs repo create <slug> \
  --access public|password|private \
  --name "Display name" \
  --description "Optional description" \
  --password "required-for-password-access" \
  --index
```

Use `--index` to expose a repository index at `/r/:repo/`. The index lists only public documents.

## Publish Documents

Publish a folder containing `index.html` and any static assets:

```bash
maradocs publish ./report --repo demo --doc hello
```

Common options:

```bash
maradocs publish ./report \
  --repo demo \
  --doc hello \
  --title "Hello report" \
  --access private \
  --entrypoint index.html
```

Use `--replace` to publish a new version of an existing document through PUT semantics:

```bash
maradocs publish ./report --repo demo --doc hello --replace
```

Each successful publish creates a new immutable version. The document URL resolves to the latest version, while the version URL pins the exact publish.

## Manage Documents and Versions

```bash
maradocs doc list demo
maradocs doc versions demo/hello
maradocs doc rollback demo/hello --version 2
maradocs doc delete demo/hello --yes
maradocs open demo/hello
```

Rollback promotes an existing immutable version to become the latest. It does not delete later versions.

## Folder Packaging Rules

The CLI zips the folder in memory before upload.

- Hidden files are skipped, except `.well-known`.
- `node_modules` is skipped.
- Regular files are included with paths relative to the report folder.
- A missing entrypoint produces a warning, not a local failure; the server still validates and stores the bundle.

The server enforces path safety during extraction and serving. See [Security model](SECURITY.md).

## Agent Skill

The `@maradocs/skill` package includes a `publish.sh` wrapper for agent runtimes:

```bash
report_path="./report" \
repo="revenue" \
doc="monthly-june-2026" \
access="private" \
bash packages/skill/skill/scripts/publish.sh
```

The skill reads `~/.maradocs/config.json` created by `maradocs auth login`. Set `MARADOCS_SERVER_URL` and `MARADOCS_API_KEY` only to override the saved CLI config. The skill creates the repository if needed, uploads a zip bundle, and prints the API JSON response. If the document already exists, it updates the document with a new immutable version.
