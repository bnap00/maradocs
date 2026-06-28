# Agent Integration

MaraDocs is designed for the workflow where you tell an agent: when I ask for a report or document, create an HTML report and share it with me through MaraDocs unless I say otherwise.

The agent generates a folder with `index.html` and supporting assets, publishes it to MaraDocs, and returns a stable URL to the user.

MaraDocs serves uploaded files as static assets only. It does not execute uploaded scripts or server-side code.

## Common Setup

Set up the MaraDocs CLI before configuring individual agents. This keeps the normal agent workflow simple: agents can publish through the local CLI or skill without you pasting server URLs and API keys into every agent setup.

Install and authenticate the CLI:

```bash
npm install -g @maradocs/cli
maradocs auth login --server https://docs.example.com --api-key mdo_...
```

For local development:

```bash
maradocs auth login --server http://localhost:8787 --api-key mdo_...
```

Credentials are saved in `~/.maradocs/config.json` with file mode `0600`. See [CLI usage](CLI.md#authenticate) for details.

Install the MaraDocs skill in the agent environment, or make the CLI/API available to the agent:

```bash
npx skills add https://github.com/bnap00/maradocs --skill maradocs-publish
```

Create the API key in the MaraDocs dashboard with the least scope the agent needs:

- `publish`: create repositories and publish, replace, delete, or roll back documents.
- `read`: list metadata and fetch private reports.
- `admin`: use only for trusted automation that needs all machine API operations.

The skill reads the same `~/.maradocs/config.json` file created by `maradocs auth login`. Environment variables are optional overrides for CI jobs, containers, or agent runtimes that cannot read the CLI config file:

```bash
export MARADOCS_SERVER_URL="https://docs.example.com"
export MARADOCS_API_KEY="mdo_..."
```

For local development with environment variables, the server URL is usually:

```bash
export MARADOCS_SERVER_URL="http://localhost:8787"
```

After the CLI and skill are installed, add an instruction like this to the agent's memory, project instructions, or system prompt:

> When I ask you to create a report or document, create an HTML report using my preferences and share it with me using MaraDocs unless I specify otherwise.

That instruction turns MaraDocs into the default delivery path for reports instead of leaving the output trapped in chat.

## Publishing Contract

An agent should create a static report folder with an entrypoint, usually `index.html`:

```text
report/
  index.html
  assets/
    chart.png
    styles.css
```

Then it should publish the folder to a repository and document slug:

```bash
maradocs publish ./report --repo demo --doc hello
```

The response includes:

- `url`: the stable latest-version URL, such as `/r/demo/hello/`.
- `versionUrl`: an immutable pinned version URL, such as `/r/demo/hello/v/1/`.

Agents should usually return the stable `url` to users. Use `versionUrl` when the exact generated artifact must be preserved.

## CLI Integration

Use the CLI when the agent can run shell commands.

Install once in the runtime image or environment:

```bash
npm install -g @maradocs/cli
```

Publish from the agent workspace:

```bash
maradocs publish ./report \
  --repo demo \
  --doc hello \
  --title "Hello report" \
  --access private
```

Use `--replace` when the agent should publish a new version of an existing document:

```bash
maradocs publish ./report --repo demo --doc hello --replace
```

## REST API Integration

Use the REST API when the agent runtime can make HTTP requests but does not use the CLI.

Create a zip bundle and upload it with `multipart/form-data`:

```bash
zip -r report.zip report

curl -sS -X POST "$MARADOCS_SERVER_URL/api/v1/repos/demo/docs" \
  -H "Authorization: Bearer $MARADOCS_API_KEY" \
  -F doc=hello \
  -F title="Hello report" \
  -F access=private \
  -F file=@report.zip
```

See [REST API](API.md) for response shapes, endpoints, and error formats.

## Skill Integration

MaraDocs includes a skills.sh-compatible package with a `publish.sh` wrapper. Use this when the agent platform supports skills or packaged tool wrappers.

Install with the skills.sh CLI:

```bash
npx skills add https://github.com/bnap00/maradocs --skill maradocs-publish
```

Direct script form:

```bash
report_path="./report" \
repo="demo" \
doc="hello" \
access="private" \
bash packages/skill/skill/scripts/publish.sh
```

Set `MARADOCS_SERVER_URL` and `MARADOCS_API_KEY` only to override saved CLI credentials.

See [CLI usage](CLI.md#agent-skill) for the current script options.

## Agent Runtime Notes

### OpenClaw

Configure the MaraDocs server URL and API key in the OpenClaw runtime environment. Install the MaraDocs skill, then give the agent an instruction like:

> Remember, when I ask you to create a report or document, create an HTML report using my preferences and share it with me using the MaraDocs skill unless I specify otherwise.

The agent can then write static reports to a folder and publish that folder with the MaraDocs skill, CLI, or REST API.

### Hermes

Expose `MARADOCS_SERVER_URL` and `MARADOCS_API_KEY` to Hermes jobs or tools that generate reports. Use the CLI path when Hermes can run commands, or the REST API path when it should publish through HTTP.

### Claude Code

Install the CLI in the development environment or make the skill wrapper available. Ask Claude Code to build the report into a static folder and run `maradocs publish` after generation.

### OpenCode

Install the CLI in the OpenCode workspace or runtime image. Provide the environment variables and instruct OpenCode to publish the generated report folder with `maradocs publish`.

### Generic Agent Runners

Any agent runner can use MaraDocs if it can do one of these:

- Install and run the MaraDocs skill.
- Run shell commands with the MaraDocs CLI.
- Make authenticated HTTP requests to the REST API.

## Safety Guidance

- Prefer scoped API keys. Use `publish` for publishing agents and avoid `admin` unless required.
- Use `private` or `password` access for reports that may contain sensitive information.
- Treat generated reports as static artifacts. MaraDocs will serve uploaded JavaScript and assets to browsers, but it does not run uploaded code on the server.
- Return stable latest URLs for ongoing reports and immutable version URLs for audit trails or exact snapshots.
