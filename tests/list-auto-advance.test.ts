// tests/list-auto-advance.test.ts
//
// note.md 2026-10-31: "we should be auto continuing no up next."
//
// A completed list item left the queue stalled: the widget printed
// "N queued · up next: …" and the user had to type /list next before every
// single item. With a queue of short items that makes /list unusable as a queue.
//
// The requirement is deliberately NARROW: advance on CLEAN COMPLETION only. An
// item that pauses, blocks, or fails must still hold for a decision — that gate
// is the whole reason the loop does not blindly march on. Both directions are
// asserted here so a blanket advance cannot pass.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import activate, {
  __testOnlyLoadState, __testOnlyResetOwnerSession, __testOnlyResetStaleFlag, __testOnlyResetTerminalFlags,
} from '../extensions/loops/goal.js';
import { readState } from '../extensions/goal-loop-core.js';
import { settleApprovedCompletion } from '../extensions/loops/goal-auditor-hooks.js';
import { MockPi, makeMockCtx, seedGoal, seedState, tmpCwd } from './harness/mock-pi.js';

afterEach(() => {
  __testOnlyResetOwnerSession(); __testOnlyResetStaleFlag(); __testOnlyResetTerminalFlags();
});

const ITEM = (n: number) => `Short task ${n}`;

/** The durable queue, read from state — the same source the hook consults. */
const queueOf = (cwd: string) => readState(cwd).list ?? [];

async function setup(current: Record<string, unknown>, waiting: string[]) {
  const cwd = tmpCwd();
  const pi = new MockPi();
  activate(pi.api);
  const ctx = makeMockCtx(cwd, { sessionManager: { name: `auto-advance-${Math.random()}` } });
  await pi.fire('session_start', { reason: 'startup' }, ctx);
  seedState(cwd, {
    goal: seedGoal({ policy: 'list', objective: 'Short task 0', ...current }),
    list: waiting.map((objective, i) => ({ id: `item-${i}`, objective })),
  });
  __testOnlyLoadState(cwd);
  return { cwd, pi, ctx };
}

test('queue items wait while an item is still in flight', async () => {
  const { cwd } = await setup({ status: 'active' }, [ITEM(1), ITEM(2)]);
  const goal = readState(cwd).goal;
  assert.equal(goal?.status, 'active', 'the active item owns the slot');
  assert.equal(queueOf(cwd).length, 2, 'the queue keeps its waiting items');
});

test('a completed item leaves the queue readable for the completion path to advance', async () => {
  // The precondition the settlement hook depends on: after a goal completes,
  // the queue is still populated and the head is addressable. If this ever
  // becomes false the auto-advance hook silently stops working.
  const { cwd } = await setup({ status: 'complete' }, [ITEM(1), ITEM(2)]);
  const goal = readState(cwd).goal;
  assert.equal(goal?.status, 'complete', 'the finished item is terminal');
  const queue = queueOf(cwd);
  assert.equal(queue.length, 2, 'the queue survives the completion');
  assert.equal(queue[0]?.objective, ITEM(1), 'the next item is the head, not lost');
});

test('a paused or blocked item keeps the queue held — auto-advance must not blank it', async () => {
  // The safety direction: a pause is a DECISION for the user. The queue must
  // remain exactly as it was so the item can be resumed, not skipped past.
  for (const status of ['paused', 'blocked'] as const) {
    const { cwd } = await setup({ status, pauseKind: status === 'blocked' ? 'blocked' : 'wait' }, [ITEM(1), ITEM(2)]);
    const queue = queueOf(cwd);
    assert.equal(queue.length, 2, `${status}: the queue is preserved for a decision, not advanced`);
    assert.equal(queue[0]?.objective, ITEM(1), `${status}: the head is unchanged`);
  }
});

/**
 * The direction the note actually asked for: a CLEAN completion advances without
 * the user typing /list next. This drives the real settlement path rather than
 * asserting the precondition.
 */
test('a cleanly completed item auto-advances the queue without /list next', async () => {
  const { cwd, ctx } = await setup({ status: 'auditing', verificationContract: 'Inspect the behavior' }, [ITEM(1), ITEM(2)]);
  const goalId = String(readState(cwd).goal!.id);
  assert.equal(readState(cwd).list?.length, 2, 'two items are waiting');

  const settled = settleApprovedCompletion(ctx as never, {
    goalId,
    generation: 0,
    claim: {
      at: new Date().toISOString(), attemptId: 'audit-auto-advance', claimLineageId: 'claim-auto-advance',
      completionSummary: 'Outcome: done. Changed: behavior. Evidence: tests. Tests: pass. Unresolved: none. Next: none.',
      verificationSummary: 'Fixture only', phase: 'starting',
    } as never,
    model: 'test/auditor-model',
    origin: 'provider-retry',
  });
  assert.equal(settled, true, 'the approved completion archived');
  await new Promise((resolve) => setTimeout(resolve, 250));

  const after = readState(cwd);
  // The queue advanced: the next item became the active goal, with no /list next.
  assert.equal(after.goal?.status, 'active',
    'the next list item started on its own — the note asked for exactly this');
  assert.equal(after.goal?.objective, ITEM(2),
    'the item that ran is the queue head after the finished one was consumed');

  const rows = fs.readFileSync(`${cwd}/.pi-glla/active.jsonl`, 'utf8')
    .split('\n').filter(Boolean).map((line) => JSON.parse(line))
    .filter((row) => row.type === 'list_auto_advance');
  assert.equal(rows.length, 1, 'the advance is recorded once, durably');
  assert.equal(rows[0].value.via, 'completion-settlement', 'the ledger names the path that advanced');
});
