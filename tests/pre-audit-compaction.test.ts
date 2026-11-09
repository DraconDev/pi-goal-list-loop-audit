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
import { waitFor } from './harness/host-budget.js';

const originalBinary = process.env.GLLA_PI_BINARY;
afterEach(() => {
  __testOnlyResetCompactor(); __testOnlyResetOwnerSession(); __testOnlyResetStaleFlag(); __testOnlyResetTerminalFlags();
  if (originalBinary === undefined) delete process.env.GLLA_PI_BINARY; else process.env.GLLA_PI_BINARY = originalBinary;
});
async function setup() {
  __testOnlyResetOwnerSession(); __testOnlyResetStaleFlag(); __testOnlyResetTerminalFlags();
  const cwd = tmpCwd(), pi = new MockPi(); activate(pi.api);
  const ctx = makeMockCtx(cwd, { sessionManager: { name: `pre-audit-${Math.random()}` } });
  // Keep both direct and recovery dispatch paths independent of configured
  // provider registries; only the inert session-model worker is available.
  Object.assign(ctx, { modelRegistry: { find: () => undefined, getAvailable: () => [ctx.model], getAll: () => [ctx.model], hasConfiguredAuth: () => true } });
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
  // The admitted claim boots a child process. On a loaded host that boot is
  // slower than on an idle one, so the budget comes from the shared
  // host-scaled helper instead of a hand-rolled wall clock: the condition is
  // still required (a claim that never dispatches fails), it just gets the
  // CPU time the wait assumes.
  await waitFor(() => fs.existsSync(file), {
    timeoutMs: 6000,
    intervalMs: 10,
    message: 'the admitted stored claim launches its auditor',
  });
}

for (const outcome of ['success', 'failure', 'unavailable'] as const) {
  test(`busy complete_goal stages admission, then ${outcome} launches exactly one stored audit`, async () => {
    const h = await setup();
    try {
      if (outcome === 'unavailable') Reflect.deleteProperty(h.ctx, 'compact');
      const result = await h.pi.runTool('complete_goal', { completionSummary: 'Outcome: feature verified. Changed: intended feature. Evidence: checks. Tests: focused pass. Unresolved: none. Next: none.' }, h.ctx);
      const staged = readState(h.cwd).goal!;
      // DURABLE admission state, not response wording: the claim is persisted
      // as staged pre-audit debt and no worker has been launched for it.
      assert.equal(result.isError, undefined, 'a staged admission is not a failure');
      assert.equal(staged.status, 'auditing');
      assert.equal(staged.pendingCompletion?.preAuditCompaction, true);
      assert.ok(staged.pendingCompletion?.attemptId, 'the retained completion claim is stored');
      // STRUCTURAL non-live-audit classification: this claim has not launched a
      // worker, so its compaction reason must not be `audit` (which would mean
      // a live audit blocks compaction) and the rendered surface must not
      // claim a live detached auditor. Asserting the typed classification and
      // the liveness badge keeps the requirement without pinning prose.
      assert.notEqual(currentUiStatusContext(h.ctx as unknown as ExtensionContext).evidence?.compaction?.reason, 'audit', 'an unlaunched claim must not pretend a live audit blocks compaction');
      assert.doesNotMatch(buildWidgetLines(readState(h.cwd), null)?.join('\n') ?? '', /DETACHED · LIVE/, 'a staged claim must not render as a live detached auditor');
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

// ────────────────────────────────────────────────────────────────────
// Field 2026-11-09 (GitHub #62 follow-up): a session boundary during the
// admission wait stranded the claim on a manual resume.
//
// The operator's transcript: `complete_goal` staged admission ("GLLA will
// check preventive compaction at an owned idle boundary"), the host then
// reloaded extensions before that boundary arrived, and afterwards the item
// sat at
//   completion audit: parked — no review recorded
//   next: /list resume starts a fresh auditor
// with the rest of the list (14 queued) frozen behind it.
//
// What the machinery should do: a same-process successor already grants the
// stored claim one automatic recovery (v0.35.50) — the submitted claim IS the
// consent. But the admission-debt gate in the dispatch path requires
// `status === "auditing"` for every origin except manual/agent, while the
// automatic recovery only runs when the goal is `paused`, so the one automatic
// retry could never clear the debt it was created for: a dead end that reads
// to the user as an "auditor/session issue".
// ────────────────────────────────────────────────────────────────────

function sameProcessReloadSidecar(cwd: string): void {
  fs.mkdirSync(path.join(cwd, '.pi-glla'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.pi-glla', 'session-owner.json'), JSON.stringify({
    pid: process.pid,
    at: new Date().toISOString(),
    generation: 7,
    ownerSessionId: 'pre-reload-session',
    shutdownReason: 'reload',
  }));
}

test('a reload during the admission wait still launches the stored audit (no manual resume)', async () => {
  const h = await setup();
  const settingsPath = process.env.GLLA_GLOBAL_SETTINGS_PATH!;
  const previousSettings = fs.readFileSync(settingsPath, 'utf8');
  try {
    // 1. Busy complete_goal stages admission debt — the transcript's first line.
    const result = await h.pi.runTool('complete_goal', { completionSummary: 'Outcome: staged. Changed: x. Evidence: y. Tests: z. Unresolved: none. Next: none.' }, h.ctx);
    assert.equal(result.isError, undefined);
    const staged = readState(h.cwd).goal!;
    assert.equal(staged.pendingCompletion?.preAuditCompaction, true);
    assert.equal(staged.status, 'auditing');

    // 2. The host reloads BEFORE the owned idle boundary: the shutdown path
    //    parks the claim as recovery-pending and the admission debt rides it.
    await h.pi.fire('session_shutdown', { reason: 'reload' }, h.ctx);
    const parked = readState(h.cwd).goal!;
    assert.equal(parked.status, 'paused', 'a session boundary parks the claim');
    assert.equal(parked.pendingCompletion?.phase, 'recovery-pending');
    assert.equal(parked.pendingCompletion?.preAuditCompaction, true, 'the admission debt survives the boundary');

    // 3. The successor session in the SAME process: stock settings (autoResume
    //    unset) — consent comes from the same-process reload, not a setting.
    fs.writeFileSync(settingsPath, JSON.stringify({}));
    sameProcessReloadSidecar(h.cwd);
    __testOnlyResetOwnerSession(); __testOnlyResetStaleFlag(); __testOnlyResetTerminalFlags();
    const successor = makeMockCtx(h.cwd, {
      sessionManager: { name: `successor-${Date.now()}`, getSessionId: () => 'successor-session-id' },
    });
    let idle = true;
    let tokens = 903644;
    Object.assign(successor, { modelRegistry: { find: () => undefined, getAvailable: () => [successor.model], getAll: () => [successor.model], hasConfiguredAuth: () => true } });
    (successor as unknown as { isIdle: () => boolean }).isIdle = () => idle;
    (successor as unknown as { hasPendingMessages: () => boolean }).hasPendingMessages = () => false;
    (successor as unknown as { getContextUsage: () => unknown }).getContextUsage = () => ({ tokens, contextWindow: 1048000, percent: tokens / 10480 });
    const callbacks: Array<{ onComplete?(): void; onError?(error: Error): void }> = [];
    (successor as unknown as { compact: (o: unknown) => void }).compact = options => {
      callbacks.push({
        onComplete: () => (options as { onComplete?: (r: unknown) => void }).onComplete?.({ summary: 'Preserved completion claim', firstKeptEntryId: 'kept', tokensBefore: tokens }),
        onError: error => (options as { onError?: (e: Error) => void }).onError?.(error),
      });
      idle = false;
    };
    const successorPi = new MockPi();
    activate(successorPi.api);
    await successorPi.fire('session_start', { reason: 'resume' }, successor);
    await tick(150);

    // The automatic recovery claimed the parked claim (the machinery works)…
    const events = (): string[] => fs.readFileSync(path.join(h.cwd, '.pi-glla', 'active.jsonl'), 'utf8')
      .split('\n').filter(Boolean).map(line => JSON.parse(line) as { type: string }).map(e => e.type);
    assert.ok(events().includes('audit_recovery_auto_retry_claimed'), 'the same-process successor grants its one automatic retry');

    // …so the admission must make progress on its own: either the boundary
    // compaction restarts, or the audit launches directly.
    if (callbacks.length > 0) {
      callbacks[0]!.onComplete?.();
      idle = true;
      await successorPi.fire('session_compact', {}, successor);
      await h.pi.fire('session_compact', {}, h.ctx);
      await tick(120);
      await h.pi.fire('agent_settled', {}, h.ctx);
      await successorPi.fire('agent_settled', {}, successor);
    }
    await waitForStart(h.started);

    const admitted = readState(h.cwd).goal!;
    assert.notEqual(admitted.status, 'paused', 'the staged claim is no longer a paused dead end');
    assert.equal(admitted.pendingCompletion?.preAuditCompaction, undefined, 'the admission debt is discharged by the launch');
    assert.equal(
      fs.readFileSync(h.started, 'utf8').trim().split('\n').length, 1,
      'exactly one auditor launched — the automatic retry must not duplicate the claim',
    );
  } finally {
    fs.writeFileSync(settingsPath, previousSettings);
    await h.pi.fire('session_shutdown', { reason: 'quit' }, h.ctx);
  }
});
