# Security Policy

## Supported Versions

Only the latest release of MaraDocs (npm packages and the `ghcr.io/bnap00/maradocs`
image) receives security fixes.

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

Report privately through GitHub:
**[Security → Report a vulnerability](https://github.com/bnap00/maradocs/security/advisories/new)**.
If you can't use GitHub, email **bnap00@gmail.com** instead.

Please include:

- A description of the vulnerability
- Steps to reproduce
- The potential impact
- Any suggested fixes (optional)

You will receive a response within 72 hours. If the issue is confirmed, we will:

1. Work with you on a fix
2. Coordinate a disclosure timeline (typically 90 days)
3. Credit you in the release notes and advisory (unless you prefer to remain anonymous)

## How dependencies are kept patched

- Dependabot alerts and security updates are enabled; weekly grouped version
  updates cover npm, the Docker base image and GitHub Actions (3-day cooldown).
- pnpm refuses to install package versions younger than 3 days
  (`minimumReleaseAge` in `pnpm-workspace.yaml`); CI installs with `--frozen-lockfile`.
- The `Security` workflow runs OSV-Scanner (lockfile and built image), Gitleaks
  and CodeQL on pushes, pull requests and weekly.
- All GitHub Actions are pinned to commit SHAs; npm packages are published with
  provenance via trusted publishing.

## Security Model

See [docs/SECURITY.md](docs/SECURITY.md) for the full security model, trust boundaries, and operational recommendations.
