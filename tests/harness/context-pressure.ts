import * as fs from 'node:fs';
import activate, { __testOnlyResetOwnerSession, __testOnlyResetStaleFlag } from '../../extensions/loops/goal.js';
import { __testOnlyResetCompactor, __testOnlySetSpawnWorker } from '../../extensions/goal-compactor.js';
import { MockPi, makeMockCtx, seedGoal, seedLoop, seedState, tmpCwd, tick } from './mock-pi.js';
import { __testOnlySetPressureTimeout } from '../../extensions/context-pressure-attempt.js';
import type { MockCtx } from './mock-pi.js';

export async function withPressureSession(run: (pi: MockPi, ctx: MockCtx, cwd: string) => Promise<void>, mode: 'goal' | 'list' | 'loop' = 'goal'): Promise<void> {
  const global = process.env.GLLA_GLOBAL_SETTINGS_PATH!;
  const original = fs.readFileSync(global, 'utf8');
  const cwd = tmpCwd(), pi = new MockPi();
  __testOnlyResetOwnerSession(); __testOnlyResetStaleFlag(); __testOnlyResetCompactor();
  __testOnlySetSpawnWorker(async () => ({ ok: true, brief: 'Continue preserved work.' }));
  fs.writeFileSync(global, JSON.stringify({ autoResume: true, aggressiveMode: false, compactionTokenThreshold: 200000, mainModelFallbacks: ['provider/backup'] }));
  seedState(cwd, mode === 'loop' ? { loop: seedLoop({ active: true }) } : { goal: seedGoal({ status: 'active', objective: 'pressure lifecycle fault injection', autoContinue: true, policy: mode }) });
  activate(pi.api);
  const ctx = makeMockCtx(cwd, { sessionManager: { name: `pressure-${cwd}` } });
  ctx.model = { provider: 'provider', id: 'primary' } as typeof ctx.model;
  ctx.modelRegistry = { find: (provider: string, id: string) => ({ provider, id }), hasConfiguredAuth: () => true } as unknown as typeof ctx.modelRegistry;
  ctx.getContextUsage = () => ({ tokens: 265000, contextWindow: 272000, percent: 97.4 });
  try {
    await pi.fire('session_start', { reason: 'reload' }, ctx);
    await pi.fire('agent_start', {}, ctx);
    pi.sent.length = 0;
    await run(pi, ctx, cwd);
  } finally {
    __testOnlySetPressureTimeout();
    await pi.fire('session_shutdown', { reason: 'test-end' }, ctx);
    await tick(30);
    __testOnlyResetCompactor(); __testOnlyResetOwnerSession(); __testOnlyResetStaleFlag();
    fs.writeFileSync(global, original);
  }
}
export function providerError(raw = 'provider request failed') {
  return { messages: [{ role: 'assistant', content: [], stopReason: 'error', errorMessage: raw }] };
}
