// pi-goal-list-loop-audit — v0.34.80
// tests/stuck-audit-latch.test.ts
//
// 2026-08-07 field incident (the "are we stuck" freeze): a latched-stale
// LIVE session froze item 2's goal in "auditing" for 30m+ with zero ledger
// activity. Chain: transient heartbeat-probe failures tripped
// goStaleTerminal (extensionApiStale latched) → complete_goal's tool path
// (raw toolCtx) still dispatched the detached audit → the worker's verdict
// (DISAPPROVED) completed on disk → the apply gate's freshCtxForGeneration()
// returned null under the latch → the verdict was SILENTLY DROPPED → the
// stranded-audit recovery in heartbeatTick is unreachable below the stale
// branch → the queue froze with no in-flight audit.
//
// Fixes pinned here:
//   Fix A — the apply gate never drops a completed verdict silently: it
//           ledgeres audit_verdict_deferred and parks the claim via
//           markCompletionAuditRecoveryPending (recovery-pending phase) so a
//           fresh session's recovery path surfaces it for /goal resume.
//   Fix B — heartbeatTick parks a stuck auditing goal (stale-latch branch)
//           BEFORE the extensionApiStale early return, using a fresh context
//           when available or a context-free cwd bridge — the park is the
//           durable recovery gate; a healthy same-session heartbeat may
//           consume it through the one-shot path, but the heartbeat itself
//           never launches a worker directly.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import { readGoalRuntimeSource } from "./harness/goal-source.js";

const SRC = readGoalRuntimeSource();
const HB = fs.readFileSync("extensions/goal-heartbeat.ts", "utf-8"); // decomposition step 4 (v0.34.112)

test("Fix A: the apply gate defers + parks instead of silently dropping a completed verdict", () => {
  // The two silent returns became one guarded path:
  assert.match(SRC, /const currentAfterAudit = freshCtxForGeneration\(generation\);\n  if \(!currentAfterAudit \|\| !state\.goal \|\| state\.goal\.id !== goalId\) \{/);
  assert.match(SRC, /audit_verdict_deferred/, "the deferred-verdict ledger event exists");
  assert.match(SRC, /markCompletionAuditRecoveryPending\((?:recoveryCtx|lastCtx), "verdict-apply-gate"\)/, "the claim parks as recovery-pending");
  assert.match(SRC, /NEVER drop a completed verdict silently/, "the intent comment is pinned");
  // The legit-supersede case (a NEWER attempt owns the durable claim) stays silent:
  assert.match(SRC, /if \(state\.goal\.pendingCompletion\?\.attemptId !== claim\.attemptId\) return; \/\/ a newer attempt owns the durable claim/);
});

test("Fix B: the stale-latch stranded park runs BEFORE the extensionApiStale early return", () => {
  const staleBranch = HB.indexOf("const rawApiStale = probeExtensionApiStaleRaw();");
  const parked = HB.indexOf("stranded_audit_recovered");
  assert.ok(staleBranch > 0 && parked > 0, "both branches exist");
  assert.ok(parked < staleBranch, "the stale-latch park is ordered BEFORE the stale probe branch — the backstop is reachable while latched");
  assert.match(HB, /via: "stale-latch"/, "the park is attributed to the stale latch");
  assert.match(HB, /const current = freshCtx\(\);/, "the retained stale context is not used for mutation");
  assert.match(HB, /if \(!markCompletionAuditRecoveryPending\(current, "stale-latch-recovery"\)\)/, "fresh-context success is checked before the safe-claim notice");
  assert.match(HB, /if \(!parkCompletionAuditRecovery\(cwd, "stale-latch-recovery"\)\)/, "the context-free fallback reports persistence failure honestly");
  assert.doesNotMatch(HB, /markCompletionAuditRecoveryPending\(knownCtx, "stale-latch-recovery"\)/, "the retained stale context is probe-only");
  // A heartbeat must never launch another worker — only the park. The
  // pre-branch block (between the park and the stale probe branch) contains
  // no dispatch call:
  const between = HB.slice(parked, staleBranch);
  assert.ok(!between.includes("retryStoredCompletionAudit"), "no worker relaunch from the heartbeat pre-branch");
  assert.ok(between.includes("return;"), "the park returns — the stale branch is skipped this tick");
});

test("Fix B: the park requires the exact stuck signature (auditing, no in-flight, claim, 90s silence)", () => {
  assert.match(HB, /state\.goal\?\.status === "auditing"/);
  assert.match(HB, /!flags\.completionAuditInFlight/);
  assert.match(HB, /state\.goal\.pendingCompletion/);
  assert.match(HB, /Date\.now\(\) - flags\.lastActivityAt >= 90_000/);
  // the pre-existing (non-stale) stranded block keeps its stored-claim path:
  assert.match(HB, /markCompletionAuditRecoveryPending\(ctx, "heartbeat-recovery"\)/);
  const RECOVERY = fs.readFileSync("extensions/goal-recovery.ts", "utf-8");
  assert.match(RECOVERY, /writeGoalStateTransaction\(cwd, \{ \.\.\.state, goal: nextGoal \}\)/, "context-free park writes the durable recovery transaction");
  assert.match(RECOVERY, /const stateLanded = persistStateLine\(cwd, state\);/, "context-free park checks the state append result");
});

test("audit 2026-09-25: stranded_audit_recovered is ledgered only after the park lands", () => {
  // Both stale-latch branches (fresh-ctx and context-free) must persist the
  // recovery projection BEFORE claiming "recovered" — on a failed park the
  // claim is still auditing and the ledger must not overstate it.
  // Fresh-ctx branch: the failure notify + early return precede the ledger.
  assert.match(
    HB,
    /if \(!markCompletionAuditRecoveryPending\(current, "stale-latch-recovery"\)\) \{[^]*?could not be persisted[^]*?return;[^]*?\}\s*\/\/ The recovery projection landed[^]*?appendLedger\(current\.cwd, "stranded_audit_recovered"/,
    "fresh-ctx ledger follows the successful park",
  );
  // Context-free branch: the ledger sits after the failure-check block.
  assert.match(
    HB,
    /if \(!parkCompletionAuditRecovery\(cwd, "stale-latch-recovery"\)\) \{[^]*?return;\s*\}\s*appendLedger\(cwd, "stranded_audit_recovered"/,
    "context-free ledger follows the successful park",
  );
});
