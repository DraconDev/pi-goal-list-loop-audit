import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withPressureSession } from './harness/context-pressure.js';
import { state, persistStateLine } from '../extensions/goal-state.js';
import { readState } from '../extensions/goal-loop-core.js';
import { tick } from './harness/mock-pi.js';

// /goal resume during a saved main-model recovery used to route into the
// recovery probe and stop there. When the probe won, the paused goal stayed
// paused because only recovery-reason parks were released, so the user had to
// type "continue" to get the goal running again.
test('goal resume recovers the provider and reactivates the paused goal', async () => {
  await withPressureSession(async (pi, ctx, cwd) => {
    state.goal = { ...state.goal!, status: 'paused', pauseKind: 'blocked', pauseReason: 'waiting on the operator' };
    state.mainModelRecovery = {
      kind: 'goal', primary: 'provider/primary', active: 'provider/primary',
      owner: { kind: 'goal', id: state.goal!.id },
      attempted: ['provider/primary'], attempts: 1,
      retryAt: new Date(Date.now() + 3_600_000).toISOString(),
      reason: 'main model recovery — provider unavailable',
    };
    persistStateLine(cwd, state);
    await tick(20);
    const original = pi.api.setModel;
    pi.api.setModel = async () => true;
    try {
      await pi.command('goal', 'resume', ctx);
      await tick(60);
      const saved = readState(cwd);
      assert.equal(saved.goal?.status, 'active', 'the resumed goal must come back after recovery succeeds');
      const notices = ctx.ui.notifies.map(n => n.message);
      assert.ok(notices.some(m => /resum/i.test(m)), JSON.stringify(notices));
    } finally { pi.api.setModel = original; }
  });
});

for (const boundary of ['supervisor', 'load', 'replacement', 'new-pause'] as const) {
  test(`post-probe resume stands down across ${boundary}`, async () => {
    await withPressureSession(async (pi, ctx, cwd) => {
      state.goal = { ...state.goal!, status: 'paused', pauseKind: 'blocked', pauseReason: 'waiting on the operator' };
      state.mainModelRecovery = {
        kind: 'goal', primary: 'provider/primary', active: 'provider/primary',
        owner: { kind: 'goal', id: state.goal.id }, attempted: ['provider/primary'], attempts: 1,
        retryAt: new Date(Date.now() + 3_600_000).toISOString(),
        reason: 'main model recovery — provider unavailable',
      };
      persistStateLine(cwd, state);
      const resume = pi.command('goal', 'resume', ctx);
      if (boundary === 'supervisor') state.supervisorPausedAt = Date.now();
      else if (boundary === 'load') state.loadHoldAt = Date.now();
      else state.goal = { ...state.goal!, ...(boundary === 'replacement' ? { id: 'successor' } : {}),
        status: 'paused', pauseKind: 'decision', pauseReason: 'new authorization required' };
      persistStateLine(cwd, state);
      const expected = state.goal;
      await resume; await tick(60);
      assert.equal(state.goal, expected, 'the later hold/snapshot stays untouched');
      assert.equal(readState(cwd).goal?.status, 'paused');
      assert.equal(ctx.ui.matching('Recovery probe settled — resuming').length, 0);
      assert.equal(pi.sent.length, 0);
    });
  });
}
