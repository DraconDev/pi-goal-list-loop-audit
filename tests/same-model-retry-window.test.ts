import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { sameModelRetryDeadline, sameModelRetryPhaseActive, classifyMainModelFailure, PERSISTENT_PROVIDER_RETRY_MS } from '../extensions/main-model-recovery.js';
import { formatMainModelRecoveryStatus, sanitizeMainModelRecovery } from '../extensions/goal-loop-core.js';
import { createGoalRecovery, parkMainModelAfterFailure, probeMainModelRecovery, scheduleMainModelRecoveryTimer, tryMainModelFallback, mainModelRecoverySucceeded } from '../extensions/goal-recovery.js';
import { state, replaceState } from '../extensions/goal-state.js';
import { globalSettingsPath } from '../extensions/goal-settings.js';
import { buildWidgetLines } from '../extensions/goal-loop-display.js';
import { uiStatusOwnerKey } from '../extensions/ui-status.js';

const now = Date.parse('2026-10-11T14:00:00Z');
test('count and time bound primary retries independently; no candidate preserves paced retry', () => {
  const recovery = { sameModelRetries: 2, sameModelPhaseStartedAt: new Date(now - 180_000).toISOString() };
  assert.equal(sameModelRetryPhaseActive(recovery, 10, true, now), false);
  assert.equal(sameModelRetryPhaseActive(recovery, 10, false, now), true);
  assert.equal(sameModelRetryPhaseActive({ ...recovery, sameModelPhaseStartedAt: new Date(now).toISOString() }, 10, true, now), true);
  assert.equal(sameModelRetryPhaseActive({ sameModelRetries: 10 }, 10, true, now), false);
  assert.equal(sameModelRetryPhaseActive(undefined, 0, true, now), false);
  assert.equal(sameModelRetryDeadline({ firstFailureAt: new Date(now).toISOString() }), now + 120_000, 'legacy episode age anchors initial primary phase');
});

test('bounded recovery card states retry progress and fallback eligibility without claiming a successful switch', () => {
  const fixture: any = { list: [], goal: { id: 'ui', objective: 'work', policy: 'goal', status: 'paused', pauseKind: 'wait', pauseSource: 'system', pauseReason: 'main model recovery', createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(), usage: { tokensUsed: 0, tokensLimit: 1000000 } },
    mainModelRecovery: { primary: 'provider/free', active: 'provider/free', attempted: ['provider/free'], attempts: 3, sameModelRetries: 2,
      sameModelPhaseStartedAt: new Date(now - 180_000).toISOString(), kind: 'goal', owner: { kind: 'goal', id: 'ui' }, reason: 'provider error', retryAt: new Date(now + 1000).toISOString() } };
  const extras = { uiStatusContext: { now }, mainModelSameModelRetries: 10, mainModelFallbacks: ['provider/forbidden', 'provider/backup'], modelProvenance: { skippedForbiddenRefs: ['provider/forbidden'] } };
  const lines = buildWidgetLines(fixture, undefined, now, undefined, 200, extras)!;
  assert.ok(lines.length <= 8);
  assert.match(lines.join('\n'), /retry: same model 2\/10/);
  assert.match(lines.join('\n'), /fallback: eligible now/);
  assert.match(lines.join('\n'), /candidate: provider\/backup/);
  assert.doesNotMatch(lines.join('\n'), /candidate: provider\/forbidden|switched to/);
  const narrowExtras = { ...extras, mainModelFallbacks: ['opencode-go/muse-spark-1.3-contributor'] };
  const narrow = buildWidgetLines(fixture, undefined, now, undefined, 40, narrowExtras)!;
  const start = narrow.findIndex(line => line.startsWith('├─ candidate:'));
  assert.ok(start >= 0);
  let name = narrow[start]!.replace('├─ candidate: ', '');
  for (let i = start + 1; i < narrow.length && narrow[i]!.startsWith('│  '); i++) name += narrow[i]!.slice(3);
  assert.equal(name, 'opencode-go/muse-spark-1.3-contributor', 'the full next candidate survives narrow bounded geometry');
  assert.ok(narrow.length <= 8);
  assert.match(narrow.join('\n'), /\/glla status/);
  const runtime = { retryTimerArmed: true, hourlyTimerArmed: false, turnActive: false, turnQueued: false, switchInFlight: false };
  const armed = buildWidgetLines(fixture, undefined, now, undefined, 200, { ...extras, maxWidgetLines: 12, mainModelRecoveryRuntime: runtime,
    uiStatusContext: { now, generation: 1, evidence: { ownerKey: uiStatusOwnerKey(fixture)!, generation: 1, observedAt: now, session: 'open', recovery: runtime } } })!.join('\n');
  assert.match(armed, /RETRY ARMED/);
  assert.match(armed, /next: recovery timer armed/);
  assert.doesNotMatch(armed, /next: retry scheduled \(unconfirmed\)/, 'the lifecycle row must not contradict the owner-fenced live timer evidence');
});

test('recovery order deduplicates the primary and repeated backups like the selector', () => {
  const text = formatMainModelRecoveryStatus({ primary: 'provider/free', active: 'provider/backup', attempted: ['provider/free'], attempts: 1, reason: 'provider error', kind: 'goal' }, ['provider/free', 'provider/backup', 'PROVIDER/BACKUP']).join('\n');
  assert.match(text, /backup 1\/1 selected/);
  assert.match(text, /Order: provider\/free → provider\/backup\n/);
});

test('real recovery clamps reset waits, rotates after slow failures, and restores old long waits', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'glla-retry-window-'));
  const settingsPath = globalSettingsPath();
  const original = fs.existsSync(settingsPath) ? fs.readFileSync(settingsPath, 'utf8') : undefined;
  const calls: string[] = [], timers: number[] = [];
  let rejectIntent = false;
  let rejectCommitTarget: string | undefined;
  const dispatches: string[] = [];
  const ctx: any = { cwd, model: { provider: 'provider', id: 'free' },
    modelRegistry: { find: (provider: string, id: string) => ({ provider, id, reasoning: true }), hasConfiguredAuth: () => true },
    ui: { notify: () => {} }, abort: () => {} };
  const flags: any = { sessionGeneration: 1, mainModelRecoveryTimer: null, hourlyProbeTimer: null, hourlyProbeFireAt: null,
    extensionApi: { setModel: async (model: any) => { calls.push(`${model.provider}/${model.id}`); ctx.model = model; return true; }, getThinkingLevel: () => 'high', setThinkingLevel: () => {} } };
  try {
    fs.writeFileSync(settingsPath, JSON.stringify({ mainModelFallbacks: ['provider/backup', 'provider/backup2'], mainModelSameModelRetries: 10, hourlyRetryProbe: false }));
    replaceState({ goal: { id: 'window', status: 'active', objective: 'work', tasks: [], startedAt: new Date().toISOString() }, loop: null } as any);
    createGoalRecovery(flags, { activeGoalSurfaceCommand: (c: string) => `/goal ${c}`, clearDetachedAuditRuntime: () => {},
      updateGoal: (patch: any) => { Object.assign(state.goal!, patch); return true; }, clearContinuationTimer: () => {},
      freshCtxForGeneration: () => ctx, isSupervising: () => true, notifyExternal: () => {}, persistState: () => !(rejectIntent && state.mainModelRecovery?.pendingModelSwitch)
        && !(rejectCommitTarget && state.mainModelRecovery?.active === rejectCommitTarget && !state.mainModelRecovery.pendingModelSwitch),
      recoverySurfaceCommand: (_k: string, c: string) => `/goal ${c}`, scheduleContinuation: () => { dispatches.push('continuation'); },
      scheduleSessionTimeout: (_fn: () => void, ms: number) => { timers.push(ms); return null; } } as any);
    parkMainModelAfterFailure(ctx, classifyMainModelFailure('429 Rate limit exceeded. Retry-After: 14400'));
    assert.equal(state.goal?.status, 'paused');
    assert.ok(timers.length && timers.every(ms => ms <= 120_000), 'a primary reset hint must not postpone testing an independent backup for hours');
    assert.ok(Date.parse(state.mainModelRecovery!.retryAt!) - Date.now() <= 120_000);
    assert.equal(state.goal?.pauseResumeAt, state.mainModelRecovery!.retryAt, 'durable goal and recovery agree with the bounded timer');
    const start = new Date(Date.now() - 180_000).toISOString();
    state.mainModelRecovery = { ...state.mainModelRecovery!, sameModelPhaseStartedAt: start, sameModelRetries: 2,
      firstFailureAt: start, retryAt: new Date(Date.now() + 3_600_000).toISOString() };
    state.goal!.pauseResumeAt = state.mainModelRecovery.retryAt;
    timers.length = 0;
    scheduleMainModelRecoveryTimer(ctx, 3_600_000);
    assert.deepEqual(timers, [1000], 'reload of a legacy long wait reaches the backup gate promptly');
    assert.ok(Date.parse(state.mainModelRecovery.retryAt!) - Date.now() <= 1000);
    assert.equal(state.goal!.pauseResumeAt, state.mainModelRecovery.retryAt);
    const previous = Date.now();
    await probeMainModelRecovery(ctx);
    assert.deepEqual(calls, ['provider/backup'], 'two slow failures may exhaust elapsed time without consuming all ten retries');
    assert.equal(state.mainModelRecovery?.sameModelRetries, 0);
    assert.ok(Date.parse(state.mainModelRecovery!.sameModelPhaseStartedAt!) >= previous, 'backup owns a fresh phase, not primary age');
    assert.equal(state.goal!.status, 'active');
    state.mainModelRecovery!.attempts = 30;
    parkMainModelAfterFailure(ctx, classifyMainModelFailure('429 Upstream request failed: Endpoint is unavailable.'));
    assert.equal(state.mainModelRecovery!.attempts, 31, 'episode history remains intact');
    assert.equal(state.mainModelRecovery!.modelFailureSteps, 1, 'new backup starts its own failure cadence');
    assert.ok(timers.at(-1)! <= 5000, 'backup must not inherit primary’s 30-minute rung');
    await probeMainModelRecovery(ctx);
    assert.deepEqual(state.mainModelRecovery!.attempted, ['provider/free', 'provider/backup', 'provider/backup2'], 'prompt fallback preserves the failed predecessors and the selected second backup');
    assert.deepEqual(calls, ['provider/backup', 'provider/backup2'], 'a failed first backup advances promptly, never jumping backward to the primary');
    parkMainModelAfterFailure(ctx, classifyMainModelFailure('429 TPM rate limit exceeded (1039)'));
    assert.ok(timers.at(-1)! <= PERSISTENT_PROVIDER_RETRY_MS && timers.at(-1)! >= PERSISTENT_PROVIDER_RETRY_MS - 1000,
      'after every configured alternative fails the episode keeps a five-minute retry, not an eager loop or an hours-long reset wait');
    mainModelRecoverySucceeded(ctx);
    assert.equal(state.mainModelRecovery!.sameModelRetries, 0);
    assert.equal(state.mainModelRecovery!.modelFailureSteps, 0);
    assert.equal(state.mainModelRecovery!.sameModelPhaseStartedAt, undefined, 'healthy work is not an ongoing failure phase');
    state.mainModelRecovery!.firstFailureAt = new Date(Date.now() - 3_600_000).toISOString();
    const freshFailure = Date.now();
    parkMainModelAfterFailure(ctx, classifyMainModelFailure('429 TPM rate limit exceeded (1039)'));
    assert.ok(Date.parse(state.mainModelRecovery!.sameModelPhaseStartedAt!) >= freshFailure, 'a later failure after healthy backup work starts a fresh phase');
    assert.ok(timers.at(-1)! <= PERSISTENT_PROVIDER_RETRY_MS);
    const restored = sanitizeMainModelRecovery(state.mainModelRecovery);
    assert.equal(restored?.sameModelPhaseStartedAt, state.mainModelRecovery!.sameModelPhaseStartedAt);
    const seed = () => ({ primary: 'provider/free', active: 'provider/free', primaryThinkingLevel: 'high' as const,
      owner: { kind: 'goal' as const, id: 'window' }, kind: 'goal' as const, reason: 'provider error', attempted: ['provider/free'], attempts: 1,
      sameModelRetries: 10, firstFailureAt: start, sameModelPhaseStartedAt: start, retryAt: new Date(Date.now() - 1).toISOString() });
    for (const mode of ['immediate', 'delayed', 'preferred'] as const) {
      ctx.model = { provider: 'provider', id: mode === 'preferred' ? 'backup' : 'free' };
      state.mainModelRecovery = mode === 'preferred' ? { ...seed(), active: 'provider/backup', attempted: ['provider/free', 'provider/backup'], primaryProbeAt: new Date(Date.now() - 1).toISOString(), retryAt: undefined } : seed();
      Object.assign(state.goal!, { status: mode === 'preferred' ? 'active' : 'paused', pauseKind: 'wait', pauseSource: 'system', pauseReason: 'main model recovery' });
      const before = structuredClone(state.mainModelRecovery);
      const count = calls.length;
      rejectIntent = true;
      if (mode === 'immediate') await tryMainModelFallback(ctx, classifyMainModelFailure('429 TPM rate limit exceeded (1039)'));
      else await probeMainModelRecovery(ctx);
      assert.equal(calls.length, count, `${mode} switch must not cross the host boundary after rejected intent persistence`);
      assert.deepEqual(state.mainModelRecovery, before, 'failed intent restores its prior durable projection');
      assert.equal(flags.continuationDispatchStoodDown, true);
      rejectIntent = false;
    }
    for (const mode of ['immediate', 'delayed', 'preferred'] as const) {
      ctx.model = { provider: 'provider', id: mode === 'preferred' ? 'backup' : 'free' };
      state.mainModelRecovery = mode === 'preferred' ? { ...seed(), active: 'provider/backup', attempted: ['provider/free', 'provider/backup'], primaryProbeAt: new Date(Date.now() - 1).toISOString(), retryAt: undefined } : seed();
      Object.assign(state.goal!, { status: mode === 'preferred' ? 'active' : 'paused', pauseKind: 'wait', pauseReason: 'main model recovery' });
      const count = calls.length, sent = dispatches.length;
      rejectCommitTarget = mode === 'preferred' ? 'provider/free' : 'provider/backup';
      if (mode === 'immediate') await tryMainModelFallback(ctx, classifyMainModelFailure('429 TPM rate limit exceeded (1039)'));
      else await probeMainModelRecovery(ctx);
      assert.equal(calls.length, count + 1, `${mode}: host selection happened after successful intent persistence`);
      assert.equal(state.mainModelRecovery!.pendingModelSwitch, rejectCommitTarget, 'failed accepted-selection commit retains durable intent for reconciliation');
      assert.equal(dispatches.length, sent, 'no continuation may be dispatched when accepted selection cannot be committed');
      assert.equal(flags.continuationDispatchStoodDown, true);
      rejectCommitTarget = undefined;
    }
    ctx.model = { provider: 'provider', id: 'free' };
    state.mainModelRecovery = { ...seed(), sameModelRetries: 0, sameModelPhaseStartedAt: new Date().toISOString(), pendingModelSwitch: 'provider/backup', attempted: ['provider/free', 'provider/backup'] };
    const count = calls.length;
    await probeMainModelRecovery(ctx);
    assert.equal(calls[count], 'provider/backup', 'pending intent is re-driven even when a changed retry budget would otherwise keep the old model');
    ctx.model = { provider: 'provider', id: 'free' };
    state.mainModelRecovery = { ...seed(), pendingModelSwitch: 'provider/backup', attempted: ['provider/free', 'provider/backup'] };
    fs.writeFileSync(settingsPath, JSON.stringify({ mainModelFallbacks: ['provider/backup', 'provider/other'], mainModelSameModelRetries: 10, hourlyRetryProbe: false, forbiddenModels: ['provider/backup'] }));
    const forbiddenCount = calls.length;
    await probeMainModelRecovery(ctx);
    assert.equal(calls[forbiddenCount], 'provider/other', 'newly forbidden persisted target must advance to a permitted candidate (forbidden matching is substring-based)');
    assert.ok(state.mainModelRecovery!.skipped?.some(entry => entry.ref === 'provider/backup' && entry.reason === 'forbidden'));
    fs.writeFileSync(settingsPath, JSON.stringify({ mainModelFallbacks: ['provider/backup', 'provider/backup2'], mainModelSameModelRetries: 10, hourlyRetryProbe: false }));
    ctx.model = { provider: 'provider', id: 'backup' };
    state.goal!.status = 'active';
    state.mainModelRecovery = { ...seed(), active: 'provider/backup', sameModelRetries: 5, primaryProbeAt: new Date(Date.now() - 1).toISOString(), retryAt: undefined, attempted: ['provider/free', 'provider/backup'] };
    const failbackAt = Date.now();
    await probeMainModelRecovery(ctx);
    assert.equal(state.mainModelRecovery!.active, 'provider/free');
    assert.equal(state.mainModelRecovery!.sameModelRetries, 0);
    assert.ok(Date.parse(state.mainModelRecovery!.sameModelPhaseStartedAt!) >= failbackAt, 'preferred primary receives its own new retry phase');
  } finally {
    replaceState({ goal: null, loop: null } as any);
    if (original === undefined) fs.rmSync(settingsPath, { force: true }); else fs.writeFileSync(settingsPath, original);
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
