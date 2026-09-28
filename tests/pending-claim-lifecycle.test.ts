// tests/pending-claim-lifecycle.test.ts
//
// Pending-claim lifecycle contract:
//  1. While a completion claim awaits its audit, the executor gets no
//     stall-warning checkpoints or duplicate-claim prompts (covered by
//     tests/auditing-standstill.test.ts, the 095239 sequence).
//  2. Pending status survives a cold reload without duplicate submission:
//     the durable auditing claim parks to paused/recovery-pending with its
//     identity intact and no auditor launched.
//  3. /goal verify on a healthy pending audit reports the truthful
//     awaiting state instead of overwriting the claim and relaunching.
//  4. /goal verify on an APPROVED-but-unarchived claim finishes the owed
//     settlement instead of destroying the approval (v0.38.108).

import { test, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import activate, {
  __testOnlyLoadState,
  __testOnlyResetOwnerSession,
  __testOnlyResetStaleFlag,
} from "../extensions/loops/goal.js";
import { __testOnlyResetAuditorSurface } from "../extensions/loops/goal-auditor-surface.js";
import { archivedGoalPath, readState } from "../extensions/goal-loop-core.js";
import { MockPi, makeMockCtx, seedGoal, seedState, tick, tmpCwd, type MockCtx } from "./harness/mock-pi.js";

function ledger(cwd: string): string {
  return fs.readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf8");
}

function ledgerTypes(cwd: string): string[] {
  return ledger(cwd).split("\n").filter(Boolean).map((line) => (JSON.parse(line) as { type: string }).type);
}

async function boot(pi: MockPi, cwd: string): Promise<MockCtx> {
  __testOnlyResetOwnerSession();
  __testOnlyResetStaleFlag();
  const ctx = makeMockCtx(cwd, { sessionManager: { name: `pending-claim-${Date.now()}-${Math.random()}` } });
  await pi.fire("session_start", { reason: "startup" }, ctx);
  await tick(120);
  return ctx;
}

afterEach(() => {
  __testOnlyResetAuditorSurface();
  __testOnlyResetStaleFlag();
  __testOnlyResetOwnerSession();
});

test("/goal verify on a healthy pending audit reports the awaiting state without touching the claim", async () => {
  const pi = new MockPi();
  activate(pi.api);
  const cwd = tmpCwd();
  const ctx = await boot(pi, cwd);
  try {
    // A stored agent claim awaiting its verdict (healthy: phase running).
    // Seeded after boot so the cold-load park policy does not convert it;
    // this is the live-process pending shape.
    seedState(cwd, {
      goal: seedGoal({
        status: "auditing",
        objective: "pending verify — done when pinned",
        pendingCompletion: {
          completionSummary: "agent claim under audit",
          verificationSummary: "agent evidence",
          at: new Date().toISOString(),
          phase: "running",
          attemptId: "pending-verify-attempt",
        } as any,
      }),
    });
    __testOnlyLoadState(cwd);
    const before = ledgerTypes(cwd);
    await pi.command("goal", "verify", ctx);
    await tick();
    const notices = ctx.ui.notifies.map((entry) => entry.message).join("\n");
    assert.match(notices, /already awaiting its verdict/, "verify names the awaiting state");
    const goal = readState(cwd).goal as any;
    assert.equal(goal.status, "auditing", "verify does not move a pending audit");
    assert.equal(goal.pendingCompletion?.completionSummary, "agent claim under audit", "the healthy claim is not overwritten");
    assert.equal(goal.pendingCompletion?.attemptId, "pending-verify-attempt", "no fresh attempt is minted");
    const after = ledgerTypes(cwd);
    assert.ok(!after.includes("manual_audit_requested"), "no synthesized-claim seed is ledgered");
    assert.equal(after.filter((t) => t === "audit_started").length, before.filter((t) => t === "audit_started").length, "no auditor is relaunched");
  } finally {
    await pi.fire("session_shutdown", { reason: "test-end" }, ctx);
  }
});

test("/goal verify on an approved-but-unarchived claim settles it instead of re-auditing", async () => {
  const pi = new MockPi();
  activate(pi.api);
  const cwd = tmpCwd();
  const ctx = await boot(pi, cwd);
  try {
    // The archive-failed park (v0.38.99): the approval is DURABLE on the
    // claim and only the terminal archive is owed. status paused, phase
    // settling — exactly what /goal verify used to overwrite.
    const goal = seedGoal({
      status: "paused",
      objective: "approved work whose archive is owed — done when pinned",
      completionSummary: "Outcome: shipped. Changed: one file. Evidence: test. Tests: pass. Unresolved: none. Next: none.",
      auditHistory: [{
        at: new Date().toISOString(),
        approved: true,
        disapproved: false,
        model: "openai/gpt-test",
        revision: 0,
        regressionShieldPassed: true,
        durationMs: 1000,
        report: "<approved/>",
      }],
      pendingCompletion: {
        completionSummary: "Outcome: shipped. Changed: one file. Evidence: test. Tests: pass. Unresolved: none. Next: none.",
        verificationSummary: "evidence",
        at: new Date().toISOString(),
        phase: "settling",
        verdictAt: new Date().toISOString(),
        attemptId: "owed-archive-attempt",
      } as any,
      pauseKind: "blocked",
      pauseReason: "completion approved, but the terminal archive failed",
    } as any);
    seedState(cwd, { goal });
    __testOnlyLoadState(cwd);
    const goalId = (goal as { id: string }).id;
    const before = ledgerTypes(cwd);
    await pi.command("goal", "verify", ctx);
    await tick(200);
    const after = ledgerTypes(cwd);
    assert.ok(after.includes("audit_settlement_completed"), "verify finishes the owed settlement");
    assert.ok(fs.existsSync(archivedGoalPath(cwd, goalId)), "the approved work is archived, not re-audited");
    assert.equal(after.filter((t) => t === "audit_started").length, before.filter((t) => t === "audit_started").length, "no new auditor is launched over approved work");
    const requested = after.filter((t) => t === "manual_audit_requested").length - before.filter((t) => t === "manual_audit_requested").length;
    assert.equal(requested, 1, "the manual request is still recorded, flagged as a settlement");
  } finally {
    await pi.fire("session_shutdown", { reason: "test-end" }, ctx);
  }
});

test("a durable pending audit survives cold reload parked with its identity and no submission", async () => {
  const cwd = tmpCwd();
  // Durable state as the previous process left it: auditing claim running.
  seedState(cwd, {
    goal: seedGoal({
      status: "auditing",
      objective: "pending reload — done when pinned",
      pendingCompletion: {
        completionSummary: "durable claim under audit",
        verificationSummary: "durable evidence",
        at: new Date().toISOString(),
        phase: "running",
        attemptId: "reload-attempt",
      } as any,
    }),
  });
  const pi = new MockPi();
  activate(pi.api);
  const ctx = await boot(pi, cwd);
  try {
    await tick();
    const goal = readState(cwd).goal as any;
    assert.equal(goal.status, "paused", "cold reload parks the orphaned auditing state");
    assert.equal(goal.pendingCompletion?.phase, "recovery-pending", "the claim waits for explicit consent");
    assert.equal(goal.pendingCompletion?.completionSummary, "durable claim under audit", "the claim content survives");
    assert.equal(goal.pendingCompletion?.attemptId, "reload-attempt", "no fresh attempt is minted on reload");
    assert.ok(!ledgerTypes(cwd).includes("audit_started"), "no auditor is submitted on a cold load");
    const notices = ctx.ui.notifies.map((entry) => entry.message).join("\n");
    assert.match(notices, /stored claim is safe/, "the hold message names the recovery action");
  } finally {
    await pi.fire("session_shutdown", { reason: "test-end" }, ctx);
  }
});
