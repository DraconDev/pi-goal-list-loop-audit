import { test } from "node:test";
import assert from "node:assert/strict";
import { adoptRespecRequirements, beginRespecAudit, blockRespecRequirement, claimRespecTask, createRespecBuilder, planRespecIncrement, respecCoverage, settleRespecAudit } from "../extensions/respec-builder.js";

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
