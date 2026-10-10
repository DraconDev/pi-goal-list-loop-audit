import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { withPressureSession } from './harness/context-pressure.js';
import { state, persistStateLine } from '../extensions/goal-state.js';
import { probeMainModelRecovery } from '../extensions/goal-recovery.js';
import { tick } from './harness/mock-pi.js';

for (const mode of ['goal', 'list', 'loop'] as const) {
  for (const hold of ['supervisor', 'load'] as const) {
    for (const outcome of ['accepted', 'rejected', 'thrown'] as const) {
      test(`${mode}: ${hold} hold survives delayed ${outcome} recovery selection`, async () => {
        await withPressureSession(async (pi, ctx, cwd) => {
          const reason = 'main model recovery — provider unavailable';
          if (mode === 'loop') state.loop = { ...state.loop!, active: false, stopReason: reason };
          else state.goal = { ...state.goal!, status: 'paused', pauseKind: 'wait', pauseReason: reason };
          state.mainModelRecovery = {
            kind: mode === 'loop' ? 'loop' : 'goal', primary: 'provider/primary', active: 'provider/primary',
            owner: mode === 'loop' ? { kind: 'loop', startedAt: state.loop!.startedAt } : { kind: 'goal', id: state.goal!.id },
            attempted: ['provider/primary'], attempts: 1, sameModelRetries: 999,
            firstFailureAt: new Date().toISOString(), reason,
          };
          persistStateLine(cwd, state);
          let release!: () => void;
          const gate = new Promise<void>(resolve => { release = resolve; });
          let selections = 0;
          const original = pi.api.setModel;
          pi.api.setModel = async model => {
            selections++;
            await gate;
            if (outcome === 'thrown') throw new Error('late rejection');
            if (outcome === 'rejected') return false;
            ctx.model = model;
            return true;
          };
          const pending = probeMainModelRecovery(ctx as unknown as ExtensionContext);
          try {
            await tick(10);
            assert.equal(state.mainModelRecovery?.pendingModelSwitch, 'provider/backup');
            if (hold === 'supervisor') await pi.command('glla', 'pause', ctx);
            else { state.loadHoldAt = new Date().toISOString(); persistStateLine(cwd, state); }
            const savedGoal = state.goal && { ...state.goal }, savedLoop = state.loop && { ...state.loop };
            const cursor = { ...state.mainModelRecovery! };
            release(); await pending;
            assert.deepEqual(state.goal, savedGoal);
            assert.deepEqual(state.loop, savedLoop);
            assert.deepEqual(state.mainModelRecovery, cursor, 'held cursor remains reconcilable');
            assert.equal(pi.sent.length, 0);
            assert.equal(ctx.ui.matching('sending one supervised probe').length, 0);
            if (outcome === 'accepted') {
              state.supervisorPausedAt = null; state.loadHoldAt = null;
              persistStateLine(cwd, state);
              await probeMainModelRecovery(ctx as unknown as ExtensionContext);
              assert.equal(selections, 1, 'resume reconciles committed selection without selecting twice');
              assert.equal(state.mainModelRecovery?.pendingModelSwitch, undefined);
              assert.equal(mode === 'loop' ? state.loop?.active : state.goal?.status === 'active', true);
            }
          } finally { release(); await pending; pi.api.setModel = original; }
        }, mode);
      });
    }
  }
}
