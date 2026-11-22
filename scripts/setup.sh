#!/usr/bin/env bash
#
# MaraDocs one-command setup for macOS and Linux.
#
#   curl -fsSL https://raw.githubusercontent.com/bnap00/maradocs/main/scripts/setup.sh | bash
#
# What it does:
#   1. Picks a runtime: Docker (preferred) or Node 22+ (no Docker needed).
#   2. Creates an install directory (default ~/maradocs) with generated secrets.
#   3. Starts the server (prebuilt ghcr.io/bnap00/maradocs image, or
#      `npx @maradocs/server` standalone mode when running via Node).
#   4. Creates your MaraDocs account (the first account on a fresh server) or
#      signs in to it, and mints a publish-scoped API key.
#   5. Configures the maradocs CLI if npm is available.
#
# Overridable via environment variables:
#   MARADOCS_HOME        install directory     (default: ~/maradocs)
#   MARADOCS_PORT        host port             (default: 8787)
#   MARADOCS_IMAGE       docker image          (default: ghcr.io/bnap00/maradocs:latest)
#   MARADOCS_SETUP_MODE  auto | docker | node  (default: auto)
#   MARADOCS_EMAIL       account email         (prompted if a terminal is available)
#   MARADOCS_PASSWORD    account password, 12+ chars (prompted; generated if
#                        left blank when creating the first account)
#   MARADOCS_CLAIM_PASSWORD  claim password for the first account on a server
#                        upgraded from the old ADMIN_PASSWORD (read from the
#                        install's .env / standalone-secrets.json when present)
#
# The script is idempotent: re-running it reuses existing secrets and skips
# steps that are already done.
set -euo pipefail

MARADOCS_HOME="${MARADOCS_HOME:-$HOME/maradocs}"
MARADOCS_PORT="${MARADOCS_PORT:-8787}"
MARADOCS_IMAGE="${MARADOCS_IMAGE:-ghcr.io/bnap00/maradocs:latest}"
MARADOCS_SETUP_MODE="${MARADOCS_SETUP_MODE:-auto}"
BASE_URL="http://localhost:${MARADOCS_PORT}"

say()  { printf '\033[36m==>\033[0m %s\n' "$*"; }
ok()   { printf '\033[32m ✔ \033[0m%s\n' "$*"; }
warn() { printf '\033[33m ⚠ \033[0m%s\n' "$*" >&2; }
die()  { printf '\033[31m ✖ \033[0m%s\n' "$*" >&2; exit 1; }

# Extract a top-level string value from a small JSON payload without
# requiring jq/python on the host.
json_value() {
  sed -nE "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"([^\"]*)\".*/\1/p" | head -n 1
}

# Extract a top-level boolean (true/false) from a small JSON payload.
json_bool() {
  sed -nE "s/.*\"$1\"[[:space:]]*:[[:space:]]*(true|false).*/\1/p" | head -n 1
}

# Escape a value for embedding in a JSON string literal.
json_str() {
  local v="$1"
  v="${v//\\/\\\\}"
  v="${v//\"/\\\"}"
  v="${v//$'\t'/\\t}"
  v="${v//$'\r'/\\r}"
  v="${v//$'\n'/\\n}"
  printf '%s' "$v"
}

# True when we can prompt the user (stdin is the script itself under curl | bash).
have_tty() { { : < /dev/tty; } 2>/dev/null; }

# Private scratch space for request bodies, responses and auth headers, so
# secrets never appear on curl's argv (visible in `ps`).
SETUP_TMP="$(umask 077 && mktemp -d "${TMPDIR:-/tmp}/maradocs-setup.XXXXXX")"
trap 'rm -rf "$SETUP_TMP"' EXIT

# api_post PATH [AUTH_HEADER_FILE] < json-body
# Writes the response body to $SETUP_TMP/response and prints the HTTP status
# (000 if the request failed outright).
api_post() {
  local path="$1" header_file="${2:-}"
  local args=(-sS -o "$SETUP_TMP/response" -w '%{http_code}' -X POST "${BASE_URL}${path}"
    -H 'content-type: application/json' --data-binary @-)
  [ -n "$header_file" ] && args+=(-H "@${header_file}")
  # On a connection failure curl still prints 000 for %{http_code}.
  curl "${args[@]}" 2>/dev/null || true
}

response_message() {
  local msg
  msg="$(json_value message < "$SETUP_TMP/response" 2>/dev/null || true)"
  printf '%s' "${msg:-$(head -c 200 "$SETUP_TMP/response" 2>/dev/null || true)}"
}

random_hex() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex "$1"
  else
    od -An -tx1 -N"$1" /dev/urandom | tr -d ' \n'
  fi
}

wait_for_health() {
  say "Waiting for the server to become healthy …"
  for _ in $(seq 1 60); do
    if curl -fsS "${BASE_URL}/health" >/dev/null 2>&1; then
      ok "Server is up at ${BASE_URL}"
      return 0
    fi
    sleep 1
  done
  return 1
}

node_major() {
  command -v node >/dev/null 2>&1 || { echo 0; return; }
  node -e 'process.stdout.write(String(process.versions.node.split(".")[0]))' 2>/dev/null || echo 0
}

# --- 1. Pick a runtime -------------------------------------------------------
command -v curl >/dev/null 2>&1 || die "curl is required."

MODE=""
case "$MARADOCS_SETUP_MODE" in
  docker) MODE="docker" ;;
  node)   MODE="node" ;;
  auto)
    if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
      MODE="docker"
    elif [ "$(node_major)" -ge 22 ]; then
      MODE="node"
      say "Docker not available — using Node $(node --version) standalone mode."
    fi
    ;;
  *) die "MARADOCS_SETUP_MODE must be auto, docker, or node." ;;
esac

if [ -z "$MODE" ]; then
  warn "Neither Docker nor Node 22+ was found. Install one of:"
  warn "  Docker:  https://docs.docker.com/get-started/get-docker/"
  warn "  Node 22: https://nodejs.org/en/download"
  die "No usable runtime."
fi

if [ "$MODE" = "docker" ]; then
  command -v docker >/dev/null 2>&1 || die "Docker is required for MARADOCS_SETUP_MODE=docker."
  docker info >/dev/null 2>&1 || die "Docker is installed but the daemon is not running. Start Docker and re-run."
  if docker compose version >/dev/null 2>&1; then
    COMPOSE="docker compose"
  elif command -v docker-compose >/dev/null 2>&1; then
    COMPOSE="docker-compose"
  else
    die "Docker Compose is required (ships with Docker Desktop; on Linux install the docker-compose-plugin package)."
  fi
  ok "Using Docker ($COMPOSE)."
else
  [ "$(node_major)" -ge 22 ] || die "Node 22+ is required for MARADOCS_SETUP_MODE=node (found $(node --version 2>/dev/null || echo none))."
  command -v npm >/dev/null 2>&1 || die "npm is required alongside Node."
  ok "Using Node $(node --version) (standalone, no Docker)."
fi

mkdir -p "$MARADOCS_HOME"
cd "$MARADOCS_HOME"

# --- 2. Start the server -----------------------------------------------------
# Only installs from before user accounts have an ADMIN_PASSWORD; it is now
# just the claim password needed to create the first account on them.
CLAIM_PASSWORD="${MARADOCS_CLAIM_PASSWORD:-}"

start_docker() {
  if [ -f .env ]; then
    say "Reusing existing $MARADOCS_HOME/.env"
  else
    say "Generating secrets in $MARADOCS_HOME/.env"
    umask 077
    cat > .env <<EOF
# Generated by the MaraDocs setup script on $(date -u +%Y-%m-%dT%H:%M:%SZ).
PUBLIC_BASE_URL=${BASE_URL}
COOKIE_SECRET=$(random_hex 32)
REGISTRATION=first
DEFAULT_REPO_ACCESS=private
MAX_UPLOAD_MB=50
EOF
    umask 022
  fi
  if [ -z "$CLAIM_PASSWORD" ]; then
    CLAIM_PASSWORD="$(sed -nE 's/^ADMIN_PASSWORD=(.*)$/\1/p' .env | head -n 1)"
  fi
  # Upgraded installs keep passing ADMIN_PASSWORD (as the claim password).
  ADMIN_PASSWORD_ENV=""
  if grep -q '^ADMIN_PASSWORD=' .env; then
    ADMIN_PASSWORD_ENV="      - ADMIN_PASSWORD=\${ADMIN_PASSWORD}"
  fi

  if [ ! -f docker-compose.yml ]; then
    say "Writing $MARADOCS_HOME/docker-compose.yml"
    cat > docker-compose.yml <<EOF
services:
  maradocs:
    image: ${MARADOCS_IMAGE}
    container_name: maradocs
    restart: unless-stopped
    ports:
      - "${MARADOCS_PORT}:8787"
    volumes:
      - ./data:/data
    environment:
      - NODE_ENV=production
      - PORT=8787
      - DATA_DIR=/data
      - PUBLIC_BASE_URL=\${PUBLIC_BASE_URL:?set PUBLIC_BASE_URL in .env}
      - DEFAULT_REPO_ACCESS=\${DEFAULT_REPO_ACCESS:-private}
      - MAX_UPLOAD_MB=\${MAX_UPLOAD_MB:-50}
      - COOKIE_SECRET=\${COOKIE_SECRET:?set COOKIE_SECRET in .env}
      - REGISTRATION=\${REGISTRATION:-first}
${ADMIN_PASSWORD_ENV}
    healthcheck:
      test:
        ["CMD", "node", "-e", "fetch('http://127.0.0.1:8787/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 30s
      timeout: 5s
      retries: 3
EOF
  fi

  say "Pulling ${MARADOCS_IMAGE} …"
  if ! $COMPOSE pull --quiet 2>/dev/null && ! $COMPOSE pull; then
    warn "Could not pull ${MARADOCS_IMAGE}."
    warn "To build from source instead:"
    warn "  git clone https://github.com/bnap00/maradocs && cd maradocs"
    warn "  cp .env.example .env"
    warn "  docker compose up -d --build"
    die "Image pull failed."
  fi

  say "Starting MaraDocs on ${BASE_URL} …"
  $COMPOSE up -d
  wait_for_health || die "Server did not become healthy. Check: cd $MARADOCS_HOME && $COMPOSE logs"
  MANAGE_HINT="cd ${MARADOCS_HOME} && ${COMPOSE} logs|stop|down"
}

start_node() {
  export DATA_DIR="$MARADOCS_HOME/data"

  if curl -fsS "${BASE_URL}/health" >/dev/null 2>&1; then
    say "A server is already responding on ${BASE_URL} — skipping start."
  else
    SERVER_BIN=""
    if command -v maradocs-server >/dev/null 2>&1; then
      SERVER_BIN="$(command -v maradocs-server)"
    else
      say "Installing @maradocs/server (npm install -g) …"
      if npm install -g @maradocs/server >/dev/null 2>&1; then
        SERVER_BIN="$(command -v maradocs-server || true)"
      fi
      if [ -z "$SERVER_BIN" ]; then
        warn "Global npm install failed (permissions?) — installing into ${MARADOCS_HOME}/server instead."
        mkdir -p "$MARADOCS_HOME/server"
        ( cd "$MARADOCS_HOME/server" && npm install --no-fund --no-audit @maradocs/server >/dev/null )
        SERVER_BIN="$MARADOCS_HOME/server/node_modules/.bin/maradocs-server"
      fi
    fi
    [ -x "$SERVER_BIN" ] || die "Could not install @maradocs/server."

    say "Starting MaraDocs standalone on ${BASE_URL} …"
    PORT="$MARADOCS_PORT" DATA_DIR="$DATA_DIR" nohup "$SERVER_BIN" > "$MARADOCS_HOME/server.log" 2>&1 &
    echo $! > "$MARADOCS_HOME/server.pid"
  fi

  wait_for_health || die "Server did not become healthy. Check: $MARADOCS_HOME/server.log"
  if [ -z "$CLAIM_PASSWORD" ]; then
    CLAIM_PASSWORD="$(json_value adminPassword < "$DATA_DIR/standalone-secrets.json" 2>/dev/null || true)"
  fi
  MANAGE_HINT="kill \$(cat ${MARADOCS_HOME}/server.pid)  # stop; re-run this script to start again. Logs: ${MARADOCS_HOME}/server.log"
  RESTART_NOTE="The standalone server does not restart on reboot. Re-run this script after a reboot, or add maradocs-server to systemd/launchd."
}

RESTART_NOTE=""
if [ "$MODE" = "docker" ]; then start_docker; else start_node; fi

# --- 3. Create / sign in to your account and mint an API key ----------------
API_KEY=""
ACCOUNT_EMAIL=""
GENERATED_PASSWORD=""
CREDENTIALS_FILE=""
CLI_CONFIG="$HOME/.maradocs/config.json"
CREATE_KEY_HINT="Sign in at ${BASE_URL}/dashboard/ and create a key under API Keys, or run: maradocs auth bootstrap --server ${BASE_URL} --email <you@example.com>"

bootstrap_key() {
  local config registration claim_required email password status token
  config="$(curl -fsS "${BASE_URL}/api/v1/auth/config" 2>/dev/null || true)"
  registration="$(printf '%s' "$config" | json_bool registration)"
  claim_required="$(printf '%s' "$config" | json_bool claimRequired)"
  if [ -z "$registration" ]; then
    warn "This server does not support account sign-in (/api/v1/auth/config missing; is the image up to date?)."
    warn "$CREATE_KEY_HINT"
    return 0
  fi

  email="${MARADOCS_EMAIL:-}"
  password="${MARADOCS_PASSWORD:-}"
  if [ "$registration" = true ]; then
    say "Creating your MaraDocs account …"
  else
    say "Signing in to create an API key …"
  fi
  if [ -z "$email" ] && have_tty; then
    printf 'Account email: ' > /dev/tty
    IFS= read -r email < /dev/tty || true
  fi
  if [ -z "$email" ]; then
    warn "No account email (set MARADOCS_EMAIL or run interactively) — skipping API key bootstrap."
    warn "$CREATE_KEY_HINT"
    return 0
  fi
  if [ -z "$password" ] && have_tty; then
    if [ "$registration" = true ]; then
      printf 'Choose a password (12+ characters, blank to generate one): ' > /dev/tty
    else
      printf 'Password: ' > /dev/tty
    fi
    IFS= read -rs password < /dev/tty || true
    printf '\n' > /dev/tty
  fi
  if [ -z "$password" ]; then
    if [ "$registration" != true ]; then
      warn "No password (set MARADOCS_PASSWORD or run interactively) — skipping API key bootstrap."
      warn "$CREATE_KEY_HINT"
      return 0
    fi
    password="$(random_hex 12)"
    GENERATED_PASSWORD="$password"
  fi

  if [ "$registration" = true ]; then
    if [ "$claim_required" = true ] && [ -z "$CLAIM_PASSWORD" ]; then
      if have_tty; then
        printf "Claim password (this server's old ADMIN_PASSWORD): " > /dev/tty
        IFS= read -rs CLAIM_PASSWORD < /dev/tty || true
        printf '\n' > /dev/tty
      fi
      if [ -z "$CLAIM_PASSWORD" ]; then
        warn "This server needs a claim password (its old ADMIN_PASSWORD) to create the first account."
        warn "Re-run with MARADOCS_CLAIM_PASSWORD=..., or: maradocs auth bootstrap --server ${BASE_URL} --email <you@example.com> --register --claim-password <password>"
        GENERATED_PASSWORD=""
        return 0
      fi
    fi
    local body
    body="{\"email\":\"$(json_str "$email")\",\"password\":\"$(json_str "$password")\""
    if [ "$claim_required" = true ]; then
      body="${body},\"claimPassword\":\"$(json_str "$CLAIM_PASSWORD")\""
    fi
    status="$(printf '%s}' "$body" | api_post /api/v1/auth/register)"
    if [ "$status" = 409 ]; then
      # REGISTRATION=open and the account already exists: sign in instead.
      registration=false
    elif [ "$status" != 201 ]; then
      warn "Could not create the account (HTTP ${status}): $(response_message)"
      warn "$CREATE_KEY_HINT"
      GENERATED_PASSWORD=""
      return 0
    else
      ok "Account ${email} created."
    fi
  fi
  if [ "$registration" != true ]; then
    GENERATED_PASSWORD=""
    status="$(printf '{"email":"%s","password":"%s"}' "$(json_str "$email")" "$(json_str "$password")" \
      | api_post /api/v1/auth/login)"
    if [ "$status" != 200 ]; then
      warn "Could not sign in as ${email} (HTTP ${status}): $(response_message)"
      warn "$CREATE_KEY_HINT"
      return 0
    fi
  fi
  ACCOUNT_EMAIL="$email"
  if [ -n "$GENERATED_PASSWORD" ]; then
    CREDENTIALS_FILE="$MARADOCS_HOME/account-credentials.txt"
    ( umask 077 && printf 'MaraDocs account for %s\nemail: %s\npassword: %s\n' "$BASE_URL" "$email" "$GENERATED_PASSWORD" > "$CREDENTIALS_FILE" )
  fi

  token="$(json_value token < "$SETUP_TMP/response")"
  if [ -z "$token" ]; then
    warn "The server did not return a session token."
    warn "$CREATE_KEY_HINT"
    return 0
  fi
  ( umask 077 && printf 'authorization: Bearer %s\n' "$token" > "$SETUP_TMP/auth-header" )

  status="$(printf '%s' '{"name":"setup-script","scopes":["publish"]}' | api_post /api/v1/auth/keys "$SETUP_TMP/auth-header")"
  if [ "$status" = 201 ] || [ "$status" = 200 ]; then
    API_KEY="$(json_value key < "$SETUP_TMP/response")"
  fi
  # The session was only needed to mint the key: revoke it.
  curl -sS -o /dev/null -X POST -H "@$SETUP_TMP/auth-header" "${BASE_URL}/api/v1/auth/logout" >/dev/null 2>&1 || true
  rm -f "$SETUP_TMP/auth-header"
  if [ -n "$API_KEY" ]; then
    ok "API key created."
  else
    warn "Could not create an API key automatically (HTTP ${status})."
    warn "$CREATE_KEY_HINT"
  fi
}

if [ -f "$CLI_CONFIG" ] && grep -q "\"server\": \"${BASE_URL}\"" "$CLI_CONFIG" 2>/dev/null; then
  say "CLI already configured for ${BASE_URL} — skipping API key bootstrap."
else
  bootstrap_key
fi

# --- 4. Configure the CLI ----------------------------------------------------
CLI_READY=0
if [ -n "$API_KEY" ]; then
  if ! command -v maradocs >/dev/null 2>&1 && command -v npm >/dev/null 2>&1; then
    say "Installing the MaraDocs CLI (npm install -g @maradocs/cli) …"
    npm install -g @maradocs/cli >/dev/null 2>&1 \
      || warn "Global npm install failed (permissions?). Install manually: npm install -g @maradocs/cli"
  fi
  if command -v maradocs >/dev/null 2>&1; then
    maradocs auth login --server "$BASE_URL" --api-key "$API_KEY" >/dev/null
    CLI_READY=1
    ok "CLI authenticated (credentials in ~/.maradocs/config.json)."
  fi
elif [ -f "$CLI_CONFIG" ] && grep -q "\"server\": \"${BASE_URL}\"" "$CLI_CONFIG" 2>/dev/null; then
  # Only trust an existing config that actually targets this server.
  CLI_READY=1
fi

# --- 5. Summary ---------------------------------------------------------------
echo
say "MaraDocs is ready."
echo "  Dashboard:      ${BASE_URL}/dashboard/"
if [ -n "$ACCOUNT_EMAIL" ]; then
  echo "  Account:        ${ACCOUNT_EMAIL}"
fi
if [ -n "$GENERATED_PASSWORD" ]; then
  echo "  Password:       ${GENERATED_PASSWORD}   (generated; also saved to ${CREDENTIALS_FILE}, mode 600)"
fi
if [ -n "$API_KEY" ] && [ "$CLI_READY" = 0 ]; then
  echo "  API key:        ${API_KEY}   (shown once — store it securely)"
  echo
  echo "  Use it with:"
  echo "    export MARADOCS_SERVER_URL=${BASE_URL}"
  echo "    export MARADOCS_API_KEY=${API_KEY}"
fi
echo
echo "  Publish your first report:"
echo "    mkdir -p report && printf '<h1>Hello</h1>' > report/index.html"
if [ "$CLI_READY" = 1 ]; then
  echo "    maradocs publish ./report --repo demo --doc hello"
else
  echo "    npx @maradocs/cli publish ./report --repo demo --doc hello"
fi
echo
echo "  Manage the server:"
echo "    ${MANAGE_HINT}"
if [ -n "$RESTART_NOTE" ]; then
  echo
  warn "$RESTART_NOTE"
fi
