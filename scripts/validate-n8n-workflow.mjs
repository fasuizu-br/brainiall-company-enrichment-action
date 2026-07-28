#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const defaultWorkflow = new URL('../examples/n8n-brainiall-company-enrichment.json', import.meta.url);
const workflowPath = process.argv[2] ?? fileURLToPath(defaultWorkflow);
const source = readFileSync(workflowPath, 'utf8');
const workflow = JSON.parse(source);

assert.equal(typeof workflow.name, 'string');
assert.ok(Array.isArray(workflow.nodes));
assert.equal(workflow.nodes.length, 6, 'expected trigger, input, two validations, request, and note');
assert.ok(workflow.nodes.every((node) => !Object.hasOwn(node, 'credentials')), 'credential IDs must not be embedded');

const names = workflow.nodes.map((node) => node.name);
const ids = workflow.nodes.map((node) => node.id);
assert.equal(new Set(names).size, names.length, 'node names must be unique');
assert.equal(new Set(ids).size, ids.length, 'node ids must be unique');

const request = workflow.nodes.find((node) => node.type === 'n8n-nodes-base.httpRequest');
assert.ok(request, 'HTTP Request node is required');
assert.equal(request.parameters.method, 'POST');
assert.equal(
  request.parameters.url,
  'https://api.apify.com/v2/acts/vivid_astronaut~company-enrichment/run-sync-get-dataset-items',
);
assert.equal(request.parameters.authentication, 'genericCredentialType');
assert.equal(request.parameters.genericAuthType, 'httpHeaderAuth');
assert.equal(request.parameters.rawContentType, 'application/json');
assert.equal(request.parameters.body, '={{ JSON.stringify($json) }}');
assert.equal(request.parameters.options?.timeout, 150000);

const query = Object.fromEntries(
  request.parameters.queryParameters.parameters.map((parameter) => [parameter.name, parameter.value]),
);
assert.deepEqual(query, { maxItems: '1', maxTotalChargeUsd: '0.02' });

const inputValidation = workflow.nodes.find((node) => node.name === 'Validate domain');
assert.ok(inputValidation, 'domain validation node is required');
assert.match(inputValidation.parameters.jsCode, /domain\.includes\('\:\/\/'\)/);
assert.match(inputValidation.parameters.jsCode, /integrationSource: 'n8n-github-c9'/);

const resultValidation = workflow.nodes.find((node) => node.name === 'Validate enrichment result');
assert.ok(resultValidation, 'semantic result validation node is required');
assert.match(resultValidation.parameters.jsCode, /rows\.length !== 1/);
assert.match(resultValidation.parameters.jsCode, /row\.success !== true/);
assert.match(resultValidation.parameters.jsCode, /website_metadata_scrape/);
assert.deepEqual(
  workflow.connections['Enrich company on Apify'].main[0][0],
  { node: 'Validate enrichment result', type: 'main', index: 0 },
);

assert.equal(workflow.meta?.templateCredsSetupCompleted, false);
assert.doesNotMatch(source, /Bearer\s+(?!YOUR_SCOPED_APIFY_TOKEN(?:`|\\|\s|$))[A-Za-z0-9._~-]{12,}/, 'possible bearer secret found');
assert.doesNotMatch(source, /apify_api_[A-Za-z0-9_-]{12,}/, 'possible Apify token found');

console.log('PASS: n8n workflow JSON and safety invariants are valid.');
