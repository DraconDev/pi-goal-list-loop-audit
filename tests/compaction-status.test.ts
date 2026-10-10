import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { projectCompactionStatus, readCompactionMetadata, type CompactionObservation } from '../extensions/compaction-status.js';
import { projectUiStatus } from '../extensions/ui-status.js';
import { uiStatusContextFromRuntime } from '../extensions/ui-status-runtime.js';
import { buildWidgetLines, buildStatusText } from '../extensions/goal-loop-display.js';
import type { State } from '../extensions/goal-loop-core.js';

const NOW = 1_800_000_000_000;
const input: CompactionObservation = { tokens: 400_000, threshold: 200_000, observedAt: NOW,
  supervising: true, audit: false, paused: false, recovery: false, idle: true, pending: false,
  available: true, pressureBudget: false, marker: 'absent' };

test('compaction projection names each safe-boundary admission reason', () => {
  const cases: Array<[Partial<CompactionObservation>, string]> = [
    [{}, 'eligible'], [{ tokens: undefined }, 'unknown-usage'], [{ tokens: NaN }, 'unknown-usage'],
    [{ tokens: 199_999 }, 'below-target'], [{ tokens: 400_000, threshold: 500_000 }, 'below-target'],
    [{ idle: false }, 'busy'], [{ pending: true }, 'pending'], [{ idle: undefined }, 'boundary-unknown'],
    [{ audit: true, supervising: false }, 'audit'], [{ paused: true, supervising: false }, 'paused'],
    [{ recovery: true, supervising: false }, 'recovery'], [{ supervising: false }, 'unsupervised'],
    [{ compacting: true }, 'compacting'], [{ pressureBudget: true }, 'pressure-budget'],
    [{ marker: 'suppressed' }, 'prior-attempt'], [{ marker: 'rearming' }, 'rearming'],
    [{ marker: 'unknown' }, 'metadata-unknown'], [{ available: false }, 'unavailable'],
  ];
  for (const [patch, reason] of cases) {
    const observation = { ...input, ...patch }; const before = { ...observation };
    assert.equal(projectCompactionStatus(observation).reason, reason);
    assert.deepEqual(observation, before, 'projection never mutates admission state');
  }
  assert.equal(projectCompactionStatus({ ...input, threshold: NaN }).threshold, 200_000);
  assert.match(projectCompactionStatus(input).note, /not a hard ceiling/);
});

test('metadata inspection is bounded, read-only and distinguishes spent budgets from other work', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glla-compaction-status-'));
  const marker = path.join(root, 'marker.json'), budget = path.join(root, 'budget.json');
  const read = (tokens = 400_000) => readCompactionMetadata(marker, budget, 'goal:current', NOW, tokens, 200_000);
  try {
    assert.deepEqual(read(), { marker: 'absent', pressureBudget: false });
    fs.writeFileSync(marker, JSON.stringify({ at: new Date(NOW - 240_000).toISOString(), completedAt: NOW - 180_000 }));
    fs.writeFileSync(budget, JSON.stringify({ key: 'goal:old' }));
    const before = fs.readFileSync(marker, 'utf8');
    assert.equal(read().marker, 'rearming');
    assert.equal(fs.readFileSync(marker, 'utf8'), before, 'inspection does not clear eligible markers');
    fs.writeFileSync(marker, JSON.stringify({ at: new Date(NOW - 240_000).toISOString() }));
    fs.writeFileSync(budget, JSON.stringify({ key: 'goal:current' }));
    assert.deepEqual(read(), { marker: 'suppressed', pressureBudget: true });
    assert.equal(read(50_000).marker, 'rearming');
    fs.writeFileSync(marker, 'x'.repeat(4097)); assert.equal(read().marker, 'unknown');
    fs.unlinkSync(marker); fs.symlinkSync(budget, marker); assert.equal(read().marker, 'unknown');
    fs.unlinkSync(marker); fs.writeFileSync(marker, '{bad'); assert.equal(read().marker, 'unknown');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

function fixture(): State {
  return { goal: { id: 'current', objective: 'Observe compaction', status: 'active', policy: 'goal',
    autoContinue: true, usage: { tokensUsed: 0, tokensLimit: 1_000_000 },
    createdAt: new Date(NOW).toISOString(), updatedAt: new Date(NOW).toISOString() }, list: [] };
}

test('only fresh current-owner host observations establish compaction eligibility', () => {
  const state = fixture();
  const host = { ownerKey: 'goal:current', generation: 1, observedAt: NOW, session: 'open' as const,
    compaction: projectCompactionStatus(input) };
  assert.equal(projectUiStatus(state, { now: NOW }).compaction?.reason, 'unconfirmed');
  for (const patch of [{ ownerKey: 'goal:old' }, { generation: 2 }, { observedAt: NOW - 31_000 },
    { observedAt: NOW + 1 }, { session: 'closed' as const }, { compaction: { ...host.compaction, observedAt: NOW - 31_000 } }]) {
    assert.equal(projectUiStatus(state, { now: NOW, generation: 1, evidence: { ...host, ...patch } }).compaction?.reason, 'unconfirmed');
  }
  assert.equal(projectUiStatus(state, { now: NOW, generation: 1, evidence: host }).compaction?.reason, 'eligible');
});

test('fresh host admission can explain audit deferral without claiming stale worker liveness', () => {
  const state = fixture(); state.goal!.status = 'auditing';
  state.goal!.pendingCompletion = { phase: 'running', attemptId: 'audit', completionSummary: 'saved', at: new Date(NOW).toISOString() };
  const context = uiStatusContextFromRuntime(state, NOW, 1, {
    ownerKey: 'goal:current', generation: 1, observedAt: NOW, session: 'open',
    compaction: projectCompactionStatus({ ...input, audit: true }),
  }, { ownerKey: 'goal:current', generation: 1, attemptId: 'audit', observedAt: NOW - 60_000 });
  const status = projectUiStatus(state, context);
  assert.equal(status.execution, 'unconfirmed');
  assert.equal(status.compaction?.reason, 'audit');
});

test('existing compact, detailed and footer surfaces share the same over-target deferral', () => {
  const state = fixture();
  const uiStatusContext = { now: NOW, generation: 1, evidence: { ownerKey: 'goal:current', generation: 1,
    observedAt: NOW, session: 'open' as const, compaction: projectCompactionStatus({ ...input, pending: true }) } };
  for (const compactAuditCard of [true, false]) {
    const extras = { uiStatusContext, compactAuditCard };
    const text = buildWidgetLines(state, undefined, NOW, undefined, 160, extras)!.join('\n');
    assert.match(text, /compaction: deferred while messages are pending/);
    assert.match(text, /400000 \/ 200000 token target/);
    assert.match(buildStatusText(state, undefined, NOW, undefined, extras)!, /compact: pending/);
  }
  const saved = buildWidgetLines(state, undefined, NOW, undefined, 160,
    { uiStatusContext: { now: NOW }, compactAuditCard: false })!.join('\n');
  assert.match(saved, /compaction: eligibility unconfirmed/);
  assert.doesNotMatch(saved, /400000|eligible at a safe boundary/);
});
