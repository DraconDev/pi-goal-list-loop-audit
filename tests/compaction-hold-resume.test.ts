import { test, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import activate, { __testOnlyResetProcessState } from '../extensions/loops/goal.js';
import { replaceState, state } from '../extensions/goal-state.js';
import { appendStateSnapshot, readState, type Goal } from '../extensions/goal-loop-core.js';
import { buildStatusText, buildWidgetLines } from '../extensions/goal-loop-display.js';
import { MockPi, makeMockCtx, seedState, seedGoal, tmpCwd, tick } from './harness/mock-pi.js';

const reason = 'context compaction failure: compact-first recovery exceeded its 120s budget';
function heldGoal(policy: 'goal' | 'list' = 'goal'): Goal {
  return seedGoal({ policy, status: 'paused', pauseKind: 'error', pauseReason: reason,
    pauseSuggestedAction: 'Inspect compaction, then /goal resume.' }) as unknown as Goal;
}
afterEach(() => __testOnlyResetProcessState());

for (const policy of ['goal', 'list'] as const) {
  test(`${policy} resume reactivates compaction-held work before optional primary probe`, async () => {
    __testOnlyResetProcessState();
    const pi = new MockPi();
    activate(pi.api);
    const cwd = tmpCwd();
    seedState(cwd, {});
    const ctx = makeMockCtx(cwd, { sessionManager: { name: 'compaction-resume-owner' } });
    await pi.fire('session_start', { reason: 'resume' }, ctx);
    const primary = `${ctx.model!.provider}/${ctx.model!.id}`;
    replaceState({ ...state, goal: heldGoal(policy), mainModelRecovery: {
      primary, active: primary, attempted: [primary], attempts: 0,
      reason: 'previous provider failure', kind: 'goal', primaryProbeInFlight: true,
    } });
    assert.equal(appendStateSnapshot(cwd, state), true);
    pi.sent.length = 0;
    await pi.command(policy, 'resume', ctx);
    await tick(80);
    assert.equal(state.goal?.status, 'active', 'primary failback must not consume the operational resume');
    assert.equal(readState(cwd).goal?.status, 'active', 'reactivation must be durable');
    assert.ok(pi.sent.length > 0, 'resume actually dispatches a fresh request; no provider success is assumed');
    assert.ok(!ctx.ui.notifies.some(n => n.message.startsWith('Probing the preferred primary now')), 'do not announce a probe that cannot schedule paused work');
    assert.equal(state.mainModelRecovery?.primaryProbeInFlight, true, 'preserve pending health verification until a real work response');
  });
}

test('old compaction hold renders actionable instructions and a short action-first footer', () => {
  const fixture = { goal: heldGoal(), list: [], loop: null } as unknown as typeof state;
  const status = buildStatusText(fixture, null, Date.now(), undefined, undefined, 44)!;
  assert.ok(status.includes('/goal resume'), status);
  assert.ok(status.length <= 44, status);
  assert.ok(!status.includes('owner:'), status);
  const widget = buildWidgetLines(fixture, null, Date.now(), undefined, 100)!.join('\n');
  assert.ok(widget.includes('/goal resume'), widget);
  assert.ok(widget.includes('/compact'), widget);
  assert.ok(!widget.includes('Inspect compaction'), widget);
  assert.ok(!widget.includes("this won't fix itself"), widget);
});
