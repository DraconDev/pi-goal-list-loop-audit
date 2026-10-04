import { test } from "node:test";
import assert from "node:assert/strict";
import { createRespecBuilder, adoptRespecRequirements, planRespecIncrement, claimRespecTask, beginRespecAudit, settleRespecAudit } from "../extensions/respec-builder.js";
import { getRespecAuditLive, setRespecAuditLive, respecAuditStatus, respecCompletionSummary } from "../extensions/respec-builder-ui.js";
import { buildWidgetLines } from "../extensions/goal-loop-display.js";
import type { State } from "../extensions/goal-loop-core.js";
import { visibleWidth } from "@earendil-works/pi-tui";

function pending() {
  const drafted = adoptRespecRequirements(createRespecBuilder("Build login"), [{ id: "login", text: "Usable login", acceptance: "Reject invalid credentials" }]);
  return beginRespecAudit(claimRespecTask(planRespecIncrement(drafted, [{ id: "auth", text: "Build login", requirementIds: ["login"] }]), "auth"), "attempt", "Login implemented");
}
test("live telemetry is claim-fenced and missing telemetry never implies a running worker", () => {
  const builder = pending();
  assert.match(respecAuditStatus(builder, 5000), /waiting for dispatch/);
  setRespecAuditLive(builder, { phase: "retrying", model: "provider/model", startedAt: 1000, lastActivityAt: 2000, retryAt: 7000, activity: "retry: timeout" });
  try {
    assert.match(respecAuditStatus(builder, 5000), /retrying.*provider\/model.*elapsed 4s.*last activity 3s ago.*retry in 2s/);
    assert.equal(getRespecAuditLive({ ...builder, audit: { ...builder.audit!, attemptId: "new-claim" } }), undefined);
    const state = { goal: null, list: [], loop: { builder, active: true, target: builder.vision, startedAt: "now", iteration: 1, maxIterations: 0, plateauWindow: 5, stallCount: 0, bestValue: null, lastValue: null, history: [] } } as State;
    for (const width of [1, 20, 40, 80, 120]) {
      const lines = buildWidgetLines(state, null, 5000, undefined, width)!;
      assert.ok(lines.every(line => visibleWidth(line) <= Math.max(0, width - 2)));
      if (width >= 80) { assert.match(lines.join("\n"), /auditor: retrying/); assert.match(lines.join("\n"), /last activity:/); }
    }
  } finally { setRespecAuditLive(builder); }
});
test("completion summary requires proof and includes acceptance, shipped capability and evidence", () => {
  const builder = pending();
  assert.throws(() => respecCompletionSummary(builder, "archive.json"));
  const complete = settleRespecAudit(builder, "attempt", { approved: true, disapproved: false, output: "Invalid credentials rejected", model: "independent/model", regressionShieldPassed: true });
  const text = respecCompletionSummary(complete, "archive.json");
  for (const phrase of ["What Changed", "Usable login", "Reject invalid credentials", "independent/model", "Invalid credentials rejected", "No unfinished adopted requirements", "Archive"]) assert.ok(text.includes(phrase));
  assert.doesNotMatch(text, /\x1b/);
});
