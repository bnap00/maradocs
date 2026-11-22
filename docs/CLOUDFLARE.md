# MaraDocs on Cloudflare

MaraDocs ships a Cloudflare-native edition in [`apps/cloudflare`](../apps/cloudflare): one Worker that serves the API, the published reports and a new management dashboard, backed by **D1** (metadata) and **R2** (report files). There is no server to run, no container and no volume to back up by hand. Light use fits the **Workers Free** plan; [Limits and the Free plan](#limits-and-the-free-plan) explains what costs CPU.

The machine API is the same as the Docker/Node server's (with the few auth-endpoint differences listed [at the end](#differences-from-the-dockernode-server)), so the `maradocs` CLI and the agent skill work against a Cloudflare deployment unchanged.

- [Deploy](#deploy) — [one click](#option-a-deploy-to-cloudflare-button), [one command](#option-b-one-command-setup), or [manual Wrangler](#option-c-manual-wrangler-steps)
- [Connect the CLI and agent skill](#connect-the-cli-and-the-agent-skill)
- [Custom domains](#custom-domains)
- [Configuration](#configuration)
- [Limits and the Free plan](#limits-and-the-free-plan)
- [Updating](#updating)
- [Backups and export](#backups-and-export)
- [Local development](#local-development)
- [Security model](#security-model)
- [Troubleshooting](#troubleshooting)
- [Differences from the Docker/Node server](#differences-from-the-dockernode-server)

## What gets created

| Resource | Name (default) | Purpose |
|----------|----------------|---------|
| Worker | `maradocs` | API, report serving at `/r/…`, dashboard at `/dashboard/` |
| D1 database (binding `DB`) | `<worker>-db` (`maradocs-db`) | Accounts, repositories, documents, versions, API key hashes, sessions, settings, audit log, rate-limit counters |
| R2 bucket (binding `BUCKET`) | `<worker>-bucket` (`maradocs-bucket`) | Report files: one object per version (`versions/<versionId>.bin`) |
| Secrets | none required | `ADMIN_PASSWORD` is only an optional claim password for the first account (see [Accounts](#accounts)) |
| Cron trigger | `17 3 * * *` (daily) | Removes R2 objects that no version references (left behind by interrupted publishes). Cron triggers are free on every plan. |

`wrangler.jsonc` declares the `DB` and `BUCKET` bindings without names or IDs. On the first deploy, Wrangler (and the Deploy button) creates a database and a bucket named after the Worker. Later deploys reuse whatever is already bound to the Worker. Because the names come from the Worker name, a second deployment such as `npm run setup -- --name maradocs-staging` gets its own `maradocs-staging-db` and `maradocs-staging-bucket`. It never shares repositories, keys, passwords or sessions with your main deployment, and it never picks up an unrelated database that happens to be called `maradocs`.

Deployments made before this naming scheme (with a database called `maradocs` and a bucket called `maradocs-reports`) keep those resources: redeploys reuse the bindings already attached to the Worker. Only the D1 commands in this guide need the real name there (see [D1 commands](#configuration)).

The Worker applies its database schema itself on the first request, so there are no migrations to run. A cookie-signing secret is generated on first use and kept in D1 unless you set `COOKIE_SECRET`.

## Deploy

### Option A: Deploy to Cloudflare button

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/bnap00/maradocs/tree/main/apps/cloudflare)

1. Click the button and sign in to Cloudflare.
2. Connect GitHub or GitLab. Cloudflare copies `apps/cloudflare` into a new repository in your account and connects it to Workers Builds, so every push to that repository redeploys.
3. The D1 database and R2 bucket are provisioned for you; keep or rename them on the setup screen.
4. Click **Create and deploy**. No secrets are needed.
5. When the build finishes, open `https://maradocs.<your-subdomain>.workers.dev/dashboard/` **right away** and create your account. With the default `REGISTRATION=first`, the first account owns the deployment and sign-up then closes.

R2 must be enabled on your account once (Cloudflare dashboard → R2 → enable; the free tier needs no paid plan, but Cloudflare may ask for a payment method on file).

### Option B: one-command setup

Node 22+. Use the line that matches your checkout:

```bash
# Clone of this monorepo (at the repository root):
pnpm install
pnpm cf:deploy                 # runs apps/cloudflare's setup script

# Standalone copy of apps/cloudflare (e.g. the repository the Deploy button created):
npm ci                         # installs the versions pinned in package-lock.json
npm run setup
```

In the monorepo, don't run `npm install` inside `apps/cloudflare`. pnpm has already installed everything at the root, and npm would add a second `node_modules`.

The setup script (`scripts/setup.mjs`, Node built-ins only):

1. checks `wrangler whoami` and runs `wrangler login` in your browser if needed (or uses `CLOUDFLARE_API_TOKEN`). In a standalone copy without `node_modules` it offers to run `npm ci` first;
2. runs `wrangler deploy`, which builds the dashboard and provisions D1 + R2 on first deploy. Wrangler then writes the new `database_id` into `wrangler.jsonc`, and the script restores the file (see [below](#wranglerjsonc-stays-account-neutral));
3. reads the deployed URL from Wrangler's output (or asks for it), then waits for `/health`;
4. creates your MaraDocs account (on a fresh deployment the first account owns it) or signs in to an existing one, mints a publish-scoped API key, signs that session out again, and saves the key to `~/.maradocs/config.json` for the `maradocs` CLI and the agent skill. Email and password come from the flags, `MARADOCS_EMAIL` / `MARADOCS_PASSWORD`, or a prompt (the password is read without echo and never printed).

Re-running is safe. When the CLI is already connected to this deployment, setup doesn't mint another key; it never replaces a CLI connection to a different server without asking.

| Option | Effect |
|--------|--------|
| `--email <email>` | Account email (or `MARADOCS_EMAIL`). |
| `--password <value>` | Account password, at least 12 characters. `MARADOCS_PASSWORD` does the same and keeps it out of shell history. |
| `--claim-password <value>` | Only for creating the first account on a deployment whose `ADMIN_PASSWORD` secret is set (for example one upgraded from the single-admin version). Or `MARADOCS_CLAIM_PASSWORD`; `MARADOCS_ADMIN_PASSWORD` is accepted too. |
| `--name <worker>` | Deploy under another Worker name, with its own `<worker>-db` and `<worker>-bucket`. |
| `--url <origin>` | Use this URL (for example a custom domain) instead of the one Wrangler reports. |
| `-y`, `--yes` | Never prompt. The account step then needs `MARADOCS_EMAIL` and `MARADOCS_PASSWORD`. |
| `--no-cli` | Deploy only; create your account in the dashboard. |
| `--dry-run` | Print the commands that would run, without running anything. |

The old `--skip-password` flag is accepted and ignored; `--rotate-password` and `--reset-dashboard-password` were removed with the admin password.

Passing options: npm needs a `--` before them (`npm run setup -- --no-cli`). pnpm doesn't: `pnpm cf:deploy --no-cli`, or `pnpm run setup --no-cli` inside `apps/cloudflare`. Plain `pnpm setup` is a built-in pnpm command, not this script. A stray `--` is ignored.

For CI, set `CLOUDFLARE_API_TOKEN` (Workers Scripts, D1 and R2 edit permissions) and optionally `CLOUDFLARE_ACCOUNT_ID`, then run `npm run setup -- --yes --no-cli`.

### Option C: manual Wrangler steps

```bash
cd apps/cloudflare                         # after `pnpm install` at the root, or `npm ci` in a standalone copy
npx wrangler login
npx wrangler deploy                        # builds the dashboard, creates D1 + R2 on first run
git checkout wrangler.jsonc                # drop the database_id Wrangler wrote into it
curl https://maradocs.<your-subdomain>.workers.dev/health
```

`/health` returns `{"status":"ok","service":"maradocs","runtime":"cloudflare",…}`. Then open `/dashboard/` and create your account.

### wrangler.jsonc stays account-neutral

After an interactive deploy that provisioned resources, Wrangler writes their IDs (`database_id`, and the generated names) back into `wrangler.jsonc`. Keep that out of the file:

- Deploys don't need it, because the Worker keeps its bindings and the next deploy inherits them.
- With a `database_id` in the file, everyone else's deploy of that config fails ("binding DB of type d1 must have a valid id"), since the ID belongs to your account.
- Local development keys its database on the ID, so `npm run dev` would switch to a new, empty local database.

`npm run setup` restores the file automatically. After a manual `npx wrangler deploy`, run `git checkout wrangler.jsonc`. CI fails if a `database_id` is committed.

## Connect the CLI and the agent skill

```bash
npm install -g @maradocs/cli
maradocs --version             # or -V
maradocs auth bootstrap --server https://maradocs.<your-subdomain>.workers.dev --email you@example.com
# asks for your account password, creates a publish-scoped key, saves it
# (add --register if you haven't created the account in the dashboard yet)

mkdir -p report && printf '<h1>Hello from MaraDocs</h1>\n' > report/index.html
maradocs publish ./report --repo demo --doc hello
```

You can also create a key in the dashboard under **API keys**. It is shown once. To sign the CLI in with it, run `maradocs auth setup`: it prompts for the server URL and the key and reads the key without echo, so the key stays out of your shell history and process list. The dashboard's **Connect** page shows every command below with your real URL filled in.

Install the agent skill. It reuses the CLI's saved config:

```bash
npx skills add https://github.com/bnap00/maradocs --skill maradocs-publish
```

For CI or isolated agent runtimes, use environment variables from your secret store instead of a saved config: `MARADOCS_SERVER_URL=https://…` and `MARADOCS_API_KEY=mdo_…`. See [Agent integration](AGENTS.md) and [CLI usage](CLI.md).

Without the CLI, the REST API needs the repository to exist first, and `POST` only creates documents:

```bash
curl -X POST "$MARADOCS_SERVER_URL/api/v1/repos" -H "Authorization: Bearer $MARADOCS_API_KEY" \
  -H "content-type: application/json" -d '{"slug":"demo"}'
curl -X POST "$MARADOCS_SERVER_URL/api/v1/repos/demo/docs" -H "Authorization: Bearer $MARADOCS_API_KEY" \
  -F doc=hello -F file=@report.zip                    # first version
curl -X PUT "$MARADOCS_SERVER_URL/api/v1/repos/demo/docs/hello" -H "Authorization: Bearer $MARADOCS_API_KEY" \
  -F file=@report.zip                                 # later versions
```

## Custom domains

The zone must be on Cloudflare. Either add the domain in the dashboard (**Workers & Pages → maradocs → Settings → Domains & Routes → Add → Custom domain**), or declare it in `wrangler.jsonc` and redeploy:

```jsonc
"routes": [{ "pattern": "docs.example.com", "custom_domain": true }],
```

Cloudflare creates the DNS record and certificate. Then, optionally:

- set the `PUBLIC_BASE_URL` var (for example `https://docs.example.com`) so API responses always link to the custom domain. Without it, links use the origin of the incoming request;
- set `"workers_dev": false` to turn off the `*.workers.dev` URL;
- reconnect the CLI to the new origin: `maradocs auth setup`, or run `bootstrap` again.

Reports are served with a CSP `sandbox` (opaque origin), so report scripts can't read dashboard cookies even on the same host. A separate reports hostname is optional.

## Configuration

**Vars** go in `wrangler.jsonc` → `vars`. That file is the source of truth: each deploy replaces the Worker's vars with the ones in the file, including every push to a Deploy-button repository and every `npm run setup`. A var you add or edit in the Cloudflare dashboard therefore disappears on the next deploy. **Secrets** are kept across deploys. Set them with `npx wrangler secret put <NAME>` or in the Cloudflare dashboard under **Settings → Variables and Secrets**.

| Name | Kind | Default | Description |
|------|------|---------|-------------|
| `REGISTRATION` | var | `first` | Who can create accounts: `first` (only the first account), `open` (anyone) or `closed`. See [Accounts](#accounts). |
| `ADMIN_PASSWORD` | secret, optional | — | Claim password: while no account exists, creating the first one requires it. Ignored afterwards and never used to sign in. Only useful for deployments upgraded from the single-admin version. |
| `COOKIE_SECRET` | secret, optional | generated, stored in D1 | HMAC key for password-gate unlock cookies and report capability tokens. Must be at least 32 characters (`openssl rand -hex 32`). A shorter value is ignored (the Worker logs a warning) and the generated secret is used instead. Changing it locks out everyone who already unlocked a report. |
| `PUBLIC_BASE_URL` | var, optional | request origin | External origin used in URLs returned by the API. |
| `DEFAULT_REPO_ACCESS` | var | `private` | Access for repositories created without an explicit mode (`public`, `password`, `private`). Each account's dashboard setting overrides it for that account. |
| `MAX_UPLOAD_MB` | var | `25` | Maximum upload size, and maximum total uncompressed size of a bundle. Values above 25 are capped at 25 ([why](#limits-and-the-free-plan)). |
| `PBKDF2_ITERATIONS` | var, optional | `10000` | PBKDF2-SHA256 iterations for password hashes. Values outside 10,000–100,000 are clamped to that range (the Worker logs a warning; Workers caps PBKDF2 at 100,000). Existing hashes move to the configured count after their next successful sign-in or unlock, keeping their salt, so sessions and unlocked visitors stay signed in. |
| `PDF_INLINE` | var, optional | off | By default PDFs in reports are served as downloads (`Content-Disposition: attachment`), because Chromium's PDF viewer shows a blank page inside the report sandbox. `true` serves them inline without the sandbox; the browser's PDF viewer runs in its own origin, so PDF scripts never run as this site. |
| `REPORTS_HOST` | var, optional | — | Serve reports from a second hostname (for example `reports.example.com`) so a report can never imitate the dashboard on the same address. Requires `PUBLIC_BASE_URL` (the dashboard origin) and a second custom domain or route pointing at the same Worker. The reports host serves only `/r/…` and `/health`; `/r/…` on the dashboard host redirects there, and signed-in owners are handed over with a short-lived, session-bound token. Dashboard previews of private reports then need third-party cookies. |

**D1 commands** in this guide use the binding name `DB`. Wrangler resolves it from `wrangler.jsonc` to the Worker's database (`<worker>-db`), so run them inside `apps/cloudflare`. If you renamed the database on the Deploy screen, deployed with `--name` (use `<name>-db`), or deployed before databases were named after the Worker (then it is `maradocs`), use the name that `npx wrangler d1 list` shows. Likewise, substitute your bucket name (`npx wrangler r2 bucket list`) in the R2 commands.

### Accounts

MaraDocs uses email + password accounts. Each account has its own repositories, documents, API keys, machines, activity log and default-access setting, invisible to other accounts. Repository slugs are unique across the deployment (they are part of report URLs), so a slug another account uses answers `409`.

- **Upgrading from the single-admin version.** Everyone signs in again. Create the first account with your old admin password as the claim password (the dashboard's sign-up form asks for it, or `maradocs auth bootstrap --register --claim-password …`). That account adopts every existing repository, document, API key and audit entry, and old API keys work again. Then remove the secret: `npx wrangler secret delete ADMIN_PASSWORD`.
- **Forgotten password.** There is no reset email. See [Troubleshooting](#troubleshooting).

See [AUTH.md](AUTH.md) for the full model.

## Limits and the Free plan

Every request uses a small, constant number of D1 queries and R2 operations. Serving a report file is one indexed D1 lookup plus one ranged R2 read.

| Limit | Value |
|-------|-------|
| Upload size (`MAX_UPLOAD_MB`) | 25 MB (also the maximum), applied to the upload and to the total uncompressed size |
| Files per bundle | 2,000 |
| Path length / depth | 240 characters / 20 segments |
| Report passwords | 4–256 characters |
| Account password | at least 12 characters |
| Sessions | 30 days, extended with use |
| Report capability tokens | 4 hours |

Cloudflare platform limits that matter (Workers Free, at the time of writing — check Cloudflare's pricing pages):

- **10 ms CPU per request**, with some tolerance for occasional bursts. Browsing reports and listing things stay far below it. These operations don't:
  - **Password hashing (PBKDF2).** Report unlocks, setting a report or repository password (including `maradocs publish -p`), dashboard password changes, and sign-ins after a dashboard password change each hash once. That costs about 4 ms of CPU at the default 10,000 iterations, and about 40 ms at 100,000. On the Free plan keep `PBKDF2_ITERATIONS` at the default, or at most around 20,000–30,000.
  - **Publishing.** Validating, decompressing, CRC-checking, checksumming and packing a bundle costs CPU in proportion to its size. Decompression and CRCs run in the runtime's native code, but budget up to about 10 ms per MB of content, so anything beyond a small report can run over 10 ms.
  - **Downloads** (`maradocs doc download`, the skill and the dashboard's download button) are cheap: the zip is streamed from the stored blob without recompressing, using CRCs recorded at publish time.

  An isolated burst is usually tolerated. Sustained or large overruns fail with error **1102**. If you publish often or publish larger bundles, use the [Workers Paid plan](https://developers.cloudflare.com/workers/platform/pricing/) (30 s of CPU per request).
- **128 MB memory per request, on every plan.** While a publish is processed, the request body and the unpacked files (one buffer) are in memory at once, which comes to about twice the upload plus its uncompressed contents. That is why `MAX_UPLOAD_MB` stops at 25, and why publish requests must send `Content-Length` (otherwise `411`); oversized ones are refused (`413`) before the body is read. Image-heavy (incompressible) reports are safest at around 20 MB.
- **100 MB request body**, which is not a constraint at 25 MB.
- **100,000 requests/day** on Workers Free. D1 Free: 5 GB storage, 5 million rows read and 100,000 rows written per day. R2 free tier: 10 GB-month storage, 1 million Class A and 10 million Class B operations per month, no egress fees.

## Updating

**From a clone of this monorepo:**

```bash
git pull
pnpm install
pnpm cf:deploy --no-cli             # or, in apps/cloudflare: npx wrangler deploy && git checkout wrangler.jsonc
```

Schema changes are applied by the Worker itself on the next request. Data in D1 and R2 is kept.

**From a repository created by the Deploy button (or another standalone copy):** that repository holds a copy of `apps/cloudflare`, and Workers Builds redeploys on every push. To pull in a newer MaraDocs, mirror the new files over yours and push. `--delete` removes files that were deleted upstream. Keep your own `wrangler.jsonc`, because it may hold routes, vars and renamed resources:

```bash
tmp=$(mktemp -d)
git clone --depth 1 https://github.com/bnap00/maradocs.git "$tmp"
rsync -a --delete \
  --exclude .git --exclude node_modules --exclude .wrangler --exclude public \
  --exclude .dev.vars --exclude wrangler.jsonc \
  "$tmp/apps/cloudflare/" ./
diff "$tmp/apps/cloudflare/wrangler.jsonc" wrangler.jsonc   # merge any new settings by hand
git add -A && git diff --cached --stat                       # review: --delete also removes files you added yourself
git commit -m "Update MaraDocs" && git push
```

Without Workers Builds, deploy with `npm ci && npm run setup -- --no-cli`.

## Backups and export

The D1 database and the R2 bucket belong together. D1 holds the manifests that map each file to a byte range inside its version's R2 object, so back up **both**.

**D1** (all metadata):

```bash
npx wrangler d1 export DB --remote --output maradocs-$(date +%F).sql
```

**R2** (report bytes). Single objects work with Wrangler (`maradocs-bucket` is the default name; see `npx wrangler r2 bucket list`):

```bash
npx wrangler r2 object get maradocs-bucket/versions/<versionId>.bin --remote --file <versionId>.bin
```

For the whole bucket, create an R2 API token (R2 → Manage API tokens) and use any S3-compatible tool, for example [rclone](https://rclone.org/s3/#cloudflare-r2):

```bash
rclone sync r2:maradocs-bucket ./maradocs-r2-backup
```

**Restore** into an empty database and bucket: `npx wrangler d1 execute DB --remote --file maradocs-YYYY-MM-DD.sql`, then sync the objects back with `rclone sync ./maradocs-r2-backup r2:maradocs-bucket`.

**Portable export of individual reports:** `maradocs doc download <repo>/<doc> --zip report.zip` (add `-v N` for a pinned version) returns a normal zip with the original files. The dashboard's version timeline has the same download button. This also works for moving reports between MaraDocs servers.

D1 also keeps point-in-time history ([Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/): 7 days on Workers Free, 30 days on Paid): `npx wrangler d1 time-travel restore DB --timestamp <ISO time>`.

## Local development

```bash
cd apps/cloudflare
npm run dev                       # or `pnpm cf:dev` at the repo root; serves http://localhost:8787
```

No secrets are needed locally: open the dashboard and create the first account. Optional settings go in `.dev.vars` (gitignored; see `.dev.vars.example`). Arguments after `--` go to `wrangler dev` (`npm run dev -- --port 8790`).

`wrangler dev` uses local D1 and R2 emulation stored in `.wrangler/state/` (delete that folder to start fresh). Session cookies drop the `Secure` flag only on plain `http://localhost`. Keep local secrets in `.dev.vars`: it, `.dev.vars.*` and `.env*` are gitignored.

Other scripts:

| Command | What it does |
|---------|--------------|
| `npm run build` | Build the dashboard SPA into `public/dashboard` |
| `npm run typecheck` | Type-check the Worker and the dashboard |
| `npm test` | Integration tests inside workerd with real local D1/R2 (`@cloudflare/vitest-plugin`) |
| `npm run test:scripts` | Unit tests for the setup script (`node:test`) |
| `npm run e2e` | Start `wrangler dev` and drive the real `maradocs` CLI against it (needs the monorepo) |
| `npm run sync` / `sync:check` | Refresh / verify the vendored copies of `packages/shared` and the OpenAPI document in `src/vendor/` |

`src/vendor/` is generated from `packages/shared` so that `apps/cloudflare` stays self-contained, because the Deploy button copies only this folder. Never edit it by hand: change the source and run `npm run sync`. CI fails if it is stale.

`apps/cloudflare/package-lock.json` pins the versions that standalone copies install with `npm ci`, and pnpm ignores it. When you change dependencies, regenerate it in a standalone copy of the folder with `npm install --package-lock-only --ignore-scripts`. CI's standalone job exports the folder the way the Deploy button does (tracked files only), installs it with `npm ci`, checks that the lockfile is current, and runs the typecheck, tests, setup script and a dry-run deploy there.

## Security model

- **Reports are sandboxed.** Every file under `/r/` is served with `Content-Security-Policy: sandbox allow-downloads allow-forms allow-popups allow-scripts`. There is no `allow-same-origin`, so report JavaScript runs in an opaque origin and can't read the dashboard's cookies or storage, or call the API with your credentials. Reports also get `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer`. Uploaded content is never executed server-side.
- **Capability URLs for protected reports.** Because a report runs in an opaque origin, the browser treats every asset request it makes as cross-site. Where third-party cookies are blocked (Safari, Brave, private windows), those requests carry no cookies at all. So when a signed-in or unlocked browser opens a password-protected or private report, the Worker redirects it to the same URL with a capability segment, `/r/<repo>/<doc>/[v/<n>/]~<token>/…`. Relative asset URLs resolve under that segment, and the token authorises those asset requests.
  - The token never authorises opening the page itself. A copied address-bar URL shows the sign-in or password page to anyone without the cookie.
  - It expires after 4 hours and is bound to the report's password, or to the owner's session for signed-in viewers. Changing the password, changing access or signing out revokes it.
  - Outside a browser it acts as a bearer secret until it expires, so treat such URLs like the report itself.
  - Assets referenced by absolute path (`/r/<repo>/<doc>/style.css`) don't get the segment and still rely on cookies. The unlock cookie, and a 4-hour view cookie set for signed-in viewers, are `SameSite=None; Secure` and scoped to the report's path, so this works wherever third-party cookies are allowed. Use relative paths in reports.
  - An `<iframe>` nested inside a protected report is a navigation, which never accepts a token, so it also needs cookies.
  - A token minted from a session dies at once when that session signs out or is revoked (password change, **Sign out other sessions**).
  - Token URLs can appear in analytics run by the report itself and in Workers logs. Responses send `Referrer-Policy: no-referrer`, so they don't leak through `Referer`.
- **Cross-origin reads.** Report files are sent with `Access-Control-Allow-Origin: *` (never with credentials), and `OPTIONS` preflights are answered, so module scripts, web fonts and `fetch()` inside a sandboxed report work. Browsers refuse `*` for credentialed requests, so a cookie-authorised response can't be read cross-site; a request without credentials only reaches public files or ones its token already grants.
- **Caching and ranges.** Public files are cacheable for 60 seconds (latest and pinned versions alike), so tightening access takes effect within a minute. Protected files are `private, no-store`. Single `Range` requests are honoured (video playback in Safari), and `If-None-Match` revalidation uses weak comparison.
- **The dashboard is locked down.** It runs under a strict self-only CSP (`default-src 'self'`, no third-party scripts, fonts or CDNs), with `frame-ancestors 'none'` / `X-Frame-Options: DENY`. API responses are `Cache-Control: no-store`. The live preview frames the report with the same sandbox (no `allow-same-origin`). Its navigation is redirected to a capability URL like any other, so private and password-protected previews render completely.
- **Cookies.** The session is an `HttpOnly; Secure; SameSite=Lax` cookie (`maradocs_session`, 30 days, extended with use); browser sign-ins never receive the token in the response body (the CLI, which sends no `Origin`, still does). The SPA never stores tokens in `localStorage`. Only a SHA-256 of each session token is stored. Changing your password revokes your other sessions, and **Settings → Sign out other sessions** does that on demand. If your password may have leaked: change it and revoke API keys you no longer trust under **API keys**. When a session expires while the dashboard is open, it asks for your password in place and retries, so open forms and uploads aren't lost.
- **CSRF.** Every state-changing request authenticated by cookie must come from the same origin (`Origin` header, or `Sec-Fetch-Site: same-origin`) and carry the `x-maradocs: 1` header, otherwise it gets `403`. Requests authenticated with a Bearer token or API key are exempt, because browsers don't attach those automatically.
- **API keys.** Keys are `mdo_` plus 32 random bytes. Only their SHA-256 and a 12-character display prefix are stored. Scopes are `read`, `publish` (the default) and `admin`. `admin` passes every check. Viewing private or password-protected reports and downloading bundles require `read` or `publish`, so the publish keys that `maradocs auth bootstrap` mints can read every report of their account. Keys act only for the account that created them, and only a signed-in session can create or revoke keys.
- **Report passwords.** These are hashed with PBKDF2-SHA256 (random salt, `PBKDF2_ITERATIONS`, default 10,000) via Web Crypto; bcrypt would exceed the Workers CPU budget. An unlocked report sets a path-scoped, HMAC-signed cookie bound to the current password hash, so changing the password locks out existing visitors.
- **Rate limiting.** Counters live in D1 and are kept per client network: an IPv4 address, or an IPv6 /64, so rotating addresses inside one allocation doesn't help. Sign-in allows 5 attempts per 15 minutes and sign-up 5 per hour; password checks for password changes and account deletion allow 10 per hour per account; report unlocks allow 10 per 15 minutes for each password being guessed, so every document sharing a repository password shares one budget. On top of that, 100 failed logins per 15 minutes from anywhere pause all logins, and 100 failed guesses of one report password pause unlocks for it. A rate-limited response carries `Retry-After`, the dashboard counts down from it, and `auth.rate_limited` appears in the activity log. To lift a lockout early, run `npx wrangler d1 execute DB --remote --command "DELETE FROM rate_limits"`.
- **Access modes.** `public` serves anyone, `password` shows an unlock page, `private` requires the owning account's session or one of its API keys with `read`, `publish` or `admin`; other signed-in accounts get what an anonymous visitor gets. A document's own mode overrides its repository's default, and a document's own password overrides the repository password. The owner's session (or such an API key) can also open password-protected reports without unlocking them. Password access with no password stored anywhere is treated as private, and removing a repository password that documents still depend on is refused. Visitors who haven't passed the gate get the same answer for every path of a protected document, so they can't tell which versions or files exist. A repository's browsable index is only served when the repository is public or contains at least one public document. After sign-in, the dashboard only redirects to same-origin `/r/…` or `/dashboard/…` paths.
- **Input validation.** Slugs are validated everywhere they enter. Uploaded zips are checked before anything is inflated: absolute paths, drive letters, `..` that escapes the bundle (an interior `a/../b` is normalised, as on the Node server), control characters, duplicate names, encrypted or overlapping entries, over-long paths and bundles over the size or file limits are rejected. While inflating, every entry must produce exactly its declared size and CRC-32.
- **Separate reports host (optional).** Reports share the dashboard's hostname by default. Anyone with a publish key could therefore host a page that looks like the dashboard sign-in. The dashboard never asks for your account password anywhere under `/r/…`; set `REPORTS_HOST` to remove the risk entirely.

See [Security model](SECURITY.md) for the trust boundaries both editions share.

## Troubleshooting

| Symptom | Cause and fix |
|---------|---------------|
| **Error 1102** "Worker exceeded resource limits" | A request ran out of CPU time (10 ms on Free) or memory (128 MB). Usually it's a large publish. With raised `PBKDF2_ITERATIONS` it can also be report unlocks, and account sign-ins. Publish smaller bundles (compress images, drop unused assets), set `PBKDF2_ITERATIONS` back to the default (each stored hash moves to it on its next successful sign-in or unlock), or switch to Workers Paid. |
| `413 payload_too_large` | The upload or its uncompressed contents exceed `MAX_UPLOAD_MB` (default and maximum 25). Split the report or shrink its assets. |
| `411 length_required` on publish | The client sent the upload without `Content-Length` (chunked). The CLI, the skill and `curl -F` always send it; for custom clients, buffer the multipart body first. |
| `400 bad_request` on publish | The zip was rejected: unsafe or duplicate paths, more than 2,000 files, or an empty bundle. The message names the problem. |
| Sign-up says registration is closed | With `REGISTRATION=first`, only the first account can be created. To add people, set `REGISTRATION` to `open` in `wrangler.jsonc`, redeploy, let them sign up, then set it back. |
| Sign-up asks for a claim password | The `ADMIN_PASSWORD` secret is set and no account exists yet (an upgraded deployment). Enter that secret, or delete it (`npx wrangler secret delete ADMIN_PASSWORD`) if the deployment has nothing worth protecting. |
| Forgot your password | There is no reset email. Delete your sessions and the account row in D1 (`npx wrangler d1 execute DB --remote --command "DELETE FROM users WHERE email = 'you@example.com'"`), then sign up again (temporarily set `REGISTRATION=open` if needed). Repositories of the deleted account stay ownerless and inaccessible until removed. |
| Report renders without styles or images | The report references its assets by absolute path (`/r/<repo>/<doc>/…`), or loads them in a nested `<iframe>`, which bypasses the capability URL. Browsers that block third-party cookies then load them without credentials. Use relative paths. Public reports are unaffected. |
| A PDF downloads instead of opening | That's the default: inside the report sandbox Chromium's viewer shows a blank page. Set `PDF_INLINE` to `"true"` to serve PDFs inline. |
| Signed out right after updating | The update to user accounts signs everyone out once. Sign in again (or create the first account with the claim password if upgrading). |
| `403 forbidden` on dashboard actions | The CSRF check failed. A proxy or browser extension is stripping the `Origin` or `x-maradocs` header, or the dashboard is loaded from a different origin than the API. Open the dashboard on the Worker's own URL. |
| `401` / "API key was rejected" in the CLI | The key is invalid or was revoked. Mint a new one with `maradocs auth bootstrap --server <url> --email <you>`, or create one in the dashboard and run `maradocs auth setup`. |
| `403` "API key missing required scope: …" | The key works but lacks the scope (for example a `read` key publishing). Create one with the scopes it needs: `maradocs auth bootstrap --server <url> --scopes publish` (or `read,publish`), or in the dashboard. |
| `wrangler deploy` fails mentioning R2 (code 10042) | Enable R2 once in the Cloudflare dashboard, then deploy again. |
| `wrangler deploy` asks which account to use, or fails in CI | Set `CLOUDFLARE_ACCOUNT_ID`. In CI, also set `CLOUDFLARE_API_TOKEN`. |
| `binding DB of type d1 must have a valid id` | A `database_id` from another account was committed to `wrangler.jsonc`. Remove the `database_id` line, then deploy again. |
| `npm run dev` shows none of your local data after a deploy | Wrangler wrote a `database_id` into `wrangler.jsonc`, and local dev keys its database on it. `git checkout wrangler.jsonc` brings the old local database back. |
| A var you set in the Cloudflare dashboard is gone | Deploys replace vars with those in `wrangler.jsonc`. Set it there and push or redeploy. |
| `/health` unreachable right after the first deploy | A new `workers.dev` subdomain can take a few minutes to resolve. Retry shortly, or check **Workers & Pages** in the dashboard. |
| Anything else | Stream live logs with `npx wrangler tail`. Observability is enabled in `wrangler.jsonc`, so logs also appear in the Cloudflare dashboard. Errors never include stack traces in responses. |

## Differences from the Docker/Node server

| | Docker / Node (`apps/server`) | Cloudflare (`apps/cloudflare`) |
|---|---|---|
| Runtime | Fastify on Node 22, Docker or `npx @maradocs/server` | One Cloudflare Worker |
| Metadata | SQLite file in `DATA_DIR` | D1 |
| Report files | Extracted directory tree on disk | R2, one object per version, files served by byte range |
| Required settings | `PUBLIC_BASE_URL` (prod) | None |
| Password hashing | bcrypt | PBKDF2-SHA256 (Web Crypto) |
| Accounts | Email + password, `REGISTRATION`, per-account isolation | Same |
| Default `MAX_UPLOAD_MB` | 50 | 25, also the maximum (Workers memory/CPU limits) |
| Login protection | Rate limiting (5 per 15 min) | Rate limiting (5 per 15 min per IPv4 address or IPv6 /64 plus a global ceiling, D1-backed, with `Retry-After`), Origin + `x-maradocs` CSRF checks |
| Protected report assets | Cookies | Cookies plus [capability URLs](#security-model), so they work with third-party cookies blocked |
| Dashboard | `apps/dashboard` | New dashboard: overview, connect guide, activity filters, settings, folder upload |
| Machine API, CLI, skill | — | Same endpoints, JSON shapes and error codes; the CLI and skill work unchanged. Auth endpoints match too; `POST /api/v1/auth/login` and `/register` additionally reject cross-origin browser requests with `403`. Browser sign-ins (requests with `Origin`) get only the cookie, not the token. Publishing requires `Content-Length` (`411` without it). Bundle downloads add `x-maradocs-entrypoint-encoded` (percent-encoded) and omit the raw `x-maradocs-entrypoint` header for non-ASCII names. |
| `/health` | `status`, `service` | Adds `runtime: "cloudflare"` and `configured` (always `true`) |
| TLS, scaling, backups | Your reverse proxy and volume | Handled by Cloudflare; back up D1 + R2 as described above |
| Process settings (`PORT`, `HOST`, `DATA_DIR`, `LOG_LEVEL`, `BCRYPT_ROUNDS`) | Supported | Not applicable |

There is no automatic data migration between the two editions. To move reports, download each document from the old server with `maradocs doc download` and publish it to the new one with `maradocs publish`. The version history starts fresh.
