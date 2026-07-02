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

The fastest path is `auth bootstrap`, which mints a new API key with the dashboard admin password and saves it locally — no dashboard visit needed:

```bash
maradocs auth bootstrap --server http://localhost:8787
# Prompts for ADMIN_PASSWORD, creates a publish-scoped key, saves it.
```

Options: `--admin-password <pw>` (skip the prompt), `--name <name>`, `--scopes read,publish,admin`, `--no-save` (print the key without writing config), `--json`.

If you already have an API key (created in the dashboard under **API Keys**), store it directly:

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

Publishing is designed to just work for agents and scripts:

- If the repository does not exist, it is created automatically (using `--access` if given). Disable with `--no-create-repo`.
- If the document already exists, the publish becomes a new immutable version of it — no flag needed.
- `--replace` forces PUT semantics: the publish fails unless the document already exists.

Common options:

```bash
maradocs publish ./report \
  --repo demo \
  --doc hello \
  --title "Hello report" \
  --access private \
  --entrypoint index.html \
  --json
```

Each successful publish creates a new immutable version. The document URL resolves to the latest version, while the version URL pins the exact publish.

## Machine-Readable Output

Every command that returns data supports `--json`: `publish`, `repo create|list|update`, `doc list|versions|download|rollback|delete`, `auth status`, `auth bootstrap`, and `open`. With `--json`, the JSON payload is the only thing written to stdout — progress messages go to stderr — so output can be piped straight into `jq` or parsed by an agent:

```bash
maradocs publish ./report --repo demo --doc hello --json | jq -r .url
```

Errors in `--json` mode are emitted to stderr as a single JSON object: `{"error": "<code>", "message": "...", "status": <http-status>}`.

## Manage Documents and Versions

```bash
maradocs doc list demo
maradocs doc versions demo/hello
maradocs doc rollback demo/hello --version 2
maradocs doc delete demo/hello --yes
maradocs open demo/hello
```

Rollback promotes an existing immutable version to become the latest. It does not delete later versions.

## Download and Update Documents

`doc download` fetches a version's files so an artifact can be edited and republished:

```bash
maradocs doc download demo/hello            # extract latest into ./hello
maradocs doc download demo/hello --out ./report
maradocs doc download demo/hello -v 2       # pinned version
maradocs doc download demo/hello --zip hello.zip  # keep the archive
```

Extraction refuses to overwrite a non-empty directory unless `--force` is given. The typical update loop:

```bash
maradocs doc download demo/hello --out ./report
# edit ./report ...
maradocs publish ./report --repo demo --doc hello   # becomes a new version
```

## Folder Packaging Rules

The CLI zips the folder in memory before upload.

- Hidden files are skipped, except `.well-known`.
- `node_modules` is skipped.
- Regular files are included with paths relative to the report folder.
- A missing entrypoint produces a warning, not a local failure; the server still validates and stores the bundle.

The server enforces path safety during extraction and serving. See [Security model](SECURITY.md).

## Agent Skill

The `@maradocs/skill` package includes `publish.sh` and `download.sh` wrappers for agent runtimes:

```bash
report_path="./report" \
repo="revenue" \
doc="monthly-june-2026" \
access="private" \
bash packages/skill/skill/scripts/publish.sh

repo="revenue" \
doc="monthly-june-2026" \
out_dir="./report" \
bash packages/skill/skill/scripts/download.sh
```

The skill reads `~/.maradocs/config.json` created by `maradocs auth login`. Set `MARADOCS_SERVER_URL` and `MARADOCS_API_KEY` only to override the saved CLI config. Publishing creates the repository if needed and becomes a new immutable version when the document already exists; downloading fetches a version's files (latest, or pinned with `version=N`) so an artifact can be edited and republished. Both scripts print exactly one JSON object on stdout, with progress on stderr.
