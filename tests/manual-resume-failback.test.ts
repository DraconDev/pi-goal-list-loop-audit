import { test, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import activate, { __testOnlyResetProcessState } from '../extensions/loops/goal.js';
import { replaceState, state } from '../extensions/goal-state.js';
import { appendStateSnapshot, readState, type Goal } from '../extensions/goal-loop-core.js';
import { buildWidgetLines } from '../extensions/goal-loop-display.js';
import { MockPi, makeMockCtx, seedState, seedGoal, tmpCwd, tick } from './harness/mock-pi.js';

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
afterEach(() => {
  __testOnlyResetProcessState();
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
});
async function fixture() {
  __testOnlyResetProcessState();
  process.env.PI_CODING_AGENT_DIR = tmpCwd();
  const pi = new MockPi();
  activate(pi.api);
  const cwd = tmpCwd();
  seedState(cwd, {});
  const ctx = makeMockCtx(cwd, { sessionManager: { name: 'manual-resume' } });
  await pi.fire('session_start', { reason: 'resume' }, ctx);
  const primary = `${ctx.model!.provider}/${ctx.model!.id}`;
  state.mainModelRecovery = { primary, active: primary, attempted: [primary], attempts: 0,
    reason: 'old provider failure', kind: 'goal', primaryProbeInFlight: true };
  return { pi, cwd, ctx };
}

test('selected decision resumes real work despite an unfinished preferred-primary probe', async () => {
  const { pi, cwd, ctx } = await fixture();
  const goal = seedGoal({ status: 'paused', pauseKind: 'decision', pauseReason: 'Choose the verification approach',
    pauseOptions: ['Change the benchmark', 'Keep the contract; collect hardware evidence'],
    verificationContract: 'Both medians <= 16.7ms' }) as unknown as Goal;
  replaceState({ ...state, goal });
  appendStateSnapshot(cwd, state);
  const widget = buildWidgetLines(state, null, Date.now(), undefined, 100)!.join('\n');
  assert.ok(widget.includes('/goal decide'), widget);
  ctx.ui.selectImpl = async (_title, options) => options[1];
  pi.sent.length = 0;
  await pi.command('goal', 'decide', ctx);
  await tick(100);
  assert.equal(readState(cwd).goal?.status, 'active');
  assert.equal(state.goal?.verificationContract, 'Both medians <= 16.7ms', 'the resume mechanism cannot silently amend acceptance');
  assert.ok(pi.userMessages.some(m => m.message.includes('Keep the contract; collect hardware evidence')));
  assert.ok(pi.sent.length > 0, 'after selection the goal continuation actually dispatches');
  assert.ok(!ctx.ui.notifies.some(n => n.message.startsWith('Probing the preferred primary now')));
});

test('cancelled decision picker preserves the pause and the verification contract', async () => {
  const { pi, cwd, ctx } = await fixture();
  replaceState({ ...state, goal: seedGoal({ status: 'paused', pauseKind: 'decision', pauseOptions: ['One', 'Two'], verificationContract: 'unchanged' }) as unknown as Goal });
  appendStateSnapshot(cwd, state);
  ctx.ui.selectImpl = async () => undefined;
  pi.sent.length = 0;
  await pi.command('goal', 'decide', ctx);
  assert.equal(state.goal?.status, 'paused');
  assert.equal(state.goal?.verificationContract, 'unchanged');
  assert.equal(pi.sent.length, 0);
  assert.equal(pi.userMessages.length, 0);
});

test('Designer stays off on startup and is registered only when a live goal explicitly selects it', async () => {
  const { pi, cwd, ctx } = await fixture();
  const designerFile = path.join(process.env.PI_CODING_AGENT_DIR!, 'agents', 'Designer.md');
  assert.equal(fs.existsSync(designerFile), false, 'plain startup does not enable Designer');
  replaceState({ ...state, mainModelRecovery: undefined, goal: seedGoal({ status: 'paused', pauseKind: 'blocked', agentRole: 'designer' }) as unknown as Goal });
  appendStateSnapshot(cwd, state);
  await pi.command('goal', 'resume', ctx);
  await tick(100);
  assert.equal(fs.existsSync(designerFile), true, 'explicit role is made available at dispatch, not silently skipped');
  assert.ok(pi.sent.some(m => m.message.content?.includes('DESIGNER ROLE REQUESTED')));
});

test('no-objective resume retires a stale probe marker without inventing a goal or claiming provider health', async () => {
  const { pi, cwd, ctx } = await fixture();
  appendStateSnapshot(cwd, state);
  const widget = buildWidgetLines(state, null, Date.now(), undefined, 120)!.join('\n');
  assert.ok(widget.includes("send 'continue'"), widget);
  assert.ok(!widget.includes('work is saved'), widget);
  pi.sent.length = 0;
  await pi.command('glla', 'resume', ctx);
  assert.equal(state.mainModelRecovery, undefined);
  assert.equal(readState(cwd).mainModelRecovery, undefined);
  assert.equal(state.goal, null);
  assert.equal(pi.sent.length, 0);
  assert.equal(pi.userMessages.length, 0);
  assert.ok(ctx.ui.notifies.some(n => n.message.includes("Send 'continue'")));
});
