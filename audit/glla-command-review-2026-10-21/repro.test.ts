import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import activate, { __testOnlyResetProcessState } from '../../extensions/loops/goal.ts';
import { resolveAuditorModel, handleSettingChoice } from '../../extensions/loops/goal-settings-ui.ts';
import { MockPi, makeMockCtx } from '../../tests/harness/mock-pi.ts';
import { loadSettings, projectSettingsPath } from '../../extensions/goal-settings.ts';
import { resolveDesignerModel } from '../../extensions/designer-model.ts';
import { resolveDrafterModel } from '../../extensions/drafter-model.ts';
import { buildSettingsRows } from '../../extensions/settings-menu.ts';
import { resolveAuditorThinkingLevel } from '../../extensions/auditor-thinking.ts';

const pi = new MockPi();
activate(pi.api);
const globalFile = process.env.GLLA_GLOBAL_SETTINGS_PATH!;
function fixture(settings: any = {}) {
  __testOnlyResetProcessState();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'glla-audit-fixture-'));
  process.env.PI_CODING_AGENT_DIR = path.join(cwd, 'agent-dir');
  fs.writeFileSync(globalFile, JSON.stringify({aggressiveMode: false, ...settings}));
  const session = { provider: 'audit', id: 'session', reasoning: true, thinkingLevelMap: {max: 'max', xhigh: 'xhigh'} };
  const selected = { provider: 'audit', id: 'selected', reasoning: true };
  const other = { provider: 'audit', id: 'other', reasoning: true };
  const models = [session, selected, other];
  const ctx: any = makeMockCtx(cwd);
  ctx.model = session;
  ctx.thinkingLevel = 'max';
  ctx.modelRegistry = {
    getAvailable: () => models,
    hasConfiguredAuth: () => true,
    find: (provider: string, id: string) => models.find(m => m.provider === provider && m.id === id),
  };
  (pi.api as any).getThinkingLevel = () => ctx.thinkingLevel;
  (pi.api as any).setThinkingLevel = (level: string) => { ctx.thinkingLevel = level; };
  (pi.api as any).setModel = async (model: any) => { pi.modelSelections.push(model); ctx.model = model; return true; };
  pi.modelSelections.length = 0;
  return {cwd, ctx, session, selected, other};
}

test('v0.39.62: session selection saves global inheritance for every tree (global-only)', async () => {
  const {cwd, ctx} = fixture({auditorModel: 'audit/selected', auditorThinkingLevel: 'low'});
  const projectFile = projectSettingsPath(cwd);
  fs.mkdirSync(path.dirname(projectFile), {recursive: true});
  fs.writeFileSync(projectFile, JSON.stringify({auditorModel: 'audit/other', auditorThinkingLevel: 'medium'}));
  ctx.ui.customImpl = async () => ({kind: 'session'});
  try {
    await handleSettingChoice('auditorModel', ctx);
    const settings = loadSettings(cwd);
    console.log('session picker effective result:', JSON.stringify({auditorModel: settings.auditorModel, auditorThinkingLevel: settings.auditorThinkingLevel, notifications: ctx.ui.notifies}));
    const resolved = resolveAuditorModel(ctx, settings.auditorModel, settings.auditorModelFallbacks);
    assert.equal(resolved.model, ctx.model, 'global session choice must actually inherit, not unmask the global auditor pin');
    assert.equal(settings.auditorModel, null, 'v0.39.62: session choice is global null, masking nothing project-locally');
    assert.equal(settings.auditorThinkingLevel, undefined, 'global thinking must not shadow the live session');
    assert.equal(JSON.parse(fs.readFileSync(globalFile, 'utf8')).auditorModel, null, 'other projects now see the same global session switch');
  } finally { await pi.fire('session_shutdown', {reason: 'audit-test'}, ctx); }
});

test('runtime drafter failure must attempt the session fallback and retain restoration', async () => {
  const {ctx, session} = fixture({drafterModel: 'audit/selected', drafterThinkingLevel: 'low'});
  await pi.fire('session_start', {reason: 'startup'}, ctx);
  try {
    await pi.command('list', '', ctx);
    const recovery = await (globalThis as any).handleDrafterModelFailure(ctx, '503 upstream unavailable');
    await (globalThis as any).restoreDrafterModel();
    console.log('drafter runtime recovery:', JSON.stringify({recovery, model: ctx.model.id, thinking: ctx.thinkingLevel, selectedModels: pi.modelSelections.map((m: any) => m.id)}));
    assert.equal(ctx.model, session, 'a failed dedicated drafter must not strand the main session on its failed model');
  } finally { await pi.fire('session_shutdown', {reason: 'audit-test'}, ctx); }
});

test('session-backed Designer must update when the session model and thinking change', async () => {
  const {ctx, session, other} = fixture({designerEnabled: true});
  await pi.fire('session_start', {reason: 'startup'}, ctx);
  const file = path.join(process.env.PI_CODING_AGENT_DIR!, 'agents', 'Designer.md');
  try {
    const before = fs.readFileSync(file, 'utf8');
    assert.match(before, /^model: audit\/session$/m);
    ctx.model = other;
    ctx.thinkingLevel = 'low';
    await pi.fire('model_select', {model: other, previousModel: session, source: 'set'}, ctx);
    const after = fs.readFileSync(file, 'utf8');
    console.log('Designer frontmatter after model switch:', after.split('---')[1]);
    assert.match(after, /^model: audit\/other$/m, 'session-default Designer must not stay pinned to the previous session');
    assert.match(after, /^thinking: low$/m);
  } finally { await pi.fire('session_shutdown', {reason: 'audit-test'}, ctx); }
});

test('on-demand Designer must stay unregistered until explicitly requested', async () => {
  const {ctx} = fixture();
  try {
    await pi.fire('session_start', {reason: 'startup'}, ctx);
    const file = path.join(process.env.PI_CODING_AGENT_DIR!, 'agents', 'Designer.md');
    console.log('unconfigured Designer registered on startup:', fs.existsSync(file));
    assert.equal(fs.existsSync(file), false, 'a resolved session default is not consent to enable Designer');
  } finally { await pi.fire('session_shutdown', {reason: 'audit-test'}, ctx); }
});

test('thinking display must not raise an unsupported request above the runtime level', () => {
  const requested = 'xhigh';
  const model = {reasoning: true, thinkingLevelMap: {xhigh: null, max: 'max'}};
  const runtime = resolveAuditorThinkingLevel(model, requested);
  const rows = buildSettingsRows({auditorModel: 'audit/selected', auditorThinkingLevel: requested}, {}, {
    sessionModel: 'audit/session', sessionThinkingLevel: 'max',
    thinkingLevelsByRef: {'audit/selected': ['off', 'minimal', 'low', 'medium', 'high', 'max']},
  });
  const display = rows.find(row => row.id === 'auditorModel')!.valueText;
  console.log('thinking display/runtime:', JSON.stringify({runtime, display}));
  assert.match(display, new RegExp(` · ${runtime}(?: |$)`), 'menu must show runtime high, not maximum thinking');
});

test('ten configured fallback slots must remain available after a Designer or Drafter primary', () => {
  const {ctx, other} = fixture();
  const fallbacks = [...Array.from({length: 9}, (_, i) => `audit/missing-${i}`), 'audit/other'];
  const designer = resolveDesignerModel(ctx, {designerModel: 'audit/missing-primary', designerModelFallbacks: fallbacks});
  const drafter = resolveDrafterModel(ctx, {drafterModel: 'audit/missing-primary', drafterModelFallbacks: fallbacks});
  console.log('tenth fallback results:', JSON.stringify({designer: designer.selectedRef, drafter: drafter.selected?.ref, configuredDesignerRefs: designer.configuredRefs}));
  assert.equal(designer.selectedRef, 'audit/other', 'the tenth configured fallback must not be truncated by the primary');
  assert.equal(drafter.selected?.model, other);
});
