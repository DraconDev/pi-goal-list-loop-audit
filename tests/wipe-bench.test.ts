import { test } from 'node:test';
import { performance } from 'node:perf_hooks';
import activate from '../extensions/loops/goal.js';
import { MockPi, makeMockCtx, seedState, seedGoal } from './harness/mock-pi.js';
import * as core from '../extensions/goal-loop-core.js';
import fs from 'node:fs';

test('bench: real /glla wipe end to end at the real profile', async () => {
  const cwd = process.env.WIPE_BENCH_CWD || '/tmp/wipreal';
  const pi = new MockPi();
  activate(pi.api);
  seedState(cwd, { goal: seedGoal({ policy: 'goal', status: 'active', objective: 'wipe bench' }) });
  const ctx = makeMockCtx(cwd, { sessionManager: { name: 'wipe-bench-main' } });
  Object.assign(ctx, { hasUI: true });
  Object.assign(ctx.ui, { confirmImpl: () => Promise.resolve(true) });
  await pi.fire('session_start', { reason: 'startup' }, ctx);
  await pi.command('status', '', ctx).catch(() => {});

  // Where does the time go? Time the candidate costs individually.
  const time = (label: string, fn: () => unknown) => {
    const t = performance.now(); const r = fn(); console.log(`${label}\t${(performance.now() - t).toFixed(1)}ms`); return r;
  };
  time('readState', () => core.readState(cwd));
  time('ledgerFiles', () => core.ledgerFiles(cwd));
  time('scanLedgerRecords(ALL BYTES)', () => { let n = 0; core.scanLedgerRecords(cwd, () => { n++; }); return n; });
  time('readQueueFromDisk', () => core.readQueueFromDisk(cwd));
  time('appendLedger x1 (first write)', () => core.appendLedger(cwd, 'bench_probe', { a: 1 }));
  time('appendLedger x1 (warm)', () => core.appendLedger(cwd, 'bench_probe', { a: 2 }));
  time('persistState-like write', () => fs.appendFileSync(`${cwd}/.pi-glla/active.jsonl`, JSON.stringify({ type: 'bench' }) + '\n'));

  core.__testOnlyResetLedgerScanRecordsCalls();
  const t = performance.now();
  await pi.command('glla', 'wipe', ctx);
  console.log(`WIPE_E2E_MS=${(performance.now() - t).toFixed(1)}`);
  console.log(`SCAN_CALLS_DURING_WIPE=${core.__testOnlyLedgerScanRecordsCalls()}`);
});
