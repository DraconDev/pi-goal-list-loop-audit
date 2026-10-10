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
      console.log("NOTICES", JSON.stringify(ctx.ui.notifies.map(n => n.message)));
      const saved = readState(cwd);
      assert.equal(saved.goal?.status, 'active', 'the resumed goal must come back after recovery succeeds');
      const notices = [...ctx.ui.matching('/resum/i'), ...ctx.ui.matching('/Resumed goal/i')];
      assert.ok(notices.length > 0, JSON.stringify(ctx.ui.notifications ?? []));
      assert.doesNotMatch(notices.join('\n'), /continue/i);
    } finally { pi.api.setModel = original; }
  });
});
