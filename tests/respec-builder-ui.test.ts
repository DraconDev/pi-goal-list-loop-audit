import * as path from "node:path";
import { loadThemeFromPath } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { registerSummaryRenderer } from "../extensions/summary-renderer.js";
import { MockPi } from "./harness/mock-pi.js";
import { stripTerminalSequences, type Component } from "@earendil-works/pi-tui";
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


test("actual project summaries render semantic headings, bold and no italics in both themes", () => {
  const builder = pending();
  const complete = settleRespecAudit(builder, "attempt", { approved: true, disapproved: false, output: "Invalid credentials rejected", model: "independent/model", regressionShieldPassed: true });
  const content = respecCompletionSummary(complete, "archive.json");
  for (const appearance of ["dark", "light"]) {
    const theme = loadThemeFromPath(path.resolve(import.meta.dirname, `../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/${appearance}.json`), "truecolor");
    const pi = new MockPi(); registerSummaryRenderer(pi.api);
    const renderer = pi.messageRenderers.get("goal-event")!({ content, details: { terminalApprovalGoalId: "respec:project:1" } } as never, { outputPad: 1 } as never, theme) as Component;
    for (const width of [1, 20, 40, 80, 120]) {
      const lines = renderer.render(width), ansi = lines.join("\n");
      assert.ok(lines.every(line => visibleWidth(line) <= width));
      assert.doesNotMatch(ansi, /\x1b\[(?:\d+;)*3(?:;\d+)*m/);
      if (width >= 40) {
        assert.ok(ansi.includes(theme.bold(theme.fg("success", "Done"))));
        assert.match(stripTerminalSequences(ansi), /What Changed/);
      }
    }
  }
});


test("large project summaries stay within the shared receipt transport and disclose omissions", () => {
  const complete = settleRespecAudit(pending(), "attempt", { approved: true, disapproved: false, output: "proof", model: "independent/model", regressionShieldPassed: true });
  complete.requirements = Array.from({ length: 100 }, (_, i) => ({ ...complete.requirements[0]!, id: `r${i}`, text: "𐐀".repeat(3000), evidence: { ...complete.requirements[0]!.evidence!, attemptId: `audit${i}`, report: "𐐀".repeat(3000) } }));
  const summary = respecCompletionSummary(complete, "archive.json");
  const lines = summary.split("\n");
  assert.ok(lines.length <= 150);
  assert.ok(lines.every(line => [...line].length <= 2000));
  assert.match(summary, /60 more requirements/);
  assert.match(summary, /80 more audit reports/);
  assert.match(summary, /PASS: All 100/);
  assert.ok(lines.some(line => line.endsWith("…")));
  assert.ok(!summary.includes("\ufffd"));
});
