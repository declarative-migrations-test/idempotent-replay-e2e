#!/usr/bin/env node

import fs from 'node:fs';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const REQUIRED_CASES = new Set([
  'crash-after-lock',
  'crash-after-statement-before-ledger',
  'crash-after-ledger-before-ack',
  'foreign-active-lock',
  'ambiguous-expired-lock',
  'checksum-drift',
  'identical-replay',
]);
const REQUIRED_EVIDENCE = new Set([
  'attemptId',
  'migrationId',
  'engine',
  'engineVersion',
  'exactSourceSha',
  'planDigest',
  'injectedFaultPoint',
  'lockTransitions',
  'finalSchemaDigest',
  'planChecksum',
  'leaseKey',
  'leaseOwner',
  'decision',
]);
const CASE_CONTRACTS = new Map([
  ['crash-after-lock', {
    category: 'crash',
    injectionPoint: 'after-lock-acquire',
    initialState: { ledgerRows: 0, lock: 'owned', checksum: 'absent' },
    expected: {
      decision: 'resume', exit: 'retryable-failure', ledgerRows: 0,
      mayExecuteSql: true, requiresOwnershipProof: true,
    },
  }],
  ['crash-after-statement-before-ledger', {
    category: 'crash',
    injectionPoint: 'after-statement-before-ledger',
    initialState: { ledgerRows: 0, lock: 'owned', checksum: 'absent' },
    expected: {
      decision: 'resume', exit: 'retryable-failure', ledgerRows: 0,
      mayExecuteSql: true, requiresOwnershipProof: true,
    },
  }],
  ['crash-after-ledger-before-ack', {
    category: 'crash',
    injectionPoint: 'after-ledger-before-ack',
    initialState: { ledgerRows: 1, lock: 'owned', checksum: 'matching' },
    expected: {
      decision: 'no-op', exit: 'success', ledgerRows: 1,
      mayExecuteSql: false, requiresOwnershipProof: true,
    },
  }],
  ['foreign-active-lock', {
    category: 'lock',
    injectionPoint: 'lease-acquire',
    initialState: { ledgerRows: 0, lock: 'foreign-active', checksum: 'absent' },
    expected: {
      decision: 'refuse', exit: 'retryable-failure', ledgerRows: 0,
      mayExecuteSql: false, requiresOwnershipProof: true,
    },
  }],
  ['ambiguous-expired-lock', {
    category: 'lock',
    injectionPoint: 'lease-recovery',
    initialState: { ledgerRows: 0, lock: 'ambiguous-expired', checksum: 'absent' },
    expected: {
      decision: 'refuse', exit: 'terminal-failure', ledgerRows: 0,
      mayExecuteSql: false, requiresOwnershipProof: true,
    },
  }],
  ['checksum-drift', {
    category: 'drift',
    injectionPoint: 'preflight',
    initialState: { ledgerRows: 1, lock: 'owned', checksum: 'mismatched' },
    expected: {
      decision: 'refuse', exit: 'terminal-failure', ledgerRows: 1,
      mayExecuteSql: false, requiresOwnershipProof: true,
    },
  }],
  ['identical-replay', {
    category: 'replay',
    injectionPoint: 'preflight',
    initialState: { ledgerRows: 1, lock: 'owned', checksum: 'matching' },
    expected: {
      decision: 'no-op', exit: 'success', ledgerRows: 1,
      mayExecuteSql: false, requiresOwnershipProof: true,
    },
  }],
]);
const TOP_LEVEL_KEYS = new Set([
  'schemaVersion',
  'source',
  'databaseMatrix',
  'requiredEvidence',
  'cases',
]);
const CASE_KEYS = new Set(['id', 'category', 'injectionPoint', 'initialState', 'expected']);
const STATE_KEYS = new Set(['ledgerRows', 'lock', 'checksum']);
const EXPECTED_KEYS = new Set([
  'decision',
  'exit',
  'ledgerRows',
  'mayExecuteSql',
  'requiresOwnershipProof',
  'evidence',
]);

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function unknownKeys(value, allowed, label, errors) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) errors.push(`${label} contains unknown field ${key}`);
  }
}

function exactSet(values, expected) {
  return Array.isArray(values)
    && values.length === expected.size
    && new Set(values).size === expected.size
    && values.every((value) => typeof value === 'string' && expected.has(value));
}

function enforceExactFields(actual, required, label, errors) {
  for (const [field, expected] of Object.entries(required)) {
    if (actual?.[field] !== expected) {
      errors.push(`${label}.${field} must be ${JSON.stringify(expected)}`);
    }
  }
}

export function validateRecoveryContract(contract) {
  const errors = [];
  if (!plainObject(contract)) return ['contract must be an object'];
  unknownKeys(contract, TOP_LEVEL_KEYS, 'contract', errors);
  if (contract.schemaVersion !== 1) errors.push('schemaVersion must be 1');
  if (!plainObject(contract.source)) {
    errors.push('source must be an object');
  } else {
    unknownKeys(contract.source, new Set(['repository', 'sha']), 'source', errors);
    if (contract.source.repository !== 'declarative-migrations/declarative-postgres-migrate.rs') {
      errors.push('source.repository must be the certified PostgreSQL migrator');
    }
    if (!/^[0-9a-f]{40}$/.test(contract.source.sha ?? '')) {
      errors.push('source.sha must be an immutable 40-character commit SHA');
    }
  }
  if (!exactSet(contract.databaseMatrix, new Set(['16', '17']))) {
    errors.push('databaseMatrix must cover PostgreSQL 16 and 17 exactly');
  }
  if (!exactSet(contract.requiredEvidence, REQUIRED_EVIDENCE)) {
    errors.push('requiredEvidence must contain the canonical evidence fields exactly');
  }
  if (!Array.isArray(contract.cases)) {
    errors.push('cases must be an array');
    return errors;
  }

  const seen = new Set();
  for (const [index, testCase] of contract.cases.entries()) {
    const label = `cases[${index}]`;
    if (!plainObject(testCase)) {
      errors.push(`${label} must be an object`);
      continue;
    }
    unknownKeys(testCase, CASE_KEYS, label, errors);
    if (typeof testCase.id !== 'string' || !/^[a-z][a-z0-9-]+$/.test(testCase.id)) {
      errors.push(`${label}.id is invalid`);
    } else if (seen.has(testCase.id)) {
      errors.push(`duplicate case id ${testCase.id}`);
    } else {
      seen.add(testCase.id);
    }
    if (!['crash', 'lock', 'drift', 'replay'].includes(testCase.category)) {
      errors.push(`${label}.category is invalid`);
    }
    if (![
      'after-lock-acquire',
      'after-statement-before-ledger',
      'after-ledger-before-ack',
      'lease-acquire',
      'lease-recovery',
      'preflight',
    ].includes(testCase.injectionPoint)) {
      errors.push(`${label}.injectionPoint is invalid`);
    }

    const state = testCase.initialState;
    if (!plainObject(state)) {
      errors.push(`${label}.initialState must be an object`);
      continue;
    }
    unknownKeys(state, STATE_KEYS, `${label}.initialState`, errors);
    if (![0, 1].includes(state.ledgerRows)) errors.push(`${label}.initialState.ledgerRows must be 0 or 1`);
    if (!['none', 'owned', 'foreign-active', 'ambiguous-expired'].includes(state.lock)) {
      errors.push(`${label}.initialState.lock is invalid`);
    }
    if (!['absent', 'matching', 'mismatched'].includes(state.checksum)) {
      errors.push(`${label}.initialState.checksum is invalid`);
    }

    const expected = testCase.expected;
    if (!plainObject(expected)) {
      errors.push(`${label}.expected must be an object`);
      continue;
    }
    unknownKeys(expected, EXPECTED_KEYS, `${label}.expected`, errors);
    if (!['apply', 'resume', 'no-op', 'refuse'].includes(expected.decision)) {
      errors.push(`${label}.expected.decision is invalid`);
    }
    if (!['success', 'retryable-failure', 'terminal-failure'].includes(expected.exit)) {
      errors.push(`${label}.expected.exit is invalid`);
    }
    if (![0, 1].includes(expected.ledgerRows)) errors.push(`${label}.expected.ledgerRows must be 0 or 1`);
    if (typeof expected.mayExecuteSql !== 'boolean') errors.push(`${label}.expected.mayExecuteSql must be boolean`);
    if (typeof expected.requiresOwnershipProof !== 'boolean') {
      errors.push(`${label}.expected.requiresOwnershipProof must be boolean`);
    }
    if (!exactSet(expected.evidence, REQUIRED_EVIDENCE)) {
      errors.push(`${label}.expected.evidence must contain every canonical evidence field exactly`);
    }

    const required = CASE_CONTRACTS.get(testCase.id);
    if (required) {
      enforceExactFields(testCase, {
        category: required.category,
        injectionPoint: required.injectionPoint,
      }, label, errors);
      enforceExactFields(state, required.initialState, `${label}.initialState`, errors);
      enforceExactFields(expected, required.expected, `${label}.expected`, errors);
    }

    if (expected.decision === 'refuse' && expected.mayExecuteSql !== false) {
      errors.push(`${label} refuses but still permits SQL execution`);
    }
    if (state.lock === 'foreign-active' || state.lock === 'ambiguous-expired') {
      if (expected.decision !== 'refuse' || expected.mayExecuteSql !== false) {
        errors.push(`${label} must fail closed for an unowned or ambiguous lease`);
      }
    }
    if (state.checksum === 'mismatched') {
      if (expected.decision !== 'refuse' || expected.exit !== 'terminal-failure') {
        errors.push(`${label} must terminally refuse checksum drift`);
      }
    }
    if (testCase.id === 'crash-after-statement-before-ledger' && expected.ledgerRows !== 0) {
      errors.push(`${label} leaked a ledger row before commit`);
    }
    if (testCase.id === 'crash-after-ledger-before-ack') {
      if (expected.decision !== 'no-op' || expected.ledgerRows !== 1 || expected.mayExecuteSql) {
        errors.push(`${label} must replay as a no-op after durable ledger commit`);
      }
    }
    if (testCase.id === 'identical-replay') {
      if (expected.decision !== 'no-op' || expected.exit !== 'success' || expected.ledgerRows !== 1) {
        errors.push(`${label} must remain a successful one-row no-op`);
      }
    }
  }

  for (const id of REQUIRED_CASES) {
    if (!seen.has(id)) errors.push(`missing required recovery case ${id}`);
  }
  for (const id of seen) {
    if (!REQUIRED_CASES.has(id)) errors.push(`unexpected recovery case ${id}`);
  }

  const serialized = JSON.stringify(contract);
  if (/ghp_[A-Za-z0-9]+|github_pat_[A-Za-z0-9_]+|lin_api_[A-Za-z0-9]+/.test(serialized)) {
    errors.push('credential-shaped value found');
  }
  return errors;
}

export function validateRecoveryBundle(contract, sourcePins, testPlan) {
  const errors = validateRecoveryContract(contract);
  const repository = contract?.source?.repository;
  const pinnedSha = sourcePins?.sources?.[repository]?.sha;
  const plannedSource = Array.isArray(testPlan?.sources)
    ? testPlan.sources.find((source) => source?.fullName === repository)
    : undefined;
  if (!/^[0-9a-f]{40}$/.test(pinnedSha ?? '')) {
    errors.push('source-pins.json must contain the certified immutable source SHA');
  } else if (contract?.source?.sha !== pinnedSha) {
    errors.push('contract source SHA must match source-pins.json');
  }
  if (!/^[0-9a-f]{40}$/.test(plannedSource?.sha ?? '')) {
    errors.push('test-plan.json must contain the certified immutable source SHA');
  } else if (contract?.source?.sha !== plannedSource.sha) {
    errors.push('contract source SHA must match test-plan.json');
  }
  return errors;
}

export function main() {
  const contract = JSON.parse(
    fs.readFileSync(new URL('../recovery-contract.json', import.meta.url), 'utf8'),
  );
  const sourcePins = JSON.parse(
    fs.readFileSync(new URL('../source-pins.json', import.meta.url), 'utf8'),
  );
  const testPlan = JSON.parse(
    fs.readFileSync(new URL('../test-plan.json', import.meta.url), 'utf8'),
  );
  const errors = validateRecoveryBundle(contract, sourcePins, testPlan);
  if (errors.length) {
    for (const error of errors) console.error(`error: ${error}`);
    process.exitCode = 1;
    return;
  }
  console.log(`validated ${contract.cases.length} deterministic recovery cases at ${contract.source.sha}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main();
