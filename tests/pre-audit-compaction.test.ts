import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import activate, { __testOnlyLoadState, __testOnlyResetOwnerSession, __testOnlyResetStaleFlag, __testOnlyResetTerminalFlags } from '../extensions/loops/goal.js';
import { __testOnlyResetCompactor, __testOnlySetSpawnWorker } from '../extensions/goal-compactor.js';
import { readState } from '../extensions/goal-loop-core.js';
import { currentUiStatusContext } from '../extensions/loops/goal-ui.js';
import { buildWidgetLines } from '../extensions/goal-loop-display.js';
import { MockPi, makeMockCtx, seedGoal, seedState, tick, tmpCwd } from './harness/mock-pi.js';

const originalBinary = process.env.GLLA_PI_BINARY;
afterEach(() => {
  __testOnlyResetCompactor(); __testOnlyResetOwnerSession(); __testOnlyResetStaleFlag(); __testOnlyResetTerminalFlags();
  if (originalBinary === undefined) delete process.env.GLLA_PI_BINARY; else process.env.GLLA_PI_BINARY = originalBinary;
});
async function setup() {
  __testOnlyResetOwnerSession(); __testOnlyResetStaleFlag(); __testOnlyResetTerminalFlags();
  const cwd = tmpCwd(), pi = new MockPi(); activate(pi.api);
  const ctx = makeMockCtx(cwd, { sessionManager: { name: `pre-audit-${Math.random()}` } });
  await pi.fire('session_start', { reason: 'startup' }, ctx);
  seedState(cwd, { goal: seedGoal({ status: 'active', policy: 'list', objective: 'Verify the intended feature', verificationContract: 'Inspect the feature behavior' }), list: [] });
  __testOnlyLoadState(cwd); pi.sent.length = 0;
  const started = path.join(cwd, 'audit-worker-starts');
  const worker = path.join(cwd, 'inert-auditor.mjs');
  fs.writeFileSync(worker, `#!/usr/bin/env node\nimport fs from 'node:fs';\nlet handled=false;process.stdin.on('data',()=>{if(!handled){handled=true;fs.appendFileSync(${JSON.stringify(started)},'started\\n');}});\n`);
  fs.chmodSync(worker, 0o700); process.env.GLLA_PI_BINARY = worker;
  __testOnlySetSpawnWorker(async () => ({ ok: true, brief: 'Preserve the completion claim.' }));
  let idle = false, tokens = 903644;
  ctx.isIdle = () => idle; ctx.hasPendingMessages = () => false;
  ctx.getContextUsage = () => ({ tokens, contextWindow: 1048000, percent: tokens / 10480 });
  const callbacks: { onComplete?(): void; onError?(error: Error): void }[] = [];
  ctx.compact = options => {
    callbacks.push({
      onComplete: () => options?.onComplete?.({ summary: 'Preserved completion claim', firstKeptEntryId: 'kept', tokensBefore: tokens }),
      onError: error => options?.onError?.(error),
    });
    idle = false;
  };
  return { cwd, pi, ctx, started, callbacks, setIdle: (v: boolean) => { idle = v; }, setTokens: (v: number) => { tokens = v; } };
}
async function waitForStart(file: string) {
  const until = performance.now() + 6000;
  while (!fs.existsSync(file) && performance.now() < until) await tick(10);
  assert.equal(fs.existsSync(file), true, 'the admitted stored claim launches its auditor');
}

for (const outcome of ['success', 'failure', 'unavailable'] as const) {
  test(`busy complete_goal stages admission, then ${outcome} launches exactly one stored audit`, async () => {
    const h = await setup();
    try {
      if (outcome === 'unavailable') Reflect.deleteProperty(h.ctx, 'compact');
      const result = await h.pi.runTool('complete_goal', { completionSummary: 'Outcome: feature verified. Changed: intended feature. Evidence: checks. Tests: focused pass. Unresolved: none. Next: none.' }, h.ctx);
      assert.match(result.content[0]!.text, /AUDIT PENDING/);
      const staged = readState(h.cwd).goal!;
      assert.equal(staged.status, 'auditing');
      assert.equal(staged.pendingCompletion?.preAuditCompaction, true);
      assert.notEqual(currentUiStatusContext(h.ctx as unknown as ExtensionContext).evidence?.compaction?.reason, 'audit', 'an unlaunched claim must not pretend a live audit blocks compaction');
      assert.match(buildWidgetLines(readState(h.cwd), null)?.join('\n') ?? '', /waiting for safe compaction boundary/);
      assert.equal(h.callbacks.length, 0, 'a busy tool callback never compacts');
      assert.equal(fs.existsSync(h.started), false, 'no worker before owned idle admission');
      await h.pi.fire('agent_settled', {}, h.ctx);
      assert.equal(h.callbacks.length, 0, 'a falsely settled but still busy host stays held');
      h.setIdle(true);
      await h.pi.fire('agent_settled', {}, h.ctx);
      if (outcome !== 'unavailable') {
        assert.equal(h.callbacks.length, 1);
        assert.equal(fs.existsSync(h.started), false, 'the audit must not overlap compaction');
        await h.pi.fire('agent_settled', {}, h.ctx);
        assert.equal(h.callbacks.length, 1, 'repeated contact cannot double compact');
        h.setIdle(true);
        if (outcome === 'success') {
          h.setTokens(80000);
          h.callbacks[0]!.onComplete?.();
          await h.pi.fire('session_compact', {}, h.ctx);
        } else h.callbacks[0]!.onError?.(new Error('summarizer unavailable'));
      }
      await waitForStart(h.started);
      await h.pi.fire('agent_settled', {}, h.ctx);
      await tick(40);
      assert.equal(fs.readFileSync(h.started, 'utf8').trim().split('\n').length, 1);
      const admitted = readState(h.cwd).goal!;
      assert.equal(admitted.pendingCompletion?.preAuditCompaction, undefined);
      assert.equal(admitted.pendingCompletion?.completionSummary, staged.pendingCompletion?.completionSummary);
      assert.equal(admitted.objective, staged.objective);
      assert.equal(admitted.verificationContract, staged.verificationContract);
      assert.equal(h.pi.sent.length, 0, 'admission does not enqueue another main-agent turn');
    } finally { await h.pi.fire('session_shutdown', { reason: 'quit' }, h.ctx); }
  });
}

for (const guard of ['decision', 'cold-load', 'cancel', 'revision'] as const) {
  test(`a staged claim cannot bypass ${guard}`, async () => {
    const h = await setup();
    try {
      await h.pi.runTool('complete_goal', {}, h.ctx);
      const saved = readState(h.cwd);
      if (guard === 'decision') {
        saved.goal = { ...saved.goal!, status: 'paused', pauseKind: 'decision', pauseReason: 'Choose scope', pauseOptions: ['Keep', 'Cancel'] };
      } else if (guard === 'cold-load') saved.loadHoldAt = Date.now();
      else if (guard === 'cancel') saved.goal = null;
      else saved.goal = { ...saved.goal!, revision: (saved.goal!.revision ?? 0) + 1, pendingCompletion: undefined };
      seedState(h.cwd, saved); __testOnlyLoadState(h.cwd);
      h.setIdle(true);
      await h.pi.fire('agent_settled', {}, h.ctx);
      await tick(30);
      assert.equal(h.callbacks.length, 0);
      assert.equal(fs.existsSync(h.started), false);
      if (guard === 'decision') assert.equal(readState(h.cwd).goal?.pauseKind, 'decision');
      if (guard === 'cold-load') assert.equal(readState(h.cwd).loadHoldAt, saved.loadHoldAt);
    } finally { await h.pi.fire('session_shutdown', { reason: 'quit' }, h.ctx); }
  });
}

for (const race of ['revision', 'cancel', 'session', 'owner'] as const) {
  test(`late compaction callbacks cannot dispatch across ${race} change`, async () => {
    const h = await setup(); const generation = sessionGeneration, owner = ownerSession;
    try {
      await h.pi.runTool('complete_goal', {}, h.ctx);
      h.setIdle(true); await h.pi.fire('agent_settled', {}, h.ctx);
      assert.equal(h.callbacks.length, 1);
      const saved = readState(h.cwd);
      if (race === 'revision') saved.goal = { ...saved.goal!, revision: (saved.goal!.revision ?? 0) + 1 };
      if (race === 'cancel') saved.goal = null;
      if (race === 'revision' || race === 'cancel') { seedState(h.cwd, saved); __testOnlyLoadState(h.cwd); }
      if (race === 'session') sessionGeneration++;
      if (race === 'owner') ownerSession = makeMockCtx(h.cwd).sessionManager;
      h.setIdle(true); h.callbacks[0]!.onError?.(new Error('late summarizer failure'));
      await tick(40);
      assert.equal(fs.existsSync(h.started), false);
      if (race === 'revision') {
        assert.equal(readState(h.cwd).goal?.status, 'paused');
        assert.match(readState(h.cwd).goal?.pauseSuggestedAction ?? '', /\/goal verify/);
        assert.equal(readState(h.cwd).goal?.pendingCompletion?.preAuditCompaction, true);
      }
    } finally {
      sessionGeneration = generation; ownerSession = owner;
      await h.pi.fire('session_shutdown', { reason: 'quit' }, h.ctx);
    }
  });
}
