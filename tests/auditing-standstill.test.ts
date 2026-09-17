// tests/auditing-standstill.test.ts
//
// Regression for note.md 2026-09-17 095239: after complete_goal is accepted
// (goal auditing, claim stored), repeated executor turns must NOT receive
// stall warnings, checkpoint dispatches, or duplicate-claim prompts. The
// audit owns the goal surface; only a verdict or infrastructure failure
// may move it.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import { readState } from "../extensions/goal-loop-core.js";
import activate, {
  __testOnlyLoadState,
  __testOnlyResetOwnerSession,
  __testOnlyResetStaleFlag,
  __testOnlyResetTerminalFlags,
} from "../extensions/loops/goal.js";
import { MockPi, makeMockCtx, tmpCwd, seedGoal, seedState, tick, type MockCtx } from "./harness/mock-pi.js";

const pi = new MockPi();
activate(pi.api);

function freshCtx(cwd: string): MockCtx {
  __testOnlyResetOwnerSession();
  return makeMockCtx(cwd, { sessionManager: { name: "audit-standstill" } });
}

test("agent turns during a pending audit stay silent instead of escalating", { timeout: 60_000 }, async () => {
  __testOnlyResetStaleFlag();
  __testOnlyResetTerminalFlags();
  const cwd = tmpCwd();
  const ctx = freshCtx(cwd);
  try {
    await pi.fire("session_start", { reason: "startup" }, ctx);
    seedState(cwd, {
      goal: seedGoal({
        status: "auditing",
        objective: "pending audit standstill — done when pinned",
        pendingCompletion: {
          completionSummary: "stored claim",
          verificationSummary: "stored evidence",
          at: new Date().toISOString(),
          phase: "running",
          attemptId: "audit-standstill-attempt",
        } as any,
      }),
    });
    __testOnlyLoadState(cwd);
    pi.sent.length = 0;
    for (let turn = 0; turn < 4; turn++) {
      await pi.fire("agent_end", { messages: [{ role: "assistant", content: [{ type: "text", text: "idle narration" }], stopReason: "end_turn" }] }, ctx);
      await tick();
    }
    const notices = ctx.ui.notifies.map((entry) => entry.message).join("\n");
    const stalled = pi.sent.filter((sent) => (sent.message as { content?: string }).content?.includes("[STALL WARNING"));
    assert.deepEqual(stalled, [], "no stall warning dispatches while an audit is pending");
    const goal = readState(cwd).goal as { status: string; pauseReason?: string };
    assert.equal(goal.status, "auditing", "a pending audit is not auto-paused by the stall brake");
    assert.doesNotMatch(notices, /stalled|duplicate|already running/, "no churn guidance while auditing");
    const ledger = fs.readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf8");
    assert.doesNotMatch(ledger, /stall_escalation_nudge/, "stall escalation never fires on an auditing goal");
    assert.doesNotMatch(ledger, /goal_continuation_sent/, "no duplicate continuation is dispatched while auditing");
  } finally {
    await pi.fire("session_shutdown", { reason: "test-end" }, ctx);
    __testOnlyResetStaleFlag();
    __testOnlyResetTerminalFlags();
    __testOnlyResetOwnerSession();
  }
});
