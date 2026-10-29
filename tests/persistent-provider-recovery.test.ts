import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { waitFor } from './harness/host-budget.js';
import activate, { __testOnlyResetOwnerSession, __testOnlyResetStaleFlag } from '../extensions/loops/goal.js';
import { readState, type State } from '../extensions/goal-loop-core.js';
import { ownsPersistentProviderWait } from '../extensions/persistent-provider-recovery.js';
import { auditorRetryPlan } from '../extensions/loops/goal-auditor-hooks.js';
import { classifyCompactionFailure } from '../extensions/compaction-failure.js';
import { PERSISTENT_PROVIDER_RETRY_MS } from '../extensions/main-model-recovery.js';
import { MockPi, makeMockCtx, seedGoal, seedState, tmpCwd } from './harness/mock-pi.js';

const settingsPath = process.env.GLLA_GLOBAL_SETTINGS_PATH!;
const settingsBefore = fs.readFileSync(settingsPath, 'utf8');
const sessions: { pi: MockPi; ctx: ReturnType<typeof makeMockCtx> }[] = [];
const quotaError = 'Auto-compaction failed: Summarization failed: Codex error: The usage limit has been reached';
const originalBinary = process.env.GLLA_PI_BINARY;
afterEach(async () => {
  for (const { pi, ctx } of sessions.splice(0)) await pi.fire('session_shutdown', { reason: 'test' }, ctx);
  fs.writeFileSync(settingsPath, settingsBefore);
  if (originalBinary === undefined) delete process.env.GLLA_PI_BINARY; else process.env.GLLA_PI_BINARY = originalBinary;
  __testOnlyResetOwnerSession(); __testOnlyResetStaleFlag();
});

for (const flag of ['willRetry', 'aborted', 'fromExtension'] as const) {
  test(`provider compaction error preserves ${flag} ownership`, () => {
    assert.notEqual(classifyCompactionFailure({ errorMessage: quotaError, [flag]: true }).kind, 'provider-recovery');
  });
}
test('a terminal compaction attempt is not a terminal quota recovery episode', () => {
  assert.equal(classifyCompactionFailure({ errorMessage: quotaError, willRetry: false }).kind, 'provider-recovery');
  assert.equal(classifyCompactionFailure({ errorMessage: `${quotaError}; summary is incomplete` }).kind, 'summarization-length');
});

test('quota compaction failure retains a five-minute durable recovery and duplicate events do not renew it', async () => {
  const cwd = tmpCwd();
  fs.writeFileSync(settingsPath, JSON.stringify({ autoResume: true, aggressiveMode: false, mainModelFallbacks: [] }));
  seedState(cwd, { goal: seedGoal({ status: 'active', objective: 'Survive summarizer quota exhaustion' }) });
  __testOnlyResetOwnerSession(); __testOnlyResetStaleFlag();
  const pi = new MockPi(); activate(pi.api);
  const ctx = makeMockCtx(cwd);
  await pi.fire('session_start', { reason: 'reload' }, ctx);
  sessions.push({ pi, ctx });
  const before = Date.now();
  const sends = pi.sent.length;
  await pi.fire('session_compact_failed', { errorMessage: quotaError, willRetry: false }, ctx);
  const durable = readState(cwd);
  assert.equal(durable.goal?.status, 'paused');
  assert.equal(durable.goal?.pauseKind, 'wait', 'quota recovery does not become a manual blocked pause');
  assert.equal(durable.goal?.pauseSource, 'system');
  assert.equal(durable.mainModelRecovery?.owner?.kind, 'goal');
  assert.ok(durable.mainModelRecovery?.retryAt, 'recovery due time is durable');
  const due = Date.parse(durable.mainModelRecovery!.retryAt!);
  assert.ok(due >= before + PERSISTENT_PROVIDER_RETRY_MS);
  assert.ok(due <= Date.now() + PERSISTENT_PROVIDER_RETRY_MS);
  assert.equal(durable.goal?.pauseResumeAt, durable.mainModelRecovery?.retryAt);
  await pi.fire('session_compact_failed', { errorMessage: quotaError, willRetry: false }, ctx);
  assert.deepEqual(readState(cwd).mainModelRecovery, durable.mainModelRecovery, 'duplicate event preserves episode and due time');
  assert.equal(pi.sent.length, sends, 'quota failure does not dispatch a competing immediate continuation');

  await pi.fire('session_shutdown', { reason: 'reload' }, ctx);
  sessions.pop();
  fs.writeFileSync(settingsPath, JSON.stringify({ autoResume: false, aggressiveMode: false, mainModelFallbacks: [] }));
  __testOnlyResetOwnerSession(); __testOnlyResetStaleFlag();
  const replacement = new MockPi(); activate(replacement.api);
  const replacementCtx = makeMockCtx(cwd);
  await replacement.fire('session_start', { reason: 'startup' }, replacementCtx);
  sessions.push({ pi: replacement, ctx: replacementCtx });
  const restored = readState(cwd);
  assert.equal(restored.mainModelRecovery?.retryAt, durable.mainModelRecovery?.retryAt, 'reload does not renew or shorten the due time');
  assert.equal(restored.loadHoldAt, undefined, 'a proven recovery-owned wait does not become an unrelated cold-load hold');
  assert.equal(restored.goal?.pauseKind, 'wait');
  assert.equal(replacement.sent.length, 0, 'a future retry is not dispatched early after restore');
});

function providerWait(): State {
  const cwd = tmpCwd();
  seedState(cwd, { goal: seedGoal({ status: 'paused', pauseKind: 'wait', pauseSource: 'system', pauseReason: 'main model recovery — retrying', pauseResumeAt: '2030-01-01T00:05:00.000Z' }) });
  const saved = readState(cwd);
  saved.mainModelRecovery = { owner: { kind: 'goal', id: saved.goal!.id }, primary: 'test/primary', active: 'test/primary', attempted: ['test/primary'], kind: 'goal', attempts: 1000,
    reason: 'provider error', providerErrorDiagnostic: quotaError, retryAt: saved.goal!.pauseResumeAt };
  return saved;
}
for (const [label, mutate] of [
  ['supervisor pause', (s: State) => { s.supervisorPausedAt = Date.now(); }],
  ['unrelated cold-load hold', (s: State) => { s.loadHoldAt = Date.now(); }],
  ['agent missing-input block', (s: State) => { s.goal!.pauseKind = 'blocked'; }],
  ['user pause', (s: State) => { s.goal!.pauseSource = 'user'; }],
  ['decision', (s: State) => { s.goal!.pauseKind = 'decision'; }],
  ['cancel', (s: State) => { s.goal!.status = 'aborted'; }],
  ['replaced target', (s: State) => { s.goal!.id = 'different'; }],
  ['explicit recovery stop', (s: State) => { s.mainModelRecovery!.manualResumeRequired = true; }],
] as const) {
  test(`provider recovery restore cannot bypass ${label}`, () => {
    const saved = providerWait();
    assert.equal(ownsPersistentProviderWait(saved), true);
    mutate(saved);
    assert.equal(ownsPersistentProviderWait(saved), false);
  });
}

for (const overdue of [false, true]) {
  test(`auditor provider wait restores ${overdue ? 'one overdue attempt beyond legacy horizons' : 'the original future due time without an early launch'}`, async () => {
    const cwd = tmpCwd();
    const marker = path.join(cwd, 'worker-starts');
    const worker = path.join(cwd, 'inert-provider.mjs');
    fs.writeFileSync(worker, `#!/usr/bin/env node\nimport fs from 'node:fs';\nprocess.stdin.once('data',()=>fs.appendFileSync(${JSON.stringify(marker)},'started\\n'));\n`);
    fs.chmodSync(worker, 0o700);
    process.env.GLLA_PI_BINARY = worker;
    fs.writeFileSync(settingsPath, JSON.stringify({ autoResume: false, aggressiveMode: false }));
    const due = new Date(Date.now() + (overdue ? -1000 : PERSISTENT_PROVIDER_RETRY_MS)).toISOString();
    seedState(cwd, { goal: seedGoal({ status: 'paused', pauseSource: 'system', pauseKind: 'wait', pauseResumeAt: due,
      pauseReason: 'auditor retry: provider error', pendingCompletion: {
        at: '2020-01-01T00:00:00.000Z', phase: 'retry-waiting', attemptId: 'old-provider-attempt',
        recoveryEpisodeKey: 'quota-fixture', providerErrorDiagnostic: quotaError,
        retryAttempts: 10000, retryUntil: '2020-01-02T00:00:00.000Z', automaticRecoveryUntil: '2020-01-02T00:00:00.000Z',
        completionSummary: 'Stored provider recovery claim',
      } }) });
    __testOnlyResetOwnerSession(); __testOnlyResetStaleFlag();
    const pi = new MockPi(); activate(pi.api);
    const ctx = makeMockCtx(cwd);
    Object.assign(ctx, { modelRegistry: { find: () => undefined, getAvailable: () => [ctx.model], getAll: () => [ctx.model], hasConfiguredAuth: () => true } });
    sessions.push({ pi, ctx });
    await pi.fire('session_start', { reason: 'startup' }, ctx);
    if (overdue) {
      await waitFor(() => fs.existsSync(marker), { timeoutMs: 6000, intervalMs: 10, message: 'overdue provider claim launches despite legacy expiry' });
      await pi.fire('agent_settled', {}, ctx);
      assert.equal(fs.readFileSync(marker, 'utf8').trim(), 'started', 'restore launches exactly one worker');
      assert.equal(readState(cwd).goal?.status, 'auditing');
      assert.equal(readState(cwd).goal?.pendingCompletion?.completionSummary, 'Stored provider recovery claim');
    } else {
      assert.equal(readState(cwd).goal?.pauseResumeAt, due);
      assert.equal(readState(cwd).goal?.pendingCompletion?.phase, 'retry-waiting');
      assert.equal(fs.existsSync(marker), false);
    }
    assert.equal(readState(cwd).loadHoldAt, undefined, 'owned provider recovery survives cold startup');
    assert.equal(pi.sent.length, 0, 'stored audit recovery dispatches no main-agent turn');
  });
}

test('provider auditor retries remain five-minute and automatic past legacy expiry and attempt limits', () => {
  for (const aggressive of [false, true]) {
    const plan = auditorRetryPlan({ at: '2020-01-01T00:00:00.000Z', retryAttempts: 10000, retryUntil: '2020-01-02T00:00:00.000Z', providerErrorDiagnostic: quotaError }, undefined, undefined, aggressive);
    assert.equal(plan.automatic, true);
    assert.equal(plan.unbounded, true);
    assert.equal(plan.retryAfterSec * 1000, PERSISTENT_PROVIDER_RETRY_MS);
  }
});
