#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildNeotomaReviewProposal } from './build-neotoma-review-proposal.mjs';

const scriptPath = fileURLToPath(new URL('./build-neotoma-review-proposal.mjs', import.meta.url));
const testRoot = await mkdtemp(join(tmpdir(), 'brainiall-neotoma-proposal-test-'));
const entityId = 'ent_1234567890abcdef';

function validItem() {
  return {
    success: true,
    domain: 'example.com',
    website: 'https://example.com/',
    nameCandidate: 'Example Company',
    description: 'Source-backed website description',
    industryCandidate: 'Software',
    provenance: {
      method: 'website_metadata_scrape',
      sourceUrl: 'https://example.com/',
      caveat: 'Candidate fields are not authoritative registry data.',
    },
    integrationSource: 'github-action-c30',
    observedAt: '2026-07-29T12:34:56.000Z',
  };
}

try {
  const dataset = [validItem()];
  const first = buildNeotomaReviewProposal(dataset, entityId);
  const second = buildNeotomaReviewProposal(dataset, entityId);
  assert.deepEqual(first, second, 'idempotency proposal must be stable across reruns');
  assert.equal(first.status, 'pending_review');
  assert.equal(first.boundary.performsWrites, false);
  assert.equal(first.boundary.sendsNetworkRequests, false);
  assert.deepEqual(first.boundary.excludesUnsupportedFirmographics, [
    'hq_location',
    'size_band',
    'funding',
  ]);
  assert.deepEqual(first.fields.map(({ field }) => field), [
    'website',
    'name',
    'description',
    'industry',
  ]);
  for (const field of first.fields) {
    assert.equal(field.observationSource, 'import');
    assert.equal(field.overwritePolicy, 'preserve_operator_set_values');
    assert.equal(field.dataSource.method, 'website_metadata_scrape');
    assert.match(field.idempotencyKey, new RegExp(`^company-enrich-${entityId}-`, 'u'));
  }
  assert.equal(
    first.fields.some(({ field }) => ['hq_location', 'size_band', 'funding'].includes(field)),
    false,
  );

  const nullable = validItem();
  nullable.nameCandidate = null;
  nullable.description = null;
  nullable.industryCandidate = null;
  assert.deepEqual(
    buildNeotomaReviewProposal([nullable], entityId).fields.map(({ field }) => field),
    ['website'],
  );

  assert.throws(
    () => buildNeotomaReviewProposal([validItem(), validItem()], entityId),
    /exactly one company result/u,
  );
  assert.throws(
    () => buildNeotomaReviewProposal(dataset, 'bad/entity'),
    /bounded Neotoma-style/u,
  );
  const legacy = validItem();
  legacy.location = 'Estimated place';
  assert.throws(
    () => buildNeotomaReviewProposal([legacy], entityId),
    /current source-backed schema/u,
  );

  const inputPath = join(testRoot, 'dataset.json');
  const outputPath = join(testRoot, 'proposal.json');
  await writeFile(inputPath, JSON.stringify(dataset), 'utf8');
  const success = spawnSync(
    process.execPath,
    [scriptPath, '--input', inputPath, '--entity-id', entityId, '--output', outputPath],
    { encoding: 'utf8' },
  );
  assert.equal(success.status, 0, success.stderr);
  assert.equal(success.stderr, '');
  assert.match(success.stdout, /4 candidate field/u);
  const written = JSON.parse(await readFile(outputPath, 'utf8'));
  assert.deepEqual(written, first);

  const secretMarker = 'NEVER-ECHO-THIS-INPUT';
  const invalidPath = join(testRoot, 'invalid.json');
  await writeFile(invalidPath, JSON.stringify([{ secret: secretMarker }]), 'utf8');
  const failure = spawnSync(
    process.execPath,
    [scriptPath, '--input', invalidPath, '--entity-id', entityId, '--output', join(testRoot, 'invalid-output.json')],
    { encoding: 'utf8' },
  );
  assert.notEqual(failure.status, 0);
  assert.doesNotMatch(`${failure.stdout}${failure.stderr}`, new RegExp(secretMarker, 'u'));

  console.log('PASS: Neotoma review proposal is deterministic, review-first, and offline.');
} finally {
  await rm(testRoot, { recursive: true, force: true });
}
