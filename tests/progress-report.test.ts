import { test } from 'node:test';
import assert from 'node:assert/strict';
import { projectProgress } from '../extensions/progress-report.mjs';

const state = (loop: unknown) => ({ type: 'state', at: '2026-10-08T00:00:00Z', value: { goal: null, loop } });

test('legacy metricless iteration counts and housekeeping cannot establish capability delivery', () => {
  const report = projectProgress([
    state({ startedAt: 'legacy', active: true, iteration: 686, target: 'Reconcile SPEC.md', maxIterations: 0 }),
    { type: 'loop_measured', at: '2026-10-08T00:01:00Z', value: { iteration: 686, value: null, hypothesis: 'Correct stale citations' } },
    { type: 'spec_updated', at: '2026-10-08T00:01:00Z', value: { iteration: 685, via: 'external' } },
  ]);
  assert.equal(report.runs[0]?.mode, 'metricless-loop');
  assert.equal(report.runs[0]?.iterations, 686);
  assert.equal(report.runs[0]?.capabilityProgress, 'unknown');
  assert.equal(report.runs[0]?.historicalVerification.length, 0);
  assert.equal(report.runs[0]?.loadedVersion, 'unknown');
});

test('historical requirement verification is retained separately from current reopening', () => {
  const base = { startedAt: 'builder', active: true, target: 'Build the product', builder: { projectId: 'project', cycle: 1, phase: 'replanning', requirements: [{ id: 'feature', text: 'Useful feature', status: 'verified', evidence: { attemptId: 'audit-1' } }] } };
  const report = projectProgress([
    state(base),
    state({ ...base, builder: { ...base.builder, cycle: 2, requirements: [{ id: 'feature', text: 'Useful feature', status: 'open' }] } }),
  ]);
  assert.deepEqual(report.runs[0]?.coverage, { total: 1, verified: 0, open: 1, blocked: 0 });
  assert.equal(report.runs[0]?.historicalVerification[0]?.requirementId, 'feature');
  assert.equal(report.runs[0]?.historicalVerification[0]?.current, false);
  assert.equal(report.runs[0]?.historicalVerification[0]?.attemptId, 'audit-1');
  assert.equal(report.runs[0]?.capabilityProgress, 'historical-verification-only');
});

test('distinct run identities do not merge even when targets and requirement IDs repeat', () => {
  const loop = (startedAt: string, projectId: string, status: string) => ({ startedAt, active: true, target: 'Same target', builder: { projectId, phase: 'building', cycle: 1, requirements: [{ id: 'R1', status, text: 'Same requirement' }] } });
  const report = projectProgress([state(loop('one', 'project-one', 'verified')), state(loop('two', 'project-two', 'open'))]);
  assert.equal(report.runs.length, 2);
  assert.equal(report.runs.find(r => r.id === 'project-one')?.coverage.verified, 1);
  assert.equal(report.runs.find(r => r.id === 'project-two')?.historicalVerification.length, 0);
});

test('held loop and current goal in one state are both visible without choosing an owner', () => {
  const report = projectProgress([{ type: 'state', value: {
    loop: { startedAt: 'held-loop', active: false, target: 'Earlier project' },
    goal: { id: 'current-goal', policy: 'goal', status: 'active', objective: 'Current work' },
  } }]);
  assert.equal(report.runs.length, 2);
  assert.equal(report.runs.find(r => r.id === 'held-loop')?.status, 'inactive');
  assert.equal(report.runs.find(r => r.id === 'current-goal')?.status, 'active');
});

test('malformed records and bounded windows disclose incomplete evidence', () => {
  const report = projectProgress([null, { type: 'state', value: { loop: null } }, state({ startedAt: 'legacy', iteration: 1 })], { maxRecords: 2 });
  assert.equal(report.window.truncated, true);
  assert.equal(report.window.invalidRecords, 1);
  assert.equal(report.runs.length, 0);
});
