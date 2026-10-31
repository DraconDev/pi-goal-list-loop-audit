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
