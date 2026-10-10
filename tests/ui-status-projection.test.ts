import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { State } from '../extensions/goal-loop-core.js';
import { projectUiStatus, uiStatusOwnerKey, type UiStatusEvidence } from '../extensions/ui-status.js';

const NOW = Date.parse('2026-10-10T12:00:00Z');
function fixture(): State {
  return { goal: { id: 'ui-owner', objective: 'UI fixture', status: 'active', policy: 'goal',
    autoContinue: true, usage: { tokensUsed: 0, tokensLimit: 1_000_000 },
    createdAt: new Date(NOW).toISOString(), updatedAt: new Date(NOW).toISOString() }, list: [] };
}
function observed(state: State, patch: Partial<UiStatusEvidence> = {}): UiStatusEvidence {
  return { ownerKey: uiStatusOwnerKey(state)!, generation: 2, session: 'open', observedAt: NOW, ...patch };
}
function recovery(state: State): void {
  state.mainModelRecovery = { primary: 'provider/model', active: 'provider/model', attempted: [], attempts: 6,
    kind: 'goal', owner: { kind: 'goal', id: state.goal!.id }, reason: 'Rate limit', retryAt: new Date(NOW + 5 * 3600_000).toISOString() };
}

test('saved active or auditing state never proves execution', () => {
  const state = fixture();
  assert.equal(projectUiStatus(state, { now: NOW }).execution, 'unconfirmed');
  state.goal!.status = 'auditing';
  state.goal!.pendingCompletion = { phase: 'running', completionSummary: 'saved', at: new Date(NOW - 15 * 86400_000).toISOString() };
  assert.equal(projectUiStatus(state, { now: NOW }).execution, 'unconfirmed');
});

test('saved deadline differs from attributed armed timer', () => {
  const state = fixture(); recovery(state);
  const saved = projectUiStatus(state, { now: NOW });
  assert.equal(saved.execution, 'unconfirmed');
  assert.equal(saved.retryAt, state.mainModelRecovery!.retryAt);
  const runtime = projectUiStatus(state, { now: NOW, generation: 2, evidence: observed(state,
    { recovery: { retryTimerArmed: true, hourlyTimerArmed: false, switchInFlight: false } }) });
  assert.equal(runtime.execution, 'retry-armed');
  assert.equal(runtime.retryKind, 'regular');
});

test('replaced owner, generation, stale or future snapshots do not establish liveness', () => {
  const state = fixture();
  for (const patch of [{ ownerKey: 'goal:replaced' }, { generation: 1 }, { observedAt: NOW - 31_000 }, { observedAt: NOW + 1 }]) {
    assert.equal(projectUiStatus(state, { now: NOW, generation: 2, evidence: observed(state, { turnActive: true, ...patch }) }).execution, 'unconfirmed');
  }
});

test('manual decision and supervisor holds outrank provider timers', () => {
  const state = fixture(); recovery(state);
  state.goal!.status = 'paused'; state.goal!.pauseKind = 'decision';
  state.goal!.pauseReason = 'Choose permitted destination'; state.goal!.pauseSuggestedAction = 'Choose a destination';
  const context = { now: NOW, generation: 2, evidence: observed(state,
    { recovery: { retryTimerArmed: true, hourlyTimerArmed: false, switchInFlight: false } }) };
  assert.equal(projectUiStatus(state, context).execution, 'blocked');
  assert.equal(projectUiStatus(state, context).nextAction, 'Choose a destination');
  state.supervisorPausedAt = NOW;
  assert.equal(projectUiStatus(state, context).blocker, 'Supervisor paused');
});

test('silence does not prove death; independently observed closure does', () => {
  const state = fixture();
  assert.equal(projectUiStatus(state, { now: NOW, generation: 2, evidence: observed(state,
    { lastActivityAt: NOW - 15 * 86400_000 }) }).execution, 'unconfirmed');
  assert.equal(projectUiStatus(state, { now: NOW, generation: 2, evidence: observed(state,
    { session: 'closed' }) }).execution, 'dormant');
});

test('in-budget tool is a wait and queued is not running', () => {
  const state = fixture();
  assert.equal(projectUiStatus(state, { now: NOW, generation: 2, evidence: observed(state,
    { tool: { name: 'bash', startedAt: NOW - 61 * 60_000, budgetMs: 120 * 60_000 } }) }).execution, 'tool-wait');
  assert.equal(projectUiStatus(state, { now: NOW, generation: 2, evidence: observed(state, { turnQueued: true }) }).execution, 'queued');
});

test('hourly-only timer does not advertise a regular saved deadline', () => {
  const state = fixture(); recovery(state);
  const status = projectUiStatus(state, { now: NOW, generation: 2, evidence: observed(state,
    { recovery: { retryTimerArmed: false, hourlyTimerArmed: true, switchInFlight: false } }) });
  assert.equal(status.execution, 'retry-armed');
  assert.equal(status.retryKind, 'hourly');
  assert.equal(status.retryAt, undefined);
});

test('terminal state outranks old observations; workflow issue survives independently', () => {
  const state = fixture();
  const context = { now: NOW, generation: 2, evidence: observed(state, { turnActive: true }), workflowIssue: 'Replan required before audit' };
  assert.equal(projectUiStatus(state, context).workflowIssue, context.workflowIssue);
  state.goal!.status = 'complete';
  assert.equal(projectUiStatus(state, context).execution, 'complete');
});
