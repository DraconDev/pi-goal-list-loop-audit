// Diagnostic reproduction only: asserts the observed refusal, not desired behavior.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import activate, { __testOnlyLoadState, __testOnlyRegisterAgentTools, __testOnlyRememberCtx, __testOnlyResetOwnerSession, __testOnlyResetStaleFlag, __testOnlyResetTerminalFlags } from '../../extensions/loops/goal.js';
import { state } from '../../extensions/goal-state.js';
import { readState } from '../../extensions/goal-loop-core.js';
import { MockPi, makeMockCtx, seedGoal, seedState, tmpCwd } from '../../tests/harness/mock-pi.js';

test('current defect: semantically identical state replacement rejects a confirmed amendment', async () => {
  __testOnlyResetOwnerSession(); __testOnlyResetStaleFlag(); __testOnlyResetTerminalFlags();
  const cwd = tmpCwd();
  seedState(cwd, { goal: seedGoal({ status: 'active', revision: 1, objective: 'Verify documentation ownership', verificationContract: 'Inspect the ownership map' }) });
  __testOnlyLoadState(cwd);
  const pi = new MockPi(); activate(pi.api); __testOnlyRegisterAgentTools(pi.api);
  const ctx = makeMockCtx(cwd); __testOnlyRememberCtx(ctx as never);
  ctx.ui.confirmImpl = async () => {
    const original = state.goal!;
    state.goal = JSON.parse(JSON.stringify(original));
    assert.deepEqual(state.goal, original, 'no semantic change');
    assert.notEqual(state.goal, original, 'only identity changes');
    return true;
  };
  const result = await pi.runTool('complete_goal', { newObjective: 'Verify documentation ownership\nDone when: Inspect the ownership map and its coverage gate' }, ctx);
  assert.match(result.content[0]!.text, /target changed during scope confirmation/i);
  assert.equal(readState(cwd).goal?.revision, 1);
  assert.equal(readState(cwd).goal?.verificationContract, 'Inspect the ownership map');
});
