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
  for (const width of [40, 80, 120]) for (const [key, builder] of [["drafting", draft], ["building", building], ["auditing", auditing], ["replanning", replanning], ["blocked", blocked], ["complete", complete]] as const) {
    const state = { goal: null, list: [], loop: { builder, active: key !== "blocked" && key !== "complete", target: builder.vision, startedAt: new Date().toISOString(), iteration: 1, maxIterations: 0, plateauWindow: 5, stallCount: 0, bestValue: null, lastValue: null, history: [] } } as State;
    frames.push({ key, theme: appearance, width, height: 12, lines: [...buildWidgetLines(state, null, Date.now(), theme, width)!, "", buildStatusText(state, null, Date.now(), theme, undefined, width)!] });
  }
}
const out = path.resolve(import.meta.dirname, "../../audit/respec-builder-2026-10-04"); fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, "rendered-frames.json"), JSON.stringify(frames, null, 2) + "\n");
console.log(`Rendered ${frames.length} actual project frames.`);
