// tests/auditor-dispatch-horizon.test.ts
//
// Reviewer BLOCK on the bounded-recovery item: a stored fixed window must
// bind at DISPATCH, not only at scheduling. The hourly backstop, the reload
// restore, and the ladder timer all converge on retryStoredCompletionAudit —
// an automatic entry whose claim has an expired retryUntil/automatic-
// RecoveryUntil must stop instead of launching another chain. Only an
// explicit user-authorized resume (manual/agent) may open a fresh envelope.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import activate, { __testOnlyLoadState, __testOnlyResetOwnerSession, __testOnlyResetStaleFlag, __testOnlyResetTerminalFlags } from "../extensions/loops/goal.js";
import { readState } from "../extensions/goal-loop-core.js";
import { MockPi, makeMockCtx, tmpCwd, seedGoal, seedState } from "./harness/mock-pi.js";

test("expired stored horizon blocks automatic dispatch without a launch", { timeout: 30000 }, async () => {
  const cwd = tmpCwd();
  const pi = new MockPi();
  const binary = process.env.GLLA_PI_BINARY;
  const settingsPath = process.env.GLLA_GLOBAL_SETTINGS_PATH!;
  const settings = fs.readFileSync(settingsPath, "utf8");
  __testOnlyResetOwnerSession();
  __testOnlyResetStaleFlag();
  __testOnlyResetTerminalFlags();
  // A real worker script: if the guard is missing, this LAUNCHES and the
  // audit_started ledger betrays it — the red condition is observable.
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
  const ctx = makeMockCtx(cwd, { sessionManager: { name: "dispatch-horizon" } });
  seedState(cwd, { goal: null });
  try {
    await pi.fire("session_start", { reason: "startup" }, ctx);
    const past = new Date(Date.now() - 60_000).toISOString();
    // Install the expired capped claim after startup: session recovery would
    // otherwise race the explicit dispatch this regression exercises.
    seedState(cwd, { goal: seedGoal({
      status: "paused",
      pauseKind: "wait",
      pauseResumeAt: past,
      pauseReason: "auditor retry: provider error",
      pendingCompletion: {
        at: new Date().toISOString(),
        phase: "retry-waiting",
        completionSummary: "Stored fixture claim",
        verificationSummary: "Fixture only",
        retryAttempts: 3,
        retryFirstAt: past,
        retryUntil: past,
        automaticRecoveryUntil: past,
      } as any,
    }) });
    __testOnlyLoadState(cwd);
    const ledgerPath = `${cwd}/.pi-glla/active.jsonl`;
    const rowsBefore = fs.readFileSync(ledgerPath, "utf8").split("\n").filter(Boolean).length;

    await (globalThis as any).retryStoredCompletionAudit("provider-retry");

    const goal = readState(cwd).goal as any;
    assert.equal(goal.status, "paused", "expired horizon must not launch an audit");
    assert.match(goal.pauseReason, /window ended before dispatch/);
    assert.equal(goal.pauseKind, "blocked");
    assert.equal(goal.pendingCompletion?.retryAttempts, 3, "attempt counters are not touched by a refused dispatch");
    const rows = fs.readFileSync(ledgerPath, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
    const newRows = rows.slice(rowsBefore);
    assert.ok(newRows.some((row: any) => row.type === "auditor_retry_dispatch_expired"), "refusal is ledgered");
    assert.ok(!newRows.some((row: any) => row.type === "audit_started"), "no auditor launch after the window ends");

    // Idempotent: a second automatic dispatch on the blocked claim also no-ops.
    await (globalThis as any).retryStoredCompletionAudit("provider-retry");
    const rowsAfter = fs.readFileSync(ledgerPath, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));
    assert.equal(rowsAfter.filter((row: any) => row.type === "audit_started").length, 0, "still no launch");
  } finally {
    await pi.fire("session_shutdown", {}, ctx);
    if (binary === undefined) delete process.env.GLLA_PI_BINARY; else process.env.GLLA_PI_BINARY = binary;
    fs.writeFileSync(settingsPath, settings);
    __testOnlyResetOwnerSession();
    __testOnlyResetStaleFlag();
    __testOnlyResetTerminalFlags();
  }
});

test("expired dispatch preserves the exhausted-chain diagnostic", { timeout: 30000 }, async () => {
  const cwd = tmpCwd();
  const pi = new MockPi();
  __testOnlyResetOwnerSession();
  __testOnlyResetStaleFlag();
  __testOnlyResetTerminalFlags();
  activate(pi.api);
  const ctx = makeMockCtx(cwd, { sessionManager: { name: "dispatch-horizon-keep-chain" } });
  seedState(cwd, { goal: null });
  try {
    await pi.fire("session_start", { reason: "startup" }, ctx);
    const past = new Date(Date.now() - 60_000).toISOString();
    // Post-burn retry-wait state: the exhausted chain is already named in the
    // pause reason (set at retry scheduling); candidate cursor fields are
    // cleared. Dispatch-time expiry must not overwrite that identity.
    seedState(cwd, { goal: seedGoal({
      status: "paused",
      pauseKind: "wait",
      pauseResumeAt: past,
      pauseReason: "auditor retry: Exhausted auditor chain: provider/alpha → provider/beta. provider error",
      pendingCompletion: {
        at: new Date().toISOString(),
        phase: "retry-waiting",
        completionSummary: "Stored fixture claim",
        verificationSummary: "Fixture only",
        retryAttempts: 2,
        retryFirstAt: past,
        retryUntil: past,
        automaticRecoveryUntil: past,
      } as any,
    }) });
    __testOnlyLoadState(cwd);
    await (globalThis as any).retryStoredCompletionAudit("provider-retry");
    const goal = readState(cwd).goal as any;
    assert.equal(goal.status, "paused");
    assert.match(goal.pauseReason, /Exhausted auditor chain: provider\/alpha → provider\/beta/, "the chain name survives dispatch-time expiry");
    assert.match(goal.pauseReason, /window ended before dispatch/);
    assert.match(goal.pauseSuggestedAction ?? "", /resume/, "concrete recovery action stays");
  } finally {
    await pi.fire("session_shutdown", {}, ctx);
    __testOnlyResetOwnerSession();
    __testOnlyResetStaleFlag();
    __testOnlyResetTerminalFlags();
  }
});

// ─── regression for reviewer BLOCK (2026-09-17T14:07) ───

test("hourly backstop skips blocked capped claims before dispatch", () => {
  // The backstop lives in goal-recovery.ts; pin its ineligibility guard so a
  // capped/blocked claim is never re-dispatched hourly after the window ends.
  const src = fs.readFileSync("extensions/goal-recovery.ts", "utf8");
  const fnIdx = src.indexOf("async function fireHourlyProbeForParkedAuditor");
  const body = src.slice(fnIdx, fnIdx + 1400);
  const dispatchIdx = body.indexOf('retryStoredCompletionAudit("provider-retry")');
  const blockedIdx = body.indexOf('pauseKind === "blocked"');
  assert.ok(blockedIdx > 0, "blocked pauses are ineligible for the hourly auditor backstop");
  assert.ok(blockedIdx < dispatchIdx, "the ineligibility guard precedes the dispatch");
});
