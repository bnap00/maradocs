#!/usr/bin/env bash
#
# maradocs-publish skill entrypoint.
# Packages a static report folder and publishes it to a MaraDocs server.
#
# Required env: MARADOCS_SERVER_URL, MARADOCS_API_KEY, report_path, repo, doc
# Optional env: access (public|password|private), password
set -euo pipefail

require() {
  if [ -z "${!1:-}" ]; then
    echo "error: missing required input '$1'" >&2
    exit 1
  fi
}

json_config_value() {
  local key="$1"
  local file="$2"
  sed -nE "s/.*\"${key}\"[[:space:]]*:[[:space:]]*\"([^\"]*)\".*/\1/p" "$file" | head -n 1
}

config_file="${MARADOCS_CONFIG_FILE:-${HOME:-}/.maradocs/config.json}"
if [ -f "$config_file" ]; then
  if [ -z "${MARADOCS_SERVER_URL:-}" ]; then
    MARADOCS_SERVER_URL="$(json_config_value server "$config_file")"
  fi
  if [ -z "${MARADOCS_API_KEY:-}" ]; then
    MARADOCS_API_KEY="$(json_config_value apiKey "$config_file")"
  fi
fi

require MARADOCS_SERVER_URL
require MARADOCS_API_KEY
require report_path
require repo
require doc

if [ ! -d "$report_path" ]; then
  echo "error: report_path '$report_path' is not a directory" >&2
  exit 1
fi
if [ ! -f "$report_path/index.html" ]; then
  echo "warning: no index.html found in '$report_path'" >&2
fi

server="${MARADOCS_SERVER_URL%/}"

# Escape a string value for embedding inside a JSON double-quoted field.
# Handles backslashes and double-quotes — the two characters that can break
# JSON structure when a variable is interpolated directly.
json_str() {
  local v="$1"
  v="${v//\\/\\\\}"   # \ → \\
  v="${v//\"/\\\"}"   # " → \"
  printf '%s' "$v"
}

# 1. Ensure the repository exists (ignore 409 conflict if it already does).
create_body="{\"slug\":\"$(json_str "${repo}")\""
if [ -n "${access:-}" ]; then create_body="${create_body},\"access\":\"$(json_str "${access}")\""; fi
if [ -n "${password:-}" ]; then create_body="${create_body},\"password\":\"$(json_str "${password}")\""; fi
create_body="${create_body}}"

curl -fsS -o /dev/null -X POST "${server}/api/v1/repos" \
  -H "Authorization: Bearer ${MARADOCS_API_KEY}" \
  -H "Content-Type: application/json" \
  -d "${create_body}" 2>/dev/null || true

# 2. Package the report folder into a zip bundle.
#    `zip` refuses to write into the empty file mktemp creates, so remove it first.
tmp_zip="$(mktemp -t maradocs-XXXXXX.zip)"
trap 'rm -f "$tmp_zip"' EXIT
rm -f "$tmp_zip"
( cd "$report_path" && zip -q -r "$tmp_zip" . -x '.*' -x 'node_modules/*' )

# 3. Publish the bundle. POST creates a new document; if it already exists,
#    retry with PUT so repeat publishes create a new immutable version.
form=( -F "doc=${doc}" -F "file=@${tmp_zip};type=application/zip" )
if [ -n "${access:-}" ]; then form+=( -F "access=${access}" ); fi
if [ -n "${password:-}" ]; then form+=( -F "password=${password}" ); fi

response_file="$(mktemp -t maradocs-response-XXXXXX.json)"
trap 'rm -f "$tmp_zip" "$response_file"' EXIT

status="$(curl -sS -o "$response_file" -w "%{http_code}" -X POST "${server}/api/v1/repos/${repo}/docs" \
  -H "Authorization: Bearer ${MARADOCS_API_KEY}" \
  "${form[@]}")"

if [ "$status" = "409" ]; then
  status="$(curl -sS -o "$response_file" -w "%{http_code}" -X PUT "${server}/api/v1/repos/${repo}/docs/${doc}" \
    -H "Authorization: Bearer ${MARADOCS_API_KEY}" \
    "${form[@]}")"
fi

cat "$response_file"
echo

if [ "${status#2}" = "$status" ]; then
  exit 1
fi
