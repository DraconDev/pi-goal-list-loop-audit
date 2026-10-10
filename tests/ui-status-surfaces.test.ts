import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { State } from '../extensions/goal-loop-core.js';
import { buildStatusText, buildWidgetLines, type DisplayTheme } from '../extensions/goal-loop-display.js';
import { uiStatusOwnerKey, type UiStatusContext } from '../extensions/ui-status.js';

const NOW = Date.parse('2026-10-10T12:00:00Z');
function fixture(): State {
  return { goal: { id: 'surface-owner', objective: 'Verify the redesigned UI', status: 'active', policy: 'goal',
    autoContinue: true, usage: { tokensUsed: 0, tokensLimit: 1000000 },
    createdAt: new Date(NOW).toISOString(), updatedAt: new Date(NOW).toISOString() }, list: [] };
}
function context(state: State): UiStatusContext {
  return { now: NOW, generation: 1, evidence: { ownerKey: uiStatusOwnerKey(state)!, generation: 1, observedAt: NOW,
    session: 'open', turnActive: true } };
}

test('compact and detailed production adapters agree with the footer', () => {
  const state = fixture(); const uiStatusContext = context(state);
  for (const compactAuditCard of [true, false]) {
    const text = buildWidgetLines(state, undefined, NOW, undefined, 80, { uiStatusContext, compactAuditCard })!.join('\n');
    const footer = buildStatusText(state, undefined, NOW, undefined, { uiStatusContext, compactAuditCard })!;
    assert.match(text, /RUNNING · goal working/);
    assert.match(footer, /RUNNING · goal working/);
    assert.doesNotMatch(text, /detached worker|SUPERVISING/);
  }
});

test('saved audit is unconfirmed on both paths, never called dead or automatically applying', () => {
  const state = fixture(); state.goal!.status = 'auditing';
  state.goal!.pendingCompletion = { phase: 'running', completionSummary: 'saved', at: new Date(NOW - 15 * 86400000).toISOString() };
  for (const compactAuditCard of [true, false]) {
    const extras = { uiStatusContext: { now: NOW }, compactAuditCard };
    const text = buildWidgetLines(state, undefined, NOW, undefined, 100, extras)!.join('\n');
    assert.match(text, /EXECUTION UNCONFIRMED/);
    assert.doesNotMatch(text, /worker dead|No action needed|review applies automatically/);
    assert.match(buildStatusText(state, undefined, NOW, undefined, extras)!, /EXECUTION UNCONFIRMED/);
  }
});

test('actual prerequisite precedes evidence and remains visible at narrow width', () => {
  const state = fixture(); state.goal!.status = 'paused'; state.goal!.pauseKind = 'blocked';
  state.goal!.pauseReason = 'Version evidence missing'; state.goal!.pauseSuggestedAction = 'Paste AAV version';
  const lines = buildWidgetLines(state, undefined, NOW, undefined, 40, { uiStatusContext: context(state) })!;
  assert.match(lines[0]!, /BLOCKED/);
  assert.match(lines[2]!, /Next: Paste AAV version/);
  assert.ok(lines.length <= 6);
  assert.ok(lines.every(line => line.length <= 40));
  assert.doesNotMatch(lines.join('\n'), /resume to continue|No action needed/);
});

test('semantic warning color never replaces the text state', () => {
  const state = fixture();
  const theme: DisplayTheme = { fg: (color, text) => `<${color}>${text}</${color}>` };
  const text = buildStatusText(state, undefined, NOW, theme, { uiStatusContext: { now: NOW } })!;
  assert.match(text, /<warning>.*EXECUTION UNCONFIRMED/);
});
