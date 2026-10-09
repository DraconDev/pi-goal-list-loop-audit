import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { withPressureSession } from './harness/context-pressure.js';
import { state, replaceState, persistStateLine } from '../extensions/goal-state.js';
import { readState } from '../extensions/goal-loop-core.js';
import { rearmLegacyElapsedRecoveryHold } from '../extensions/goal-recovery.js';

const hold = 'main model recovery — automatic probes stopped (the 24h automatic recovery horizon was reached)';
for (const mode of ['goal', 'list', 'loop'] as const) {
  test(`${mode}: confirmed consented reload rearms only the legacy elapsed-time hold`, async () => {
    await withPressureSession(async (pi, ctx, cwd) => {
      const before = readState(cwd);
      const primary = `${ctx.model!.provider}/${ctx.model!.id}`;
      replaceState({ ...state,
        goal: state.goal && { ...state.goal, status: 'paused', pauseKind: 'blocked', pauseReason: hold },
        loop: state.loop && { ...state.loop, active: false, stopReason: hold },
        mainModelRecovery: { primary, active: primary, attempted: [primary], attempts: 40, sameModelRetries: 9,
          kind: mode === 'loop' ? 'loop' : 'goal', reason: '503 Service Unavailable', manualResumeRequired: true,
          firstFailureAt: new Date(Date.now() - 7 * 24 * 3600000).toISOString(), autoRetryUntil: new Date(Date.now() - 6 * 24 * 3600000).toISOString(),
          owner: mode === 'loop' ? { kind: 'loop', startedAt: state.loop!.startedAt } : { kind: 'goal', id: state.goal!.id },
        },
      });
      persistStateLine(cwd, state);
      const episode = state.mainModelRecovery;
      const typedCtx = ctx as unknown as ExtensionContext;
      assert.equal(rearmLegacyElapsedRecoveryHold(typedCtx, false, true), false, 'incomplete restore is never consent');
      assert.equal(rearmLegacyElapsedRecoveryHold(typedCtx, true, false), false, 'cold restore without consent retains its hold');
      assert.equal(state.mainModelRecovery, episode);
      await pi.fire('session_start', { reason: 'reload' }, ctx);
      const saved = readState(cwd);
      assert.equal(saved.mainModelRecovery?.manualResumeRequired, undefined);
      assert.equal(saved.mainModelRecovery?.autoRetryUntil, undefined);
      assert.ok(saved.mainModelRecovery?.retryAt);
      assert.equal(saved.mainModelRecovery?.attempts, 40);
      assert.equal(saved.mainModelRecovery?.sameModelRetries, 9);
      assert.equal(saved.mainModelRecovery?.firstFailureAt, episode?.firstFailureAt);
      if (mode === 'loop') {
        assert.equal(saved.loop?.target, before.loop?.target);
        assert.equal(saved.loop?.startedAt, before.loop?.startedAt);
        assert.equal(saved.loop?.iteration, before.loop?.iteration);
      } else {
        assert.equal(saved.goal?.id, before.goal?.id);
        assert.equal(saved.goal?.objective, before.goal?.objective);
        assert.equal(saved.goal?.verificationContract, before.goal?.verificationContract);
        assert.equal(saved.goal?.pauseKind, 'wait');
      }
      assert.equal(pi.sent.length, 0, 'the retained paced deadline is not an immediate dispatch');
    }, mode);
  });
}

test('legacy horizon-looking text never releases a decision, audit, explicit manual or deterministic hold', async () => {
  await withPressureSession(async (_pi, ctx, cwd) => {
    const goal = state.goal!;
    const primary = `${ctx.model!.provider}/${ctx.model!.id}`;
    for (const fixture of ['decision', 'audit', 'manual', 'deterministic', 'supervisor', 'load', 'replaced'] as const) {
      replaceState({ ...state, supervisorPausedAt: fixture === 'supervisor' ? Date.now() : undefined, loadHoldAt: fixture === 'load' ? Date.now() : undefined,
        goal: { ...goal, status: 'paused', pauseKind: fixture === 'decision' ? 'decision' : 'blocked', pauseReason: fixture === 'manual' ? 'main model recovery — automatic probes stopped (explicit manual action required)' : hold,
          pendingCompletion: fixture === 'audit' ? { at: new Date().toISOString(), phase: 'retry-waiting' } : undefined },
        mainModelRecovery: { primary, active: primary, attempted: [primary], attempts: 40, kind: 'goal', manualResumeRequired: true,
          reason: fixture === 'deterministic' ? 'invalid_request_error: trim request' : '503 Service Unavailable',
          owner: { kind: 'goal', id: fixture === 'replaced' ? 'previous-owner' : goal.id } },
      });
      persistStateLine(cwd, state);
      const recovery = state.mainModelRecovery;
      assert.equal(rearmLegacyElapsedRecoveryHold(ctx as unknown as ExtensionContext, true, true), false, fixture);
      assert.equal(state.mainModelRecovery, recovery);
      assert.equal(state.goal?.status, 'paused');
    }
  });
});
