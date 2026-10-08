import { test, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import activate, { __testOnlyResetProcessState } from '../extensions/loops/goal.js';
import { MockPi, makeMockCtx, seedState, seedGoal, tmpCwd, tick } from './harness/mock-pi.js';

afterEach(() => { __testOnlyResetProcessState(); });

test('complete_goal newObjective refuses when the ledger write fails instead of claiming durability', async () => {
  __testOnlyResetProcessState();
  const pi = new MockPi();
  activate(pi.api);
  const cwd = tmpCwd();
  seedState(cwd, {});
  const ctx = makeMockCtx(cwd, { sessionManager: { name: 'durability-gate' } });
  await pi.fire('session_start', { reason: 'startup' }, ctx);
  const { replaceState, state } = await import('../extensions/goal-state.js');
  replaceState({ ...state, goal: seedGoal({ status: 'active', objective: 'original objective' }) as any });
  const { appendStateSnapshot } = await import('../extensions/goal-loop-core.js');
  appendStateSnapshot(cwd, state);
  // Break durable storage: a directory where the active.jsonl line must land.
  const line = path.join(cwd, '.pi-glla', 'active.jsonl');
  fs.rmSync(line, { force: true });
  fs.mkdirSync(line, { recursive: true });
  const result = await pi.runTool('complete_goal', {
    completionSummary: 'Outcome: did the thing. Changed: code. Evidence: tests pass. Tests: bun test 1 pass. Unresolved: none. Next: none.',
    verificationSummary: 'evidence',
    newObjective: 'Shifted objective with contract',
  }, ctx);
  await tick(50);
  const text = result.content.map(c => c.text).join('\n');
  assert.equal(result.isError, true);
  assert.match(text, /NOT persisted/, 'ledger failure must refuse the durability gate');
});
