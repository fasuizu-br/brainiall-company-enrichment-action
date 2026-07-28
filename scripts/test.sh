#!/usr/bin/env bash

set -Eeuo pipefail

repo_root=$(cd -P -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
enrich_script=$repo_root/scripts/enrich.sh
test_root=$(mktemp -d "${TMPDIR:-/tmp}/brainiall-enrichment-action-test.XXXXXX")

cleanup() {
  rm -rf -- "$test_root"
}
trap cleanup EXIT

workspace=$test_root/workspace
runner_temp=$test_root/runner-temp
mock_bin=$test_root/mock-bin
mkdir -p "$workspace/results" "$runner_temp" "$mock_bin"
workspace=$(cd -P -- "$workspace" && pwd)

mock_curl=$mock_bin/curl
cat >"$mock_curl" <<'MOCK_CURL'
#!/usr/bin/env bash
set -Eeuo pipefail

output_file=''
headers_arg=''
payload_arg=''
url=''

while (($#)); do
  case "$1" in
    --silent|--show-error|--fail|--tlsv1.2)
      shift
      ;;
    --proto|--connect-timeout|--max-time|--request|--write-out|--output|--header|--data-binary)
      option=$1
      value=${2:-}
      [[ -n "$value" ]] || exit 90
      case "$option" in
        --output) output_file=$value ;;
        --header)
          if [[ "$value" == @* ]]; then headers_arg=$value; fi
          ;;
        --data-binary) payload_arg=$value ;;
      esac
      shift 2
      ;;
    https://*)
      url=$1
      shift
      ;;
    *)
      printf 'Unexpected curl argument: %s\n' "$1" >&2
      exit 91
      ;;
  esac
done

[[ "$url" == 'https://api.apify.com/v2/acts/vivid_astronaut~company-enrichment/run-sync-get-dataset-items?maxItems=1&maxTotalChargeUsd=0.02' ]] || exit 92
[[ "$headers_arg" == @* ]] || exit 93
headers_file=${headers_arg#@}
grep -Fqx "Authorization: Bearer $MOCK_EXPECTED_TOKEN" "$headers_file" || exit 94
[[ "$payload_arg" == @* ]] || exit 95
payload_file=${payload_arg#@}
jq -e \
  --arg domain "$MOCK_EXPECTED_DOMAIN" \
  '.domain == $domain and .integrationSource == "github-action-c9" and length == 2' \
  "$payload_file" >/dev/null || exit 96
[[ -n "$output_file" ]] || exit 97

case "${MOCK_CURL_MODE:-success}" in
  success)
    printf '[{"success":true,"domain":"%s","website":"https://%s/","nameCandidate":"Mock Company","description":null,"industryCandidate":null,"provenance":{"method":"website_metadata_scrape","sourceUrl":"https://%s/","caveat":"Candidate fields are not authoritative registry data."},"integrationSource":"github-action-c9","observedAt":"2026-07-28T00:00:00.000Z"}]' "$MOCK_EXPECTED_DOMAIN" "$MOCK_EXPECTED_DOMAIN" "$MOCK_EXPECTED_DOMAIN" >"$output_file"
    printf '200'
    ;;
  empty)
    printf '[]' >"$output_file"
    printf '200'
    ;;
  http_error)
    printf '{"error":"unauthorized"}' >"$output_file"
    printf '401'
    exit 22
    ;;
  too_many)
    printf '[{"success":true,"domain":"one.example"},{"success":true,"domain":"two.example"}]' >"$output_file"
    printf '200'
    ;;
  semantic_error)
    printf '[{"success":false,"domain":"%s","error":"upstream failed"}]' "$MOCK_EXPECTED_DOMAIN" >"$output_file"
    printf '200'
    ;;
  legacy_estimates)
    printf '[{"success":true,"domain":"%s","website":"https://%s/","nameCandidate":"Mock Company","description":null,"industryCandidate":null,"size":"5001+","location":"Tokyo, Japan","founded":1999,"provenance":{"method":"website_metadata_scrape","sourceUrl":"https://%s/","caveat":"Candidate fields are not authoritative registry data."},"integrationSource":"github-action-c9","observedAt":"2026-07-28T00:00:00.000Z"}]' "$MOCK_EXPECTED_DOMAIN" "$MOCK_EXPECTED_DOMAIN" "$MOCK_EXPECTED_DOMAIN" >"$output_file"
    printf '200'
    ;;
  bad_provenance)
    printf '[{"success":true,"domain":"%s","website":"https://%s/","nameCandidate":"Mock Company","description":null,"industryCandidate":null,"provenance":{"method":"estimated","sourceUrl":"https://other.example/","caveat":"Unverified estimate."},"integrationSource":"github-action-c9","observedAt":"2026-07-28T00:00:00.000Z"}]' "$MOCK_EXPECTED_DOMAIN" "$MOCK_EXPECTED_DOMAIN" >"$output_file"
    printf '200'
    ;;
  *) exit 100 ;;
esac
MOCK_CURL
chmod +x "$mock_curl"

test_token='test-token-not-a-secret'

assert_not_contains_token() {
  local logs=$1
  [[ "$logs" != *"$test_token"* ]] || {
    printf 'FAIL: the Apify token appeared in logs\n' >&2
    exit 1
  }
}

run_action() {
  local mode=$1
  local domain=$2
  local output=$3
  local token=${4-$test_token}

  PATH="$mock_bin:$PATH" \
  GITHUB_WORKSPACE="$workspace" \
  GITHUB_OUTPUT="$test_root/github-output" \
  RUNNER_TEMP="$runner_temp" \
  BRAINIALL_DOMAIN="$domain" \
  BRAINIALL_APIFY_TOKEN="$token" \
  BRAINIALL_OUTPUT_PATH="$output" \
  MOCK_CURL_MODE="$mode" \
  MOCK_EXPECTED_TOKEN="$test_token" \
  MOCK_EXPECTED_DOMAIN="$domain" \
  "$enrich_script"
}

: >"$test_root/github-output"
logs=$(run_action success example.com 'results/example.json' 2>&1)
assert_not_contains_token "$logs"
jq -e '.[0].domain == "example.com"' "$workspace/results/example.json" >/dev/null
grep -Fqx "output_path=$workspace/results/example.json" "$test_root/github-output"
grep -Fqx 'result_count=1' "$test_root/github-output"

: >"$test_root/github-output"
if logs=$(run_action empty empty.example 'results/empty.json' 2>&1); then
  printf 'FAIL: an empty result was accepted\n' >&2
  exit 1
fi
assert_not_contains_token "$logs"
[[ ! -e "$workspace/results/empty.json" ]]

if logs=$(run_action success 'https://example.com/path' 'results/invalid.json' 2>&1); then
  printf 'FAIL: a URL was accepted as a domain\n' >&2
  exit 1
fi
assert_not_contains_token "$logs"
[[ ! -e "$workspace/results/invalid.json" ]]

if logs=$(run_action success example.com 'results/missing-token.json' '' 2>&1); then
  printf 'FAIL: a missing token was accepted\n' >&2
  exit 1
fi
assert_not_contains_token "$logs"
[[ ! -e "$workspace/results/missing-token.json" ]]

printf 'keep-existing-output\n' >"$workspace/results/preserved.json"
if logs=$(run_action http_error example.com 'results/preserved.json' 2>&1); then
  printf 'FAIL: an HTTP error was accepted\n' >&2
  exit 1
fi
assert_not_contains_token "$logs"
grep -Fqx 'keep-existing-output' "$workspace/results/preserved.json"

if logs=$(run_action too_many example.com 'results/too-many.json' 2>&1); then
  printf 'FAIL: more than one result was accepted\n' >&2
  exit 1
fi
assert_not_contains_token "$logs"
[[ ! -e "$workspace/results/too-many.json" ]]

if logs=$(run_action semantic_error example.com 'results/semantic-error.json' 2>&1); then
  printf 'FAIL: a success:false item was accepted\n' >&2
  exit 1
fi
assert_not_contains_token "$logs"
[[ ! -e "$workspace/results/semantic-error.json" ]]

if logs=$(run_action legacy_estimates example.com 'results/legacy-estimates.json' 2>&1); then
  printf 'FAIL: legacy simulated fields were accepted\n' >&2
  exit 1
fi
assert_not_contains_token "$logs"
[[ ! -e "$workspace/results/legacy-estimates.json" ]]

if logs=$(run_action bad_provenance example.com 'results/bad-provenance.json' 2>&1); then
  printf 'FAIL: invalid provenance was accepted\n' >&2
  exit 1
fi
assert_not_contains_token "$logs"
[[ ! -e "$workspace/results/bad-provenance.json" ]]

outside=$test_root/outside.json
printf 'outside\n' >"$outside"
ln -s "$outside" "$workspace/results/symlink.json"
if logs=$(run_action success example.com 'results/symlink.json' 2>&1); then
  printf 'FAIL: a symlink output was accepted\n' >&2
  exit 1
fi
assert_not_contains_token "$logs"

if find "$runner_temp" -mindepth 1 -print -quit | grep -q .; then
  printf 'FAIL: private request files were not cleaned up\n' >&2
  exit 1
fi

printf 'PASS: 10 isolated tests completed without a real token or network request.\n'
