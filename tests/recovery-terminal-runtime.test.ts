import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { withPressureSession } from './harness/context-pressure.js';
import { state, replaceState, persistStateLine } from '../extensions/goal-state.js';
import { readState } from '../extensions/goal-loop-core.js';
import { archiveCurrentGoal } from '../extensions/loops/goal-orchestrator.js';
import { mainModelRecoveryRuntimeStatus, scheduleMainModelRecoveryTimer } from '../extensions/goal-recovery.js';

for (const mode of ['goal', 'list', 'loop'] as const) {
  test(`${mode}: explicit cancellation removes its recovery and cancels both timers immediately`, async () => {
    await withPressureSession(async (pi, ctx, cwd) => {
      const primary = `${ctx.model!.provider}/${ctx.model!.id}`;
      const retryAt = new Date(Date.now() + 3600000).toISOString();
      replaceState({ ...state,
        goal: state.goal && { ...state.goal, status: 'paused', pauseKind: 'wait', pauseReason: 'main model recovery', pauseResumeAt: retryAt },
        loop: state.loop && { ...state.loop, active: false, stopReason: 'main model recovery' },
        mainModelRecovery: { primary, active: primary, attempted: [primary], attempts: 4, retryAt, kind: mode === 'loop' ? 'loop' : 'goal', reason: 'provider unavailable',
          owner: mode === 'loop' ? { kind: 'loop', startedAt: state.loop!.startedAt } : { kind: 'goal', id: state.goal!.id } },
      });
      persistStateLine(cwd, state);
      scheduleMainModelRecoveryTimer(ctx as unknown as ExtensionContext, 3600000);
      assert.equal(mainModelRecoveryRuntimeStatus()?.retryTimerArmed, true);
      assert.equal(mainModelRecoveryRuntimeStatus()?.hourlyTimerArmed, true);
      await pi.command(mode === 'loop' ? 'loop' : mode === 'list' ? 'list' : 'goal', mode === 'loop' ? 'stop' : 'cancel', ctx);
      assert.equal(readState(cwd).mainModelRecovery, undefined);
      assert.equal(mainModelRecoveryRuntimeStatus()?.retryTimerArmed, false);
      assert.equal(mainModelRecoveryRuntimeStatus()?.hourlyTimerArmed, false);
      assert.equal(pi.sent.length, 0);
    }, mode);
  });
}

test('terminal archive does not adopt or delete explicitly unrelated ordinary-chat recovery', async () => {
  await withPressureSession(async (_pi, ctx, cwd) => {
    const chat = { primary: 'provider/primary', active: 'provider/primary', attempted: ['provider/primary'], attempts: 2, kind: 'goal' as const, reason: 'provider unavailable', owner: { kind: 'chat' as const } };
    state.mainModelRecovery = chat;
    persistStateLine(cwd, state);
    const goalId = state.goal!.id;
    assert.equal(archiveCurrentGoal(ctx as unknown as ExtensionContext, 'aborted', 'cancel only the tracked objective'), true);
    assert.equal(readState(cwd).goal, null, 'terminal archive clears the live slot');
    assert.deepEqual(readState(cwd).mainModelRecovery, chat, 'unrelated chat recovery is neither adopted nor deleted by goal archival');
    const { archivedGoalPath } = await import('../extensions/goal-loop-core.js');
    assert.ok((await import('node:fs')).existsSync(archivedGoalPath(cwd, goalId)), 'terminal archive lands on disk');
  });
});
