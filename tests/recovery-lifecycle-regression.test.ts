// Dedicated cross-surface recovery contract regressions. The suite grows
// with the remaining retry/compaction lifecycle implementation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withPressureSession } from './harness/context-pressure.js';
import { readState } from '../extensions/goal-loop-core.js';
import { state, replaceState, persistStateLine } from '../extensions/goal-state.js';
import { tick } from './harness/mock-pi.js';

for (const mode of ['goal', 'list', 'loop'] as const) {
  for (const source of ['set', 'cycle', 'restore', 'recovery', undefined]) {
    test(`${mode}: ${String(source)} selection resumes only explicit recovery-held work`, async () => {
      await withPressureSession(async (pi, ctx, cwd) => {
        const primary = `${ctx.model!.provider}/${ctx.model!.id}`;
        const selected = { provider: 'provider', id: 'chosen' };
        const beforeGoal = state.goal && { ...state.goal, objective: 'Implement saved lifecycle work', verificationContract: 'Preserve the exact acceptance criteria', telemetry: { turns: 17, fileWrites: 3, bashCalls: 5 } };
        const beforeLoop = state.loop && { ...state.loop, iteration: 17, bestValue: 42, history: [...state.loop.history] };
        const retryAt = new Date(Date.now() + 3600000).toISOString();
        replaceState({ ...state,
          goal: beforeGoal && { ...beforeGoal, status: 'paused', pauseKind: 'wait', pauseReason: 'main model recovery — retrying', pauseResumeAt: retryAt },
          loop: beforeLoop && { ...beforeLoop, active: false, stopReason: 'main model recovery — retrying' },
          mainModelRecovery: { primary, active: primary, attempted: [primary], attempts: 12, kind: mode === 'loop' ? 'loop' : 'goal', reason: 'provider unavailable', retryAt,
            owner: mode === 'loop' ? { kind: 'loop', startedAt: beforeLoop!.startedAt } : { kind: 'goal', id: beforeGoal!.id } },
        });
        persistStateLine(cwd, state);
        const previousModel = ctx.model;
        ctx.model = selected as typeof ctx.model;
        await pi.fire('model_select', { previousModel, model: selected, source }, ctx);
        const allowed = source === 'set' || source === 'cycle';
        const saved = readState(cwd);
        assert.equal(Boolean(saved.mainModelRecovery), !allowed);
        if (mode === 'loop') {
          assert.equal(saved.loop?.active, allowed);
          assert.equal(saved.loop?.iteration, 17);
          assert.equal(saved.loop?.bestValue, 42);
          assert.deepEqual(saved.loop?.history, beforeLoop!.history);
          assert.equal(saved.loop?.target, beforeLoop!.target);
        } else {
          assert.equal(saved.goal?.status, allowed ? 'active' : 'paused');
          assert.equal(saved.goal?.id, beforeGoal!.id);
          assert.equal(saved.goal?.objective, beforeGoal!.objective);
          assert.equal(saved.goal?.verificationContract, beforeGoal!.verificationContract);
          assert.deepEqual(saved.goal?.telemetry, beforeGoal!.telemetry);
          assert.deepEqual(saved.goal?.auditHistory, beforeGoal!.auditHistory);
        }
        if (allowed && mode !== 'loop') {
          await pi.fire('model_select', { previousModel: selected, model: selected, source }, ctx);
          await tick(1150);
          assert.equal(pi.sent.length, 1, 'repeated selection cannot duplicate recovery continuation');
        } else if (!allowed) assert.equal(pi.sent.length, 0);
      }, mode);
    });
  }
}

for (const hold of ['user', 'decision', 'permission', 'load', 'freeze', 'deterministic', 'forbidden', 'forbidden-observe-only', 'audit'] as const) {
  test(`manual selection respects protected ${hold} hold`, async () => {
    await withPressureSession(async (pi, ctx, cwd) => {
      const primary = `${ctx.model!.provider}/${ctx.model!.id}`;
      const goal = state.goal!;
      replaceState({ ...state,
        ...(hold === 'load' ? { loadHoldAt: Date.now() } : {}),
        ...(hold === 'freeze' ? { supervisorPausedAt: Date.now() } : {}),
        goal: { ...goal, ...(hold === 'audit' ? { pendingCompletion: { at: new Date().toISOString(), phase: 'retry-waiting' as const } } : {}), status: 'paused', pauseKind: hold === 'decision' || hold === 'permission' ? 'decision' : hold === 'user' ? 'blocked' : 'wait',
          pauseReason: hold === 'user' ? 'user stopped work' : hold === 'permission' ? 'upload requires explicit authorization' : hold === 'decision' ? 'choose product behavior' : 'main model recovery — retrying' },
        mainModelRecovery: { primary, active: primary, attempted: [primary], attempts: 3, kind: 'goal', reason: hold === 'deterministic' ? 'BadRequestError: too many images. "code":"400"' : 'provider unavailable', retryAt: new Date(Date.now() + 3600000).toISOString(), owner: { kind: 'goal', id: goal.id } },
      });
      persistStateLine(cwd, state);
      if (hold === 'forbidden' || hold === 'forbidden-observe-only') {
        const fs = await import('node:fs');
        fs.writeFileSync(`${cwd}/.pi-glla/settings.json`, JSON.stringify({ forbiddenModels: ['chosen'], blockForbiddenModelSwitches: hold !== 'forbidden-observe-only' }));
      }
      const previousModel = ctx.model;
      const selected = { provider: 'provider', id: 'chosen' };
      ctx.model = selected as typeof ctx.model;
      await pi.fire('model_select', { previousModel, model: selected, source: 'set' }, ctx);
      assert.equal(readState(cwd).goal?.status, 'paused');
      assert.ok(readState(cwd).mainModelRecovery, 'protected hold keeps its saved episode');
      assert.equal(pi.sent.length, 0);
    });
  });
}

test('manual-switch resume fails closed when the goal transaction cannot persist', async () => {
  await withPressureSession(async (pi, ctx, cwd) => {
    const fs = await import('node:fs');
    const goal = state.goal!;
    replaceState({ ...state,
      goal: { ...goal, status: 'paused', pauseKind: 'wait', pauseReason: 'main model recovery — retrying' },
      mainModelRecovery: { primary: 'provider/primary', active: 'provider/primary', attempted: ['provider/primary'], attempts: 1, kind: 'goal', reason: 'provider unavailable', owner: { kind: 'goal', id: goal.id } },
    });
    persistStateLine(cwd, state);
    const directory = `${cwd}/.pi-glla`, ledger = `${directory}/active.jsonl`;
    fs.chmodSync(ledger, 0o444);
    fs.chmodSync(directory, 0o555);
    try {
      await pi.fire('model_select', { model: { provider: 'provider', id: 'chosen' }, previousModel: ctx.model, source: 'set' }, ctx);
      assert.equal(state.goal?.status, 'paused');
      assert.equal(readState(cwd).goal?.status, 'paused');
      assert.ok(state.mainModelRecovery);
      assert.ok(ctx.ui.matching('recovery resume could not persist').length);
      assert.equal(pi.sent.length, 0);
    } finally { fs.chmodSync(directory, 0o755); fs.chmodSync(ledger, 0o644); }
  });
});

test('forbidden selection revert event is not manual resume consent', async () => {
  await withPressureSession(async (pi, ctx, cwd) => {
    const fs = await import('node:fs');
    fs.writeFileSync(`${cwd}/.pi-glla/settings.json`, JSON.stringify({ forbiddenModels: ['forbidden'] }));
    const goal = state.goal!;
    replaceState({ ...state,
      goal: { ...goal, status: 'paused', pauseKind: 'wait', pauseReason: 'main model recovery — retrying' },
      mainModelRecovery: { primary: 'provider/primary', active: 'provider/primary', attempted: ['provider/primary'], attempts: 1, kind: 'goal', reason: 'provider unavailable', owner: { kind: 'goal', id: goal.id } },
    });
    persistStateLine(cwd, state);
    const originalSetModel = pi.api.setModel;
    let reverts = 0;
    pi.api.setModel = async model => {
      reverts++;
      ctx.model = model;
      await pi.fire('model_select', { model, previousModel: { provider: 'provider', id: 'forbidden' }, source: 'set' }, ctx);
      return true;
    };
    try {
      await pi.fire('model_select', { model: { provider: 'provider', id: 'forbidden' }, previousModel: ctx.model, source: 'set' }, ctx);
      assert.equal(reverts, 1);
      assert.equal(readState(cwd).goal?.status, 'paused');
      assert.ok(readState(cwd).mainModelRecovery);
      assert.equal(pi.sent.length, 0);
    } finally { pi.api.setModel = originalSetModel; }
  });
});
