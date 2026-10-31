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
import { scaledBudgetMs } from '../scripts/host-contention.mjs';

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
    // Hang bounds, host-scaled: a busy machine must not fail a healthy leg.
    const ceiling = scaledBudgetMs(budget);
    assert.ok(measured < ceiling,
      `${name} took ${measured.toFixed(1)}ms, ceiling ${ceiling}ms — wipe latency regressed`);
  }
});

test('a pathologically expensive reader is caught, not just a slow one', () => {
  // v0.39.61: an earlier version of this test asserted "10x the journal must not
  // cost 10x the time". That premise was WRONG and the assertion was vacuous:
  // readState is I/O-bound, so it already scales roughly linearly with file size
  // (measured 2.3ms at 50 rows -> 21ms at 2000). A control proved it caught
  // nothing. What matters for a user-visible freeze is an absolute ceiling on
  // realistic and oversized journals, so the cost of any accidental per-record
  // work shows up as a number rather than hiding inside a generous ratio.
  const realistic = tmpCwd();
  seedLargeJournal(realistic, 200);   // well beyond the live 109-row profile
  const oversized = tmpCwd();
  seedLargeJournal(oversized, 2000);  // ~10x beyond anything observed

  const realisticMs = medianMs(5, () => readState(realistic));
  const oversizedMs = medianMs(5, () => readState(oversized));

  // Ceilings are far below a perceptible freeze (< 250ms) yet comfortably above
  // the measured baseline (a few ms), so a loaded host cannot flake them while
  // per-record work added in the wipe path fails loudly.
  // v0.39.61: these are HANG BOUNDS, not benchmarks, so they must scale with the
  // host. Fixed wall-clock ceilings failed on a loaded host (load ~58 on 16
  // cores) for a reader that was provably fine — the same lesson the frame-budget
  // guard enforces elsewhere. scaledBudgetMs keeps the ceiling meaningful on an
  // idle host while not turning contention into a false failure.
  const realisticCeiling = scaledBudgetMs(120);
  const oversizedCeiling = scaledBudgetMs(200);
  assert.ok(realisticMs < realisticCeiling,
    `readState took ${realisticMs.toFixed(1)}ms at 200 rows, ceiling ${realisticCeiling}ms — wipe would feel slow`);
  assert.ok(oversizedMs < oversizedCeiling,
    `readState took ${oversizedMs.toFixed(1)}ms at 2000 rows, ceiling ${oversizedCeiling}ms — cost grew beyond I/O`);
});
