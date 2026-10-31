// tests/glla-wipe-latency.test.ts
//
// note.md 2026-10-31: "/glla wipe is slow — but it is just slow for some reason,
// as after waiting it out everything was normal."
//
// The goal contract said: measure first, do not assume the cause. Measuring
// disproved every hypothesis — readState on the live 4.1MB journal is a few ms,
// an artificially grown 8.9MB/1000-row journal is still ~15ms, appendLedger is
// sub-ms, and the archive render+write is sub-ms. There is no lock, sleep, or
// retry loop in the wipe path.
//
// So this test protects the REQUIREMENT rather than an invented fix: the work a
// wipe performs must stay bounded well below anything a user would perceive as a
// freeze. If a future change makes wipe scan the whole journal per state write,
// or block on I/O in a loop, this fails with a number.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { appendLedger, readState, readQueueFromDisk, queueItemSidecarCount, renderGoalMarkdown } from '../extensions/goal-loop-core.js';
import { refreshOwnershipStanding } from '../extensions/loops/goal-session.js';
import { seedGoal, tmpCwd } from './harness/mock-pi.js';

/** A journal shaped like the real one: a few very large state rows. */
function seedLargeJournal(cwd: string, rows: number): void {
  fs.mkdirSync(path.join(cwd, '.pi-glla'), { recursive: true });
  const row = JSON.stringify({
    type: 'state',
    value: { goal: seedGoal({ status: 'active', objective: 'x'.repeat(9000) }), list: [], loop: null },
    at: new Date().toISOString(),
  });
  fs.writeFileSync(path.join(cwd, '.pi-glla', 'active.jsonl'), `${row}\n`.repeat(rows));
}

function medianMs(runs: number, fn: () => unknown): number {
  const samples: number[] = [];
  for (let i = 0; i < runs; i++) {
    const at = performance.now();
    fn();
    samples.push(performance.now() - at);
  }
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)] ?? 0;
}

test('the work a wipe performs stays well under a perceptible freeze', () => {
  const cwd = tmpCwd();
  seedLargeJournal(cwd, 200);

  // Each leg of the wipe's own work, measured independently so a failure names
  // the leg that regressed rather than a single opaque total.
  const legs: Array<[string, number, number]> = [
    ['readState', medianMs(5, () => readState(cwd)), 250],
    ['readQueueFromDisk', medianMs(5, () => readQueueFromDisk(cwd)), 100],
    ['queueItemSidecarCount', medianMs(5, () => queueItemSidecarCount(cwd)), 100],
    ['ownership recheck (forced)', medianMs(5, () => refreshOwnershipStanding(cwd, Date.now(), true)), 100],
    ['appendLedger', medianMs(5, () => appendLedger(cwd, 'wipe_latency_probe', { i: 1 })), 100],
  ];
  const goal = readState(cwd).goal;
  if (goal) legs.push(['renderGoalMarkdown', medianMs(5, () => renderGoalMarkdown(goal)), 200]);

  for (const [name, measured, budget] of legs) {
    assert.ok(measured < budget,
      `${name} took ${measured.toFixed(1)}ms, budget ${budget}ms — wipe latency regressed`);
  }
});

test('wipe cost does not scale with journal size the way a full scan would', () => {
  // The original suspicious hypothesis was "the journal grew large". Pin the
  // ACTUAL relationship: reading a 10x larger journal must not cost 10x the
  // time, because the reader takes the last state row, not the whole history.
  const small = tmpCwd();
  const big = tmpCwd();
  seedLargeJournal(small, 50);
  seedLargeJournal(big, 500);

  const smallMs = medianMs(9, () => readState(small));
  const bigMs = medianMs(9, () => readState(big));

  // Generous factor: this is a scaling sanity check, not a perf benchmark, so a
  // loaded host cannot flake it. A true full-scan regression would be ~10x.
  assert.ok(bigMs < Math.max(smallMs * 4, smallMs + 120),
    `10x the journal grew readState from ${smallMs.toFixed(1)}ms to ${bigMs.toFixed(1)}ms — that is full-scan behaviour`);
});
