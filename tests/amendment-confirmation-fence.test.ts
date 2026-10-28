import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import activate, { __testOnlyLoadState, __testOnlyRegisterAgentTools, __testOnlyRememberCtx, __testOnlyResetOwnerSession, __testOnlyResetStaleFlag, __testOnlyResetTerminalFlags } from '../extensions/loops/goal.js';
import { state } from '../extensions/goal-state.js';
import { readState, type Goal } from '../extensions/goal-loop-core.js';
import { MockPi, makeMockCtx, seedGoal, seedState, tmpCwd } from './harness/mock-pi.js';

function reset() { __testOnlyResetOwnerSession(); __testOnlyResetStaleFlag(); __testOnlyResetTerminalFlags(); }
beforeEach(reset); afterEach(reset);
function harness() {
  const cwd = tmpCwd();
  seedState(cwd, { goal: seedGoal({ status: 'active', revision: 1, objective: 'Verify documentation ownership', verificationContract: 'Inspect the ownership map', taskList: { version: 1, tasks: [{ id: '1', title: 'Inspect ownership', status: 'complete' }] } }) });
  __testOnlyLoadState(cwd);
  const pi = new MockPi(); activate(pi.api); __testOnlyRegisterAgentTools(pi.api);
  const ctx = makeMockCtx(cwd); __testOnlyRememberCtx(ctx as never);
  return { cwd, pi, ctx };
}
const claim = { newObjective: 'Verify documentation ownership\nDone when: Inspect the ownership map and its coverage gate' };

for (const reordered of [false, true]) {
  test(`confirmed amendment survives identical rehydration (task key reorder=${reordered})`, async () => {
    const { cwd, pi, ctx } = harness();
    const originalBinary = process.env.GLLA_PI_BINARY;
    // A bounded inert worker isolates confirmation from provider availability.
    // The real detached audit is still admitted and is cancelled on shutdown.
    const worker = path.join(cwd, 'inert-auditor.mjs');
    fs.writeFileSync(worker, '#!/usr/bin/env node\nprocess.stdin.resume();\n'); fs.chmodSync(worker, 0o700);
    process.env.GLLA_PI_BINARY = worker;
    ctx.ui.confirmImpl = async () => {
      const original = state.goal!;
      state.goal = structuredClone(original);
      if (reordered) state.goal.taskList!.tasks = state.goal.taskList!.tasks.map(t => ({ status: t.status, title: t.title, id: t.id }));
      assert.deepEqual(state.goal, original);
      assert.notEqual(state.goal, original);
      return true;
    };
    try {
      const result = await pi.runTool('complete_goal', claim, ctx);
      assert.doesNotMatch(result.content[0]!.text, /target changed during scope confirmation/i);
      assert.equal(readState(cwd).goal?.revision, 2);
      assert.equal(readState(cwd).goal?.verificationContract?.replace(/^Done when:\s*/i, ''), 'Inspect the ownership map and its coverage gate');
      const journal = fs.readFileSync(path.join(cwd, '.pi-glla/active.jsonl'), 'utf8');
      assert.match(journal, /"goal_tweaked"/);
      assert.match(result.content[0]!.text, /AUDIT PENDING/);
    } finally {
      await pi.fire('session_shutdown', { reason: 'quit' }, ctx);
      if (originalBinary === undefined) delete process.env.GLLA_PI_BINARY; else process.env.GLLA_PI_BINARY = originalBinary;
    }
  });
}

const mutations: [string, (g: Goal) => void][] = [
  ['id', g => { g.id = 'replacement'; }],
  ['revision', g => { g.revision = (g.revision ?? 0) + 1; }],
  ['contract', g => { g.verificationContract = 'Different requirements'; }],
  ['objective', g => { g.objective = 'Different objective'; }],
  ['status', g => { g.status = 'paused'; }],
  ['policy', g => { g.policy = 'list'; }],
  ['task edit in place', g => { g.taskList!.tasks[0]!.title = 'Different task'; }],
  ['competing claim', g => { g.pendingCompletion = { at: new Date().toISOString(), attemptId: 'competing-attempt', phase: 'running' }; }],
];
for (const [label, mutate] of mutations) {
  test(`confirmed amendment rejects real ${label} change without durable amendment`, async () => {
    const { cwd, pi, ctx } = harness(); const before = readState(cwd).goal;
    ctx.ui.confirmImpl = async () => { mutate(state.goal!); return true; };
    const result = await pi.runTool('complete_goal', claim, ctx);
    assert.match(result.content[0]!.text, /target changed during scope confirmation/i);
    assert.deepEqual(readState(cwd).goal, before);
    if (label !== 'competing claim') assert.equal(state.goal?.pendingCompletion, undefined);
    else assert.equal(state.goal?.pendingCompletion?.attemptId, 'competing-attempt');
    assert.doesNotMatch(fs.readFileSync(path.join(cwd, '.pi-glla/active.jsonl'), 'utf8'), /"goal_tweaked"/);
  });
}

for (const boundary of ['session', 'owner', 'cancel'] as const) {
  test(`confirmation cannot cross a real ${boundary} boundary`, async () => {
    const { cwd, pi, ctx } = harness(); const before = readState(cwd).goal;
    const generation = sessionGeneration; const owner = ownerSession;
    ctx.ui.confirmImpl = async () => {
      if (boundary === 'session') sessionGeneration++;
      if (boundary === 'owner') ownerSession = makeMockCtx(cwd).sessionManager;
      if (boundary === 'cancel') state.goal = null;
      return true;
    };
    try {
      const result = await pi.runTool('complete_goal', claim, ctx);
      assert.match(result.content[0]!.text, /target changed during scope confirmation/i);
      assert.deepEqual(readState(cwd).goal, before);
      assert.equal(state.goal?.pendingCompletion, undefined);
    } finally { sessionGeneration = generation; ownerSession = owner; }
  });
}

test('identical rehydration is not a substitute for explicit amendment consent', async () => {
  const { cwd, pi, ctx } = harness(); const before = readState(cwd).goal;
  ctx.ui.confirmImpl = async () => { state.goal = structuredClone(state.goal); return false; };
  const result = await pi.runTool('complete_goal', claim, ctx);
  assert.match(result.content[0]!.text, /not confirmed/i);
  assert.deepEqual(readState(cwd).goal, before);
  assert.equal(state.goal?.pendingCompletion, undefined);
});
