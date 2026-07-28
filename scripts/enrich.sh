#!/usr/bin/env bash

# Never inherit shell tracing: action inputs include a secret.
set +x
set -Eeuo pipefail

readonly API_URL='https://api.apify.com/v2/acts/vivid_astronaut~company-enrichment/run-sync-get-dataset-items'
readonly MAX_ITEMS='1'
readonly MAX_TOTAL_CHARGE_USD='0.02'

fail() {
  printf '::error::%s\n' "$*" >&2
  exit 1
}

reject_line_breaks() {
  local label=$1
  local value=$2
  case "$value" in
    *$'\n'*|*$'\r'*) fail "$label must not contain line breaks." ;;
  esac
}

validate_domain() {
  local value=$1
  local label

  ((${#value} <= 253)) || fail 'domain must be 253 characters or fewer.'
  [[ "$value" == *.* ]] || fail 'domain must contain a public suffix.'
  [[ "$value" != .* && "$value" != *. && "$value" != *..* ]] \
    || fail 'domain has invalid dot placement.'
  [[ "$value" != *://* && "$value" != */* && "$value" != *:* && "$value" != *' '* ]] \
    || fail 'domain must not contain a scheme, port, path, or spaces.'

  IFS='.' read -r -a labels <<<"$value"
  for label in "${labels[@]}"; do
    ((${#label} >= 1 && ${#label} <= 63)) || fail 'domain contains an invalid label length.'
    [[ "$label" =~ ^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?$ ]] \
      || fail 'domain contains unsupported characters or hyphen placement.'
  done

  [[ "${labels[${#labels[@]}-1]}" =~ ^[A-Za-z]{2,63}$ ]] \
    || fail 'domain must end in an alphabetic public suffix.'
}

for required_command in curl jq mktemp mv; do
  command -v "$required_command" >/dev/null 2>&1 \
    || fail "Required command not found: $required_command"
done

workspace_input=${GITHUB_WORKSPACE:-}
[[ -n "$workspace_input" ]] || fail 'GITHUB_WORKSPACE is not set.'
[[ -d "$workspace_input" ]] || fail 'GITHUB_WORKSPACE is not a directory.'
workspace=$(cd -P -- "$workspace_input" && pwd)
[[ "$workspace" != '/' ]] || fail 'Refusing to use the filesystem root as GITHUB_WORKSPACE.'

domain=${BRAINIALL_DOMAIN:-}
apify_token=${BRAINIALL_APIFY_TOKEN:-}
output_path=${BRAINIALL_OUTPUT_PATH:-company-enrichment.json}

[[ -n "$domain" ]] || fail 'The domain input is required.'
[[ -n "$apify_token" ]] || fail 'The apify_token input is required. Pass it from GitHub Actions secrets.'
[[ -n "$output_path" ]] || fail 'The output_path input must not be empty.'

reject_line_breaks 'domain' "$domain"
reject_line_breaks 'apify_token' "$apify_token"
reject_line_breaks 'output_path' "$output_path"
validate_domain "$domain"

if [[ "$output_path" == /* ]]; then
  output_candidate=$output_path
else
  output_candidate=$workspace/$output_path
fi

output_parent_candidate=$(dirname -- "$output_candidate")
[[ -d "$output_parent_candidate" ]] \
  || fail 'The output_path parent directory must already exist.'
output_dir=$(cd -P -- "$output_parent_candidate" && pwd)
output_abs=$output_dir/$(basename -- "$output_candidate")

case "$output_abs" in
  "$workspace"/*) ;;
  *) fail 'output_path must resolve inside GITHUB_WORKSPACE.' ;;
esac

[[ ! -L "$output_abs" ]] || fail 'output_path must not be a symbolic link.'
if [[ -e "$output_abs" && ! -f "$output_abs" ]]; then
  fail 'output_path exists and is not a regular file.'
fi

umask 077
tmp_root=${RUNNER_TEMP:-${TMPDIR:-/tmp}}
[[ -d "$tmp_root" && -w "$tmp_root" ]] || fail 'No writable runner temporary directory is available.'
request_dir=$(mktemp -d "$tmp_root/brainiall-enrichment-action.XXXXXX") \
  || fail 'Could not create a private request directory.'
response_tmp=''

cleanup() {
  if [[ -n "${response_tmp:-}" && -e "$response_tmp" ]]; then
    rm -f -- "$response_tmp"
  fi
  if [[ -n "${request_dir:-}" && -d "$request_dir" ]]; then
    rm -f -- "$request_dir/headers" "$request_dir/payload.json"
    rmdir -- "$request_dir" 2>/dev/null || true
  fi
}
trap cleanup EXIT

headers_file=$request_dir/headers
payload_file=$request_dir/payload.json
printf 'Authorization: Bearer %s\n' "$apify_token" >"$headers_file"
unset apify_token BRAINIALL_APIFY_TOKEN

jq -n \
  --arg domain "$domain" \
  '{domain: $domain, integrationSource: "github-action-c9"}' \
  >"$payload_file"

response_tmp=$(mktemp "$output_dir/.brainiall-enrichment-output.XXXXXX") \
  || fail 'Could not create a private output file.'

request_url="${API_URL}?maxItems=${MAX_ITEMS}&maxTotalChargeUsd=${MAX_TOTAL_CHARGE_USD}"
curl_args=(
  --silent
  --show-error
  --fail
  --proto '=https'
  --tlsv1.2
  --connect-timeout 20
  --max-time 150
  --request POST
  --header "@$headers_file"
  --header 'Content-Type: application/json'
  --data-binary "@$payload_file"
  --output "$response_tmp"
  --write-out '%{http_code}'
)

if ! http_code=$(curl "${curl_args[@]}" "$request_url"); then
  fail 'The Apify Actor request failed. No output file was replaced.'
fi

[[ "$http_code" =~ ^2[0-9][0-9]$ ]] \
  || fail "The Apify API returned HTTP $http_code. No output file was replaced."
[[ -s "$response_tmp" ]] || fail 'The Apify Actor returned an empty response.'
jq -e --arg domain "$domain" \
  'type == "array" and length == 1 and
   (.[0] | type == "object" and
     (keys | sort) == [
       "description", "domain", "industryCandidate", "integrationSource",
       "nameCandidate", "observedAt", "provenance", "success", "website"
     ]) and
   .[0].success == true and
   .[0].domain == $domain and
   .[0].website == ("https://" + $domain + "/") and
   (. [0].nameCandidate | type == "string" or . == null) and
   (. [0].description | type == "string" or . == null) and
   (. [0].industryCandidate | type == "string" or . == null) and
   .[0].integrationSource == "github-action-c9" and
   (. [0].observedAt | type == "string" and
     test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]+)?Z$")) and
   (. [0].provenance | type == "object" and
     (keys | sort) == ["caveat", "method", "sourceUrl"] and
     .method == "website_metadata_scrape" and
     .sourceUrl == ("https://" + $domain + "/") and
     .caveat == "Candidate fields are not authoritative registry data.")' \
  "$response_tmp" >/dev/null \
  || fail 'The Apify Actor returned an unexpected response shape.'

result_count=1
mv -f -- "$response_tmp" "$output_abs"
response_tmp=''

if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  printf 'output_path=%s\n' "$output_abs" >>"$GITHUB_OUTPUT"
  printf 'result_count=%s\n' "$result_count" >>"$GITHUB_OUTPUT"
fi

printf 'Company enrichment completed with %s result(s): %s\n' "$result_count" "$output_abs"
