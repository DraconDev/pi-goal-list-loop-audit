import { test } from "node:test";
import assert from "node:assert/strict";
import type { Goal } from "../extensions/goal-loop-core.js";
function seedGoal(overrides: Partial<Goal> = {}): Goal {
  return { id: "goal-1", objective: "Implement the checked target", status: "active", policy: "goal",
    autoContinue: true, usage: { tokensUsed: 0, tokensLimit: 0 },
    createdAt: "2026-10-08T17:00:00.000Z", updatedAt: "2026-10-08T17:00:00.000Z", ...overrides };
}
import { backgroundDispatchHeld, backgroundWaitReady, goalWorkView, loopWorkView,
  sanitizeBackgroundWait, settleBackgroundDependency, type BackgroundWait } from "../extensions/work-lifecycle.js";
import type { LoopState } from "../extensions/goal-loop-forever.js";

const at = "2026-10-08T17:00:00.000Z";
function wait(): BackgroundWait {
  return { version: 1, id: "wait-1", targetId: "goal-1", sessionId: "session-1", createdAt: at,
    reason: "Design checkpoint", dependencies: [{ runId: "scout-1", outcome: "pending" }, { runId: "scout-2", outcome: "pending" }] };
}
const event = { targetId: "goal-1", sessionId: "session-1", runId: "scout-1", outcome: "completed" as const, at };

test("wait admission sanitization requires target, identity and bounded dependencies", () => {
  assert.deepEqual(sanitizeBackgroundWait(wait(), "goal-1"), wait());
  for (const value of [null, { ...wait(), version: 2 }, { ...wait(), targetId: "other" },
    { ...wait(), sessionId: "" }, { ...wait(), dependencies: [] },
    { ...wait(), dependencies: [wait().dependencies[0], wait().dependencies[0]] },
    { ...wait(), settledAt: at }]) assert.equal(sanitizeBackgroundWait(value, "goal-1"), undefined);
  assert.ok(sanitizeBackgroundWait({ ...wait(), legacy: true, dependencies: [] }, "goal-1"));
});

test("only exact owner and run can settle a dependency; multi-wait finishes once", () => {
  const original = wait();
  for (const changed of [{ targetId: "other" }, { sessionId: "old" }, { runId: "unrelated" }]) {
    assert.equal(settleBackgroundDependency(original, { ...event, ...changed }), undefined);
  }
  const first = settleBackgroundDependency(original, event)!;
  assert.equal(backgroundWaitReady(first), false);
  assert.equal(original.dependencies[0]?.outcome, "pending", "reducer does not mutate durable input");
  assert.equal(settleBackgroundDependency(first, event), undefined, "duplicate completion does nothing");
  const last = settleBackgroundDependency(first, { ...event, runId: "scout-2", outcome: "failed" })!;
  assert.equal(backgroundWaitReady(last), true, "failure requires parent assessment, not endless waiting");
  assert.equal(settleBackgroundDependency(last, event), undefined);
});

for (const policy of ["goal", "list"] as const) {
  test(`${policy}: waiting is not a pause, and explicit freeze outranks it`, () => {
    const goal = seedGoal({ status: "active", policy, backgroundWait: wait() });
    assert.deepEqual(goalWorkView(goal, {}), { lifecycle: "waiting", activity: "background", wait: goal.backgroundWait });
    assert.equal(goal.status, "active", "background work does not freeze legacy supervision status");
    assert.equal(goalWorkView(goal, { supervisorPausedAt: 1 }).lifecycle, "paused");
    assert.equal(goalWorkView(goal, { loadHoldAt: 1 }).lifecycle, "paused");
    assert.equal(goalWorkView({ ...goal, status: "paused", pauseKind: "blocked" }, {}).lifecycle, "paused");
    assert.equal(goalWorkView({ ...goal, status: "complete" }, {}).lifecycle, "complete");
    assert.equal(goalWorkView({ ...goal, status: "aborted" }, {}).lifecycle, "cancelled");
    assert.equal(backgroundDispatchHeld({ goal, loop: undefined }), true);
  });
}

test("legacy standby is an unowned wait, never evidence of running background work", () => {
  const goal = seedGoal({ status: "paused", pauseKind: "standby" });
  assert.deepEqual(goalWorkView(goal, {}), { lifecycle: "waiting", activity: "unknown" });
  assert.equal(goalWorkView(goal, { supervisorPausedAt: 1 }).lifecycle, "paused");
});

test("auditing and provider recovery are activities rather than manual pauses", () => {
  assert.deepEqual(goalWorkView(seedGoal({ status: "auditing" }), {}), { lifecycle: "running", activity: "auditing" });
  assert.deepEqual(goalWorkView(seedGoal({ status: "active" }), {}, "researching"), { lifecycle: "running", activity: "researching" });
});

test("metric/project loop waiting retains active supervision and explicit stop authority", () => {
  // The projection consumes only the loop control fields; no synthetic project
  // implementation or requirement verification is needed for this pure test.
  const loop = { active: true, backgroundWait: wait() } as LoopState;
  assert.equal(loopWorkView(loop, {}).lifecycle, "waiting");
  assert.equal(loopWorkView(loop, { supervisorPausedAt: 1 }).lifecycle, "paused");
  assert.equal(loopWorkView({ ...loop, active: false }, {}).lifecycle, "paused");
  assert.equal(backgroundDispatchHeld({ goal: null, loop }), true);
});
