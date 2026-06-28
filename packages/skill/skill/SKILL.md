---
name: maradocs-publish
description: >-
  Publish a static HTML report folder (containing index.html) to a MaraDocs
  server and return a durable, access-controlled URL. Use when an agent has
  produced an HTML report and needs to share it as a stable link.
license: MIT
metadata:
  homepage: https://github.com/bnap00/maradocs
inputs:
  - name: MARADOCS_SERVER_URL
    required: true
    description: Base URL of the MaraDocs publisher (e.g. https://docs.example.com)
  - name: MARADOCS_API_KEY
    required: true
    secret: true
    description: MaraDocs API key for authenticating machine publishing (create in the dashboard under API Keys).
  - name: report_path
    required: true
    description: Path to the folder containing index.html and assets.
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
---

# MaraDocs Publish

This skill packages a static report folder and publishes it to a MaraDocs
server through the REST API, returning a durable URL. There is **no
server-side execution** — your files are served as static assets only.

## When to use

Invoke this skill after generating an HTML report (a folder with
`index.html` plus any CSS/JS/asset files) that should be shared as a stable
link with controlled access.

## Usage

```bash
MARADOCS_SERVER_URL="https://docs.example.com" \
MARADOCS_API_KEY="mdo_..." \
report_path="./report" \
repo="revenue" \
doc="monthly-june-2026" \
access="private" \
./scripts/publish.sh
```

The script prints a JSON object on success:

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

## Behaviour & guarantees

- The repository is created automatically if it does not exist.
- Each publish creates a new **immutable version**; the document URL always
  resolves to the latest version, and `versionUrl` pins this exact version.
- Paths are validated server-side: `..`, absolute paths, and symlinks are
  rejected.
- `MARADOCS_API_KEY` is sent as a bearer token and never persisted server-side.

## Requirements

`bash`, `zip`, and `curl` must be available (all standard on agent runners).
If you prefer the Node CLI, `npx @maradocs/cli publish ...` is equivalent.
