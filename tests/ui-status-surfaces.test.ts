import { test } from 'node:test';
import assert from 'node:assert/strict';
import { visibleWidth } from '@earendil-works/pi-tui';
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
    assert.match(text, /GOAL · working · RUNNING/);
    assert.match(text, /│  Verify the redesigned UI/);
    assert.match(text, /└─ next:/);
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
  assert.match(lines[2]!, /├─ next: Paste AAV version/);
  assert.ok(lines.length <= 6);
  assert.ok(lines.every(line => visibleWidth(line) <= 40));
  assert.doesNotMatch(lines.join('\n'), /resume to continue|No action needed/);
});

test('cohesive active card retains primary and fallback model context', () => {
  const state = fixture();
  const lines = buildWidgetLines(state, undefined, NOW, undefined, 120, { uiStatusContext: context(state), modelProvenance: {
    primary: 'openai-codex/gpt-6.1-sol', primarySource: 'inherited', fallbackRefs: ['minimax/MiniMax-M3.1-Flash'],
  } })!;
  assert.ok(lines.length <= 6);
  assert.match(lines.join('\n'), /model: primary openai-codex\/gpt-6.1-sol/);
  assert.match(lines.join('\n'), /fallbacks: minimax\/MiniMax-M3.1-Flash/);
  assert.match(lines.at(-1)!, /^└─/);
  assert.ok(lines.slice(1, -1).every(line => /^[│├]/.test(line)));
});

test('terminal cards remove redundant phase and irrelevant worker uncertainty', () => {
  const state = fixture(); state.goal!.status = 'complete';
  const text = buildWidgetLines(state, undefined, NOW, undefined, 80, { uiStatusContext: { now: NOW } })!.join('\n');
  assert.match(text, /✓ GOAL · COMPLETE/);
  assert.doesNotMatch(text, /complete · COMPLETE|no worker activity confirmed|execution unconfirmed|Evidence:/i);
  assert.match(text, /└─ next: No action needed/);
});

test('simultaneous holds and workflow issues remain cohesive and bounded', () => {
  const state = fixture(); state.goal!.status = 'paused'; state.goal!.pauseKind = 'blocked';
  state.goal!.pauseReason = 'Missing prerequisite'; state.goal!.pauseSuggestedAction = 'Supply evidence';
  const uiStatusContext = { ...context(state), workflowIssue: 'Audit rejected; replan required' };
  const lines = buildWidgetLines(state, undefined, NOW, undefined, 80, { uiStatusContext })!;
  assert.ok(lines.length <= 6);
  assert.match(lines.join('\n'), /next: Supply evidence/);
  assert.match(lines.join('\n'), /workflow: Audit rejected/);
});

test('narrow styled cards preserve uncertainty and clip ANSI by terminal cells', () => {
  const state = fixture(); state.goal!.status = 'auditing';
  const theme: DisplayTheme = { fg: (_color, text) => `\x1b[38;5;179m${text}\x1b[0m` };
  const lines = buildWidgetLines(state, undefined, NOW, theme, 40, { uiStatusContext: { now: NOW } })!;
  assert.match(lines[0]!, /EXECUTION UNCONFIRMED/);
  assert.ok(lines.every(line => visibleWidth(line) <= 40));
  assert.match(lines[1]!, /Verify the redesigned UI/);
  assert.doesNotMatch(lines.join('\n'), /\x1b\[[0-9;]*…/);
});

test('semantic warning color never replaces the text state', () => {
  const state = fixture();
  const theme: DisplayTheme = { fg: (color, text) => `<${color}>${text}</${color}>` };
  const text = buildStatusText(state, undefined, NOW, theme, { uiStatusContext: { now: NOW } })!;
  assert.match(text, /<warning>.*EXECUTION UNCONFIRMED/);
});
