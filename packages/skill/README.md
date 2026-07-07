# MaraDocs Skill

skills.sh-compatible skill for publishing — and updating — static HTML
reports on a MaraDocs server.

- `scripts/publish.sh`: package a report folder and publish it (creates the
  repository on demand; republishing creates a new immutable version).
- `scripts/download.sh`: fetch a published version's files so an artifact
  can be edited and republished.

Both scripts print exactly one JSON object on stdout; progress goes to
stderr. Credentials come from `MARADOCS_SERVER_URL`/`MARADOCS_API_KEY` or
fall back to the config saved by `maradocs auth login`.

See [skill/SKILL.md](./skill/SKILL.md) for inputs and usage, and the main
repository README for setup and authentication:
https://github.com/bnap00/maradocs#readme
