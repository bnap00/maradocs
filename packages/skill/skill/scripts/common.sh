# Shared helpers for MaraDocs skill scripts. Sourced, not executed.
#
# Contract for all skill scripts:
#   - stdout carries exactly one JSON object on success (machine-readable)
#   - human-readable progress and errors go to stderr
#   - non-zero exit on any failure

fail() {
  echo "error: $*" >&2
  exit 1
}

status() {
  echo "$*" >&2
}

require_env() {
  if [ -z "${!1:-}" ]; then
    fail "missing required input '$1'"
  fi
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "'$1' is required but was not found on PATH"
}

# Extract a top-level string value from a small JSON document (file argument
# or stdin). Good enough for the flat config/response shapes we consume.
json_value() {
  local key="$1"
  shift
  sed -nE "s/.*\"${key}\"[[:space:]]*:[[:space:]]*\"([^\"]*)\".*/\1/p" "$@" | head -n 1
}

# Escape a string for embedding inside a JSON double-quoted field.
json_str() {
  local v="$1"
  v="${v//\\/\\\\}" # \ -> \\
  v="${v//\"/\\\"}" # " -> \"
  printf '%s' "$v"
}

# Resolve MARADOCS_SERVER_URL / MARADOCS_API_KEY, falling back to the config
# saved by `maradocs auth login`. Sets the global `server` (no trailing /).
load_credentials() {
  local config_file="${MARADOCS_CONFIG_FILE:-${HOME:-}/.maradocs/config.json}"
  if [ -f "$config_file" ]; then
    if [ -z "${MARADOCS_SERVER_URL:-}" ]; then
      MARADOCS_SERVER_URL="$(json_value server "$config_file")"
    fi
    if [ -z "${MARADOCS_API_KEY:-}" ]; then
      MARADOCS_API_KEY="$(json_value apiKey "$config_file")"
    fi
  fi
  if [ -z "${MARADOCS_SERVER_URL:-}" ] || [ -z "${MARADOCS_API_KEY:-}" ]; then
    fail "no credentials: run \`maradocs auth login\` or set MARADOCS_SERVER_URL and MARADOCS_API_KEY"
  fi
  server="${MARADOCS_SERVER_URL%/}"
}

# curl with authentication and sane timeouts. Callers add method/output flags.
mcurl() {
  curl -sS --connect-timeout 10 --max-time "${MARADOCS_TIMEOUT:-120}" \
    -H "Authorization: Bearer ${MARADOCS_API_KEY}" "$@"
}

# Print the server's error body (stderr) in a readable way and exit 1.
fail_http() {
  local http_status="$1"
  local body_file="$2"
  local message
  message="$(json_value message "$body_file" 2>/dev/null || true)"
  if [ -n "$message" ]; then
    fail "server responded ${http_status}: ${message}"
  fi
  echo "error: server responded ${http_status}:" >&2
  cat "$body_file" >&2 || true
  echo >&2
  exit 1
}
