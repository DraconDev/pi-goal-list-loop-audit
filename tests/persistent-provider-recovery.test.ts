import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import activate, { __testOnlyResetOwnerSession, __testOnlyResetStaleFlag } from '../extensions/loops/goal.js';
import { readState } from '../extensions/goal-loop-core.js';
import { classifyCompactionFailure } from '../extensions/compaction-failure.js';
import { PERSISTENT_PROVIDER_RETRY_MS } from '../extensions/main-model-recovery.js';
import { MockPi, makeMockCtx, seedGoal, seedState, tmpCwd } from './harness/mock-pi.js';

const settingsPath = process.env.GLLA_GLOBAL_SETTINGS_PATH!;
const settingsBefore = fs.readFileSync(settingsPath, 'utf8');
const sessions: { pi: MockPi; ctx: ReturnType<typeof makeMockCtx> }[] = [];
const quotaError = 'Auto-compaction failed: Summarization failed: Codex error: The usage limit has been reached';
afterEach(async () => {
  for (const { pi, ctx } of sessions.splice(0)) await pi.fire('session_shutdown', { reason: 'test' }, ctx);
  fs.writeFileSync(settingsPath, settingsBefore);
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
});
