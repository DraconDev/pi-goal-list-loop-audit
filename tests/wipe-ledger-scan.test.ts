// tests/wipe-ledger-scan.test.ts
//
// note.md item 3 ("/glla wipe is slow... after waiting it out everything was
// normal"). Measured at the real profile: 32 ledger segments / 287 MB, and the
// FULL-history scan the depth and status surfaces used took 4.84 s of
// synchronous main-thread work — the "looks frozen" signature.
//
// This pins the CAUSE (unbounded ledger rescanning), not merely that a call
// returns: the indexed read must stay bounded as history grows AND converge to
// exactly the answer a full scan gives.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  __testOnlyLedgerIndexReadBytes as ledgerIndexReadBytes,
  __testOnlyLedgerScanRecordsCalls as scanRecordsCalls,
  __testOnlyResetLedgerScanRecordsCalls as resetScanRecordsCalls,
  __testOnlyResetLedgerIndexReadBytes as resetLedgerIndexReadBytes,
  computeListDepth, computeListDepthFromLedger, scanLedgerRecords,
} from '../extensions/goal-loop-core.js';
import { scaledBudgetMs } from '../scripts/host-contention.mjs';
import { tmpCwd } from './harness/mock-pi.js';

const NOW = Date.parse('2026-11-01T00:00:00.000Z');

/** A state dir with a deliberately large ledger: N segments, each with lots of
 * non-state noise plus a few completed list-policy goals deep in history. */
function bigLedger(cwd: string, segments: number, noiseRows: number): void {
  const segDir = path.join(cwd, '.pi-glla', 'ledger-segments');
  fs.mkdirSync(segDir, { recursive: true });
  for (let s = 0; s < segments; s++) {
    const lines: string[] = [];
    for (let i = 0; i < noiseRows; i++) {
      lines.push(JSON.stringify({ type: 'audit_heartbeat', value: { i, s, padding: 'x'.repeat(120) }, at: '2026-10-01T00:00:00.000Z' }));
    }
    // One completed list-policy goal per segment, deep in the history.
    const gid = `goal-${s}`;
    lines.push(JSON.stringify({
      type: 'state',
      value: {
        goal: {
          id: gid, policy: 'list', status: 'complete',
          createdAt: '2026-09-20T00:00:00.000Z', updatedAt: '2026-09-20T01:00:00.000Z',
        },
      },
      at: '2026-09-20T01:00:00.000Z',
    }));
    fs.writeFileSync(path.join(segDir, `segment-${String(s).padStart(6, '0')}.jsonl`), lines.join('\n') + '\n');
  }
}

const queue = [{ id: 'q1', addedAt: '2026-10-01T00:00:00.000Z' }];

test('the depth read is bounded as ledger history grows (the wipe freeze)', () => {
  const cwd = tmpCwd();
  bigLedger(cwd, 24, 20_000); // ~60 MB of history

  // Bounded cost: the old full scan read every byte and took seconds here.
  const budget = scaledBudgetMs(1200);
  const started = Date.now();
  const first = computeListDepthFromLedger(queue, cwd, NOW);
  const elapsed = Date.now() - started;
  assert.ok(elapsed < budget,
    `the first indexed read took ${elapsed}ms, budget ${budget}ms — it must not rescan all history`);
  // Backfill is deliberately sliced, so the FIRST call may still have thin
  // coverage; what matters is that the call is bounded and the queue facts are
  // right. Convergence to the full answer is the next test.
  assert.equal(first.queueDepth, 1, 'the queue facts are correct');
  assert.equal(first.oldestItemId, 'q1', 'the oldest item is identified');
  assert.ok(first.durationSamples >= 0, 'sample coverage is reported, not guessed');
});

test('the indexed read converges to EXACTLY the full-scan answer', () => {
  const cwd = tmpCwd();
  bigLedger(cwd, 12, 8_000);

  // The reference answer, computed the old way (allowed to be slow — one time).
  const finals = new Map<string, { type: string; value?: any }>();
  scanLedgerRecords(cwd, (entry) => {
    if (entry.type === 'state' && entry.value?.goal?.id) finals.set(String(entry.value.goal.id), entry);
  });
  const reference = computeListDepth(queue, [...finals.values()], NOW);

  // Bounded backfill converges; it must land on the identical answer.
  let got = computeListDepthFromLedger(queue, cwd, NOW);
  for (let i = 0; i < 200 && JSON.stringify(got) !== JSON.stringify(reference); i++) {
    got = computeListDepthFromLedger(queue, cwd, NOW);
  }
  assert.deepEqual(got, reference, 'the indexed read must not lose or invent samples');
});

test('a warm read folds ZERO ledger bytes — it never rescans history', () => {
  const cwd = tmpCwd();
  bigLedger(cwd, 12, 8_000);
  // Warm the index: bounded slices until full coverage.
  for (let i = 0; i < 200; i++) computeListDepthFromLedger(queue, cwd, NOW);

  // Deterministic pin: the cause was re-reading ledger bytes, so once warm the
  // read must touch none. A wall-clock ceiling alone is a weak pin — a loaded
  // host can slip under it while the full rescan is still happening.
  resetLedgerIndexReadBytes();
  resetScanRecordsCalls();
  computeListDepthFromLedger(queue, cwd, NOW);
  assert.equal(ledgerIndexReadBytes(), 0,
    'a warm depth read folded ledger bytes — the unbounded rescan is back');
  // The direct statement of the cause: the depth read must not invoke the
  // full-history scanner at all.
  assert.equal(scanRecordsCalls(), 0,
    'the depth read called scanLedgerRecords — the unbounded rescan is back');

  // And repeated reads stay at zero, so a status render cannot creep.
  for (let i = 0; i < 5; i++) computeListDepthFromLedger(queue, cwd, NOW);
  assert.equal(ledgerIndexReadBytes(), 0, 'repeated warm reads must stay at zero bytes');
  assert.equal(scanRecordsCalls(), 0, 'repeated warm reads must never rescan');
});
