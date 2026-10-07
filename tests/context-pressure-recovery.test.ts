import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import activate, { __testOnlyResetOwnerSession, __testOnlyResetStaleFlag } from '../extensions/loops/goal.js';
import { __testOnlyResetCompactor, __testOnlySetSpawnWorker } from '../extensions/goal-compactor.js';
import { MockPi, makeMockCtx, seedGoal, seedState, tmpCwd, tick } from './harness/mock-pi.js';

import { shouldRecoverContextPressure } from '../extensions/context-pressure-recovery.js';
import { classifyMainModelFailure } from '../extensions/main-model-recovery.js';

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

const GLOBAL = process.env.GLLA_GLOBAL_SETTINGS_PATH!;
for (const scenario of [
  { name: 'near-limit generic provider error', tokens: 265000, error: 'An error occurred while processing your request.', compact: true },
  { name: 'explicit overflow with unavailable estimate', tokens: undefined, error: 'maximum context length exceeded', compact: true },
  { name: 'low-context generic provider error', tokens: 55829, error: 'An error occurred while processing your request.', compact: false },
]) {
  test(`${scenario.name} uses the appropriate recovery before fallback`, async () => {
    const original = fs.readFileSync(GLOBAL, 'utf8');
    const cwd = tmpCwd();
    const pi = new MockPi();
    __testOnlyResetOwnerSession(); __testOnlyResetStaleFlag(); __testOnlyResetCompactor();
    fs.writeFileSync(GLOBAL, JSON.stringify({ autoResume: true, aggressiveMode: false, compactionTokenThreshold: 200000, mainModelFallbacks: ['provider/backup'] }));
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
      assert.equal(pi.modelSelections.length, scenario.compact ? 0 : 1);
    } finally {
      await pi.fire('session_shutdown', { reason: 'test-end' }, ctx);
      await tick(30);
      __testOnlyResetCompactor(); __testOnlyResetOwnerSession(); __testOnlyResetStaleFlag();
      fs.writeFileSync(GLOBAL, original);
    }
  });
}
