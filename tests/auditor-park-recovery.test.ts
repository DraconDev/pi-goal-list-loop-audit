// pi-goal-list-loop-audit — v0.39.68
// tests/auditor-park-recovery.test.ts
//
// A park that arms a retry timer must write the pause state that timer's
// own recovery gate accepts.
//
// v0.39.68 (field 2026-11-09): the audit lane's parks did not agree with the
// gate that resumes them. The recovery gate accepts a system-owned pause
// whose reason is an audit-lane park ("auditor retry: …", "auditor blocked:
// …", "completion audit blocked …"), but two parks wrote something else:
//
//   - the timeout / no-verdict park: "completion audit timed out — …"
//   - the thrown-infrastructure park: "completion auditor infrastructure
//     failure — …"
//
// and neither wrote `pauseSource: "system"`. A claim parked that way armed a
// retry timer, the timer fired into a refusal, and the stored claim waited
// for a human — the same "stranded at the final audit" shape as the
// session-boundary dead end, one path over.
//
// A DELIBERATE stop stays manual: "automatic recovery disabled", "aggressive
// recovery horizon reached", "cursor could not be persisted" and "candidate
// chain exhausted" are honest decisions, and an automatic recovery must not
// paper over them.
//
// The order of the two behaviour tests matters: the dispatching one takes the
// in-process audit latch, and the refusal one must run first.

import { test, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import activate, { __testOnlyLoadState, __testOnlyResetOwnerSession, __testOnlyResetStaleFlag, __testOnlyResetTerminalFlags } from "../extensions/loops/goal.js";
import { maybeAutoRetryParkedCompletionAudit } from "../extensions/loops/goal-auditor-hooks.js";
import { isAuditParkPauseReason } from "../extensions/auditor-lane.js";
import { readState } from "../extensions/goal-loop-core.js";
import { MockPi, makeMockCtx, seedGoal, seedState, tmpCwd } from "./harness/mock-pi.js";

const originalBinary = process.env.GLLA_PI_BINARY;
const sessions: Array<{ pi: MockPi; ctx: ReturnType<typeof makeMockCtx> }> = [];
afterEach(async () => {
  for (const { pi, ctx } of sessions.splice(0)) await pi.fire("session_shutdown", { reason: "test-end" }, ctx);
  if (originalBinary === undefined) delete process.env.GLLA_PI_BINARY; else process.env.GLLA_PI_BINARY = originalBinary;
  __testOnlyResetOwnerSession(); __testOnlyResetStaleFlag(); __testOnlyResetTerminalFlags();
});

function ledgerTypes(cwd: string): string[] {
  const file = path.join(cwd, ".pi-glla", "active.jsonl");
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean)
    .map((line) => (JSON.parse(line) as { type: string }).type);
}

/** A parked completion claim, in the shape the audit lane's parks write. */
async function park(cwd: string, goal: Record<string, unknown>, claim: Record<string, unknown>): Promise<void> {
  seedState(cwd, {
    goal: seedGoal({
      ...goal,
      pendingCompletion: {
        at: new Date().toISOString(),
        attemptId: "attempt-1",
        phase: "recovery-pending",
        recoveryEpisodeKey: "episode-1",
        recoveryRetryAt: new Date(Date.now() - 1_000).toISOString(),
        completionSummary: "stored completion claim",
        ...claim,
      },
    }),
    list: [],
  });
  __testOnlyLoadState(cwd);
}

async function session(cwd: string): Promise<{ pi: MockPi; ctx: ReturnType<typeof makeMockCtx> }> {
  const pi = new MockPi();
  activate(pi.api);
  const ctx = makeMockCtx(cwd, { sessionManager: { name: `park-${Math.random()}` } });
  Object.assign(ctx, { modelRegistry: { find: () => undefined, getAvailable: () => [ctx.model], getAll: () => [ctx.model], hasConfiguredAuth: () => true } });
  await pi.fire("session_start", { reason: "startup" }, ctx);
  sessions.push({ pi, ctx });
  return { pi, ctx };
}

test("the pause-reason vocabulary accepts the audit lane's parks and rejects its deliberate stops", () => {
  for (const reason of [
    "auditor retry: 429 rate limit exceeded",
    "auditor blocked: 3 identical infra failures (x) · chain: a → b · re-probing every 5 minutes",
    "completion audit blocked — no verdict: session_shutdown:reload",
    "completion audit timed out — no verifier verdict was produced",
    "completion audit stopped before a verifier verdict — no semantic verdict was produced",
    "completion auditor infrastructure failure — no verdict was produced",
  ]) {
    assert.equal(isAuditParkPauseReason(reason), true, `an audit-lane park is resumable: ${reason}`);
  }
  for (const reason of [
    "completion auditor automatic recovery disabled — no verdict was produced",
    "completion auditor aggressive recovery horizon reached — no verdict was produced",
    "completion auditor recovery cursor could not be persisted — automatic recovery stopped",
    "completion auditor candidate fallback chain exhausted — no verifier verdict was produced",
    "main model recovery — retrying after provider compaction failure",
    "paused by user",
    undefined,
  ]) {
    assert.equal(isAuditParkPauseReason(reason), false, `a deliberate stop stays manual: ${String(reason)}`);
  }
});

test("a deliberately stopped claim is NOT picked up by the automatic recovery", async () => {
  const cwd = tmpCwd();
  await session(cwd);
  await park(cwd, {
    status: "paused",
    pauseSource: "system",
    pauseKind: "blocked",
    pauseReason: "completion auditor automatic recovery disabled — no verdict was produced",
  }, { providerErrorDiagnostic: "429 rate limit exceeded", auditorFailureClass: "provider" });
  assert.equal(maybeAutoRetryParkedCompletionAudit("auditor-recovery-timer"), false,
    "an operator-visible stop is not papered over by automation");
  assert.equal(ledgerTypes(cwd).includes("audit_recovery_auto_retry_claimed"), false);
});

test("a claim parked by the infrastructure park recovers on its own", async () => {
  const cwd = tmpCwd();
  // An inert worker: the dispatch is what is under test, not a verdict.
  const worker = path.join(cwd, "inert-auditor.mjs");
  fs.writeFileSync(worker, "#!/usr/bin/env node\nprocess.stdin.resume();\nsetTimeout(() => process.exit(3), 40);\n");
  fs.chmodSync(worker, 0o700);
  process.env.GLLA_PI_BINARY = worker;
  await session(cwd);
  await park(cwd, {
    status: "paused",
    pauseSource: "system",
    pauseKind: "wait",
    pauseResumeAt: new Date(Date.now() - 1_000).toISOString(),
    pauseReason: "completion auditor infrastructure failure — no verdict was produced",
  }, { providerErrorDiagnostic: "429 rate limit exceeded", auditorFailureClass: "provider" });

  assert.equal(maybeAutoRetryParkedCompletionAudit("auditor-recovery-timer"), true,
    "the park's own timer must be able to resume the claim it parked");
  assert.equal(ledgerTypes(cwd).includes("audit_recovery_auto_retry_claimed"), true,
    "the automatic recovery claimed the parked claim");
  assert.notEqual(readState(cwd).goal?.status, "paused", "the claim left the parked state");
});
