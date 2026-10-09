import { test } from 'node:test';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import activate, { __testOnlyResetProcessState } from '../extensions/loops/goal.js';
import { readState } from '../extensions/goal-loop-core.js';
import { state } from '../extensions/goal-state.js';
import { retireOrphanedMainModelRecovery } from '../extensions/goal-recovery.js';
import { MockPi, makeMockCtx, seedGoal, seedState, tmpCwd } from './harness/mock-pi.js';

const recovery = {
  primary: 'provider/primary', active: 'provider/primary', attempted: ['provider/primary'],
  attempts: 4, kind: 'goal', reason: 'main model recovery — provider unavailable',
  retryAt: new Date(Date.now() + 3600000).toISOString(),
};

for (const fixture of ['absent-legacy', 'terminal', 'replaced', 'retained', 'chat'] as const) {
  test(`completed restore reconciles recovery ownership: ${fixture}`, async () => {
    __testOnlyResetProcessState();
    const global = process.env.GLLA_GLOBAL_SETTINGS_PATH!;
    const prior = fs.readFileSync(global, 'utf8');
    fs.writeFileSync(global, JSON.stringify({ autoResume: false, aggressiveMode: false }));
    const cwd = tmpCwd(), pi = new MockPi();
    const goal = fixture === 'retained' || fixture === 'replaced' || fixture === 'terminal'
      ? seedGoal({ id: 'current', status: fixture === 'terminal' ? 'complete' : 'paused', objective: 'retain the contract', verificationContract: 'saved acceptance' }) : null;
    const owner = fixture === 'chat' ? { kind: 'chat' } : fixture === 'absent-legacy' ? undefined : { kind: 'goal', id: fixture === 'replaced' ? 'predecessor' : 'current' };
    seedState(cwd, { goal, mainModelRecovery: { ...recovery, owner } });
    activate(pi.api);
    const ctx = makeMockCtx(cwd);
    try {
      await pi.fire('session_start', { reason: 'reload' }, ctx);
      const saved = readState(cwd);
      const retained = fixture === 'retained' || fixture === 'chat';
      assert.equal(Boolean(saved.mainModelRecovery), retained);
      if (retained) assert.deepEqual(saved.mainModelRecovery?.owner, owner);
      assert.equal(pi.sent.length, 0, 'ownership reconciliation never resumes unrelated held work');
      if (goal && fixture !== 'terminal') {
        assert.equal(saved.goal?.id, goal.id);
        assert.equal(saved.goal?.verificationContract, 'saved acceptance');
      }
      const ledger = fs.readFileSync(path.join(cwd, '.pi-glla', 'active.jsonl'), 'utf8');
      assert.equal(ledger.includes('main_model_recovery_retired'), !retained);
    } finally {
      await pi.fire('session_shutdown', { reason: 'test-end' }, ctx);
      fs.writeFileSync(global, prior);
      __testOnlyResetProcessState();
    }
  });
}

test('failed retirement persistence retains the marker and holds dispatch', async () => {
  __testOnlyResetProcessState();
  const cwd = tmpCwd(), pi = new MockPi();
  seedState(cwd, { goal: seedGoal({ id: 'owner', status: 'paused', pauseKind: 'decision' }), mainModelRecovery: { ...recovery, owner: { kind: 'goal', id: 'owner' } } });
  activate(pi.api);
  const ctx = makeMockCtx(cwd);
  const ledger = path.join(cwd, '.pi-glla', 'active.jsonl');
  const directory = path.dirname(ledger);
  try {
    await pi.fire('session_start', { reason: 'reload' }, ctx);
    assert.ok(state.goal);
    state.goal = { ...state.goal!, status: 'complete' };
    const previous = state.mainModelRecovery;
    fs.chmodSync(ledger, 0o444);
    fs.chmodSync(directory, 0o555);
    assert.equal(retireOrphanedMainModelRecovery(ctx as unknown as ExtensionContext, true), 'persistence-failed');
    assert.equal(state.mainModelRecovery, previous, 'failed cleanup restores the same episode');
    assert.ok(readState(cwd).mainModelRecovery, 'durable projection never falsely claims cleanup');
    assert.ok(ctx.ui.matching('recovery cleanup could not persist').length);
    assert.equal(pi.sent.length, 0);
  } finally {
    fs.chmodSync(directory, 0o755);
    fs.chmodSync(ledger, 0o644);
    await pi.fire('session_shutdown', { reason: 'test-end' }, ctx);
    __testOnlyResetProcessState();
  }
});

test('blank startup retains orphan marker until restore positively completes', async () => {
  __testOnlyResetProcessState();
  const cwd = tmpCwd(), pi = new MockPi();
  seedState(cwd, { goal: null, mainModelRecovery: recovery });
  activate(pi.api);
  const ctx = makeMockCtx(cwd, { sessionManager: { getSessionId: () => 'restore-owner', buildSessionContext: () => ({ messages: [] }) } });
  try {
    await pi.fire('session_start', { reason: 'startup' }, ctx);
    assert.ok(readState(cwd).mainModelRecovery, 'blank context cannot prove absence');
    assert.equal(pi.sent.length, 0);
    assert.equal(fs.readFileSync(path.join(cwd, '.pi-glla', 'active.jsonl'), 'utf8').includes('main_model_recovery_retired'), false);
  } finally {
    await pi.fire('session_shutdown', { reason: 'test-end' }, ctx);
    __testOnlyResetProcessState();
  }
});
