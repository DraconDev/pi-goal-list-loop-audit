// GENERATED EVIDENCE — deleted after the run; see the audit register.
import { test, afterEach } from 'node:test';
import * as fs from 'node:fs';
import activate, { __testOnlyResetOwnerSession, __testOnlyResetStaleFlag } from '../extensions/loops/goal.js';
import { readState } from '../extensions/goal-loop-core.js';
import { MockPi, makeMockCtx, seedGoal, seedState, tmpCwd } from './harness/mock-pi.js';

const settingsPath = process.env.GLLA_GLOBAL_SETTINGS_PATH!;
const settingsBefore = fs.readFileSync(settingsPath, 'utf8');
const out: string[] = [];
afterEach(() => fs.writeFileSync(settingsPath, settingsBefore));

test('evidence', async () => {
  const pad = (s: string, n: number) => s.length > n ? s.slice(0, n - 1) + '…' : s.padEnd(n);
  out.push([pad('session_compact_failed errorMessage', 52), pad('failureKind', 18), pad('pauseKind', 11), 'mainModelRecovery.retryAt'].join(' '));
  out.push('-'.repeat(120));
  for (const raw of ['Error: Connection error.', 'Error: Request timed out.', 'Error: 429 "Rate limit exceeded"',
    'Error: Provider returned an empty response', 'auditor produced no verdict marker', 'user aborted']) {
    const cwd = tmpCwd();
    fs.writeFileSync(settingsPath, JSON.stringify({ autoResume: true, aggressiveMode: false, mainModelFallbacks: [] }));
    seedState(cwd, { goal: seedGoal({ status: 'active', objective: 'evidence' }) });
    __testOnlyResetOwnerSession(); __testOnlyResetStaleFlag();
    const pi = new MockPi(); activate(pi.api);
    const ctx = makeMockCtx(cwd);
    await pi.fire('session_start', { reason: 'reload' }, ctx);
    await pi.fire('session_compact_failed', { errorMessage: raw, willRetry: false }, ctx);
    const s = readState(cwd);
    const ledger = fs.readFileSync(`${cwd}/.pi-glla/active.jsonl`, 'utf8').trim().split('\n')
      .map((l) => JSON.parse(l) as { type: string; value: Record<string, unknown> });
    const cf = ledger.find((e) => e.type === 'session_compact_failed');
    out.push([pad(raw, 52), pad(String(cf?.value.failureKind), 18), pad(String(s.goal?.pauseKind), 11), String(s.mainModelRecovery?.retryAt ?? '(none — no durable retry)')].join(' '));
    await pi.fire('session_shutdown', { reason: 'test' }, ctx);
  }
  out.push('');
  out.push('pauseKind=wait + a retryAt  => the goal wakes itself on the paced ladder.');
  out.push('pauseKind=blocked, no retryAt => MANUAL pause: the goal is dead until a human resumes it.');
  fs.writeFileSync('/home/dracon/Dev/pi-plugins/pi-goal-list-loop-audit/audit/transport-failure-durable-retry-2026-11-05/verification/compaction-park.txt', out.join('\n') + '\n');
});
