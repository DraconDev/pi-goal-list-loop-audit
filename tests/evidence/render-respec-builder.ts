import { setRespecAuditLive, respecCompletionSummary } from "../../extensions/respec-builder-ui.js";
import { registerSummaryRenderer } from "../../extensions/summary-renderer.js";
import { MockPi } from "../harness/mock-pi.js";
import type { Component } from "@earendil-works/pi-tui";
import * as fs from "node:fs";
import * as path from "node:path";
import { loadThemeFromPath } from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { buildWidgetLines, buildStatusText } from "../../extensions/goal-loop-display.js";
import { createRespecBuilder, adoptRespecRequirements, planRespecIncrement, claimRespecTask, beginRespecAudit, settleRespecAudit, blockRespecRequirement } from "../../extensions/respec-builder.js";
import type { State } from "../../extensions/goal-loop-core.js";

const draft = createRespecBuilder("Build usable account login and data export");
const planning = adoptRespecRequirements(draft, [{ id: "login", text: "Usable account login", acceptance: "Valid credentials open the account; invalid credentials are rejected" }, { id: "export", text: "Data export", acceptance: "Export round-trips all fields" }]);
const building = planRespecIncrement(planning, [{ id: "auth", text: "Implement login behavior and exercise acceptance criteria", requirementIds: ["login"] }]);
const auditing = beginRespecAudit(claimRespecTask(building, "auth"), "audit-one", "Login implemented and exercised");
const replanning = settleRespecAudit(auditing, "audit-one", { approved: false, disapproved: true, output: "Invalid credentials are accepted; repair the credential check.", model: "auditor" });
const blocked = blockRespecRequirement(building, "login", "Identity service credentials are unavailable");
const allTasks = planRespecIncrement(planning, [{ id: "whole", text: "Build login and export", requirementIds: ["login", "export"] }]);
const complete = settleRespecAudit(beginRespecAudit(claimRespecTask(allTasks, "whole"), "audit-final", "Both capabilities implemented"), "audit-final", { approved: true, disapproved: false, regressionShieldPassed: true, output: "Login rejection and export round-trip independently exercised.", model: "auditor" });
const frames = [];
for (const appearance of ["dark", "light"]) {
  const theme = loadThemeFromPath(path.resolve(import.meta.dirname, `../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/${appearance}.json`), "truecolor");
  for (const width of [40, 80, 120]) for (const [key, builder] of [["drafting", draft], ["building", building], ["auditing", auditing], ["held-audit", auditing], ["running", auditing], ["retrying", auditing], ["replanning", replanning], ["blocked", blocked], ["complete", complete]] as const) {
    const state = { goal: null, list: [], loop: { builder, active: key !== "blocked" && key !== "complete" && key !== "held-audit", ...(key === "held-audit" ? { stopReason: "stalled: 5 continuation refires landed no turn" } : {}), target: builder.vision, startedAt: new Date().toISOString(), iteration: 1, maxIterations: 0, plateauWindow: 5, stallCount: 0, bestValue: null, lastValue: null, history: [] } } as State;
    if (key === "running" || key === "retrying") setRespecAuditLive(builder, { phase: key, model: "provider/auditor-model", startedAt: Date.now() - 65000, lastActivityAt: Date.now() - 17000, activity: key === "running" ? "tool: bash" : "retry: timeout", ...(key === "retrying" ? { retryAt: Date.now() + 5000 } : {}) });
    frames.push({ key, theme: appearance, width, height: 12, lines: [...buildWidgetLines(state, null, Date.now(), theme, width)!, "", buildStatusText(state, null, Date.now(), theme, undefined, width)!] });
    setRespecAuditLive(builder);
  }
  const pi = new MockPi(); registerSummaryRenderer(pi.api);
  const receipt = { content: respecCompletionSummary(complete, ".pi-glla/archive/respec-project.json"), details: { terminalApprovalGoalId: "respec:preview:1" } };
  const renderer = pi.messageRenderers.get("goal-event")!(receipt as never, { outputPad: 1 } as never, theme) as Component;
  for (const width of [40, 80, 120]) frames.push({ key: "summary", theme: appearance, width, height: 12, lines: renderer.render(width) });
}
const out = path.resolve(process.env.GLLA_UI_EVIDENCE_DIR ?? path.resolve(import.meta.dirname, "../../audit/respec-project-ui-2026-10-04")); fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, "rendered-frames.json"), JSON.stringify(frames, null, 2) + "\n");
console.log(`Rendered ${frames.length} actual project frames.`);
