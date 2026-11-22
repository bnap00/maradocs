# MaraDocs CLI

Command-line publisher for MaraDocs static HTML reports.

## Quick start

Sign in with your MaraDocs account (email + password). `auth bootstrap` mints a
publish-scoped API key, saves it to `~/.maradocs/config.json` (mode 0600) and
revokes the short-lived session it used:

```sh
# Existing account (password is prompted without echo, or read from MARADOCS_PASSWORD)
maradocs auth bootstrap --server https://docs.example.com --email you@example.com

# Fresh server: create the first account (same as `maradocs auth register ...`)
maradocs auth bootstrap --server http://localhost:8787 --email you@example.com --register

maradocs publish ./report --repo demo --doc hello
```

If the server was upgraded from the old single admin password, creating the
first account asks for a claim password: pass the old `ADMIN_PASSWORD` with
`--claim-password` (or `MARADOCS_CLAIM_PASSWORD`). Already have a key? Use
`maradocs auth login --server <url> --api-key <key>`.

See the main repository README for setup, authentication, and usage:
https://github.com/bnap00/maradocs#readme
