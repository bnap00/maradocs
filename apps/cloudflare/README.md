# MaraDocs on Cloudflare

Publish static HTML reports from agents, CLIs and CI, and get back durable, versioned URLs with access control. Runs entirely on Cloudflare: one **Worker**, a **D1** database for metadata, an **R2** bucket for report files, and a built-in management dashboard. Light use fits the Workers **Free** plan; see [Limits and the Free plan](#limits-and-the-free-plan) for what costs CPU.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/bnap00/maradocs/tree/main/apps/cloudflare)

```bash
maradocs publish ./report --repo demo --doc hello
# https://maradocs.<you>.workers.dev/r/demo/hello/
```

The full guide (custom domains, security model, troubleshooting, differences from the Docker server) is in [docs/CLOUDFLARE.md](https://github.com/bnap00/maradocs/blob/main/docs/CLOUDFLARE.md).

## What gets created

| Resource | Default name | Purpose |
|----------|--------------|---------|
| Worker | `maradocs` | API, reports at `/r/<repo>/<doc>/`, dashboard at `/dashboard/` |
| D1 database (binding `DB`) | `<worker>-db`, e.g. `maradocs-db` | Accounts, repositories, documents, versions, key hashes, sessions, settings, audit log |
| R2 bucket (binding `BUCKET`) | `<worker>-bucket`, e.g. `maradocs-bucket` | Report files, one object per version |
| Secrets | `ADMIN_PASSWORD` (asked by the Deploy button) | Claim password for the first account (see [Accounts](#accounts)); optional with `npm run setup`, which creates your account right away |

`wrangler.jsonc` declares only the bindings, so Wrangler creates the database and bucket on the first deploy and names them after the Worker. A second deployment under another Worker name (`npm run setup -- --name maradocs-staging`) therefore gets its own database and bucket instead of sharing yours. Later deploys reuse the resources already bound to the Worker. The Deploy button shows the names on its setup screen, where you can change them.

The Worker creates its own schema on the first request. There are no migrations, and no cookie secret to generate (one is created and stored in D1 unless you set `COOKIE_SECRET`).

## Deploy

**One click.** Use the button above. Cloudflare copies this folder into a new GitHub/GitLab repository, and creates the D1 database and R2 bucket. It asks for one secret, `ADMIN_PASSWORD`: a claim password (generate one with `openssl rand -base64 24` and keep it). Then open `https://<worker>.<you>.workers.dev/dashboard/` and create your account, entering the claim password on the sign-up form; the first account owns the deployment (see [Accounts](#accounts)), so nobody who finds the URL first can take it. Every push to that repository redeploys. R2 must be enabled on your account once (Cloudflare dashboard → R2).

**One command.** With Node 22+, pick the line for your checkout:

```bash
# Standalone copy of this folder (e.g. the repository the Deploy button created):
npm ci && npm run setup          # npm ci installs the versions in package-lock.json

# Clone of the MaraDocs monorepo (run at the repository root):
pnpm install && pnpm cf:deploy   # same script; with pnpm, pass flags without `--`
```

In the monorepo, don't run `npm install` inside `apps/cloudflare`: pnpm already installed everything at the root, and npm would create a second `node_modules`.

The setup script logs you in to Cloudflare if needed, deploys, waits for `/health`, then creates your MaraDocs account (the first account owns the deployment) or signs in to an existing one, mints a publish-scoped API key and saves it to `~/.maradocs/config.json` for the `maradocs` CLI and the agent skill. Passwords are read without echo and never printed. Re-running is safe. If dependencies are missing in a standalone copy, it offers to install them.

Useful flags: `--email` (or `MARADOCS_EMAIL`), `--password` (or `MARADOCS_PASSWORD`), `--claim-password` (or `MARADOCS_CLAIM_PASSWORD`; only for a claim-protected deployment), `--name`, `--url`, `--yes`, `--no-cli`, `--dry-run`. Run `npm run setup -- --help` (or `pnpm cf:deploy --help`) for details. Non-interactive: `MARADOCS_EMAIL=you@example.com MARADOCS_PASSWORD=… npm run setup -- --yes`.

An interactive first deploy makes Wrangler write the new `database_id` into `wrangler.jsonc`. The setup script puts the file back as it was, because deploys don't need the ID: the Worker keeps its binding. If you deploy by hand with `npx wrangler deploy`, discard that change (`git checkout wrangler.jsonc`) rather than committing it. Otherwise the config is tied to your account, and `npm run dev` switches to a new, empty local database.

**By hand** (standalone copy):

```bash
npm ci
npx wrangler login
npx wrangler deploy
git checkout wrangler.jsonc    # drop the database_id Wrangler wrote, if any
# then open <url>/dashboard/ and create your account
```

## Accounts

MaraDocs uses email + password accounts. Each account has its own repositories, documents, API keys, machines, activity log and default access setting, invisible to other accounts. Repository slugs are unique across the deployment (they are part of report URLs), so a slug another account uses answers `409 Repository slug '<slug>' is already taken`.

- **Who can sign up** is set by the `REGISTRATION` var: `first` (default) allows only the first account, the owner; `open` lets anyone create an account; `closed` allows none (existing accounts only).
- **Claim password.** If the `ADMIN_PASSWORD` secret is set (or a dashboard password was set before accounts existed) and no account exists yet, creating the first account requires it as the *claim password*. This keeps a stranger from claiming a fresh deployment before you do, or one that already holds data. The Deploy button asks for it; `npm run setup` doesn't need it because it creates your account immediately. Once any account exists it is ignored (the Worker logs a reminder to remove it); it is never used to sign in.
- **Upgrading from the single-admin version.** Everyone signs in again. The first account created adopts every existing repository, document, API key and audit entry; create it with your old admin password as the claim password (`maradocs auth bootstrap --register --claim-password …` or the dashboard's sign-up form). Old API keys work again once adopted.
- **Sessions** last 30 days and extend with use (`maradocs_session` cookie in the browser, `Authorization: Bearer` for the CLI). Changing your password signs out your other sessions; **Settings → Sign out other sessions** does that on demand. **Settings → Delete account** removes the account with all its data and stored files.
- There is no email verification or password reset. A forgotten password: sign in with another account, or delete the account row in D1 (`npx wrangler d1 execute DB --remote --command "DELETE FROM users WHERE email = 'you@example.com'"`; its repositories then belong to nobody until you remove them).

## Connect the CLI and your agent

```bash
npm install -g @maradocs/cli
maradocs --version                                                     # check the install
maradocs auth bootstrap --server https://maradocs.<you>.workers.dev --email you@example.com   # asks for your password, saves a publish key
npx skills add https://github.com/bnap00/maradocs --skill maradocs-publish
```

Add `--register` to create the account first. You can also create API keys in the dashboard under **API keys**; keys act for the account that created them. Sign the CLI in with one using `maradocs auth setup`, which prompts for the server URL and the key and reads the key without echoing it, so it stays out of your shell history. The **Connect** page in the dashboard lists these commands with your URL filled in. For CI, set `MARADOCS_SERVER_URL` and `MARADOCS_API_KEY` from your CI system's secret store.

## Custom domain

Add it under **Workers & Pages → maradocs → Settings → Domains & Routes**, or in `wrangler.jsonc`:

```jsonc
"routes": [{ "pattern": "docs.example.com", "custom_domain": true }],
"vars": { "PUBLIC_BASE_URL": "https://docs.example.com" /* …keep the other vars */ }
```

Set `"workers_dev": false` to turn off the `workers.dev` URL. Then point the CLI at the new origin.

## Configuration

Vars live in `wrangler.jsonc` → `vars`, which is the source of truth: every deploy (including each push to a Deploy-button repository) replaces the Worker's vars with what the file says, so a var edited in the Cloudflare dashboard is lost on the next deploy. Secrets are never touched by deploys. Set them with `npx wrangler secret put <NAME>` or in the Cloudflare dashboard.

| Name | Default | Notes |
|------|---------|-------|
| `REGISTRATION` | `first` | `first` (only the first account), `open` (anyone can sign up) or `closed`. See [Accounts](#accounts). |
| `ADMIN_PASSWORD` (secret) | — | Claim password (asked by the Deploy button): required to create the first account while none exists, ignored afterwards. Never used to sign in. |
| `COOKIE_SECRET` (secret) | generated | Optional. At least 32 characters (`openssl rand -hex 32`); shorter values are ignored (the Worker logs a warning) and the generated secret is used. Changing it locks out everyone who unlocked a password-protected report. |
| `PUBLIC_BASE_URL` | request origin | Optional external origin for API links. |
| `DEFAULT_REPO_ACCESS` | `private` | `public`, `password` or `private`; each account's dashboard setting overrides it for that account. |
| `MAX_UPLOAD_MB` | `25` | Upload limit, also applied to the total uncompressed size. 25 is also the maximum (larger values are capped) because a publish holds several copies of the bundle in the 128 MB of Worker memory. Stay around 20 for image-heavy reports. |
| `PBKDF2_ITERATIONS` | `10000` | Cost of password hashes (report passwords, account passwords). Values outside 10,000–100,000 are clamped. Each hash or unlock costs roughly 4 ms of CPU at 10,000 and 40 ms at 100,000. Stored hashes move to the configured cost on their next successful sign-in or unlock. |
| `PDF_INLINE` | off | `true` serves PDFs in reports inline, without the report sandbox. By default they download, because Chromium's viewer shows a blank page inside the sandbox. |
| `REPORTS_HOST` | — | Optional second hostname for `/r/…` (needs `PUBLIC_BASE_URL` and a second route to this Worker), so a report can never pose as the dashboard on the same address. |

D1 and R2 are created on the first deploy and named after the Worker (`<worker>-db`, `<worker>-bucket`); a daily cron trigger removes R2 objects that no version references. `wrangler d1 execute DB` (and `d1 export DB`) resolve the `DB` binding from `wrangler.jsonc`, so run them in this folder. If you renamed the database when deploying with the button, or deployed before resources were named after the Worker (database `maradocs`), use the name that `npx wrangler d1 list` shows instead of `DB`.

## Limits and the Free plan

- Bundles: up to `MAX_UPLOAD_MB` (25 MB by default) and 2,000 files. Paths can be up to 240 characters and 20 segments deep.
- Workers Free gives **10 ms CPU** and **128 MB memory** per request, with some tolerance for occasional bursts. Viewing reports is cheap: one indexed D1 lookup and one ranged R2 read per file. CPU goes into:
  - **Password hashing.** Each report unlock, report or repository password change, account sign-up, sign-in and password change runs PBKDF2. That is about 4 ms at the default 10,000 iterations, and about 40 ms at 100,000.
  - **Publishing.** Decompressing (native), CRC-checking, checksumming and packing: budget up to about 10 ms of CPU per MB of content.
  - Downloads are cheap: the zip is streamed from storage without recompressing.
- So a single larger publish, or password-heavy use with raised iterations, can exceed 10 ms. Isolated bursts are usually tolerated; sustained overruns fail with error **1102**. Publish smaller bundles, keep `PBKDF2_ITERATIONS` near the default, or move to Workers Paid (30 s CPU per request).
- Memory is 128 MB on every plan. A publish holds the upload plus its unpacked files, which is why `MAX_UPLOAD_MB` stops at 25 and publish requests must send `Content-Length`.

## Local development

```bash
npm run dev    # http://localhost:8787/dashboard/
```

No secrets are needed: open the dashboard and create the first account. Optional settings go in `.dev.vars` (gitignored; see `.dev.vars.example`). Local D1/R2 data lives in `.wrangler/state/`. Also available: `npm run typecheck`, `npm test` (integration tests inside workerd), `npm run test:scripts` (setup script unit tests) and `npm run e2e` (real CLI against `wrangler dev`; needs the monorepo). From the monorepo root, `pnpm cf:dev` does the same as `npm run dev`.

`src/vendor/` is generated from the monorepo's shared package by `npm run sync`. Don't edit it by hand.

`package-lock.json` is for standalone copies (the Deploy button and `npm ci`); pnpm ignores it. After changing dependencies in `package.json`, refresh it in a standalone copy of this folder with `npm install --package-lock-only --ignore-scripts`. CI fails when it is stale.

## Updating

- **Monorepo clone:** `git pull && pnpm install && pnpm cf:deploy`.
- **Standalone copy / Deploy-button repo:** copy the newer `apps/cloudflare` files into your repository (keep your own `wrangler.jsonc`), then push. Workers Builds redeploys automatically. The guide has a [copy-paste recipe](https://github.com/bnap00/maradocs/blob/main/docs/CLOUDFLARE.md#updating). Without Workers Builds, run `npm ci && npm run setup`.

Your data in D1 and R2 is kept, and schema changes apply themselves.

## Backups

Back up D1 and R2 together. D1 holds the manifests that locate each file inside the R2 objects.

```bash
npx wrangler d1 export DB --remote --output maradocs-$(date +%F).sql
rclone sync r2:maradocs-bucket ./maradocs-r2-backup     # your bucket name; any S3-compatible tool with an R2 API token
```

`npx wrangler r2 bucket list` shows the bucket name. Single R2 objects: `npx wrangler r2 object get maradocs-bucket/<key> --remote --file <out>`. For a portable zip of one report, use `maradocs doc download <repo>/<doc> --zip report.zip`.

## Security

- Reports are served with `Content-Security-Policy: sandbox …` (no `allow-same-origin`), so report scripts can't touch dashboard cookies or the API. Uploaded files are never executed server-side.
- Password-protected and private reports work even where third-party cookies are blocked (Safari, Brave, private windows). A sandboxed report runs in an opaque origin, so its CSS, JS and image requests can't carry cookies. When a signed-in or unlocked browser opens such a report, the Worker redirects it to a URL with a short-lived capability segment (`/r/<repo>/<doc>/~<token>/…`, valid for 4 hours). Relative asset URLs resolve under it, and the token authorises those asset requests. It never authorises opening the page itself, so a copied address-bar URL is useless without the cookie. Tokens are bound to the report password or the owner's session, so changing the password, changing access or signing out revokes them. Known limits: assets referenced by absolute path (`/r/<repo>/<doc>/style.css`) and nested `<iframe>`s still depend on cookies (the unlock and view cookies are `SameSite=None`, so they work wherever third-party cookies are allowed); and outside a browser a token URL is a bearer secret until it expires. Use relative paths.
- Report files carry `Access-Control-Allow-Origin: *` (never with credentials), so module scripts, fonts and `fetch()` work inside the sandbox. Public files are cached for at most 60 seconds, so tightening access applies within a minute.
- Dashboard: strict self-only CSP, `HttpOnly; Secure; SameSite=Lax` session cookie (`maradocs_session`, stored as a SHA-256 hash). Cookie-authenticated writes must come from the same origin and carry the `x-maradocs: 1` header (CSRF); Bearer-authenticated requests are exempt. Account passwords use PBKDF2-SHA256; sign-in answers the same, with similar timing, for a wrong password and an unknown email. After a suspected leak: change your password (signs out your other sessions) and revoke API keys.
- API keys (`mdo_…`) are stored as SHA-256 hashes, with scopes `read`, `publish` and `admin`, and act only on their account's resources. Any of the three can view that account's private and password-protected reports, and the publish keys that `maradocs auth bootstrap` mints can too.
- Report passwords use PBKDF2-SHA256. Unlock cookies are HMAC-signed and stop working when the password changes.
- Login is limited to 5 attempts per 15 minutes per IPv4 address or IPv6 /64, with a global ceiling of 100 failures; sign-up to 5 per hour per network; password checks for password changes and account deletion to 10 per hour per account; report unlock to 10 per 15 minutes per network and password (documents sharing a repository password share the budget), with a ceiling of 100 failures per password.
- A report's owner (signed in, or with one of their API keys) can open its password-protected and private reports without unlocking them; the dashboard preview relies on this. Other signed-in accounts get exactly what an anonymous visitor gets, and capability tokens and the `REPORTS_HOST` handoff are only minted for and honoured from the owner.

More detail and troubleshooting (1102, `413 payload_too_large`, forgotten password): [docs/CLOUDFLARE.md](https://github.com/bnap00/maradocs/blob/main/docs/CLOUDFLARE.md).

## License

MIT.
