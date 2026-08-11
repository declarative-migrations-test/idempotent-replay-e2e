import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { validateRecoveryContract } from './validate-recovery-contract.mjs';

function contract() {
  return JSON.parse(fs.readFileSync(new URL('../recovery-contract.json', import.meta.url), 'utf8'));
}

function caseById(value, id) {
  return value.cases.find((item) => item.id === id);
}

test('canonical recovery matrix is complete and deterministic', () => {
  assert.deepEqual(validateRecoveryContract(contract()), []);
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

test('credential-shaped content is rejected', () => {
  const value = contract();
  value.source.sha = 'ghp_abcdefghijklmnopqrstuvwxyz1234567890';
  assert.match(validateRecoveryContract(value).join('\n'), /credential-shaped value found/);
});
