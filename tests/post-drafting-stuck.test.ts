// pi-goal-list-loop-audit — post-drafting stuck cluster (field 110418/111629/111716/111957)
//
// After drafting, the loop must never get stuck unless something critical
// comes up. Three stuck shapes observed in the field:
//   1. claim-not-persisted confusion — complete_goal storage fails yet the
//      agent narrates "a detached auditor is settling it" and waits.
//   2. false manual action — a paused recovery-wait list item is
//      agent-resumable via resume_goal, but the agent concludes only a
//      user-side /list resume can clear it and bounces to the user.
//   3. waits too long — auditor retry attempt>=2 aligns to the next :00:30
//      hourly slot (field: "auto-retry in 44m 03s") with no tighter bound.

import { test, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";

import activate, {
  __testOnlyResetOwnerSession,
  __testOnlyResetStaleFlag,
  __testOnlyResetTerminalFlags,
} from "../extensions/loops/goal.js";
import { __testOnlyResetZombieAutoRetry } from "../extensions/loops/goal-activation.js";
import { __testOnlyResetZombieRunWatchdog } from "../extensions/goal-heartbeat.js";
import { resetContinuationDispatchState } from "../extensions/goal-continuation.js";
import { readState, goalStateTransactionPath } from "../extensions/goal-loop-core.js";
import { auditorRetryPlan } from "../extensions/loops/goal-auditor-hooks.js";
import { MockPi, makeMockCtx, seedGoal, seedState, tick, tmpCwd } from "./harness/mock-pi.js";

const summary = "Outcome: Fixed routing.\nChanged: router.ts.\nEvidence: routing fixture.\nTests: routing suite passed.\nUnresolved: none.\nNext: await audit.";

afterEach(() => {
  __testOnlyResetStaleFlag();
  __testOnlyResetTerminalFlags();
  __testOnlyResetOwnerSession();
  __testOnlyResetZombieAutoRetry();
  __testOnlyResetZombieRunWatchdog();
});

test("post-drafting: complete_goal storage failure returns an error, never a wait narrative", async () => {
  const cwd = tmpCwd();
  const pi = new MockPi();
  activate(pi.api);
  __testOnlyResetOwnerSession();
  __testOnlyResetStaleFlag();
  __testOnlyResetTerminalFlags();
  __testOnlyResetZombieAutoRetry();
  __testOnlyResetZombieRunWatchdog();
  resetContinuationDispatchState(cwd);
  const ctx = makeMockCtx(cwd);
  await pi.fire("session_start", { reason: "startup" }, ctx);
  await pi.command("goal", "fix routing — done when pinned", ctx);
  assert.equal(readState(cwd).goal?.status, "active");
  // Block the durable transaction write while leaving the ledger writable:
  // a directory where goal-state.transaction.json must land fails the rename.
  fs.mkdirSync(goalStateTransactionPath(cwd));
  try {
    const result = await pi.runTool(
      "complete_goal",
      { completionSummary: summary, verificationSummary: "pinned" },
      ctx,
    ) as unknown as { content: Array<{ text: string }>; isError?: boolean };
    assert.match(result.content[0]!.text, /not persisted/, "the failure names persistence");
    assert.match(result.content[0]!.text, /no auditor was launched/, "no auditor is claimed");
    assert.equal(result.isError, true, "persist failure is an error result — the agent must not narrate settling/waiting");
    assert.doesNotMatch(result.content[0]!.text, /AUDIT PENDING/, "no pending narrative on a claim that was never stored");
    assert.notEqual(readState(cwd).goal?.status, "auditing", "an unpersisted claim never flips to auditing");
  } finally {
    fs.rmdirSync(goalStateTransactionPath(cwd));
  }
  await pi.fire("session_shutdown", { reason: "quit" }, ctx);
  resetContinuationDispatchState(cwd);
});

test("post-drafting: resume_goal resumes a paused auditor-retry list item", async () => {
  const cwd = tmpCwd();
  seedState(cwd, {
    goal: seedGoal({
      status: "paused",
      policy: "list",
      pauseKind: "wait",
      pauseReason: "auditor retry: provider unavailable",
      pauseResumeAt: new Date(Date.now() + 44 * 60_000).toISOString(),
      pauseSuggestedAction: "Auto-retry in 44m — or /list resume to retry now",
    }),
  });
  const pi = new MockPi();
  activate(pi.api);
  __testOnlyResetOwnerSession();
  __testOnlyResetStaleFlag();
  const ctx = makeMockCtx(cwd, { sessionManager: { name: `post-drafting-resume-${Date.now()}` } });
  await pi.fire("session_start", { reason: "startup" }, ctx);
  await tick(120);
  assert.equal(readState(cwd).goal?.status, "paused");
  const result = await pi.runTool("resume_goal", { reason: "wait elapsed; retry the auditor now" }, ctx) as unknown as {
    content: Array<{ text: string }>;
  };
  assert.match(result.content[0]!.text, /active again/, "the agent clears a recovery-wait list item itself");
  assert.equal(readState(cwd).goal?.status, "active");
  await pi.fire("session_shutdown", { reason: "quit" }, ctx);
});

test("post-drafting: auditor retry waits after the eager probe are capped at 15 minutes", () => {
  const realNow = Date.now;
  try {
    // Pin local time to 11:05 so the next :00:30 hourly slot is ~25m out —
    // past the cap, proving the cap (not the slot) sets the wait.
    const fixed = new Date();
    fixed.setHours(11, 5, 0, 0);
    Date.now = () => fixed.getTime();
    const plan = auditorRetryPlan({
      phase: "retry-waiting",
      claim: "done",
      goalId: "g-1",
      attemptId: "a-1",
      retryAttempts: 1,
      retryFirstAt: new Date(fixed.getTime() - 3_600_000).toISOString(),
    } as never);
    assert.equal(plan.attempt, 2);
    assert.ok(plan.requestedSec > 15 * 60, `precondition: the hourly slot waits longer than the cap, got ${plan.requestedSec}s`);
    assert.ok(
      plan.retryAfterSec <= 15 * 60,
      `attempt>=2 waits stay within the 15m bound, got ${plan.retryAfterSec}s`,
    );
    assert.ok(plan.retryAfterSec >= 60, "the 60s floor still holds");
  } finally {
    Date.now = realNow;
  }
});

test("post-drafting: recovery-wait surfaces name resume_goal as the agent path", () => {
  const hooks = fs.readFileSync("extensions/loops/goal-auditor-hooks.ts", "utf8");
  assert.match(
    hooks,
    /retry now[^`]*resume_goal/s,
    "the auditor-retry park action names resume_goal next to the retry verb",
  );
  const recovery = fs.readFileSync("extensions/goal-recovery.ts", "utf8");
  assert.match(
    recovery,
    /resume_goal/,
    "the main-model recovery wait names resume_goal so the agent never bounces to a user-side resume",
  );
});
