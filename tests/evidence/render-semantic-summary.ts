import * as fs from "node:fs";
import * as path from "node:path";
import { loadThemeFromPath } from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { registerSummaryRenderer } from "../../extensions/summary-renderer.js";
import { buildTerminalApprovalRender } from "../../extensions/completion-summary.js";
import { MockPi, seedGoal } from "../harness/mock-pi.js";
import type { Goal } from "../../extensions/goal-loop-core.js";
import type { Component } from "@earendil-works/pi-tui";

const goal = seedGoal({ completionSummary: "Outcome: Background audits now clearly show their progress.\nChanged: Audit cards keep the state, elapsed time and latest activity visible.\nEvidence: Real dark and light previews at narrow and wide terminal sizes.\nTests: 190 passed, 0 failures.\nUnresolved: The rollout owner still needs confirmation.\nNext: Confirm the rollout owner; reload after the active audit finishes.", auditHistory: [{ at: "2026-10-03T18:25:00Z", approved: true, disapproved: false, model: "fixture" }] }) as unknown as Goal;
const frames = [];
for (const appearance of ["dark", "light"]) {
  const theme = loadThemeFromPath(path.resolve(import.meta.dirname, `../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/${appearance}.json`), "truecolor");
  const pi = new MockPi(); registerSummaryRenderer(pi.api);
  for (const width of [40, 80, 120]) {
    for (const [key, notes] of [["passed", "190 passed, 0 failures"], ["failed", "190 passed, 2 failed"], ["reported", "Verification reported"]]) {
      const content = buildTerminalApprovalRender({ goal, status: "complete", approval: "completion audit approved", record: "archive.md", showVerification: true,
        leftOut: "Live production changes were deliberately left to the owner.", gateRows: [{ gate: "UI regression", scope: "component renderings", notes }] }).chatLines.join("\n");
      const component = pi.messageRenderers.get("goal-event")!({ content, details: { terminalApprovalGoalId: goal.id } }, { outputPad: 1 }, theme) as Component;
      frames.push({ key, theme: appearance, width, height: 60, lines: component.render(width) });
    }
  }
}
const out = path.resolve(import.meta.dirname, "../../audit/semantic-summary-2026-10-03"); fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, "rendered-frames.json"), JSON.stringify(frames, null, 2) + "\n");
console.log(`Rendered ${frames.length} production summaries.`);
