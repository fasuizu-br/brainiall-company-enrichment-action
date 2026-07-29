#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildReviewQueueCsv, validateDataset } from './build-review-queue.mjs';

const scriptPath = fileURLToPath(new URL('./build-review-queue.mjs', import.meta.url));
const testRoot = await mkdtemp(join(tmpdir(), 'brainiall-review-queue-test-'));

function validItem(domain = 'example.com') {
  return {
    success: true,
    domain,
    website: `https://${domain}/`,
    nameCandidate: 'Example "Company"',
    description: 'Source-backed website description',
    industryCandidate: null,
    provenance: {
      method: 'website_metadata_scrape',
      sourceUrl: `https://${domain}/`,
      caveat: 'Candidate fields are not authoritative registry data.',
    },
    integrationSource: 'github-action-c9',
    observedAt: '2026-07-29T12:34:56.000Z',
  };
}

function expectRejected(value, pattern) {
  assert.throws(() => validateDataset(value), pattern);
}

try {
  const valid = [validItem('example.com'), validItem('example.org')];
  assert.deepEqual(validateDataset(valid), valid);
  const csv = buildReviewQueueCsv(valid);
  assert.match(csv, /^"status","domain",/u);
  assert.match(csv, /"pending","example\.com"/u);
  assert.match(csv, /"Example ""Company"""/u);
  assert.match(csv, /"website_metadata_scrape"/u);
  assert.match(csv, /"Candidate fields are not authoritative registry data\."/u);

  expectRejected([], /between 1 and 200/u);
  expectRejected(Array.from({ length: 201 }, (_, index) => validItem(`company${index}.com`)), /between 1 and 200/u);

  for (const legacyField of ['size', 'location', 'founded']) {
    const item = validItem();
    item[legacyField] = 'simulated';
    expectRejected([item], /current source-backed schema/u);
  }

  for (const formula of ['=IMPORTDATA("https://example.com")', ' +cmd', '\uFEFF@SUM(A1:A2)', '-1+1']) {
    const item = validItem();
    item.nameCandidate = formula;
    expectRejected([item], /spreadsheet formula/u);
  }

  const tooLong = validItem();
  tooLong.description = 'x'.repeat(2_001);
  expectRejected([tooLong], /2000 character limit/u);

  const badDomain = validItem('https://example.com');
  expectRejected([badDomain], /bare public domain/u);

  const mismatchedWebsite = validItem();
  mismatchedWebsite.website = 'https://other.example/';
  expectRejected([mismatchedWebsite], /canonical HTTPS URL/u);

  const mismatchedSource = validItem();
  mismatchedSource.provenance.sourceUrl = 'https://other.example/';
  expectRejected([mismatchedSource], /sourceUrl must match/u);

  const wrongMethod = validItem();
  wrongMethod.provenance.method = 'estimated';
  expectRejected([wrongMethod], /not source-backed/u);

  const wrongCaveat = validItem();
  wrongCaveat.provenance.caveat = 'Looks authoritative.';
  expectRejected([wrongCaveat], /evidence boundary/u);

  const badObservedAt = validItem();
  badObservedAt.observedAt = '2026-02-30T12:34:56Z';
  expectRejected([badObservedAt], /UTC ISO-8601/u);

  const badIntegrationSource = validItem();
  badIntegrationSource.integrationSource = '=formula';
  expectRejected([badIntegrationSource], /integration identifier/u);

  expectRejected([validItem(), validItem()], /duplicate domains/u);

  const inputPath = join(testRoot, 'dataset.json');
  const outputPath = join(testRoot, 'review-queue.csv');
  await writeFile(inputPath, JSON.stringify(valid), 'utf8');
  const success = spawnSync(
    process.execPath,
    [scriptPath, '--input', inputPath, '--output', outputPath],
    { encoding: 'utf8' },
  );
  assert.equal(success.status, 0, success.stderr);
  assert.equal(success.stderr, '');
  assert.match(success.stdout, /2 pending item/u);
  assert.match(await readFile(outputPath, 'utf8'), /"pending","example\.org"/u);

  const stdinOutputPath = join(testRoot, 'stdin-review-queue.csv');
  const stdinSuccess = spawnSync(
    process.execPath,
    [scriptPath, '--input', '-', '--output', stdinOutputPath],
    { encoding: 'utf8', input: JSON.stringify([validItem('stdin.example')]) },
  );
  assert.equal(stdinSuccess.status, 0, stdinSuccess.stderr);
  assert.match(await readFile(stdinOutputPath, 'utf8'), /"stdin\.example"/u);

  const secretMarker = 'NEVER-ECHO-THIS-INPUT';
  const secretInputPath = join(testRoot, 'invalid-dataset.json');
  await writeFile(secretInputPath, JSON.stringify([{ secret: secretMarker }]), 'utf8');
  const failure = spawnSync(
    process.execPath,
    [scriptPath, '--input', secretInputPath, '--output', join(testRoot, 'invalid.csv')],
    { encoding: 'utf8' },
  );
  assert.notEqual(failure.status, 0);
  assert.doesNotMatch(`${failure.stdout}${failure.stderr}`, new RegExp(secretMarker, 'u'));

  console.log('PASS: local review-queue checks completed without network access.');
} finally {
  await rm(testRoot, { recursive: true, force: true });
}
