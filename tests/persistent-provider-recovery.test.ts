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

test('the confirmed steady provider recovery cadence is five minutes', () => {
  assert.equal(PERSISTENT_PROVIDER_RETRY_MS, 5 * 60_000, 'this duration is an explicit operator policy, not an incidental implementation value');
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
  // A consent-less cold load engages the ordinary load hold — that is a
  // deliberate "automation waits for your decision" gate, not the permanent
  // manual pause this repair targets. The recovery claim, phase and due time
  // must survive it intact so consent resumes exactly the saved wait.
  assert.equal(restored.goal?.pauseKind, 'wait');
  assert.equal(restored.mainModelRecovery?.manualResumeRequired, undefined, 'a reload never converts recovery into a manual-hold requirement');
  assert.equal(restored.goal?.status, 'paused', 'the saved work stays parked, not abandoned');
  assert.equal(replacement.sent.length, 0, 'a future retry is not dispatched early after restore');
});

test('consent after a cold reload resumes the same durable provider wait, not a new episode', async () => {
  const cwd = tmpCwd();
  fs.writeFileSync(settingsPath, JSON.stringify({ autoResume: false, aggressiveMode: false, mainModelFallbacks: [] }));
  const due = new Date(Date.now() + PERSISTENT_PROVIDER_RETRY_MS).toISOString();
  const id = 'consent-restore';
  seedState(cwd, { goal: seedGoal({ id, status: 'paused', pauseKind: 'wait', pauseSource: 'system',
    pauseReason: 'main model recovery — retrying', pauseResumeAt: due }), mainModelRecovery: {
    primary: 'test/primary', active: 'test/primary', attempted: ['test/primary'], owner: { kind: 'goal', id },
    kind: 'goal', attempts: 1, reason: 'provider error', providerErrorDiagnostic: quotaError, retryAt: due,
  } });
  __testOnlyResetOwnerSession(); __testOnlyResetStaleFlag();
  const pi = new MockPi(); activate(pi.api);
  const ctx = makeMockCtx(cwd);
  sessions.push({ pi, ctx });
  await pi.fire('session_start', { reason: 'startup' }, ctx);
  assert.equal(readState(cwd).mainModelRecovery?.retryAt, due, 'the cold load preserves the due time verbatim');
  await pi.command('goal', 'resume', ctx);
  const resumed = readState(cwd);
  assert.equal(resumed.goal?.status, 'active', 'consent resumes the saved work');
  assert.equal(resumed.mainModelRecovery?.retryAt, undefined, 'an immediate probe clears the wait instead of leaving a stale timer');
});

for (const userHeld of [false, true]) {
  test(`legacy quota-compaction block ${userHeld ? 'preserves a genuine user hold' : 'migrates only its matching system recovery owner'}`, async () => {
    const cwd = tmpCwd();
    fs.writeFileSync(settingsPath, JSON.stringify({ autoResume: false, aggressiveMode: false, mainModelFallbacks: [] }));
    const id = `legacy-${userHeld}`;
    seedState(cwd, { goal: seedGoal({ id, status: 'paused', pauseKind: 'blocked', pauseSource: userHeld ? 'user' : 'system',
      pauseReason: `compaction failure: ${quotaError}` }), mainModelRecovery: {
      primary: 'test/primary', active: 'test/primary', attempted: ['test/primary'], owner: { kind: 'goal', id },
      kind: 'goal', attempts: 1000, reason: 'provider error', providerErrorDiagnostic: quotaError,
    } });
    __testOnlyResetOwnerSession(); __testOnlyResetStaleFlag();
    const pi = new MockPi(); activate(pi.api);
    const ctx = makeMockCtx(cwd);
    sessions.push({ pi, ctx });
    const start = Date.now();
    await pi.fire('session_start', { reason: 'startup' }, ctx);
    const restored = readState(cwd);
    if (userHeld) {
      assert.equal(restored.goal?.pauseKind, 'blocked');
      assert.equal(restored.mainModelRecovery?.retryAt, undefined, 'an explicit user hold gains no recovery timer debt');
    } else {
      assert.equal(restored.goal?.pauseKind, 'wait');
      assert.equal(restored.mainModelRecovery?.manualResumeRequired, undefined, 'migration expects no manual-hold requirement');
      assert.ok(Date.parse(restored.mainModelRecovery!.retryAt!) >= start + PERSISTENT_PROVIDER_RETRY_MS);
      assert.equal(restored.goal?.pauseResumeAt, restored.mainModelRecovery?.retryAt);
    }
    assert.equal(pi.sent.length, 0);
  });
}

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

for (const phase of ['retry-waiting', 'recovery-pending'] as const) for (const overdue of [false, true]) {
  test(`auditor ${phase} restores ${overdue ? 'one overdue attempt beyond legacy horizons' : 'the original future due time without an early launch'}`, async () => {
    const cwd = tmpCwd();
    const marker = path.join(cwd, 'worker-starts');
    const worker = path.join(cwd, 'inert-provider.mjs');
    fs.writeFileSync(worker, `#!/usr/bin/env node\nimport fs from 'node:fs';\nprocess.stdin.once('data',()=>fs.appendFileSync(${JSON.stringify(marker)},'started\\n'));\nsetInterval(()=>{},1000);\n`);
    fs.chmodSync(worker, 0o700);
    process.env.GLLA_PI_BINARY = worker;
    fs.writeFileSync(settingsPath, JSON.stringify({ autoResume: false, aggressiveMode: false }));
    const due = new Date(Date.now() + (overdue ? -1000 : PERSISTENT_PROVIDER_RETRY_MS)).toISOString();
    seedState(cwd, { goal: seedGoal({ status: 'paused', pauseSource: 'system', pauseKind: 'wait', pauseResumeAt: due,
      pauseReason: 'auditor retry: provider error', pendingCompletion: {
        at: '2020-01-01T00:00:00.000Z', phase, attemptId: 'old-provider-attempt',
        ...(phase === 'recovery-pending' ? { recoveryRetryAt: due } : {}),
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
      assert.equal(readState(cwd).goal?.status, 'auditing', JSON.stringify({ goal: readState(cwd).goal, notices: ctx.ui.notifies }));
      assert.equal(readState(cwd).goal?.pendingCompletion?.completionSummary, 'Stored provider recovery claim');
    } else {
      assert.equal(readState(cwd).goal?.pauseResumeAt, due);
      assert.equal(readState(cwd).goal?.pendingCompletion?.phase, phase);
      assert.equal(fs.existsSync(marker), false);
    }
    assert.equal(readState(cwd).mainModelRecovery?.manualResumeRequired, undefined, 'owned provider recovery survives cold startup');
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

test('a quota wall that clears resumes the parked work and clears the durable wait', async () => {
  const cwd = tmpCwd();
  fs.writeFileSync(settingsPath, JSON.stringify({ autoResume: true, aggressiveMode: false, mainModelFallbacks: [] }));
  seedState(cwd, { goal: seedGoal({ status: 'active', objective: 'Resume when the quota wall clears' }) });
  __testOnlyResetOwnerSession(); __testOnlyResetStaleFlag();
  const pi = new MockPi(); activate(pi.api);
  const ctx = makeMockCtx(cwd);
  await pi.fire('session_start', { reason: 'reload' }, ctx);
  sessions.push({ pi, ctx });

  // A plan-quota wall parks the work with a durable five-minute due time.
  await pi.fire('session_compact_failed', { errorMessage: quotaError, willRetry: false }, ctx);
  const parked = readState(cwd);
  assert.equal(parked.goal?.status, 'paused');
  assert.equal(parked.goal?.pauseKind, 'wait');
  assert.ok(parked.mainModelRecovery?.retryAt, 'the wait is durable, not a manual hold');

  // The provider answers again on the next supervised turn.
  await pi.fire('agent_start', {}, ctx);
  await pi.fire('agent_end', { messages: [{ role: 'assistant', content: [{ type: 'text', text: 'recovered' }], stopReason: 'end_turn' }] }, ctx);
  await pi.fire('agent_settled', {}, ctx);

  const resumed = readState(cwd);
  assert.equal(resumed.mainModelRecovery, undefined, 'a healthy turn clears the durable recovery episode');
  assert.notEqual(resumed.goal?.status, 'paused', 'the parked work does not stay stranded in a permanent manual pause');
  const ledger = fs.readFileSync(`${cwd}/.pi-glla/active.jsonl`, 'utf8');
  assert.match(ledger, /"main_model_recovered"/, 'the recovery settlement is durably recorded');
});
