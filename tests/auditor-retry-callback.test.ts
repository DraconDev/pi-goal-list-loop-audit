import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import activate, { __testOnlyLoadState, __testOnlyResetOwnerSession, __testOnlyResetStaleFlag, __testOnlyResetTerminalFlags } from '../extensions/loops/goal.js';
import { readState } from '../extensions/goal-loop-core.js';
import { MockPi, makeMockCtx, tmpCwd, seedGoal, seedState } from './harness/mock-pi.js';

test('manual audit exhaustion retries through timer with fresh candidates and unchanged envelope', { timeout: 60000 }, async () => {
  // Regression pin — 2026-09-17T14:07 ledger sequence: exhausted selection
  // ("no auditor model"), 5s uniform schedule, attempt:1 repetition. The
  // timer must retry with automatic provenance so counters advance and the
  // burned chain is never re-walked.
  const cwd = tmpCwd();
  const pi = new MockPi();
  const binary = process.env.GLLA_PI_BINARY;
  const settingsPath = process.env.GLLA_GLOBAL_SETTINGS_PATH!;
  const settings = fs.readFileSync(settingsPath, 'utf8');
  __testOnlyResetOwnerSession();
  __testOnlyResetStaleFlag();
  __testOnlyResetTerminalFlags();
  const script = `${cwd}/failing-auditor.mjs`;
  fs.writeFileSync(script, `#!/usr/bin/env node
process.stdin.once('data', () => {
 process.stdout.write(JSON.stringify({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:'No verdict available.'}})+'\\n');
 process.stdout.write(JSON.stringify({type:'agent_settled'})+'\\n');
});
`);
  fs.chmodSync(script, 0o700);
  process.env.GLLA_PI_BINARY = script;
  fs.writeFileSync(settingsPath, JSON.stringify({ aggressiveMode: true, autoResume: true }));
  activate(pi.api);
  const ctx = makeMockCtx(cwd, { sessionManager: { name: 'retry-fixture' } });
  seedState(cwd, { goal: null });
  try {
    await pi.fire('session_start', { reason: 'startup' }, ctx);
    // Install the parked claim after startup: session recovery would otherwise
    // race the explicit manual entry point this regression exercises.
    seedState(cwd, { goal: seedGoal({ status: 'paused', pendingCompletion: {
      at: new Date().toISOString(), phase: 'recovery-pending', completionSummary: 'Stored fixture claim', verificationSummary: 'Fixture only',
    } }) });
    __testOnlyLoadState(cwd);
    const retry = (globalThis as any).retryStoredCompletionAudit;
    await retry('manual');
    const parked = readState(cwd).goal;
    assert.match(parked?.pauseReason ?? '', /Exhausted auditor chain: /);
    assert.match(parked?.pauseSuggestedAction ?? '', /Auto-retry in .*resume/);
    const first = parked?.pendingCompletion;
    assert.equal(first?.retryAttempts, 1, JSON.stringify({ first, notices: ctx.ui.notifies }));
    assert.equal(first?.auditorAttemptedRefs, undefined, 'burned candidates cleared before timer retry');
    const deadline = Date.now() + 25000;
    while ((readState(cwd).goal?.pendingCompletion?.retryAttempts ?? 0) < 2 && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    const second = readState(cwd).goal?.pendingCompletion;
    assert.equal(second?.retryAttempts, 2, 'timer must not inherit manual origin and reset count to 1');
    assert.equal(second?.retryFirstAt, first?.retryFirstAt);
    assert.equal(second?.retryUntil, first?.retryUntil);
    const ledger = fs.readFileSync(`${cwd}/.pi-glla/active.jsonl`, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
    assert.ok(ledger.some(row => row.type === 'audit_started' && row.value.origin === 'provider-retry'));
    const exhausted = ledger.filter(row => row.type === 'auditor_fallback_exhausted');
    assert.ok(exhausted.length >= 2);
    for (const row of exhausted) {
      assert.ok(row.value.exhaustedChain, 'burned chain survives cursor clearing in diagnostics');
      assert.ok(!row.value.exhaustedChain.includes('no available auditor candidates'), 'fixture actually selected an auditor');
    }
    assert.ok(!ledger.some(row => row.type === 'auditor_fallback_exhausted' && row.value.diagnostic === 'no auditor model'), 'next cycle must launch a candidate');
  } finally {
    await pi.fire('session_shutdown', {}, ctx);
    if (binary === undefined) delete process.env.GLLA_PI_BINARY; else process.env.GLLA_PI_BINARY = binary;
    fs.writeFileSync(settingsPath, settings);
    __testOnlyResetOwnerSession();
    __testOnlyResetStaleFlag();
    __testOnlyResetTerminalFlags();
  }
});
