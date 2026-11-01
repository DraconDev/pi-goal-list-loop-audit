// tests/auditor-model-display.test.ts
//
// note.md 2026-10-31: "I often see the auditor as openai luna max even though I
// use session."
//
// The audit card resolved its model with a preference order that fell back to
// the CONFIGURED candidate refs before the model that actually ran, so a
// session-model audit was labelled with a configured auditor pin that was never
// dispatched. The card must name what ran.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildWidgetLines } from '../extensions/goal-loop-display.js';
import { seedGoal } from './harness/mock-pi.js';
import type { State } from '../extensions/goal-loop-core.js';

const NOW = Date.parse('2026-10-31T09:22:00Z');
const CONFIGURED = 'openai-codex/gpt-6-luna';
const SESSION_MODEL = 'minimax/MiniMax-M3.1-Flash';

function auditState(claim: Record<string, unknown>, auditModel?: string): State {
  return {
    goal: seedGoal({
      status: 'auditing',
      objective: 'Verify the feature',
      verificationContract: 'Inspect the behavior',
      pendingCompletion: {
        at: new Date().toISOString(),
        attemptId: 'audit-model-display',
        claimLineageId: 'claim-model-display',
        completionSummary: 'Outcome: verified. Changed: behavior. Evidence: tests. Tests: pass. Unresolved: none. Next: none.',
        verificationSummary: 'Fixture only',
        phase: 'starting',
        auditorCandidateRef: CONFIGURED,
        auditorCandidateRefs: [CONFIGURED],
        ...claim,
      },
    }),
    list: [],
  } as unknown as State;
}

function cardText(state: State, auditModel?: string): string {
  const audit = auditModel
    ? { label: 'thinking', model: auditModel, phase: 'running', lastEventAt: NOW - 5_000 } as never
    : null;
  return (buildWidgetLines(state, audit, NOW, undefined, undefined) ?? []).join('\n');
}

test('a session-model audit names the model that ran, not a configured pin', () => {
  // The exact note.md shape: configured primary is the luna pin, but the audit
  // ran on the session model.
  const text = cardText(auditState({ auditorSourceModel: SESSION_MODEL }), SESSION_MODEL);
  assert.ok(text.includes(SESSION_MODEL),
    'the card must name the model that actually ran');
  assert.ok(/session model/i.test(text),
    'a session-model audit says so plainly instead of looking like a configured pin');
  // The contract's SECOND half: a configured candidate that was never dispatched
  // must not be reported at all. Presence-only assertions cannot see a card that
  // names the real model AND appends the pin, which is the exact forbidden
  // output — audit round 5 proved such a mutation passed all four tests.
  assert.equal(text.includes(CONFIGURED), false,
    `the card must not name the configured candidate that was never dispatched (${CONFIGURED})`);
});

test('a configured-pin audit is NOT mislabelled as the session model', () => {
  // The opposite error: when the audit really did run on the configured pin, the
  // card must not claim "session model".
  const text = cardText(auditState({ auditorSourceModel: CONFIGURED }), CONFIGURED);
  assert.ok(text.includes(CONFIGURED), 'the configured pin that ran is named');
  assert.equal(/session model/i.test(text), false,
    'a configured auditor run must not be labelled a session model');
});

test('the configured ref is only used when nothing recorded an executed model', () => {
  // No executed model anywhere: falling back to the configured ref is correct,
  // and it must NOT be presented as a session model (nothing proves that).
  const text = cardText(auditState({}), undefined);
  assert.ok(text.includes(CONFIGURED), 'with no recorded model the configured ref is shown');
  assert.equal(/session model/i.test(text), false,
    'an unproven session-model claim is never asserted');
});

test('the recorded executed model outranks the configured candidate', () => {
  // Both exist and differ: the executed one wins. This is the precedence bug
  // that produced the note.md observation.
  const text = cardText(
    auditState({ auditorSourceModel: SESSION_MODEL, auditorRetryCandidateRef: CONFIGURED }),
    undefined,
  );
  // Both refs are recorded and differ: the executed one is shown, the candidate
  // it outranks is not. Asserting the executed ref alone (or the label alone via
  // a disjunction) would let the card print both.
  assert.ok(text.includes(SESSION_MODEL),
    'the recorded executed model is preferred to the configured retry candidate');
  assert.equal(text.includes(CONFIGURED), false,
    'and the configured candidate it outranks is not reported alongside it');
});
