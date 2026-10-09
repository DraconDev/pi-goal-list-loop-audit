import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import activate, { __testOnlyResetOwnerSession, __testOnlyResetStaleFlag } from '../extensions/loops/goal.js';
import { __testOnlyResetCompactor, __testOnlySetSpawnWorker } from '../extensions/goal-compactor.js';
import { MockPi, makeMockCtx, seedGoal, seedState, tmpCwd, tick } from './harness/mock-pi.js';

import { shouldRecoverContextPressure } from '../extensions/context-pressure-recovery.js';
import { classifyMainModelFailure } from '../extensions/main-model-recovery.js';
import { withPressureSession, providerError } from './harness/context-pressure.js';
import { sendContinuation } from '../extensions/goal-continuation.js';
import { readState } from '../extensions/goal-loop-core.js';
import * as path from 'node:path';
import { __testOnlySetPressureTimeout, claimPressureAttempt, clearPressureAttempt, flushPressureAttempt, settlePressureAttempt } from '../extensions/context-pressure-attempt.js';

for (const failureOrder of ['callback-first', 'event-first', 'throw', 'unavailable'] as const) {
  test(`pressure attempt owns one fallback (${failureOrder}) and consumes its retry budget`, () => {
    const ctx = makeMockCtx(tmpCwd(), { sessionManager: { name: failureOrder } });
    let fallback = 0;
    let onError: ((error: Error) => void) | undefined;
    ctx.compact = options => {
      onError = options?.onError;
      if (failureOrder === 'throw') throw new Error('cannot compact');
    };
    if (failureOrder === 'unavailable') ctx.compact = undefined as unknown as typeof ctx.compact;
    const options = { failure: classifyMainModelFailure('provider failed'), valid: () => true, fallback: () => { fallback++; }, record: () => {}, timeout: () => assert.fail('unexpected timeout') };
    assert.equal(claimPressureAttempt(ctx, options), true);
    assert.equal(flushPressureAttempt(ctx, { compactionInFlight: false }), true);
    if (failureOrder === 'event-first') settlePressureAttempt(ctx, 'failure');
    onError?.(new Error('summarization failed'));
    settlePressureAttempt(ctx, 'failure');
    assert.equal(fallback, 1);
    assert.equal(claimPressureAttempt(ctx, options), false, 'failed retry must fall through to ordinary recovery');
    clearPressureAttempt(ctx);
  });
}

test('pressure attempt waits for healthy tools, adopts host compaction, and discards stale callbacks', () => {
  const ctx = makeMockCtx(tmpCwd(), { sessionManager: { name: 'pressure-owner' } });
  let idle = false, valid = true, compacts = 0, fallback = 0;
  ctx.isIdle = () => idle;
  ctx.compact = () => { compacts++; };
  claimPressureAttempt(ctx, { failure: classifyMainModelFailure('provider failed'), valid: () => valid, fallback: () => { fallback++; }, record: () => {}, timeout: () => {} });
  flushPressureAttempt(ctx, { compactionInFlight: false });
  assert.equal(compacts, 0, 'busy tools remain untouched');
  idle = true;
  flushPressureAttempt(ctx, { compactionInFlight: true });
  assert.equal(compacts, 0, 'host already owns compaction');
  settlePressureAttempt(ctx, 'retry-owned');
  valid = false;
  settlePressureAttempt(ctx, 'failure');
  assert.equal(fallback, 0, 'old generation cannot rotate the new owner');
  clearPressureAttempt(ctx);
});

test('pressure policy distinguishes relative pressure, explicit input overflow and unrelated errors', () => {
  const generic = classifyMainModelFailure('provider unavailable');
  assert.equal(shouldRecoverContextPressure(generic, { tokens: 18000, contextWindow: 20000 }), true);
  assert.equal(shouldRecoverContextPressure(generic, { tokens: 17999, contextWindow: 20000 }), false);
  assert.equal(shouldRecoverContextPressure(generic, { tokens: 232819, contextWindow: 272000 }), false, 'incident sample was above preventive target but below emergency pressure');
  assert.equal(shouldRecoverContextPressure(generic, { tokens: 55829, contextWindow: 272000 }), false);
  for (const usage of [undefined, { tokens: NaN, contextWindow: 20000 }, { tokens: 100, contextWindow: 0 }, { tokens: Infinity, contextWindow: 100 }, { tokens: -1, contextWindow: 100 }]) {
    assert.equal(shouldRecoverContextPressure(generic, usage), false);
  }
  for (const raw of ['max_tokens output limit', 'context lookup failed', 'invalid API key', 'user interrupt', 'content policy violation']) {
    assert.equal(shouldRecoverContextPressure(classifyMainModelFailure(raw), { tokens: 20000, contextWindow: 20000 }), false, raw);
  }
  assert.equal(shouldRecoverContextPressure(classifyMainModelFailure('maximum context length exceeded')), true);
});

for (const busy of [true, false]) {
  test(`pressure deadline bounds ${busy ? 'queued admission' : 'active compaction'} and absorbs late failure`, async () => {
    const ctx = makeMockCtx(tmpCwd(), { sessionManager: { name: `deadline-${busy}` } });
    ctx.isIdle = () => !busy;
    let held = 0, fallback = 0, aborts = 0;
    ctx.abort = () => { aborts++; };
    ctx.compact = () => {};
    claimPressureAttempt(ctx, { failure: classifyMainModelFailure('provider failed'), valid: () => true,
      fallback: () => { fallback++; }, record: () => {}, timeout: () => { held++; }, timeoutMs: 15 });
    flushPressureAttempt(ctx, { compactionInFlight: false });
    await tick(40);
    assert.equal(held, 1);
    assert.equal(aborts, busy ? 0 : 1, 'queued admission expiry cannot abort healthy tools');
    settlePressureAttempt(ctx, 'failure');
    assert.equal(fallback, 0, 'late cancelled compactor cannot resurrect the held owner');
    clearPressureAttempt(ctx);
  });
}

test('durable one-shot survives reload, but healthy work can rearm the target', () => {
  const cwd = tmpCwd(), ctx = makeMockCtx(cwd, { sessionManager: { name: 'durable' } });
  const budget = { file: path.join(cwd, 'budget.json'), key: 'goal:test' };
  const options = { failure: classifyMainModelFailure('provider failed'), valid: () => true, fallback: () => {}, record: () => {}, timeout: () => {}, budget };
  assert.equal(claimPressureAttempt(ctx, options), true);
  clearPressureAttempt(ctx);
  assert.equal(claimPressureAttempt(ctx, options), false, 'runtime reload does not manufacture a new attempt');
  fs.rmSync(budget.file);
  assert.equal(claimPressureAttempt(ctx, options), true);
  clearPressureAttempt(ctx, true);
  assert.equal(claimPressureAttempt(ctx, options), true);
  clearPressureAttempt(ctx, true);
});

for (const order of ['event-first', 'callback-first'] as const) {
  test(`runtime pressure failure coalesces ${order} into one fallback`, async () => {
    await withPressureSession(async (pi, ctx) => {
      let callbacks: Parameters<typeof ctx.compact>[0];
      let compacts = 0;
      ctx.compact = options => { callbacks = options; compacts++; };
      await pi.fire('agent_end', providerError(), ctx);
      await pi.fire('agent_settled', {}, ctx);
      const event = () => pi.fire('session_compact_failed', { errorMessage: 'summarizer unavailable', willRetry: false }, ctx);
      if (order === 'event-first') await event();
      callbacks?.onError?.(new Error('summarizer unavailable'));
      if (order === 'callback-first') await event();
      await tick(50);
      assert.equal(compacts, 1);
      assert.equal(pi.modelSelections.length, 1);
      assert.equal(readState(ctx.cwd).goal?.status, 'active');
      await pi.fire('agent_settled', {}, ctx);
      assert.equal(compacts, 1);
    });
  });
}

test('runtime pressure success preserves tool evidence, blocks queued sends, and falls back after a failed retry', async () => {
  await withPressureSession(async (pi, ctx, cwd) => {
    let callbacks: Parameters<typeof ctx.compact>[0];
    let compacts = 0, tokens = 265000;
    ctx.getContextUsage = () => ({ tokens, contextWindow: 272000, percent: tokens / 2720 });
    ctx.compact = options => { callbacks = options; compacts++; };
    pi.api.setActiveTools(['read', 'bash', ...pi.api.getActiveTools()]);
    const activeTools = pi.api.getActiveTools().sort();
    const artifact = path.join(cwd, 'completed-tool.txt');
    fs.writeFileSync(artifact, 'completed healthy tool result');
    await pi.fire('tool_result', { toolName: 'read', toolCallId: 'kept-result', input: { path: artifact }, content: [{ type: 'text', text: 'completed healthy tool result' }], isError: false }, ctx);
    await pi.fire('agent_end', providerError(), ctx);
    const id = readState(cwd).goal!.id;
    sendContinuation(id);
    assert.equal(pi.sent.length, 0);
    await pi.fire('agent_settled', {}, ctx);
    callbacks?.onComplete?.({} as never);
    await pi.fire('agent_settled', {}, ctx);
    sendContinuation(id);
    assert.equal(compacts, 1, 'callback alone cannot trigger a second compaction');
    assert.equal(pi.sent.length, 0, 'session_compact owns resume debt, not callback');
    tokens = 55000;
    await pi.fire('session_compact', {}, ctx);
    await pi.fire('agent_start', {}, ctx);
    assert.equal(fs.readFileSync(artifact, 'utf8'), 'completed healthy tool result');
    assert.deepEqual(pi.api.getActiveTools().sort(), activeTools, 'compaction preserves the tool loadout');
    await pi.fire('agent_end', providerError('maximum context length exceeded'), ctx);
    assert.equal(pi.modelSelections.length, 1, 'failed retry consumes durable budget and rotates instead of compacting again');
    assert.equal(compacts, 1);
    assert.deepEqual(pi.api.getActiveTools().sort(), activeTools, 'fallback preserves the tool loadout');
  });
});

for (const cancel of ['pause', 'manual-input', 'shutdown'] as const) {
  test(`runtime ${cancel} invalidates pressure callbacks without fallback`, async () => {
    await withPressureSession(async (pi, ctx) => {
      let callbacks: Parameters<typeof ctx.compact>[0];
      ctx.compact = options => { callbacks = options; };
      await pi.fire('agent_end', providerError(), ctx);
      await pi.fire('agent_settled', {}, ctx);
      if (cancel === 'pause') await pi.command('goal', 'pause', ctx);
      else if (cancel === 'manual-input') {
        await pi.fire('message_start', { message: { role: 'user', content: 'Stop automatic recovery.' } }, ctx);
        await pi.fire('message_end', { message: { role: 'user', content: 'Stop automatic recovery.' } }, ctx);
      }
      else await pi.fire('session_shutdown', { reason: 'reload' }, ctx);
      callbacks?.onError?.(new Error('late stale compaction failure'));
      await tick(30);
      assert.equal(pi.modelSelections.length, 0);
    });
  });
}

for (const mode of ['goal', 'list', 'loop'] as const) {
  test(`${mode} recovery reaches safe idle without relying on agent_settled`, async () => {
    await withPressureSession(async (pi, ctx) => {
      let idle = false, compacts = 0, aborts = 0;
      ctx.isIdle = () => idle;
      ctx.abort = () => { aborts++; };
      ctx.compact = () => { compacts++; };
      await pi.fire('agent_end', providerError(), ctx);
      await tick(70);
      assert.equal(compacts, 0, 'an idle probe cannot compact while tools or the host remain busy');
      assert.equal(aborts, 1, 'only the failed request is cancelled');
      idle = true;
      await tick(90);
      assert.equal(compacts, 1);
      assert.equal(pi.modelSelections.length, 0);
      await tick(60);
      assert.equal(compacts, 1, 'the bounded admission probe retires after launch');
    }, mode);
  });
}

test('host-owned compaction is adopted, including willRetry, without another manual launch', async () => {
  await withPressureSession(async (pi, ctx) => {
    let compacts = 0;
    ctx.compact = () => { compacts++; };
    ctx.isIdle = () => false;
    await pi.fire('agent_end', providerError(), ctx);
    await pi.fire('session_before_compact', {}, ctx);
    await pi.fire('session_compact_failed', { errorMessage: 'temporary summarizer failure', willRetry: true }, ctx);
    await tick(60);
    assert.equal(compacts, 0);
    assert.equal(pi.modelSelections.length, 0, 'host retry owns the attempt');
    await pi.fire('session_compact', {}, ctx);
    assert.equal(compacts, 0);
  });
});

for (const unavailable of [true, false]) {
  test(`runtime ${unavailable ? 'unavailable' : 'throwing'} compaction falls back once`, async () => {
    await withPressureSession(async (pi, ctx) => {
      ctx.compact = unavailable ? undefined as unknown as typeof ctx.compact : () => { throw new Error('compact unavailable'); };
      await pi.fire('agent_end', providerError(), ctx);
      await pi.fire('agent_settled', {}, ctx);
      await tick(50);
      assert.equal(pi.modelSelections.length, 1);
      await pi.fire('agent_settled', {}, ctx);
      assert.equal(pi.modelSelections.length, 1);
    });
  });
}

test('replacement session owns recovery and late predecessor callbacks cannot touch it', async () => {
  await withPressureSession(async (pi, ctx, cwd) => {
    let callbacks: Parameters<typeof ctx.compact>[0];
    ctx.compact = options => { callbacks = options; };
    await pi.fire('agent_end', providerError(), ctx);
    await pi.fire('agent_settled', {}, ctx);
    await pi.fire('session_shutdown', { reason: 'reload' }, ctx);
    const successor = makeMockCtx(cwd, { sessionManager: { name: 'pressure-successor' } });
    successor.model = ctx.model;
    successor.modelRegistry = ctx.modelRegistry;
    successor.getContextUsage = () => ({ tokens: 55000, contextWindow: 272000, percent: 20.2 });
    try {
      await pi.fire('session_start', { reason: 'reload' }, successor);
      const before = pi.modelSelections.length;
      callbacks?.onError?.(new Error('old compactor failed'));
      callbacks?.onComplete?.({} as never);
      await tick(60);
      assert.equal(pi.modelSelections.length, before);
      assert.equal(readState(cwd).goal?.status, 'active');
    } finally { await pi.fire('session_shutdown', { reason: 'test-end' }, successor); }
  });
});

for (const tokens of [199999, 200000]) {
  test(`healthy work at ${tokens} tokens keeps the threshold opportunistic`, async () => {
    await withPressureSession(async (pi, ctx) => {
      let idle = false, compacts = 0, aborts = 0;
      ctx.isIdle = () => idle;
      ctx.abort = () => { aborts++; };
      ctx.getContextUsage = () => ({ tokens, contextWindow: 1000000, percent: tokens / 10000 });
      ctx.compact = () => { compacts++; };
      await pi.fire('tool_call', { toolName: 'read', input: { path: 'artifact.txt' } }, ctx);
      await pi.fire('agent_end', { messages: [{ role: 'assistant', content: [{ type: 'text', text: 'Preserved tool result and continued healthy work.' }], stopReason: 'end_turn' }] }, ctx);
      assert.equal(compacts, 0, 'busy healthy work is never interrupted');
      assert.equal(aborts, 0);
      idle = true;
      await pi.fire('agent_settled', {}, ctx);
      assert.equal(compacts, tokens >= 200000 ? 1 : 0);
      assert.equal(aborts, 0);
    });
  });
}

for (const mode of ['goal', 'list', 'loop'] as const) {
  for (const writeFails of [false, true]) {
    test(`${mode} timeout ${writeFails ? 'retains fail-closed dispatch on storage failure' : 'hands off to paced automatic recovery'}`, async () => {
      await withPressureSession(async (pi, ctx, cwd) => {
        __testOnlySetPressureTimeout(30);
        let callbacks: Parameters<typeof ctx.compact>[0];
        ctx.compact = options => { callbacks = options; };
        await pi.fire('agent_end', providerError(), ctx);
        await pi.fire('agent_settled', {}, ctx);
        const ledger = path.join(cwd, '.pi-glla', 'active.jsonl');
        if (writeFails) {
          fs.chmodSync(ledger, 0o444);
          fs.chmodSync(path.dirname(ledger), 0o555); // Also block the atomic goal transaction checkpoint.
        }
        try {
          await tick(90);
          const state = readState(cwd);
          if (writeFails) {
            assert.equal(mode === 'loop' ? state.loop?.active : state.goal?.status === 'active', true, 'failed write cannot claim durable parking');
            assert.ok(ctx.ui.matching('recovery handoff could not persist').length > 0);
          } else {
            assert.equal(mode === 'loop' ? state.loop?.active : state.goal?.status === 'active', false);
            assert.ok(state.mainModelRecovery?.retryAt, 'a durable paced automatic slot replaces manual compaction parking');
            assert.equal(state.mainModelRecovery?.manualResumeRequired, undefined);
            if (state.goal) assert.equal(state.goal.pauseKind, 'wait');
            assert.ok(ctx.ui.matching('No manual resume is required').length);
          }
          callbacks?.onError?.(new Error('late cancelled compactor'));
          if (state.goal) sendContinuation(state.goal.id);
          await pi.fire('agent_settled', {}, ctx);
          await tick(60);
          assert.equal(pi.sent.length, 0, 'forced/repeated contacts cannot bypass the paced slot or storage hold');
          assert.equal(pi.modelSelections.length, 0);
        } finally {
          if (writeFails) { fs.chmodSync(path.dirname(ledger), 0o755); fs.chmodSync(ledger, 0o644); }
        }
      }, mode);
    });
  }
}

test('throwing captured host probes cannot crash the bounded admission backstop', async () => {
  const ctx = makeMockCtx(tmpCwd(), { sessionManager: { name: 'throwing-probe' } });
  ctx.isIdle = () => { throw new Error('stale captured context'); };
  let held = 0;
  claimPressureAttempt(ctx, { failure: classifyMainModelFailure('provider failed'), valid: () => true, fallback: () => assert.fail('unexpected fallback'), record: () => {}, timeout: () => { held++; }, timeoutMs: 90 });
  await tick(120);
  assert.equal(held, 1);
  clearPressureAttempt(ctx);
});

test('a genuinely pending tool finishes before preventive compaction and its result remains intact', async () => {
  await withPressureSession(async (pi, ctx, cwd) => {
    let idle = false, compacts = 0;
    const signalOwner = new AbortController();
    ctx.isIdle = () => idle;
    ctx.abort = () => signalOwner.abort();
    ctx.compact = () => { compacts++; };
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const artifact = path.join(cwd, 'pending-tool-result.txt');
    pi.tools.set('pending_fixture', { name: 'pending_fixture', execute: async () => {
      await gate;
      assert.equal(signalOwner.signal.aborted, false);
      fs.writeFileSync(artifact, 'intact completed tool result');
      return { content: [{ type: 'text', text: 'intact completed tool result' }] };
    } });
    await pi.fire('tool_call', { toolName: 'pending_fixture', input: {} }, ctx);
    const work = pi.runTool('pending_fixture', {}, ctx, signalOwner.signal);
    try {
      await pi.fire('agent_settled', {}, ctx); // A premature contact must obey the busy capability.
      assert.equal(compacts, 0);
      assert.equal(signalOwner.signal.aborted, false);
      release();
      const result = await work;
      assert.deepEqual(result.content, [{ type: 'text', text: 'intact completed tool result' }]);
      await pi.fire('tool_result', { toolName: 'pending_fixture', content: result.content, isError: false }, ctx);
      idle = true;
      await pi.fire('agent_settled', {}, ctx);
      assert.equal(compacts, 1);
      assert.equal(fs.readFileSync(artifact, 'utf8'), 'intact completed tool result');
    } finally { release(); await work; }
  });
});

const GLOBAL = process.env.GLLA_GLOBAL_SETTINGS_PATH!;
for (const scenario of [
  { name: 'missed preventive opportunity at the incident token count', tokens: 232819, error: 'An error occurred while processing your request.', compact: true },
  { name: 'near-limit generic provider error', tokens: 265000, error: 'An error occurred while processing your request.', compact: true },
  { name: 'explicit overflow with unavailable estimate', tokens: undefined, error: 'maximum context length exceeded', compact: true },
  { name: 'high-context policy exclusion cannot enter via preventive target', tokens: 265000, error: 'content policy violation', compact: false },
  { name: 'generic provider error with unavailable estimate', tokens: undefined, error: 'An error occurred while processing your request.', compact: false },
  { name: 'low-context generic provider error', tokens: 55829, error: 'An error occurred while processing your request.', compact: false },
]) {
  for (const retryBudget of scenario.compact ? [10] : [0, 10]) {
  test(`${scenario.name} uses the appropriate recovery before fallback (retry budget ${retryBudget})`, async () => {
    const original = fs.readFileSync(GLOBAL, 'utf8');
    const cwd = tmpCwd();
    const pi = new MockPi();
    __testOnlyResetOwnerSession(); __testOnlyResetStaleFlag(); __testOnlyResetCompactor();
    fs.writeFileSync(GLOBAL, JSON.stringify({ autoResume: true, aggressiveMode: false, compactionTokenThreshold: 200000, mainModelFallbacks: ['provider/backup'], mainModelSameModelRetries: retryBudget }));
    seedState(cwd, { goal: seedGoal({ status: 'active', objective: 'preserve work through context pressure', autoContinue: true }) });
    activate(pi.api);
    const ctx = makeMockCtx(cwd, { sessionManager: { name: scenario.name } });
    ctx.model = { provider: 'provider', id: 'primary' } as typeof ctx.model;
    ctx.modelRegistry = { find: (provider: string, id: string) => ({ provider, id }), hasConfiguredAuth: () => true } as unknown as typeof ctx.modelRegistry;
    let idle = true, compacts = 0;
    ctx.isIdle = () => idle;
    ctx.getContextUsage = () => scenario.tokens === undefined ? undefined : ({ tokens: scenario.tokens, contextWindow: 272000, percent: scenario.tokens / 2720 });
    ctx.compact = () => { compacts++; };
    __testOnlySetSpawnWorker(async () => ({ ok: true, brief: 'Continue durable work.' }));
    try {
      await pi.fire('session_start', { reason: 'reload' }, ctx);
      await pi.fire('agent_start', {}, ctx);
      idle = false;
      await pi.fire('agent_end', { messages: [{ role: 'assistant', content: [], stopReason: 'error', errorMessage: scenario.error }] }, ctx);
      if (scenario.compact) assert.equal(pi.modelSelections.length, 0, 'fallback must not race the compact-first attempt');
      idle = true;
      await pi.fire('agent_settled', {}, ctx);
      assert.equal(compacts, scenario.compact ? 1 : 0);
      assert.equal(pi.modelSelections.length, scenario.compact || retryBudget > 0 ? 0 : 1);
      if (!scenario.compact && retryBudget > 0) {
        const saved = readState(cwd);
        assert.equal(saved.goal?.status, 'paused');
        assert.equal(saved.goal?.pauseKind, 'wait', 'ordinary recovery owns a paced wait, not a compaction error hold');
        assert.equal(saved.goal?.objective, 'preserve work through context pressure');
        assert.equal(saved.mainModelRecovery?.active, 'provider/primary');
        assert.equal(saved.mainModelRecovery?.sameModelRetries, 1);
        assert.ok(Date.parse(saved.mainModelRecovery?.retryAt ?? '') > Date.now(), 'the first retry has a durable future deadline');
      }
    } finally {
      await pi.fire('session_shutdown', { reason: 'test-end' }, ctx);
      await tick(30);
      __testOnlyResetCompactor(); __testOnlyResetOwnerSession(); __testOnlyResetStaleFlag();
      fs.writeFileSync(GLOBAL, original);
    }
  });
  }
}
