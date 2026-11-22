# Authentication and Access Control

MaraDocs uses **email + password accounts**, **scoped API keys** for machines, and **per-report access modes** for viewers. No external auth service, email provider or secret is required to run it.

Both servers (Docker/Node and Cloudflare Workers) implement the same model and the same `/api/v1/auth` API.

## Accounts

Each account owns its own repositories, documents, API keys, machines and activity log. Accounts can't see or touch each other's data. Repository slugs are global (they appear in report URLs), so if another account already uses a slug you get `409 Repository slug '<slug>' is already taken`.

Passwords must be at least 12 characters. They are hashed on the server (bcrypt on Node, PBKDF2-SHA256 on Cloudflare) and never stored or logged in plain text.

There is no email verification and no password-reset email. An email address is just a username.

### Who can create an account

Set `REGISTRATION` on the server:

| Value | Behaviour |
|---|---|
| `first` (default) | Only the **first** account can be created. After that, sign-up is closed. Right for a personal instance. |
| `open` | Anyone who can reach the server can create an account. |
| `closed` | No new accounts. Existing accounts keep working. |

With `first`, whoever opens the dashboard first becomes the owner, so create your account straight after deploying. To add people later, temporarily set `REGISTRATION=open`, let them sign up, then set it back.

### Upgrading from the admin-password version

Older MaraDocs versions used a single `ADMIN_PASSWORD`. When you upgrade:

- Existing repositories, documents and API keys are kept. The **first account you create adopts all of them**, so existing API keys and CLI configs keep working.
- While no account exists, `ADMIN_PASSWORD` (if still set) acts as a **claim password**: the sign-up form asks for it, so a stranger can't claim an instance that already has data. After the first account exists, `ADMIN_PASSWORD` is ignored and can be removed.
- Old dashboard sessions are discarded. Sign in again.

## Dashboard sign-in

Open `/dashboard/`. If no account exists (and registration allows it) you'll see **Create account**; otherwise **Sign in**.

Sessions:

- 30 days, **sliding**: each day you use the dashboard extends it, so an active session doesn't expire.
- Stored as an `HttpOnly`, `SameSite=Lax` cookie named `maradocs_session` (`Secure` on HTTPS). The server keeps only a SHA-256 of the token. The dashboard never stores a token in `localStorage`.
- The cookie also lets the same browser open your `private` reports directly.

**Settings → Account** lets you:

- change your password (this signs out your other sessions),
- **sign out other sessions** (for example after using a shared computer),
- delete your account, which permanently removes your repositories, documents, files, API keys and activity.

## API keys

API keys let the CLI, the agent skill, CI jobs and scripts publish without a password. Create them in the dashboard under **API Keys**, or with `maradocs auth bootstrap` (below). A key is shown once. The server stores only its SHA-256 hash and a short display prefix.

Each key belongs to the account that created it and only reaches that account's data. Scopes:

- `read`: fetch your private reports, list metadata, download bundles
- `publish` (default): create, update and delete repositories and documents, plus everything `read` allows
- `admin`: every machine API operation

Use the narrowest scope that works. Revoke a key under **API Keys** (trash icon).

## Using the CLI

The quickest path signs in once, mints a publish-scoped key and saves it to `~/.maradocs/config.json`. The temporary sign-in session is revoked afterwards, so only the key remains:

```bash
# Existing account
maradocs auth bootstrap --server https://docs.example.com --email you@example.com

# Fresh server: create the first account too
maradocs auth bootstrap --server https://docs.example.com --email you@example.com --register
```

The password is prompted without echo. For scripts, set `MARADOCS_PASSWORD` instead (and `MARADOCS_CLAIM_PASSWORD` when claiming an upgraded instance). See [CLI.md](CLI.md) for all options.

If you already have a key:

```bash
maradocs auth login --server https://docs.example.com --api-key mdo_...
# or, to keep the key out of shell history:
maradocs auth setup
```

Environment variables `MARADOCS_SERVER_URL` and `MARADOCS_API_KEY` override the saved config. The bash skill reads the same config file.

## Access modes for reports

Set per repository, with an optional per-document override:

| Mode | Who can view |
|---|---|
| `public` | Anyone with the link |
| `password` | Anyone who enters the document's (or repository's) password |
| `private` | Only the **owning account**: its dashboard session in the browser, or one of its API keys with `read`, `publish` or `admin` |

A signed-in user who doesn't own a private report sees the same sign-in page as an anonymous visitor.

Report passwords are hashed before storage. Entering the right password sets a signed, document-scoped cookie bound to the current password hash, so changing the password locks out earlier visitors.

## Security details

- **CSRF.** Cookie-authenticated writes must send the header `x-maradocs: 1`, which a cross-site form or image can't add. The Cloudflare Worker also requires a same-origin `Origin`/`Sec-Fetch-Site`. Bearer-token and API-key requests are exempt.
- **Tokens in responses.** Sign-in and registration return the session token in the body only to non-browser clients (the CLI). Browsers just get the cookie.
- **Account enumeration.** A wrong email and a wrong password give the same `Invalid email or password` response with similar timing. Registration does reveal that an email is taken, so keep `REGISTRATION` at `first` or `closed` if that matters.
- **Rate limits.** Sign-in: 5 attempts per 15 minutes per client. Registration: 5 per hour per client. Password changes: 10 per hour per account. Report unlocks: 10 per 15 minutes.
- **Instance secret.** Report-unlock cookies are signed with `COOKIE_SECRET` if set (at least 32 characters), otherwise with a random secret generated on first use and stored in the database.

## Recovering access

There's no reset email. The operator can set a new password directly.

**Docker / Node server.** Run this against the container (here named `maradocs`), typing the new password on stdin. It also signs out that account's sessions:

```bash
read -rs NEWPW; echo "$NEWPW" | docker exec -i maradocs sh -c 'cd /app/apps/server && node -e "
const pw=require(\"fs\").readFileSync(0,\"utf8\").trim();
const db=new (require(\"better-sqlite3\"))(process.env.DATA_DIR+\"/docs.db\");
const u=db.prepare(\"SELECT id FROM users WHERE email=?\").get(process.argv[1]);
if(!u){console.error(\"no such account\");process.exit(1)}
db.prepare(\"UPDATE users SET password_hash=? WHERE id=?\").run(require(\"bcryptjs\").hashSync(pw,12),u.id);
db.prepare(\"DELETE FROM sessions WHERE user_id=?\").run(u.id);console.log(\"password reset\")" you@example.com'
```

For a standalone (`npx @maradocs/server`) install, run the same `node -e` script from the installed package directory with `DATA_DIR` pointing at your data folder.

**Cloudflare.** See [Troubleshooting](CLOUDFLARE.md#troubleshooting) in the Cloudflare guide.

If you suspect a leak: change your password (signs out other sessions), use **Sign out other sessions**, and revoke API keys you no longer trust.
