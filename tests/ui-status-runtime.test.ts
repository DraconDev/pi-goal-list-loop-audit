import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { State } from '../extensions/goal-loop-core.js';
import { projectUiStatus, uiStatusOwnerKey } from '../extensions/ui-status.js';
import { uiStatusContextFromRuntime, type UiRuntimeObservation, type UiAuditObservation } from '../extensions/ui-status-runtime.js';

const NOW = Date.parse('2026-10-10T12:00:00Z');
function fixture(): State {
  return { goal: { id: 'adapter-owner', objective: 'Adapter fixture', status: 'active', policy: 'goal',
    autoContinue: true, usage: { tokensUsed: 0, tokensLimit: 1000000 },
    createdAt: new Date(NOW).toISOString(), updatedAt: new Date(NOW).toISOString() }, list: [] };
}
function host(state: State): UiRuntimeObservation {
  return { ownerKey: uiStatusOwnerKey(state)!, generation: 3, observedAt: NOW, session: 'open', turnActive: true, lastActivityAt: NOW };
}
function auditing(state: State): UiAuditObservation {
  state.goal!.status = 'auditing';
  state.goal!.pendingCompletion = { phase: 'running', attemptId: 'attempt-current', at: new Date(NOW).toISOString(), completionSummary: 'saved' };
  return { ownerKey: uiStatusOwnerKey(state)!, generation: 3, attemptId: 'attempt-current', observedAt: NOW, lastActivityAt: NOW };
}

test('runtime adapter rejects replaced work and old generation', () => {
  const state = fixture(); const observation = host(state);
  state.goal!.id = 'replacement';
  assert.equal(projectUiStatus(state, uiStatusContextFromRuntime(state, NOW, 3, observation)).execution, 'unconfirmed');
  assert.equal(projectUiStatus(state, uiStatusContextFromRuntime(state, NOW, 4, host(state))).execution, 'unconfirmed');
});

test('active host turn cannot prove detached audit activity', () => {
  const state = fixture(); auditing(state);
  assert.equal(projectUiStatus(state, uiStatusContextFromRuntime(state, NOW, 3, host(state))).execution, 'unconfirmed');
});

test('audit progress requires the current attempt owner and generation', () => {
  const state = fixture(); const progress = auditing(state);
  for (const patch of [{ attemptId: 'old' }, { ownerKey: 'goal:old' }, { generation: 2 }]) {
    const context = uiStatusContextFromRuntime(state, NOW, 3, host(state), { ...progress, ...patch });
    assert.equal(projectUiStatus(state, context).execution, 'unconfirmed');
  }
  assert.equal(projectUiStatus(state, uiStatusContextFromRuntime(state, NOW, 3, host(state), progress)).execution, 'running');
});

test('new parent polls cannot refresh an old worker snapshot', () => {
  const state = fixture(); const progress = auditing(state);
  progress.observedAt = NOW - 60000;
  assert.equal(projectUiStatus(state, uiStatusContextFromRuntime(state, NOW, 3, host(state), progress)).execution, 'unconfirmed');
});

test('confirmed closure and load hold survive the audit adapter', () => {
  const state = fixture(); const progress = auditing(state);
  const observation = host(state); observation.session = 'closed';
  const context = uiStatusContextFromRuntime(state, NOW, 3, observation, progress);
  assert.equal(projectUiStatus(state, context).execution, 'dormant');
  state.loadHoldAt = NOW;
  assert.equal(projectUiStatus(state, context).execution, 'blocked');
});

test('projection and adapter do not mutate durable work or evidence', () => {
  const state = fixture(); const observation = host(state);
  const before = JSON.stringify({ state, observation });
  const status = projectUiStatus(state, uiStatusContextFromRuntime(state, NOW, 3, observation, undefined, 'Replan required before audit'));
  assert.equal(status.workflowIssue, 'Replan required before audit');
  assert.equal(JSON.stringify({ state, observation }), before);
});
