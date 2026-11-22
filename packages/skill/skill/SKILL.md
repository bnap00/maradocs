---
name: maradocs-publish
description: >-
  Publish a static HTML report folder (containing index.html) to a MaraDocs
  server and get back a durable, access-controlled URL — or download an
  existing report version to update it and republish. Use when an agent has
  produced an HTML report to share as a stable link, or needs to modify a
  previously published report.
license: MIT
metadata:
  homepage: https://github.com/bnap00/maradocs
inputs:
  - name: MARADOCS_SERVER_URL
    required: false
    description: Base URL of the MaraDocs publisher (e.g. https://docs.example.com). Falls back to ~/.maradocs/config.json from `maradocs auth bootstrap` / `maradocs auth login`.
  - name: MARADOCS_API_KEY
    required: false
    secret: true
    description: MaraDocs API key for authenticating machine publishing (keys belong to your MaraDocs account). Falls back to ~/.maradocs/config.json from `maradocs auth bootstrap` / `maradocs auth login`.
  - name: report_path
    required: false
    description: Path to the folder containing index.html and assets. Required for publish (publish.sh); not used by download.sh.
  - name: repo
    required: true
    description: Repository slug to publish into (created on demand).
  - name: doc
    required: true
    description: Document slug for this report.
  - name: access
    required: false
    description: "public | password | private (defaults to the repo default)."
  - name: password
    required: false
    secret: true
    description: Password to set when access is "password".
  - name: title
    required: false
    description: Display title for the document.
  - name: entrypoint
    required: false
    description: Entry HTML file served at the document root (default index.html).
  - name: version
    required: false
    description: Download only (download.sh). Pinned version number to download (default latest).
  - name: out_dir
    required: false
    description: Download only (download.sh). Directory to extract into (default ./<doc>).
  - name: zip_path
    required: false
    description: Download only (download.sh). Save the raw zip archive here instead of extracting.
  - name: force
    required: false
    description: Download only (download.sh). Set to 1 to extract into a non-empty directory.
---

# MaraDocs Publish

This skill publishes a static report folder to a MaraDocs server through the
REST API and returns a durable URL. It can also download a published version
so an artifact can be edited and republished. There is **no server-side
execution** — files are served as static assets only.

All scripts print exactly one JSON object on stdout on success; progress and
errors go to stderr, so stdout can be parsed directly.

## Credentials

The scripts only use an API key; they never sign in with a password. To get
one, sign in with your MaraDocs account (email + password) once:

```bash
maradocs auth bootstrap --server https://docs.example.com --email you@example.com
```

This mints a publish-scoped key and saves it to `~/.maradocs/config.json`
(add `--register` to create the account on a fresh server). Alternatively,
create a key in the dashboard under API Keys and set `MARADOCS_SERVER_URL` and
`MARADOCS_API_KEY`. A key only sees the repositories of the account that owns
it.

## When to use

- After generating an HTML report (a folder with `index.html` plus any
  CSS/JS/asset files) that should be shared as a stable link with
  controlled access.
- When an existing published report needs to be updated: download it, edit
  the files, and republish.

## Publish

```bash
report_path="./report" \
repo="revenue" \
doc="monthly-june-2026" \
access="private" \
title="Monthly revenue" \
bash ./scripts/publish.sh
```

Success output:

```json
{
  "repo": "revenue",
  "doc": "monthly-june-2026",
  "versionNumber": 1,
  "access": "private",
  "url": "https://docs.example.com/r/revenue/monthly-june-2026/",
  "versionUrl": "https://docs.example.com/r/revenue/monthly-june-2026/v/1/"
}
```

Return the stable `url` to users; use `versionUrl` when the exact artifact
must be preserved.

## Download and update

```bash
repo="revenue" \
doc="monthly-june-2026" \
out_dir="./report" \
bash ./scripts/download.sh
# edit ./report ...
report_path="./report" repo="revenue" doc="monthly-june-2026" bash ./scripts/publish.sh
```

Optional inputs: `version` (pin a version number; default latest),
`zip_path` (save the raw zip instead of extracting), `force=1` (extract into
a non-empty directory). The JSON result includes `versionNumber` and
`checksum`; compare the checksum against the latest version before
republishing if concurrent publishes are possible.

## Behaviour & guarantees

- The repository is created automatically if it does not exist.
- Each publish creates a new **immutable version**; the document URL always
  resolves to the latest version, and `versionUrl` pins this exact version.
- Republishing an existing document automatically becomes a new version (no
  flag needed).
- Dotfiles and `node_modules` are excluded from the bundle at any depth.
- Paths are validated server-side: `..`, absolute paths, and symlinks are
  rejected.
- Requests time out (10s connect, 120s total — override with
  `MARADOCS_TIMEOUT` seconds) instead of hanging an agent run.
- `MARADOCS_API_KEY` is sent as a bearer token and never persisted
  server-side.

## Requirements

`bash`, `curl`, and `zip` (publish) / `unzip` (download) must be available —
all standard on agent runners. If you prefer the Node CLI,
`npx @maradocs/cli publish|doc download ...` is equivalent.
