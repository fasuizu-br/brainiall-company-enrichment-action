#!/usr/bin/env node

import { readFile, lstat, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_ITEMS = 200;
const CURRENT_FIELDS = [
  'description',
  'domain',
  'industryCandidate',
  'integrationSource',
  'nameCandidate',
  'observedAt',
  'provenance',
  'success',
  'website',
];
const PROVENANCE_FIELDS = ['caveat', 'method', 'sourceUrl'];
const PROVENANCE_METHOD = 'website_metadata_scrape';
const PROVENANCE_CAVEAT = 'Candidate fields are not authoritative registry data.';
const CANDIDATE_LIMITS = {
  nameCandidate: 200,
  description: 2_000,
  industryCandidate: 160,
};
const CSV_COLUMNS = [
  'status',
  'domain',
  'website',
  'name_candidate',
  'description_candidate',
  'industry_candidate',
  'provenance_method',
  'source_url',
  'provenance_caveat',
  'integration_source',
  'observed_at',
  'review_notes',
];

function fail(message) {
  throw new Error(message);
}

function hasExactKeys(value, expected) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function assertBareDomain(domain, index) {
  if (typeof domain !== 'string' || domain.length === 0 || domain.length > 253) {
    fail(`Item ${index}: domain must be a non-empty string of at most 253 characters.`);
  }
  if (domain !== domain.toLowerCase()) {
    fail(`Item ${index}: domain must be lowercase.`);
  }
  if (
    !domain.includes('.') ||
    domain.startsWith('.') ||
    domain.endsWith('.') ||
    domain.includes('..') ||
    domain.includes('://') ||
    domain.includes('/') ||
    domain.includes(':') ||
    /\s/u.test(domain)
  ) {
    fail(`Item ${index}: domain must be one bare public domain.`);
  }

  const labels = domain.split('.');
  const labelPattern = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u;
  if (
    labels.some((label) => label.length < 1 || label.length > 63 || !labelPattern.test(label)) ||
    !/^[a-z]{2,63}$/u.test(labels.at(-1))
  ) {
    fail(`Item ${index}: domain contains an invalid label or public suffix.`);
  }
}

function assertSafeCandidate(value, field, index) {
  if (value === null) {
    return;
  }
  if (typeof value !== 'string') {
    fail(`Item ${index}: ${field} must be a string or null.`);
  }
  if (value.length > CANDIDATE_LIMITS[field]) {
    fail(`Item ${index}: ${field} exceeds its ${CANDIDATE_LIMITS[field]} character limit.`);
  }
  if (/[\u0000-\u001f\u007f]/u.test(value)) {
    fail(`Item ${index}: ${field} must not contain control characters.`);
  }
  if (/^[\s\uFEFF]*[=+\-@]/u.test(value)) {
    fail(`Item ${index}: ${field} could be interpreted as a spreadsheet formula.`);
  }
}

function assertObservedAt(value, index) {
  const match = typeof value === 'string'
    ? value.match(
      /^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.[0-9]{1,9})?Z$/u,
    )
    : null;
  if (!match) {
    fail(`Item ${index}: observedAt must be a valid UTC ISO-8601 timestamp.`);
  }

  const timestamp = Date.parse(value);
  const parsed = new Date(timestamp);
  const expectedParts = match.slice(1, 7).map(Number);
  const actualParts = [
    parsed.getUTCFullYear(),
    parsed.getUTCMonth() + 1,
    parsed.getUTCDate(),
    parsed.getUTCHours(),
    parsed.getUTCMinutes(),
    parsed.getUTCSeconds(),
  ];
  if (!Number.isFinite(timestamp) || actualParts.some((part, partIndex) => part !== expectedParts[partIndex])) {
    fail(`Item ${index}: observedAt must be a valid UTC ISO-8601 timestamp.`);
  }
}

function assertIntegrationSource(value, index) {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 64 ||
    !/^[a-z0-9](?:[a-z0-9._:-]*[a-z0-9])?$/iu.test(value)
  ) {
    fail(`Item ${index}: integrationSource must be a bounded integration identifier.`);
  }
}

export function validateDataset(value) {
  if (!Array.isArray(value)) {
    fail('Input must be one JSON array.');
  }
  if (value.length < 1 || value.length > MAX_ITEMS) {
    fail(`Input must contain between 1 and ${MAX_ITEMS} items.`);
  }

  const domains = new Set();
  return value.map((item, itemOffset) => {
    const index = itemOffset + 1;
    if (!hasExactKeys(item, CURRENT_FIELDS)) {
      fail(`Item ${index}: fields do not match the current source-backed schema.`);
    }
    if (item.success !== true) {
      fail(`Item ${index}: success must be true.`);
    }

    assertBareDomain(item.domain, index);
    if (domains.has(item.domain)) {
      fail(`Item ${index}: duplicate domains are not allowed.`);
    }
    domains.add(item.domain);

    const expectedUrl = `https://${item.domain}/`;
    if (item.website !== expectedUrl) {
      fail(`Item ${index}: website must be the canonical HTTPS URL for domain.`);
    }

    assertSafeCandidate(item.nameCandidate, 'nameCandidate', index);
    assertSafeCandidate(item.description, 'description', index);
    assertSafeCandidate(item.industryCandidate, 'industryCandidate', index);
    assertObservedAt(item.observedAt, index);
    assertIntegrationSource(item.integrationSource, index);

    if (!hasExactKeys(item.provenance, PROVENANCE_FIELDS)) {
      fail(`Item ${index}: provenance fields do not match the current schema.`);
    }
    if (item.provenance.method !== PROVENANCE_METHOD) {
      fail(`Item ${index}: provenance.method is not source-backed website metadata.`);
    }
    if (item.provenance.sourceUrl !== expectedUrl) {
      fail(`Item ${index}: provenance.sourceUrl must match the canonical HTTPS domain URL.`);
    }
    if (item.provenance.caveat !== PROVENANCE_CAVEAT) {
      fail(`Item ${index}: provenance.caveat does not match the current evidence boundary.`);
    }

    return item;
  });
}

function csvCell(value) {
  const text = value === null || value === undefined ? '' : String(value);
  return `"${text.replaceAll('"', '""')}"`;
}

export function buildReviewQueueCsv(items) {
  const rows = items.map((item) => [
    'pending',
    item.domain,
    item.website,
    item.nameCandidate,
    item.description,
    item.industryCandidate,
    item.provenance.method,
    item.provenance.sourceUrl,
    item.provenance.caveat,
    item.integrationSource,
    item.observedAt,
    '',
  ]);
  return [CSV_COLUMNS, ...rows].map((row) => row.map(csvCell).join(',')).join('\n') + '\n';
}

function parseArgs(argv) {
  let input;
  let output;
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
    fail('Usage error: only --input and --output are supported.');
  }
  if (!input || !output) {
    fail('Usage error: --input and --output are required.');
  }
  return { input, output };
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function assertSafeOutput(outputPath, inputPath) {
  if (inputPath !== '-' && resolve(inputPath) === outputPath) {
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
  const outputDirectory = dirname(outputPath);
  const temporaryPath = resolve(
    outputDirectory,
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
      'Usage: node scripts/build-review-queue.mjs --input <dataset.json|-> --output <queue.csv>\n',
    );
    return;
  }

  const inputText = args.input === '-' ? await readStdin() : await readFile(args.input, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(inputText);
  } catch {
    fail('Input is not valid JSON.');
  }
  const items = validateDataset(parsed);
  const outputPath = resolve(args.output);
  await assertSafeOutput(outputPath, args.input);
  await writeAtomically(outputPath, buildReviewQueueCsv(items));
  process.stdout.write(`Review queue created with ${items.length} pending item(s).\n`);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  runCli(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`Review queue was not created: ${error.message}\n`);
    process.exitCode = 1;
  });
}
