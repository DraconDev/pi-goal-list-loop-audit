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
import { scaledBudgetMs } from '../scripts/host-contention.mjs';
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

/** Stage admission, then take the host away before the owned idle boundary —
 * the field transcript: complete_goal's "AUDIT PENDING … will check preventive
 * compaction", then a reload. Returns the successor ctx/pi so the test can own
 * the compaction callbacks the fresh generation registers. */
async function stageThenReload(h: Awaited<ReturnType<typeof setup>>, settings: Record<string, unknown>) {
  const settingsPath = process.env.GLLA_GLOBAL_SETTINGS_PATH!;
  const result = await h.pi.runTool('complete_goal', { completionSummary: 'Outcome: staged. Changed: x. Evidence: y. Tests: z. Unresolved: none. Next: none.' }, h.ctx);
  assert.equal(result.isError, undefined);
  const staged = readState(h.cwd).goal!;
  assert.equal(staged.pendingCompletion?.preAuditCompaction, true, 'the claim is staged as admission debt');
  assert.equal(staged.status, 'auditing');

  await h.pi.fire('session_shutdown', { reason: 'reload' }, h.ctx);
  const parked = readState(h.cwd).goal!;
  assert.equal(parked.status, 'paused', 'a session boundary parks the claim');
  assert.equal(parked.pendingCompletion?.phase, 'recovery-pending');
  assert.equal(parked.pendingCompletion?.preAuditCompaction, true, 'the admission debt survives the boundary');

  fs.writeFileSync(settingsPath, JSON.stringify(settings));
  sameProcessReloadSidecar(h.cwd);
  __testOnlyResetOwnerSession(); __testOnlyResetStaleFlag(); __testOnlyResetTerminalFlags();
  const successor = makeMockCtx(h.cwd, {
    sessionManager: { name: `successor-${Date.now()}-${Math.random()}`, getSessionId: () => 'successor-session-id' },
  });
  let idle = true;
  let tokens = 903644;
  Object.assign(successor, { modelRegistry: { find: () => undefined, getAvailable: () => [successor.model], getAll: () => [successor.model], hasConfiguredAuth: () => true } });
  const base = successor as unknown as {
    isIdle: () => boolean; hasPendingMessages: () => boolean;
    getContextUsage: () => unknown; compact: (o: unknown) => void;
  };
  base.isIdle = () => idle;
  base.hasPendingMessages = () => false;
  base.getContextUsage = () => ({ tokens, contextWindow: 1048000, percent: tokens / 10480 });
  const callbacks: Array<{ onComplete?(): void; onError?(error: Error): void }> = [];
  base.compact = options => {
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
  return { successor, successorPi, callbacks, setIdle: (v: boolean) => { idle = v; } };
}

function ledgerTypes(cwd: string): string[] {
  return fs.readFileSync(path.join(cwd, '.pi-glla', 'active.jsonl'), 'utf8')
    .split('\n').filter(Boolean)
    .map(line => (JSON.parse(line) as { type: string }).type);
}

test('a reload during the admission wait still launches the stored audit when recovery consent exists', { timeout: scaledBudgetMs(120_000) }, async () => {
  const h = await setup();
  const settingsPath = process.env.GLLA_GLOBAL_SETTINGS_PATH!;
  const previousSettings = fs.readFileSync(settingsPath, 'utf8');
  try {
    // Auto-resume = the operator consented to load-time automation, so the
    // stored claim owns its one automatic retry (no manual /list resume).
    const s = await stageThenReload(h, { autoResume: true });
    assert.ok(ledgerTypes(h.cwd).includes('audit_recovery_auto_retry_claimed'),
      'the successor grants the parked claim its one automatic retry');

    // The retry must make progress on its own: it re-enters the admission
    // boundary (compaction) or dispatches directly. Before the fix it returned
    // at the gate, consuming the one-shot and stranding the claim.
    assert.equal(s.callbacks.length, 1, 'the admission boundary is re-entered by the automatic recovery');
    assert.ok(ledgerTypes(h.cwd).includes('audit_compaction_admission_started'));

    s.callbacks[0]!.onComplete?.();
    s.setIdle(true);
    await s.successorPi.fire('session_compact', {}, s.successor);
    await tick(120);
    await s.successorPi.fire('agent_settled', {}, s.successor);
    console.log('DBG events', ledgerTypes(h.cwd).slice(-10).join(','), 'callbacks', s.callbacks.length, 'status', readState(h.cwd).goal?.status, 'phase', readState(h.cwd).goal?.pendingCompletion?.phase, 'preAudit', readState(h.cwd).goal?.pendingCompletion?.preAuditCompaction);
    await waitForStart(h.started);

    const admitted = readState(h.cwd).goal!;
    assert.notEqual(admitted.status, 'paused', 'the staged claim is no longer a paused dead end');
    assert.equal(admitted.pendingCompletion?.preAuditCompaction, undefined, 'the launch discharges the admission debt');
    assert.equal(fs.readFileSync(h.started, 'utf8').trim().split('\n').length, 1,
      'exactly one auditor launched — the automatic retry never duplicates the claim');
  } finally {
    fs.writeFileSync(settingsPath, previousSettings);
    await h.pi.fire('session_shutdown', { reason: 'quit' }, h.ctx);
  }
});

test('a cold load without consent HOLDS the staged claim, and says so without blaming the auditor', { timeout: scaledBudgetMs(60_000) }, async () => {
  const h = await setup();
  const settingsPath = process.env.GLLA_GLOBAL_SETTINGS_PATH!;
  const previousSettings = fs.readFileSync(settingsPath, 'utf8');
  try {
    const s = await stageThenReload(h, {});
    // Stock install: the load hold is the documented consent gate. It must be
    // the reason, and the claim must not be silently consumed.
    assert.equal(s.callbacks.length, 0, 'no admission work runs behind a load hold');
    assert.equal(fs.existsSync(h.started), false, 'no auditor launches behind a load hold');
    const held = readState(h.cwd).goal!;
    assert.equal(held.status, 'paused');
    assert.equal(held.pendingCompletion?.phase, 'recovery-pending');
    assert.equal(held.pauseSuggestedAction?.includes('nothing about your auditor or model setup is implicated'), true,
      'the parked action names the session boundary instead of accusing the auditor');
    assert.doesNotMatch(held.pauseSuggestedAction ?? '', /Fix the auditor\/session issue/,
      'one generic sentence must not assert a fault class the durable record does not support');
    assert.match(held.pendingCompletion?.recoveryReason ?? '', /^session_shutdown:/,
      'the durable reason still records the real breadcrumb');
  } finally {
    fs.writeFileSync(settingsPath, previousSettings);
    await h.pi.fire('session_shutdown', { reason: 'quit' }, h.ctx);
  }
});

test('the promised manual path works from the parked state: /list resume starts exactly one audit', { timeout: scaledBudgetMs(120_000) }, async () => {
  const h = await setup();
  const settingsPath = process.env.GLLA_GLOBAL_SETTINGS_PATH!;
  const previousSettings = fs.readFileSync(settingsPath, 'utf8');
  try {
    const s = await stageThenReload(h, {});
    const parked = readState(h.cwd).goal!;
    // The card promises this exact recovery; a promise the machinery cannot
    // keep is how the field stall read as an auditor/session problem.
    assert.equal(parked.pauseSuggestedAction?.includes('/list resume'), true,
      'the parked copy names the surface command for this policy');

    s.setIdle(true);
    const t0 = Date.now();
    await s.successorPi.command('list', 'resume', s.successor);
    console.log('DBG resume returned in', Date.now() - t0, 'callbacks', s.callbacks.length, 'phase', readState(h.cwd).goal?.pendingCompletion?.phase);
    await tick(150);

    if (s.callbacks.length > 0) {
      s.callbacks[0]!.onComplete?.();
      s.setIdle(true);
      await s.successorPi.fire('session_compact', {}, s.successor);
      await tick(120);
      await s.successorPi.fire('agent_settled', {}, s.successor);
    }
    const t1 = Date.now();
    console.log('DBG before wait', fs.existsSync(h.started), 'elapsed', t1 - t0);
    await waitForStart(h.started);
    console.log('DBG after wait', Date.now() - t1);
    const admitted = readState(h.cwd).goal!;
    assert.notEqual(admitted.status, 'paused');
    assert.equal(admitted.pendingCompletion?.preAuditCompaction, undefined);
    assert.equal(fs.readFileSync(h.started, 'utf8').trim().split('\n').length, 1, 'one audit, not two');
  } finally {
    fs.writeFileSync(settingsPath, previousSettings);
    await h.pi.fire('session_shutdown', { reason: 'quit' }, h.ctx);
  }
});
