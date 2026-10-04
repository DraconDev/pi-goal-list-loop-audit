import { test } from "node:test";
import assert from "node:assert/strict";
import { adoptRespecRequirements, beginRespecAudit, blockRespecRequirement, claimRespecTask, createRespecBuilder, planRespecIncrement, respecCoverage, settleRespecAudit } from "../extensions/respec-builder.js";
import { respecIncrementAuditGoal } from "../extensions/respec-builder-audit.js";
import { refineRespecRequirements, unblockRespecRequirement } from "../extensions/respec-builder.js";
import { buildGoalAuditorPrompt } from "../extensions/goal-loop-auditor.js";

function planned() {
  const state = adoptRespecRequirements(createRespecBuilder("Build the intended project"), [
    { id: "login", text: "Users can log in", acceptance: "Valid credentials open the account; invalid credentials are rejected." },
    { id: "export", text: "Users can export data", acceptance: "Exported data round-trips with all fields preserved." },
  ]);
  return planRespecIncrement(state, [{ id: "auth", text: "Implement and verify login", requirementIds: ["login"] }]);
}
const pass = { approved: true, disapproved: false, output: "Inspected and exercised login acceptance criteria.", model: "auditor", regressionShieldPassed: true };

test("task completion is only a claim; approving one batch leaves the project unfinished", () => {
  const state = planned();
  const claimed = claimRespecTask(state, "auth");
  assert.equal(claimed.requirements[0]!.status, "open");
  assert.equal(state.tasks[0]!.status, "pending", "copy transitions preserve the prior durable snapshot");
  const approved = settleRespecAudit(beginRespecAudit(claimed, "audit-1", "Implemented login"), "audit-1", pass);
  assert.equal(approved.phase, "replanning");
  assert.deepEqual(respecCoverage(approved), { verified: 1, remaining: 1, blocked: 0, total: 2 });
  assert.equal(approved.requirements[0]!.evidence!.attemptId, "audit-1");
  const next = planRespecIncrement(approved, [{ id: "export-task", text: "Build export", requirementIds: ["export"] }]);
  assert.equal(next.cycle, 2);
  const complete = settleRespecAudit(beginRespecAudit(claimRespecTask(next, "export-task"), "audit-2", "Export round-trip works"), "audit-2", pass);
  assert.equal(complete.phase, "complete");
  assert.equal(respecCoverage(complete).remaining, 0);
});

test("failed, contradictory and infrastructure verdicts cannot close requirements", () => {
  const auditing = beginRespecAudit(claimRespecTask(planned(), "auth"), "attempt", "Login implemented");
  for (const result of [{ ...pass, approved: false, disapproved: true, output: "Invalid credentials admitted." }, { ...pass, disapproved: true }, { ...pass, impossible: true }, { ...pass, regressionShieldPassed: false }]) {
    const failed = settleRespecAudit(auditing, "attempt", result);
    assert.equal(failed.phase, "replanning");
    assert.equal(respecCoverage(failed).verified, 0);
    assert.equal(failed.requirements.length, 2);
    assert.equal(failed.feedback.length, 1);
  }
  const unavailable = settleRespecAudit(auditing, "attempt", { ...pass, error: "Provider unavailable" });
  assert.equal(unavailable.phase, "auditing");
  assert.equal(unavailable.audit!.attemptId, "attempt");
  assert.equal(respecCoverage(unavailable).verified, 0);
});

test("stale worker results and incomplete batches cannot trigger settlement", () => {
  assert.throws(() => beginRespecAudit(planned(), "attempt", "All done"), /every task/);
  const auditing = beginRespecAudit(claimRespecTask(planned(), "auth"), "current", "Login works");
  assert.equal(settleRespecAudit(auditing, "old", pass), auditing);
  const revised = { ...auditing, revision: auditing.revision + 1 };
  assert.equal(settleRespecAudit(revised, "current", pass), revised);
});

test("blocked requirements stay unfinished and visible through planning and serialization", () => {
  const state = adoptRespecRequirements(createRespecBuilder("Build"), [{ id: "integration", text: "Integrate service", acceptance: "Service returns live data" }]);
  const blocked = blockRespecRequirement(state, "integration", "Service credentials missing");
  assert.deepEqual(respecCoverage(JSON.parse(JSON.stringify(blocked))), { verified: 0, remaining: 1, blocked: 1, total: 1 });
  assert.equal(blocked.requirements[0]!.blockedReason, "Service credentials missing");
  assert.throws(() => planRespecIncrement(blocked, [{ id: "task", text: "Pretend to integrate", requirementIds: ["integration"] }]), /open requirements/);
  assert.throws(() => adoptRespecRequirements(blocked, []), /expected drafting/);
});

test("draft adoption rejects empty criteria and ignores supplied agent verification status", () => {
  const draft = createRespecBuilder("Build");
  assert.throws(() => adoptRespecRequirements(draft, [{ id: "a", text: "Feature", acceptance: "" }]), /acceptance/);
  const adopted = adoptRespecRequirements(draft, [{ id: "a", text: "Feature", acceptance: "Observable behavior", status: "verified" } as never]);
  assert.equal(adopted.requirements[0]!.status, "open");
  assert.throws(() => planRespecIncrement(adopted, [{ id: "a", text: "Task", requirementIds: ["unknown"] }]), /open requirements/);
});

test("increment audits carry acceptance criteria and regressions into the production auditor prompt", () => {
  const approved = settleRespecAudit(beginRespecAudit(claimRespecTask(planned(), "auth"), "first", "Login works"), "first", pass);
  const next = planRespecIncrement(approved, [{ id: "export-task", text: "Build export", requirementIds: ["export"] }]);
  const auditing = beginRespecAudit(claimRespecTask(next, "export-task"), "second", "Export implemented");
  const goal = respecIncrementAuditGoal(auditing, "loop", new Date().toISOString());
  assert.match(goal.verificationContract!, /Exported data round-trips/);
  assert.match(goal.verificationContract!, /Regression — login/);
  assert.match(goal.verificationContract!, /invalid credentials are rejected/);
  const prompt = buildGoalAuditorPrompt(goal, auditing.audit!.claim, undefined);
  assert.match(prompt, /Exported data round-trips/);
  assert.match(prompt, /invalid credentials are rejected/);
  assert.equal(goal.pendingCompletion!.attemptId, "second");
  assert.throws(() => respecIncrementAuditGoal(planned(), "loop", "now"), /awaiting audit/);
});

test("scope refinement invalidates in-flight claims and records explicit removals", () => {
  const auditing = beginRespecAudit(claimRespecTask(planned(), "auth"), "old", "Implemented");
  const next = refineRespecRequirements(auditing, [{ id: "login", text: "Users can log in", acceptance: "Two-factor login works" }], "Operator chose login first, with two-factor authentication");
  assert.equal(next.phase, "replanning");
  assert.equal(next.revision, auditing.revision + 1);
  assert.equal(next.audit, undefined);
  assert.deepEqual(next.scopeChanges!.at(-1)!.removedIds, ["export"]);
  assert.equal(next.history!.at(-1)!.tasks[0]!.id, "auth");
  assert.equal(settleRespecAudit(next, "old", pass), next);
  assert.equal(next.requirements[0]!.status, "open");
});

test("blocking a batch retains its work and unblocking requires a concrete reason", () => {
  const blocked = blockRespecRequirement(planned(), "login", "Identity service unavailable");
  assert.equal(blocked.phase, "replanning");
  assert.equal(blocked.history!.at(-1)!.tasks[0]!.id, "auth");
  assert.equal(blocked.requirements.length, 2);
  assert.throws(() => unblockRespecRequirement(blocked, "login", ""), /evidence/);
  const opened = unblockRespecRequirement(blocked, "login", "Service health endpoint responds and credentials validated");
  assert.equal(opened.requirements[0]!.status, "open");
  assert.equal(opened.requirements[0]!.blockedReason, undefined);
  assert.equal(respecCoverage(opened).verified, 0);
});

test("a negative regression audit reopens earlier capabilities instead of displaying stale verification", () => {
  const first = settleRespecAudit(beginRespecAudit(claimRespecTask(planned(), "auth"), "first", "Login works"), "first", pass);
  const second = planRespecIncrement(first, [{ id: "export-task", text: "Build export", requirementIds: ["export"] }]);
  const audit = beginRespecAudit(claimRespecTask(second, "export-task"), "second", "Export implemented");
  const failed = settleRespecAudit(audit, "second", { ...pass, approved: false, disapproved: true, output: "Export changed credential handling; login now admits invalid credentials." });
  assert.equal(respecCoverage(failed).verified, 0);
  assert.equal(respecCoverage(failed).remaining, 2);
  assert.equal(failed.requirements[0]!.evidence, undefined);
  assert.equal(failed.history!.at(-1)!.outcome, "needs-work");
  assert.equal(first.requirements[0]!.status, "verified", "old durable proof remains in prior journal snapshots");
});
