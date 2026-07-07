#!/usr/bin/env bash
#
# maradocs-publish skill: download a document version's files so an artifact
# can be inspected or updated (edit, then republish with publish.sh).
#
# Required inputs (env): repo, doc
# Optional inputs (env): version   pinned version number (default: latest)
#                        out_dir   directory to extract into (default: ./<doc>)
#                        zip_path  save the raw zip here instead of extracting
#                        force     set to 1 to extract into a non-empty dir
#                        MARADOCS_SERVER_URL, MARADOCS_API_KEY
#
# On success, stdout carries exactly one JSON object with repo, doc,
# versionNumber, checksum, entrypoint, and the output location; progress
# goes to stderr.
set -euo pipefail
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

require_cmd curl
load_credentials
require_env repo
require_env doc

url="${server}/api/v1/repos/${repo}/docs/${doc}/bundle"
if [ -n "${version:-}" ]; then
  case "$version" in
    *[!0-9]*|'') fail "version must be a positive integer, got '$version'" ;;
  esac
  url="${url}?version=${version}"
fi

tmp_zip="$(mktemp -t maradocs-dl-XXXXXX.zip)"
headers_file="$(mktemp -t maradocs-headers-XXXXXX.txt)"
trap 'rm -f "$tmp_zip" "$headers_file"' EXIT

status "downloading ${repo}/${doc}${version:+ v$version} ..."
http_status="$(mcurl -o "$tmp_zip" -D "$headers_file" -w "%{http_code}" "$url")"
if [ "${http_status#2}" = "$http_status" ]; then
  fail_http "$http_status" "$tmp_zip"
fi

# Case-insensitive header lookup that works with both GNU and BSD tools.
header_value() {
  grep -i "^$1:" "$headers_file" | head -n 1 | sed -E 's/^[^:]+:[[:space:]]*//' | tr -d '\r'
}
version_number="$(header_value x-maradocs-version-number)"
checksum="$(header_value x-maradocs-checksum)"
doc_entrypoint="$(header_value x-maradocs-entrypoint)"

result_common() {
  printf '"repo":"%s","doc":"%s","versionNumber":%s,"checksum":"%s","entrypoint":"%s"' \
    "$(json_str "$repo")" "$(json_str "$doc")" "${version_number:-null}" \
    "$(json_str "${checksum:-}")" "$(json_str "${doc_entrypoint:-}")"
}

if [ -n "${zip_path:-}" ]; then
  mkdir -p "$(dirname "$zip_path")"
  cp "$tmp_zip" "$zip_path"
  status "saved ${repo}/${doc} v${version_number:-?} to ${zip_path}"
  printf '{%s,"zip":"%s"}\n' "$(result_common)" "$(json_str "$zip_path")"
  exit 0
fi

require_cmd unzip
out="${out_dir:-./${doc}}"
if [ -d "$out" ] && [ -n "$(ls -A "$out" 2>/dev/null)" ] && [ "${force:-0}" != "1" ]; then
  fail "directory '$out' is not empty; set force=1 or choose another out_dir"
fi
mkdir -p "$out"
unzip -q -o "$tmp_zip" -d "$out"
file_count="$(find "$out" -type f | wc -l | tr -d ' ')"
status "downloaded ${repo}/${doc} v${version_number:-?} (${file_count} files) to ${out}"
status "edit and republish with: report_path='${out}' repo='${repo}' doc='${doc}' bash publish.sh"
printf '{%s,"fileCount":%s,"out":"%s"}\n' "$(result_common)" "$file_count" "$(json_str "$out")"
