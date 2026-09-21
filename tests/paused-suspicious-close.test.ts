import { test, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import activate, { __testOnlyResetOwnerSession, __testOnlyResetStaleFlag, __testOnlyResetTerminalFlags } from "../extensions/loops/goal.js";
import { __testOnlyResetZombieAutoRetry } from "../extensions/loops/goal-activation.js";
import { __testOnlyResetZombieRunWatchdog } from "../extensions/goal-heartbeat.js";
import { readState } from "../extensions/goal-loop-core.js";
import { assessSuspiciousObjective } from "../extensions/faulty-objective-recovery.js";
import { guardGoalBeforeContinuation, resetContinuationDispatchState } from "../extensions/goal-continuation.js";
import { MockPi, makeMockCtx, tmpCwd, seedState, seedGoal, tick } from "./harness/mock-pi.js";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

// Field 032245: a work-done goal whose objective carried report prose
// ("Evidence: tsc clean, 666 tests pass") was flagged verification-fragment,
// paused with a queued repair task, and then could never close — every
// resume re-paused it, and complete_goal only runs on an active item.
// The close path (claim -> isolated auditor verifies real artifacts) must
// stay open on a suspicious-objective pause.
const FIELD_OBJECTIVE = "Rework result filtering into quiet automatic mode. Evidence: tsc clean, 666 tests pass.";
const SUMMARY = "Outcome: Filtering reworked.\nChanged: filter.ts.\nEvidence: fixture run.\nTests: focused suite passed.\nUnresolved: none.\nNext: none.";

const pi = new MockPi();
activate(pi.api);
let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => { await cleanup?.(); cleanup = undefined; });

// Audit 2026-09-20: the suspicious-close settlement path (auditor spawn +
// RPC protocol + archive) legitimately takes ~9.4s unloaded, so the old 10s
// ceiling flaked under any load. 30s keeps the failure signal (a wedged
// audit still times out loudly) with real margin under the 60s runner cap.
async function waitFor(check: () => boolean, timeout = 30000) {
  const until = Date.now() + timeout;
  while (!check()) { if (Date.now() > until) throw new Error("settlement timeout"); await new Promise(r => setTimeout(r, 20)); }
}

function ledger(cwd: string): string {
  return fs.readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf8");
}

async function boot(cwd: string, goal: Record<string, unknown>, verdict: "approved" | "disapproved" = "approved") {
  __testOnlyResetOwnerSession(); __testOnlyResetStaleFlag(); __testOnlyResetTerminalFlags();
  __testOnlyResetZombieAutoRetry(); __testOnlyResetZombieRunWatchdog();
  resetContinuationDispatchState(cwd);
  seedState(cwd, { goal, list: [] });
  const binary = path.join(cwd, "auditor.mjs");
  fs.writeFileSync(binary, `#!/usr/bin/env node
let handled = false;
process.stdin.on("data", () => { if (handled) return; handled = true;
setTimeout(() => {
const emit = e => process.stdout.write(JSON.stringify(e) + "\\n");
emit({type:"tool_execution_start",toolCallId:"read",toolName:"read",args:{path:"README.md"}});
emit({type:"tool_execution_end",toolCallId:"read"});
emit({type:"message_update",assistantMessageEvent:{type:"text_delta",delta:${JSON.stringify(verdict === "approved" ? "<evidence>pinned</evidence>\n<approved/>" : "Fix the filter edge case.\n<disapproved/>")}}});
emit({type:"agent_settled"});
}, 350); });`);
  fs.chmodSync(binary, 0o700);
  const previous = process.env.GLLA_PI_BINARY; process.env.GLLA_PI_BINARY = binary;
  const ctx = makeMockCtx(cwd, { sessionManager: { name: `suspicious-close-${Date.now()}-${Math.random()}` } });
  cleanup = async () => {
    await pi.fire("session_shutdown", { reason: "quit" }, ctx);
    resetContinuationDispatchState(cwd); __testOnlyResetZombieRunWatchdog(); __testOnlyResetZombieAutoRetry();
    if (previous === undefined) delete process.env.GLLA_PI_BINARY; else process.env.GLLA_PI_BINARY = previous;
  };
  await pi.fire("session_start", { reason: "startup" }, ctx);
  await tick(80);
  return ctx;
}

test("032245: the field objective trips verification-fragment through the real classifier", () => {
  const assessment = assessSuspiciousObjective(FIELD_OBJECTIVE);
  assert.equal(assessment.suspicious, true, "reproduction must use a genuinely suspicious objective");
  assert.ok(assessment.reasons.includes("verification-fragment"));
});

test("032245: a paused suspicious goal can submit complete_goal and close on auditor approval", async () => {
  const cwd = tmpCwd();
  const ctx = await boot(cwd, seedGoal({ status: "active", objective: FIELD_OBJECTIVE }));
  // Resume/dispatch path pauses the suspicious goal and queues repair —
  // the exact 032245 shape.
  assert.equal(guardGoalBeforeContinuation(ctx as unknown as ExtensionContext, "dispatch"), false);
  const paused = readState(cwd).goal;
  assert.equal(paused?.status, "paused");
  assert.equal(paused?.pauseKind, "blocked");
  assert.match(String(paused?.pauseReason ?? ""), /^Suspicious objective detected \(verification-fragment\)/);
  assert.match(ledger(cwd), /"faulty_objective_repair_queued"/);
  // The claim must be accepted into audit, not refused for being paused.
  const result = await pi.runTool("complete_goal", { completionSummary: SUMMARY, verificationSummary: "pinned" }, ctx) as any;
  assert.doesNotMatch(result.content[0].text, /only runs on an active item/, "suspicious pause must not block the close path");
  assert.match(result.content[0].text, /AUDIT PENDING — nonterminal/);
  assert.equal(readState(cwd).goal?.status, "auditing");
  assert.match(ledger(cwd), /"complete_goal_suspicious_pause_accepted"/);
  // The approved claim archives the original goal...
  await waitFor(() => ledger(cwd).includes('"goal_archived"') && ledger(cwd).includes('"status":"complete"'));
  // ...and voids the moot queued repair instead of cascading into it.
  assert.match(ledger(cwd), /"faulty_objective_repair_voided_on_approval"/);
  const settled = readState(cwd);
  assert.ok(!settled.list?.some((item: any) => item?.repairTarget?.id === paused?.id), "no repair item targeting the approved goal survives");
  assert.ok(!settled.goal || settled.goal.id !== paused?.id, "the approved goal itself is closed");
});

test("stored-completion-audit retry settles a suspicious claim instead of re-pausing it", async () => {
  const cwd = tmpCwd();
  const ctx = await boot(cwd, seedGoal({
    status: "paused",
    pauseKind: "blocked",
    pauseReason: "Suspicious objective detected (verification-fragment).",
    objective: FIELD_OBJECTIVE,
    pendingCompletion: { attemptId: "attempt-1", phase: "recovery-pending" },
  }));
  const goal = readState(cwd).goal;
  assert.ok(goal);
  // Without the close flag the guard still shields worker dispatch.
  assert.equal(guardGoalBeforeContinuation(ctx as unknown as ExtensionContext, "stored-completion-audit", goal.id, { allowAuditing: true }), false);
  // With it, the in-flight claim may settle — artifacts, not prose.
  assert.equal(guardGoalBeforeContinuation(ctx as unknown as ExtensionContext, "stored-completion-audit", goal.id, { allowAuditing: true, allowSuspiciousClose: true }), true);
  assert.match(ledger(cwd), /"faulty_objective_suspicious_close_allowed"/);
});

test("narrowness: paused-by-user and paused repair cards still refuse complete_goal", async () => {
  const cwd = tmpCwd();
  const ctx = await boot(cwd, seedGoal({
    status: "paused",
    pauseKind: "blocked",
    pauseReason: "paused by user",
    objective: "Implement the saved recovery behavior",
  }));
  const userPaused = await pi.runTool("complete_goal", { completionSummary: SUMMARY, verificationSummary: "pinned" }, ctx) as any;
  assert.match(userPaused.content[0].text, /only runs on an active item/);
  assert.equal(readState(cwd).goal?.status, "paused");
});

test("narrowness: a paused repair card cannot skip its replan via the suspicious close path", async () => {
  const cwd = tmpCwd();
  const ctx = await boot(cwd, seedGoal({
    status: "paused",
    pauseKind: "blocked",
    pauseReason: "Suspicious objective detected (verification-fragment).",
    objective: "Repair the blocked goal from saved intent",
    repairTarget: { id: "original-1", objective: "Implement the saved recovery behavior", reasons: ["verification-fragment"], source: "test" },
  }));
  const result = await pi.runTool("complete_goal", { completionSummary: SUMMARY, verificationSummary: "pinned" }, ctx) as any;
  assert.match(result.content[0].text, /cannot be completed yet|propose_task_list/);
  assert.equal(readState(cwd).goal?.status, "paused");
  // v0.38.63 reviewer P2: a refused repair card must not ledger "accepted".
  assert.doesNotMatch(ledger(cwd), /"complete_goal_suspicious_pause_accepted"/);
});
