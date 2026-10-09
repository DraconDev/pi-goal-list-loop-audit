import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withPressureSession } from './harness/context-pressure.js';
import { state, replaceState, persistStateLine } from '../extensions/goal-state.js';
import { tryMainModelFallback, mainModelRecoveryRuntimeStatus, probeMainModelRecovery } from '../extensions/goal-recovery.js';
import { classifyMainModelFailure } from '../extensions/main-model-recovery.js';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { tick } from './harness/mock-pi.js';

for (const mode of ['goal', 'list', 'loop'] as const) {
  for (const change of ['terminal', 'absent', 'replaced', 'new-episode', 'user-hold'] as const) {
    for (const rejects of [false, true]) {
      test(`${mode}: late ${rejects ? 'rejected' : 'accepted'} selection cannot cross ${change} boundary`, async () => {
        await withPressureSession(async (pi, ctx, cwd) => {
          let release!: () => void;
          const gate = new Promise<void>(resolve => { release = resolve; });
          const original = pi.api.setModel;
          pi.api.setModel = async () => { await gate; if (rejects) throw new Error('late model selection failure'); return true; };
          const pending = tryMainModelFallback(ctx as unknown as ExtensionContext, classifyMainModelFailure('provider unavailable'));
          try {
            await tick(10);
            assert.equal(state.mainModelRecovery?.pendingModelSwitch, 'provider/backup', 'the old operation is crossing the host boundary');
            if (change === 'new-episode') {
              state.mainModelRecovery = { ...state.mainModelRecovery!, recoveryEpisodeKey: 'new-owner-episode' };
            } else if (mode === 'loop') {
              replaceState({ ...state, loop: change === 'terminal' || change === 'absent' ? undefined
                : change === 'replaced' ? { ...state.loop!, startedAt: new Date(Date.now() + 1000).toISOString(), target: 'successor work' }
                : { ...state.loop!, active: false, stopReason: 'explicit user stop' } });
            } else {
              replaceState({ ...state, goal: change === 'absent' ? null
                : change === 'terminal' ? { ...state.goal!, status: 'complete' }
                : change === 'replaced' ? { ...state.goal!, id: 'successor', objective: 'successor work', verificationContract: 'successor acceptance' }
                : { ...state.goal!, status: 'paused', pauseKind: 'decision', pauseReason: 'upload requires explicit authorization' } });
            }
            persistStateLine(cwd, state);
            const expectedGoal = state.goal && { ...state.goal }, expectedLoop = state.loop && { ...state.loop };
            const retained = state.mainModelRecovery;
            release();
            assert.equal(await pending, false);
            assert.deepEqual(state.goal, expectedGoal);
            assert.deepEqual(state.loop, expectedLoop);
            if (change === 'new-episode' || change === 'user-hold') assert.equal(state.mainModelRecovery, retained, 'unrelated saved episode/hold is untouched');
            else {
              assert.equal(state.mainModelRecovery, undefined, 'confirmed terminal/absent/replaced owner is retired immediately');
              assert.equal(mainModelRecoveryRuntimeStatus()?.retryTimerArmed, false);
              assert.equal(mainModelRecoveryRuntimeStatus()?.hourlyTimerArmed, false);
            }
            if (change === 'user-hold') await probeMainModelRecovery(ctx as unknown as ExtensionContext);
            await tick(30);
            assert.equal(pi.sent.length, 0, 'late callbacks never dispatch or authorize successor work');
          } finally { release(); await pending; pi.api.setModel = original; }
        }, mode);
      });
    }
  }
}
