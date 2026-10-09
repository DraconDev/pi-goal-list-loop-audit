import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { withPressureSession } from './harness/context-pressure.js';
import { state, replaceState, persistStateLine } from '../extensions/goal-state.js';
import { formatMainModelRecoveryStatus } from '../extensions/goal-loop-core.js';
import { clearMainModelRecoveryTimer, mainModelRecoveryRuntimeStatus, scheduleMainModelRecoveryTimer } from '../extensions/goal-recovery.js';

for (const mode of ['goal', 'list', 'loop'] as const) {
  test(`${mode}: live recovery diagnostic distinguishes an armed timer from the same saved deadline without a timer`, async () => {
    await withPressureSession(async (_pi, ctx, cwd) => {
      const primary = `${ctx.model!.provider}/${ctx.model!.id}`;
      replaceState({ ...state, mainModelRecovery: {
        primary, active: primary, attempted: [primary], attempts: 0,
        firstFailureAt: new Date(Date.now() - 5 * 3600000).toISOString(),
        retryAt: new Date(Date.now() + 3600000).toISOString(),
        reason: 'provider unavailable', kind: mode === 'loop' ? 'loop' : 'goal',
      } });
      persistStateLine(cwd, state);
      clearMainModelRecoveryTimer();
      let runtime = mainModelRecoveryRuntimeStatus()!;
      assert.equal(runtime.retryTimerArmed, false);
      assert.match(formatMainModelRecoveryStatus(state.mainModelRecovery, [], Date.now(), runtime).join('\n'), /stalled\/unarmed/);
      scheduleMainModelRecoveryTimer(ctx as unknown as ExtensionContext, 3600000);
      runtime = mainModelRecoveryRuntimeStatus()!;
      assert.equal(runtime.retryTimerArmed, true);
      assert.match(formatMainModelRecoveryStatus(state.mainModelRecovery, [], Date.now(), runtime).join('\n'), /timer armed/);
      clearMainModelRecoveryTimer();
      assert.equal(mainModelRecoveryRuntimeStatus()!.retryTimerArmed, false);
      state.supervisorPausedAt = Date.now();
      const held = formatMainModelRecoveryStatus(state.mainModelRecovery, [], Date.now(), mainModelRecoveryRuntimeStatus()).join('\n');
      assert.match(held, /held — supervisor pause/);
      assert.ok(!held.includes('stalled/unarmed'));
      assert.equal(state.mainModelRecovery!.attempts, 0, 'rendering/timer registration never manufactures provider-attempt counts');
    }, mode);
  });
}
