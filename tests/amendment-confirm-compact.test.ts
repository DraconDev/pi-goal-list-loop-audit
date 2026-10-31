// tests/amendment-confirm-compact.test.ts
//
// note.md 2026-10-31: the tweak/amendment confirm was "the ugly wall of text".
// The old body printed five labelled sections and reprinted BOTH full contracts
// even when nothing about the contract had changed.
//
// The requirement is not "short for its own sake": the confirm IS the consent
// record, so it must still show the EXACT old and new objective. What it must
// stop doing is reprinting an unchanged contract and burying the decision.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAmendmentConfirmBody } from '../extensions/confirm-draft.js';

const LONG_OBJECTIVE =
  'Make a mid-audit provider failure resume the independent auditor own pi session instead of '
  + 'discarding its completed work, including every retained-session interaction and the durable '
  + 'ledger lineage requirement, while keeping verdict integrity unchanged.';

test('the amendment confirm keeps the exact old and new objective text', () => {
  const body = buildAmendmentConfirmBody({
    oldObjective: 'Ship the feature',
    newObjective: 'Ship the feature and its tests',
  });
  // Consent fidelity: both sides verbatim, so the user approves a specific pair.
  assert.match(body, /Ship the feature\b/, 'the old objective appears');
  assert.match(body, /Ship the feature and its tests/, 'the new objective appears');
  assert.match(body, /auditor will judge/, 'the consequence is still stated');
});

test('an unchanged contract is NOT reprinted — that was most of the wall', () => {
  const contract = 'npm run check exits 0; npm run release:check exits 0';
  const body = buildAmendmentConfirmBody({
    oldObjective: 'Ship the feature',
    newObjective: 'Ship the feature and its tests',
    oldContract: contract,
    newContract: contract,
  });
  assert.equal(body.includes(contract), false,
    'an identical contract must not be echoed twice; it is not part of the decision');
  assert.match(body, /Contract: unchanged/, 'the user is still told the contract is untouched');
});

test('a changed contract IS shown, both sides', () => {
  const body = buildAmendmentConfirmBody({
    oldObjective: 'Ship the feature',
    newObjective: 'Ship the feature and its tests',
    oldContract: 'npm run check exits 0',
    newContract: 'npm run check and npm run release:check both exit 0',
  });
  assert.match(body, /npm run check exits 0/, 'the previous contract is shown when it changes');
  assert.match(body, /release:check/, 'the proposed contract is shown when it changes');
});

test('a long objective is clipped with a visible marker, never silently cut', () => {
  const body = buildAmendmentConfirmBody({
    oldObjective: LONG_OBJECTIVE,
    newObjective: LONG_OBJECTIVE + ' Additionally record lineage.',
  });
  const lines = body.split('\n').filter((line) => line.trim());
  // The decision must fit on screen: no body line may run to paragraph length.
  for (const line of lines) {
    assert.ok(line.length <= 340, `confirm lines must stay readable, got ${line.length} chars`);
  }
  assert.match(body, /…/, 'a clipped objective carries an explicit ellipsis marker');
  // The tail is kept because acceptance clauses live there.
  assert.match(body, /lineage/, 'the tail of a long objective survives the clip');
});

test('the compact body is measurably smaller than the old five-section form', () => {
  const oldForm = `Current objective:\n${LONG_OBJECTIVE}\n\nCurrent verification contract:\n${'x'.repeat(300)}`
    + `\n\nProposed objective:\n${LONG_OBJECTIVE} Additionally record lineage.`
    + `\n\nProposed verification contract:\n${'x'.repeat(300)}`
    + `\n\nThis changes what the independent auditor will judge. Approve this specific amendment?`;
  const compact = buildAmendmentConfirmBody({
    oldObjective: LONG_OBJECTIVE,
    newObjective: `${LONG_OBJECTIVE} Additionally record lineage.`,
    oldContract: 'x'.repeat(300),
    newContract: 'x'.repeat(300),
  });
  assert.ok(compact.length < oldForm.length / 2,
    `the default body must be materially shorter (${compact.length} vs ${oldForm.length})`);
});
