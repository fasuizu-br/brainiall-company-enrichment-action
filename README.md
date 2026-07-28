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
        uses: fasuizu-br/brainiall-company-enrichment-action@v1.0.2
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

## License

[MIT](LICENSE) © 2026 Brainiall
