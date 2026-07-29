#!/usr/bin/env node

import { lstat, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateDataset } from './build-review-queue.mjs';

const ENTITY_ID_PATTERN = /^ent_[a-z0-9]{8,128}$/iu;
const OVERWRITE_POLICY = 'preserve_operator_set_values';
const OBSERVATION_SOURCE = 'import';

function fail(message) {
  throw new Error(message);
}

function parseArgs(argv) {
  let input;
  let output;
  let entityId;
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === '--help' || option === '-h') {
      return { help: true };
    }
    if (option === '--input' || option === '-i') {
      input = argv[index + 1];
      index += 1;
      continue;
    }
    if (option === '--output' || option === '-o') {
      output = argv[index + 1];
      index += 1;
      continue;
    }
    if (option === '--entity-id') {
      entityId = argv[index + 1];
      index += 1;
      continue;
    }
    fail('Usage error: only --input, --output, and --entity-id are supported.');
  }
  if (!input || !output || !entityId) {
    fail('Usage error: --input, --output, and --entity-id are required.');
  }
  if (!ENTITY_ID_PATTERN.test(entityId)) {
    fail('Usage error: --entity-id must be a bounded Neotoma-style entity identifier.');
  }
  return { input, output, entityId };
}

function candidate(field, value, item, entityId) {
  return {
    field,
    candidateValue: value,
    observationSource: OBSERVATION_SOURCE,
    dataSource: {
      method: item.provenance.method,
      sourceUrl: item.provenance.sourceUrl,
      observedAt: item.observedAt,
      integrationSource: item.integrationSource,
    },
    overwritePolicy: OVERWRITE_POLICY,
    idempotencyKey: `company-enrich-${entityId}-${field}-${item.provenance.method}`,
  };
}

export function buildNeotomaReviewProposal(dataset, entityId) {
  if (!ENTITY_ID_PATTERN.test(entityId)) {
    fail('entityId must be a bounded Neotoma-style entity identifier.');
  }
  if (Array.isArray(dataset) && dataset.length !== 1) {
    fail('The Neotoma proposal accepts exactly one company result.');
  }
  const items = validateDataset(dataset);
  const item = items[0];
  const fields = [
    candidate('website', item.website, item, entityId),
    item.nameCandidate === null ? null : candidate('name', item.nameCandidate, item, entityId),
    item.description === null ? null : candidate('description', item.description, item, entityId),
    item.industryCandidate === null ? null : candidate('industry', item.industryCandidate, item, entityId),
  ].filter(Boolean);

  return {
    schemaVersion: 1,
    kind: 'neotoma.company_enrichment.review_proposal',
    status: 'pending_review',
    entityType: 'company',
    entityId,
    domain: item.domain,
    fields,
    boundary: {
      performsWrites: false,
      sendsNetworkRequests: false,
      excludesUnsupportedFirmographics: ['hq_location', 'size_band', 'funding'],
      caveat: item.provenance.caveat,
    },
  };
}

async function assertSafeOutput(outputPath, inputPath) {
  if (resolve(inputPath) === outputPath) {
    fail('Output must not overwrite the input file.');
  }
  try {
    const outputStat = await lstat(outputPath);
    if (outputStat.isSymbolicLink() || !outputStat.isFile()) {
      fail('Output must be a regular file and must not be a symbolic link.');
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }
}

async function writeAtomically(outputPath, contents) {
  const temporaryPath = resolve(
    dirname(outputPath),
    `.${basename(outputPath)}.${process.pid}.${Date.now()}.tmp`,
  );
  try {
    await writeFile(temporaryPath, contents, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await rename(temporaryPath, outputPath);
  } finally {
    await unlink(temporaryPath).catch((error) => {
      if (error.code !== 'ENOENT') {
        throw error;
      }
    });
  }
}

export async function runCli(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(
      'Usage: node scripts/build-neotoma-review-proposal.mjs --input <result.json> --entity-id <ent_id> --output <proposal.json>\n',
    );
    return;
  }

  let parsed;
  try {
    parsed = JSON.parse(await readFile(args.input, 'utf8'));
  } catch (error) {
    if (error instanceof SyntaxError) {
      fail('Input is not valid JSON.');
    }
    throw error;
  }
  const proposal = buildNeotomaReviewProposal(parsed, args.entityId);
  const outputPath = resolve(args.output);
  await assertSafeOutput(outputPath, args.input);
  await writeAtomically(outputPath, `${JSON.stringify(proposal, null, 2)}\n`);
  process.stdout.write(`Review proposal created with ${proposal.fields.length} candidate field(s).\n`);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  runCli(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`Review proposal was not created: ${error.message}\n`);
    process.exitCode = 1;
  });
}
