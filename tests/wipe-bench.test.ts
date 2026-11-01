import { test } from 'node:test';
import { performance } from 'node:perf_hooks';
test('bench: real /glla wipe end to end at the real profile', async () => {
  const activate = (await import('../extensions/loops/goal.js')).default;
  const { MockPi, makeMockCtx } = await import('./harness/mock-pi.js');
  const cwd = '/tmp/wipeprof';
  const pi = new MockPi();
  activate(pi.api);
  const ctx = makeMockCtx(cwd, { sessionManager: { name: 'wipe-bench' } });
  Object.assign(ctx, { hasUI: true, modelRegistry: { find: () => undefined, getAvailable: () => [ctx.model], getAll: () => [ctx.model], hasConfiguredAuth: () => true } });
  Object.assign(ctx.ui, { confirmImpl: () => Promise.resolve(true) });
  await pi.fire('session_start', { reason: 'startup' }, ctx);
  const t = performance.now();
  await pi.command('glla', 'wipe', ctx);
  console.log(`glla wipe end-to-end\t${(performance.now() - t).toFixed(1)}ms`);
  for (const n of ctx.ui.notifies) console.log('notify:', n.message.slice(0, 90));
});
