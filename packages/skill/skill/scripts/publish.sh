#!/usr/bin/env bash
#
# maradocs-publish skill: publish a static report folder to a MaraDocs server.
#
# Required inputs (env): report_path, repo, doc
# Optional inputs (env): access (public|password|private), password, title,
#                        entrypoint, MARADOCS_SERVER_URL, MARADOCS_API_KEY
#
# Behaviour matches the maradocs CLI:
#   - the repository is created automatically if it does not exist
#   - republishing an existing document creates a new immutable version
#
# On success, stdout carries exactly one JSON object (the publish result);
# progress goes to stderr.
set -euo pipefail
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

require_cmd curl
require_cmd zip
load_credentials
require_env report_path
require_env repo
require_env doc

entry="${entrypoint:-index.html}"
if [ ! -d "$report_path" ]; then
  fail "report_path '$report_path' is not a directory"
fi
if [ ! -f "$report_path/$entry" ]; then
  status "warning: no $entry found in '$report_path'"
fi

# Package the report folder into a zip bundle, excluding dotfiles and
# node_modules at any depth. `zip` refuses to write into the empty file
# mktemp creates, so remove it first.
tmp_zip="$(mktemp -t maradocs-XXXXXX.zip)"
response_file="$(mktemp -t maradocs-response-XXXXXX.json)"
trap 'rm -f "$tmp_zip" "$response_file"' EXIT
rm -f "$tmp_zip"
status "packaging '$report_path' ..."
( cd "$report_path" && zip -q -r "$tmp_zip" . \
    -x '.*' -x '*/.*' -x 'node_modules/*' -x '*/node_modules/*' )

form=( -F "doc=${doc}" -F "file=@${tmp_zip};type=application/zip" )
if [ -n "${access:-}" ]; then form+=( -F "access=${access}" ); fi
if [ -n "${password:-}" ]; then form+=( -F "password=${password}" ); fi
if [ -n "${title:-}" ]; then form+=( -F "title=${title}" ); fi
if [ -n "${entrypoint:-}" ]; then form+=( -F "entrypoint=${entrypoint}" ); fi

publish_request() {
  local method="$1" url="$2"
  mcurl -o "$response_file" -w "%{http_code}" -X "$method" "$url" "${form[@]}"
}

# Publish. POST creates a new document; 404 means the repository is missing
# (create it, then retry); 409 means the document exists (PUT a new version).
status "publishing ${repo}/${doc} ..."
http_status="$(publish_request POST "${server}/api/v1/repos/${repo}/docs")"

if [ "$http_status" = "404" ]; then
  status "repository '${repo}' not found - creating it ..."
  create_body="{\"slug\":\"$(json_str "${repo}")\""
  if [ -n "${access:-}" ]; then create_body="${create_body},\"access\":\"$(json_str "${access}")\""; fi
  if [ -n "${password:-}" ]; then create_body="${create_body},\"password\":\"$(json_str "${password}")\""; fi
  create_body="${create_body}}"
  create_status="$(mcurl -o "$response_file" -w "%{http_code}" -X POST "${server}/api/v1/repos" \
    -H "Content-Type: application/json" -d "${create_body}")"
  # 409 = concurrent creation; anything else non-2xx is a real error.
  if [ "${create_status#2}" = "$create_status" ] && [ "$create_status" != "409" ]; then
    fail_http "$create_status" "$response_file"
  fi
  http_status="$(publish_request POST "${server}/api/v1/repos/${repo}/docs")"
fi

if [ "$http_status" = "409" ]; then
  status "document exists - publishing a new version ..."
  http_status="$(publish_request PUT "${server}/api/v1/repos/${repo}/docs/${doc}")"
fi

if [ "${http_status#2}" = "$http_status" ]; then
  fail_http "$http_status" "$response_file"
fi

url="$(json_value url "$response_file" 2>/dev/null || true)"
if [ -n "$url" ]; then status "published: $url"; fi
cat "$response_file"
echo
