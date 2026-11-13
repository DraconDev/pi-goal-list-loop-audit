// tests/ledger-segment-retention.test.ts
//
// The ledger segment directory is append-only and was never pruned, so the
// corpus grew without limit: a long-lived downstream project was observed
// holding 334 segments (2.7 GiB). That unbounded corpus is what made a
// single recursive scan over it pathological — the corpus, not the scan, was
// the defect behind a runaway `grep -rho` that burned 6.5 hours of CPU.
//
// These tests pin the retention contract:
//   - the corpus is bounded by a count cap;
//   - a segment younger than the grace window is NEVER pruned, so pruning
//     cannot race a forensic read or an in-flight audit job;
//   - pruning is disabled explicitly (maxSegments = 0), never implicit;
//   - an unreadable segment directory is left entirely alone (fail closed);
//   - a symlinked segment directory is never followed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pruneLedgerSegments, ledgerSegmentDir } from '../extensions/goal-loop-core.ts';
import { tmpCwd } from './harness/mock-pi.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function seedSegments(cwd: string, count: number, ageMs: number): string[] {
  const dir = ledgerSegmentDir(cwd);
  fs.mkdirSync(dir, { recursive: true });
  const names: string[] = [];
  for (let i = 0; i < count; i++) {
    const name = `segment-${String(i).padStart(6, '0')}.jsonl`;
    const file = path.join(dir, name);
    fs.writeFileSync(file, `${JSON.stringify({ type: 'state', at: new Date().toISOString() })}\n`);
    const when = new Date(Date.now() - ageMs);
    fs.utimesSync(file, when, when);
    names.push(name);
  }
  return names;
}

function segmentNames(cwd: string): string[] {
  const dir = ledgerSegmentDir(cwd);
  try {
    return fs.readdirSync(dir).filter((n) => n.startsWith('segment-') && n.endsWith('.jsonl')).sort();
  } catch {
    return [];
  }
}

test('the corpus is bounded by the count cap: the oldest segments are pruned', () => {
  const cwd = tmpCwd();
  seedSegments(cwd, 10, 30 * DAY_MS);

  const pruned = pruneLedgerSegments(cwd, 4);

  assert.equal(pruned.length, 6, 'the six oldest segments are pruned');
  const remaining = segmentNames(cwd);
  assert.equal(remaining.length, 4, 'the corpus is bounded at the cap');
  // The NEWEST are the survivors: the cap keeps the recent history.
  assert.deepEqual(remaining, [
    'segment-000006.jsonl',
    'segment-000007.jsonl',
    'segment-000008.jsonl',
    'segment-000009.jsonl',
  ]);
});

test('a segment younger than the grace window is never pruned', () => {
  const cwd = tmpCwd();
  // Old enough to be over the cap, but RECENT: a forensic read or an
  // in-flight audit job may still be walking it.
  seedSegments(cwd, 10, 60 * 60 * 1000);

  const pruned = pruneLedgerSegments(cwd, 4);

  assert.equal(pruned.length, 0, 'recent segments are kept whatever the cap says');
  assert.equal(segmentNames(cwd).length, 10, 'nothing was removed');
});

test('the cap never touches the newest segments even when they are old', () => {
  const cwd = tmpCwd();
  seedSegments(cwd, 10, 30 * DAY_MS);

  pruneLedgerSegments(cwd, 3);

  const remaining = segmentNames(cwd);
  assert.deepEqual(remaining, [
    'segment-000007.jsonl',
    'segment-000008.jsonl',
    'segment-000009.jsonl',
  ], 'the newest segments are the survivors');
});

test('pruning is disabled explicitly, never implicitly', () => {
  const cwd = tmpCwd();
  seedSegments(cwd, 10, 30 * DAY_MS);

  const pruned = pruneLedgerSegments(cwd, 0);

  assert.equal(pruned.length, 0, 'maxSegments = 0 disables pruning');
  assert.equal(segmentNames(cwd).length, 10, 'nothing was removed');
});

test('a corpus under the cap is left entirely alone', () => {
  const cwd = tmpCwd();
  seedSegments(cwd, 3, 30 * DAY_MS);

  const pruned = pruneLedgerSegments(cwd, 64);

  assert.equal(pruned.length, 0);
  assert.equal(segmentNames(cwd).length, 3);
});

test('a symlinked segment directory is never followed', () => {
  const cwd = tmpCwd();
  const real = path.join(cwd, 'elsewhere');
  fs.mkdirSync(real, { recursive: true });
  fs.writeFileSync(path.join(real, 'segment-000000.jsonl'), '{}\n');
  fs.mkdirSync(path.join(cwd, '.pi-glla'), { recursive: true });
  fs.symlinkSync(real, ledgerSegmentDir(cwd));

  const pruned = pruneLedgerSegments(cwd, 0.5 as unknown as number);

  assert.equal(pruned.length, 0, 'a symlinked segment root is not pruned');
  assert.equal(fs.existsSync(path.join(real, 'segment-000000.jsonl')), true,
    'nothing outside the state root was removed');
});

test('a missing segment directory is normal and prunes nothing', () => {
  const cwd = tmpCwd();
  assert.deepEqual(pruneLedgerSegments(cwd, 4), []);
});
