# Brainiall Company Enrichment Action

Enrich one company domain in GitHub Actions with the public Brainiall
[`vivid_astronaut/company-enrichment`](https://apify.com/vivid_astronaut/company-enrichment)
Actor on Apify. The action accepts exactly one bare domain and writes exactly
one validated website-metadata candidate item on success.

## Quick start

1. Create a scoped Apify API token that can run Actors.
2. Save it as a GitHub Actions secret named `APIFY_TOKEN`.
3. Add the action to a workflow:

```yaml
name: Enrich company

on:
  workflow_dispatch:
    inputs:
      domain:
        description: Company domain
        required: true

permissions:
  contents: read

jobs:
  enrich:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6

      - name: Prepare output directory
        run: mkdir -p build

      - name: Enrich company
        id: company
        uses: fasuizu-br/brainiall-company-enrichment-action@v1.1.0
        with:
          domain: ${{ inputs.domain }}
          apify_token: ${{ secrets.APIFY_TOKEN }}
          output_path: build/company.json

      - name: Upload result
        uses: actions/upload-artifact@v4
        with:
          name: company-enrichment
          path: ${{ steps.company.outputs.output_path }}
```

The action never creates parent directories implicitly.

## Inputs and outputs

| Input | Required | Default | Description |
|---|---:|---|---|
| `domain` | yes | — | One bare company domain, such as `openai.com`. |
| `apify_token` | yes | — | Scoped Apify token supplied from GitHub Secrets. |
| `output_path` | no | `company-enrichment.json` | JSON destination inside `GITHUB_WORKSPACE`. |
The action returns the absolute `output_path` and a `result_count` of one only
after the Actor response passes semantic validation. Treat candidate fields as
website-derived hints, not authoritative registry facts.

### Data truth boundary

The action accepts only the current source-backed field set. It rejects legacy
size, location, founding, financial, social, technology, or other extra fields;
it also requires the source URL to match the requested domain and requires the
exact `website_metadata_scrape` provenance caveat. Builds before the Actor's
`1.1.1` remediation may have returned estimated fields and must not be used as
evidence.

## Cost and security guardrails

- The caller pays applicable Apify platform and Actor charges. Review the live
  Actor pricing before use; pricing can change.
- Every request is fixed to `maxItems=1` and `maxTotalChargeUsd=0.02`.
- The token is mandatory, never printed, sent only to the fixed Apify HTTPS
  host through a private temporary header file, and removed after the request.
- Domain, semantic result, attribution, response shape, and output paths are validated. Symlink
  outputs and paths outside `GITHUB_WORKSPACE` are rejected.
- The action does not retry a metered POST after an ambiguous failure.
- Existing output is preserved on transport, HTTP, empty-response, or schema
  failure.

Use only data you are entitled to process and follow applicable privacy,
platform, and data-protection requirements.

## Local tests

The isolated test suite replaces curl with a local mock. It makes no network
request and uses no real token:

```bash
./scripts/test.sh
node scripts/validate-n8n-workflow.mjs
node scripts/test-review-queue.mjs
node scripts/test-neotoma-review-proposal.mjs
```

## n8n workflow

[`examples/n8n-brainiall-company-enrichment.json`](examples/n8n-brainiall-company-enrichment.json)
is an importable no-code workflow with explicit input and output validation and
the same one-result, US$0.02 request cap.

1. Download the [raw workflow](https://raw.githubusercontent.com/fasuizu-br/brainiall-company-enrichment-action/main/examples/n8n-brainiall-company-enrichment.json).
2. Import it into n8n.
3. On **Enrich company on Apify**, select a **Header Auth** credential with
   header name `Authorization` and value `Bearer YOUR_SCOPED_APIFY_TOKEN`.
4. Change the domain in **Set company domain** and run the workflow manually.

No credential, credential ID, or token is embedded in the workflow JSON.

## A reviewed list of up to 200 domains

[`examples/enrich-domain-list.yml`](examples/enrich-domain-list.yml) turns a
repository-owned `domains.txt` file into a sequential matrix of at most 200
one-domain runs. It rejects blank input, malformed or duplicate domains, keeps
`max-parallel: 1`, requires an explicit paid-run confirmation in the manual
workflow form, and uploads each source-backed result separately for review.

This is intended for low-volume CRM or research maintenance, not mass scraping.
Each matrix entry can incur the action's live Apify charge, capped at USD 0.02
per domain; 200 entries therefore have a request cap of USD 4.00 before any
other account-level costs. Review the Actor's live pricing first. Website
metadata candidates are not registry truth, credit data, funding data, employee
counts, or a substitute for human verification.

## Local CSV review queue

Turn an existing Actor dataset export into a review-first CSV without making
any network request or exposing the input contents in logs:

```bash
node scripts/build-review-queue.mjs \
  --input company-enrichment-results.json \
  --output company-review-queue.csv
```

To pass a JSON array over standard input instead of naming a source file:

```bash
node scripts/build-review-queue.mjs \
  --input - \
  --output company-review-queue.csv < company-enrichment-results.json
```

The input must be one array of 1–200 unique current-schema results. The utility
requires `success=true`, canonical bare domains and matching HTTPS website and
source URLs, the exact `website_metadata_scrape` provenance boundary, a valid
UTC `observedAt`, a bounded `integrationSource`, and bounded candidate strings
(`nameCandidate` 200, `industryCandidate` 160, `description` 2,000 characters).
It rejects every extra field—including legacy `size`, `location`, and
`founded` estimates—plus control characters and spreadsheet-formula prefixes.

Every accepted row is written with `status=pending`, a blank `review_notes`
cell, and the complete provenance fields. The output is a review queue, not an
automatic CRM import and not authoritative company data. The command logs only
the accepted row count; validation errors identify the item and field without
echoing input values.

## Neotoma review-proposal contract

[`scripts/build-neotoma-review-proposal.mjs`](scripts/build-neotoma-review-proposal.mjs)
is an offline, review-first contract proposal for
[`markmhendrickson/neotoma#1931`](https://github.com/markmhendrickson/neotoma/issues/1931).
It converts exactly one already-downloaded, current-schema Actor result into a
deterministic candidate-field envelope:

```bash
node scripts/build-neotoma-review-proposal.mjs \
  --input company-enrichment-results.json \
  --entity-id ent_1234567890abcdef \
  --output neotoma-review-proposal.json
```

The proposal marks every field as `observationSource=import`, carries source
URL and observation time, derives a stable per-entity/per-field idempotency key,
and requires `preserve_operator_set_values`. It performs no network request and
no Neotoma write. It deliberately omits HQ location, size band, funding, and
other fields the current Actor does not source.

This is not an accepted Neotoma API, installed bundle, or production
integration. A Neotoma implementation would still need maintainer-approved
field mappings, tenant-scoped retrieval, credential handling, conflict checks,
interrupt/resume behavior, and post-write assertions.

## License

[MIT](LICENSE) © 2026 Brainiall
