import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { REPLAY_FIXTURE } from './fixtures/observational-replay.ts';
import { projectProgress } from '../extensions/progress-report.mjs';
import { readProgressReport } from '../extensions/progress-reader.mjs';

test('replay fixture reproduces the same findings the audit summary described, without claiming delivery', () => {
  const report = projectProgress(REPLAY_FIXTURE.map(receipt => ({ type: 'glla_progress_receipt', value: receipt, at: receipt.at })));
  const hegemon = report.runs.find(run => run.id === 'hegemon-snapshot');
  const darklord = report.runs.find(run => run.id === 'darklord');
  const studio = report.runs.find(run => run.id === 'studio');
  assert.equal(report.runs.length, 3);
  assert.equal(hegemon?.mode, 'metricless-loop');
  assert.equal(hegemon?.iterations, 686);
  assert.equal(hegemon?.capabilityProgress, 'unknown');
  assert.equal(hegemon?.phaseAccounting.durationsMs.building, 30_000);
  // Historical verification survives the conservative reopen that
  // dashboard reports would otherwise erase: theme is recorded as both
  // previously verified (audit-9) and currently open.
  const darklordHistory = darklord?.historicalVerification ?? [];
  const theme = darklordHistory.find(entry => entry.requirementId === 'theme');
  const feature = darklordHistory.find(entry => entry.requirementId === 'feature-toggle');
  assert.equal(theme?.attemptId, 'audit-9');
  assert.equal(theme?.current, false);
  assert.equal(feature?.current, true);
  assert.equal(studio?.phaseAccounting.provenance, 'observed');
  assert.equal(studio?.loadedVersion, '0.39.16');
  // Capability evidence for studio comes from the bookkeeping cycle, not
  // from any recorded verified requirement.
  assert.equal(studio?.capabilityProgress, 'unknown');
});

test('replay fixture is never written back: a journal roundtrip preserves input bytes and adds no receipts', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glla-replay-'));
  try {
    const persisted = REPLAY_FIXTURE.map(receipt => JSON.stringify({ type: 'glla_progress_receipt', value: receipt, at: receipt.at }) + '\n').join('');
    fs.writeFileSync(path.join(root, 'active.jsonl'), persisted);
    const before = (): [string, string[]] => [fs.readFileSync(path.join(root, 'active.jsonl'), 'utf8'), fs.readdirSync(root).sort()];
    const snapshot = before();
    const report = readProgressReport(root);
    assert.equal(report.source.bytesRead, Buffer.byteLength(persisted));
    assert.equal(report.source.malformedLines, 0);
    assert.equal(report.runs.length, 3);
    // Invariant: readProgressReport never opens for write. Directory snapshot
    // and journal bytes must be identical to the input.
    assert.deepEqual(snapshot, before());
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
