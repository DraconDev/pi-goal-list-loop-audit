import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { configureProgressRuntime, observeProgressState, observeProgressIteration, type ProgressReceipt } from '../extensions/progress-observer.ts';
import { readProgressReport } from '../extensions/progress-reader.mjs';
import { projectProgress } from '../extensions/progress-report.mjs';

const state: any = {
  goal: { id: 'goal-1', policy: 'goal', status: 'active', objective: 'Ship a feature',
    usage: { tokensUsed: 1024, tokensLimit: 0 }, createdAt: '2026-10-08T00:00:00Z', updatedAt: '2026-10-08T00:00:00Z' },
  list: [], loop: null, mainModelRecovery: null, lastModelRef: undefined,
  lastCompactionAt: null, postCompactRecovery: null, supervisorPausedAt: undefined, loadHoldAt: undefined, lastOutcome: undefined,
};

const loopState: any = { ...state, loop: { startedAt: 'loop-1', active: true, iteration: 3, target: 'Build the product', maxIterations: 0,
  builder: { projectId: 'project-1', phase: 'building', cycle: 2, revision: 4, requirements: [
    { id: 'feature', text: 'Useful feature', acceptance: '...', status: 'open' },
    { id: 'other', text: 'Other', acceptance: '...', status: 'verified', evidence: { attemptId: 'old', report: '', model: '' } } ] } } };

function withObserver<T>(run: (root: string, emit: (r: ProgressReceipt) => void) => T): T {
  const receipts: ProgressReceipt[] = [];
  configureProgressRuntime('0.39.16', () => 7);
  return run(path.join(tmpdir(), 'glla-progress'), receipt => receipts.push(receipt));
}

test('observer retains pre-reset iteration signals and current version, and never alters a snapshot that failed to land', () => withObserver(root => {
  const received: ProgressReceipt[] = [];
  observeProgressState(root, { ...state, goal: { ...state.goal, status: 'active' } }, receipt => received.push(receipt), 1_700_000_000_000);
  observeProgressIteration(root, loopState.loop, { fileWrites: 7, gitCommits: 3, specItemProgress: 1, currentHead: 'a1b2c3d4' }, receipt => received.push(receipt), 1_700_000_001_000);
  // Subsequent goal state after the loop activity: phase interval is inferred,
  // requirement delta recorded, target status updated.
  observeProgressState(root, { ...loopState, goal: { ...state.goal, status: 'active' } }, receipt => received.push(receipt), 1_700_000_002_000);
  // FAILED LANDING: every receipt must already have been queued, and the
  // observer must not mutate, retry, or schedule a follow-up write.
  observeProgressState(root, { ...state, goal: { ...state.goal, status: 'paused' }, supervisorPausedAt: 1_700_000_003_000 }, receipt => received.push(receipt), 1_700_000_003_000);
  const states = received.filter(receipt => receipt.kind === 'state');
  const ended = received.filter(receipt => receipt.kind === 'ended');
  const iteration = received.find(receipt => receipt.kind === 'iteration')!;
  assert.equal(states.length, 3);
  assert.equal(iteration.kind, 'iteration');
  assert.equal(iteration.signals?.fileWrites, 7);
  assert.equal(iteration.signals?.gitCommits, 3);
  assert.equal(iteration.signals?.currentHead, 'a1b2c3d4');
  // Initial loop-bearing observation ended the goal-only run, so the
  // "ended" receipt is the rebind record — not a control decision.
  assert.equal(ended.length, 1);
  assert.equal(ended[0]?.reasonCode, 'target-no-longer-present');
  const [, secondGoal] = states;
  assert.equal(secondGoal?.interval?.milliseconds, 2000);
  assert.equal(secondGoal?.interval?.phase, 'building');
  assert.equal(secondGoal?.deltas?.some(delta => delta.id === 'other' && delta.to === 'verified'), true);
  const [first, , final] = states;
  assert.equal(first?.runtimeId, secondGoal?.runtimeId);
  assert.equal(first?.generation, 7);
  assert.equal(first?.version, '0.39.16');
  assert.equal(first?.phase, 'building');
  assert.equal(final?.reasonCode, 'supervisor-paused');
  assert.equal(final?.phase, 'waiting');
}));

test('observer preserves receipt identity, intervals and redacted blocked reasons after journaling', () => {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'glla-progress-write-'));
  try {
    configureProgressRuntime('0.39.16', () => 9);
    const issued: ProgressReceipt[] = [];
    observeProgressState(root, { ...state, goal: { ...state.goal, status: 'active', usage: { tokensUsed: 10, tokensLimit: 0 } } }, r => issued.push(r), 1_700_000_000_000);
    observeProgressState(root, { ...state, goal: { ...state.goal, status: 'active', usage: { tokensUsed: 60, tokensLimit: 0 } } }, r => issued.push(r), 1_700_000_000_500);
    const persisted = issued.map(receipt => JSON.stringify({ type: 'glla_progress_receipt', value: receipt, at: receipt.at }) + '\n').join('');
    fs.writeFileSync(path.join(root, 'active.jsonl'), persisted);
    console.log('issued', JSON.stringify(issued, null, 2));
    console.log('root', root);
    const report = readProgressReport(root);
    console.log(JSON.stringify(report, null, 2));
    const goal = report.runs.find(run => run.id === 'goal-1' && run.family === 'goal') ?? report.runs.find(run => run.id === 'goal-1');
    assert.equal(goal?.loadedVersion, '0.39.16');
    assert.equal(goal?.phaseAccounting.provenance, 'observed');
    assert.equal(goal?.phaseAccounting.durationsMs.building, 500);
  assert.equal(goal?.phaseAccounting.recordedTokens, 60);
    assert.equal(goal?.phaseAccounting.monetaryCost, 'unknown');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('observer tolerates runtime/telemetry exceptions without rolling back the accepted state', () => {
  const root = path.join(tmpdir(), 'glla-progress');
  configureProgressRuntime('0.39.16', () => 1);
  // Pass a state value the observer cannot interpret; the function must swallow
  // the exception and still return undefined rather than throwing into the host.
  const receipt = (r: ProgressReceipt) => undefined;
  assert.doesNotThrow(() => observeProgressState(root, null as never, receipt));
  assert.doesNotThrow(() => observeProgressIteration(root, null as never, { fileWrites: 0, gitCommits: 0, specItemProgress: 0 }, receipt));
});

test('replacement generation breaks the interval inference fence and old activity is not attributed to a new session', () => {
  const records: any[] = [];
  configureProgressRuntime('0.39.16', () => 3);
  observeProgressState(path.join(tmpdir(), 'glla-r1'), { ...state, goal: { ...state.goal, status: 'active' } }, receipt => records.push({ ...receipt }), 1_700_000_000_000);
  // Same host, bumped session generation, six minutes later. The receipt must
  // NOT carry an interval across the rebind, and provenance must be observed.
  const receipts: ProgressReceipt[] = [];
  configureProgressRuntime('0.39.16', () => 4);
  observeProgressState(path.join(tmpdir(), 'glla-r1'), { ...state, goal: { ...state.goal, status: 'active' } }, receipt => receipts.push(receipt), 1_700_000_360_000);
  assert.equal(receipts[0]?.interval, undefined);
  assert.notEqual(records[0]?.runtimeId, receipts[0]?.runtimeId);
});

test('projected interval durations aggregate but never claim a previous run started the current one', () => {
  const receipt: ProgressReceipt = { schemaVersion: 1, receiptId: 'r', runtimeId: 'rt', generation: 1, rootId: 'root',
    runId: 'project-1', family: 'project', mode: 'requirement-builder', kind: 'state', version: '0.39.16',
    at: '2026-10-08T00:00:01.000Z', phase: 'verification', interval: { phase: 'verification', milliseconds: 2000, provenance: 'inferred-between-state-observations' },
    tokensUsed: 99, cycle: 5, revision: 11, attemptId: 'audit-2', deltas: [{ id: 'feature', from: 'open', to: 'verified', attemptId: 'audit-2' }] };
  const report = projectProgress([{ type: 'glla_progress_receipt', value: receipt, at: receipt.at }]);
  const run = report.runs[0];
  assert.equal(run?.id, 'project-1');
  assert.equal(run?.loadedVersion, '0.39.16');
  assert.equal(run?.cycle, 5);
  assert.equal(run?.checkpoint.revision, 'r11');
  assert.equal(run?.phaseAccounting.durationsMs.verification, 2000);
  assert.equal(run?.phaseAccounting.recordedTokens, 99);
  assert.equal(run?.historicalVerification[0]?.attemptId, 'audit-2');
  assert.equal(run?.capabilityProgress, 'recorded-current-verification');
});
