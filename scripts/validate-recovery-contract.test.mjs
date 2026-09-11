import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import {
  validateRecoveryBundle,
  validateRecoveryContract,
} from './validate-recovery-contract.mjs';

function contract() {
  return JSON.parse(fs.readFileSync(new URL('../recovery-contract.json', import.meta.url), 'utf8'));
}

function sourcePins() {
  return JSON.parse(fs.readFileSync(new URL('../source-pins.json', import.meta.url), 'utf8'));
}

function testPlan() {
  return JSON.parse(fs.readFileSync(new URL('../test-plan.json', import.meta.url), 'utf8'));
}

function caseById(value, id) {
  return value.cases.find((item) => item.id === id);
}

test('canonical recovery matrix is complete and deterministic', () => {
  assert.deepEqual(validateRecoveryBundle(contract(), sourcePins(), testPlan()), []);
});

test('checksum drift can never apply or retry SQL', () => {
  const value = contract();
  const drift = caseById(value, 'checksum-drift');
  drift.expected.decision = 'apply';
  drift.expected.mayExecuteSql = true;
  const errors = validateRecoveryContract(value).join('\n');
  assert.match(errors, /refuses but still permits SQL|terminally refuse checksum drift/);
});

test('foreign and ambiguous locks fail closed', () => {
  for (const id of ['foreign-active-lock', 'ambiguous-expired-lock']) {
    const value = contract();
    caseById(value, id).expected.mayExecuteSql = true;
    assert.match(validateRecoveryContract(value).join('\n'), /fail closed/);
  }
});

test('missing and duplicate recovery cases are rejected', () => {
  const missing = contract();
  missing.cases = missing.cases.filter((item) => item.id !== 'crash-after-lock');
  assert.match(validateRecoveryContract(missing).join('\n'), /missing required recovery case crash-after-lock/);

  const duplicate = contract();
  duplicate.cases.push({ ...duplicate.cases[0] });
  assert.match(validateRecoveryContract(duplicate).join('\n'), /duplicate case id crash-after-lock/);
});

test('set-valued fields reject duplicates that hide required values', () => {
  const duplicateVersion = contract();
  duplicateVersion.databaseMatrix = ['16', '16'];
  assert.match(validateRecoveryContract(duplicateVersion).join('\n'), /PostgreSQL 16 and 17 exactly/);

  const duplicateEvidence = contract();
  duplicateEvidence.requiredEvidence = duplicateEvidence.requiredEvidence.map(() => 'attemptId');
  assert.match(validateRecoveryContract(duplicateEvidence).join('\n'), /canonical evidence fields exactly/);
});

test('case identifiers cannot be paired with permissive or swapped semantics', () => {
  const value = contract();
  const crash = caseById(value, 'crash-after-lock');
  crash.injectionPoint = 'preflight';
  crash.expected.requiresOwnershipProof = false;
  crash.expected.ledgerRows = 1;
  const errors = validateRecoveryContract(value).join('\n');
  assert.match(errors, /injectionPoint must be "after-lock-acquire"/);
  assert.match(errors, /requiresOwnershipProof must be true/);
  assert.match(errors, /ledgerRows must be 0/);
});

test('acceptance evidence is mandatory for every recovery decision', () => {
  const value = contract();
  value.requiredEvidence = value.requiredEvidence.filter((field) => field !== 'finalSchemaDigest');
  caseById(value, 'identical-replay').expected.evidence =
    caseById(value, 'identical-replay').expected.evidence.filter(
      (field) => field !== 'lockTransitions',
    );
  const errors = validateRecoveryContract(value).join('\n');
  assert.match(errors, /canonical evidence fields exactly/);
  assert.match(errors, /every canonical evidence field exactly/);
});

test('contract source SHA cannot drift from either generated source pin', () => {
  const pins = sourcePins();
  pins.sources['declarative-migrations/declarative-postgres-migrate.rs'].sha =
    '1111111111111111111111111111111111111111';
  assert.match(
    validateRecoveryBundle(contract(), pins, testPlan()).join('\n'),
    /contract source SHA must match source-pins.json/,
  );

  const plan = testPlan();
  plan.sources[0].sha = '2222222222222222222222222222222222222222';
  assert.match(
    validateRecoveryBundle(contract(), sourcePins(), plan).join('\n'),
    /contract source SHA must match test-plan.json/,
  );
});

test('credential-shaped content is rejected', () => {
  const value = contract();
  value.source.sha = 'ghp_abcdefghijklmnopqrstuvwxyz1234567890';
  assert.match(validateRecoveryContract(value).join('\n'), /credential-shaped value found/);
});
