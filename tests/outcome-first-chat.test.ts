import { test } from "node:test";
import * as assert from "node:assert/strict";
import { buildTerminalApprovalRender, buildRichArchiveSection } from "../extensions/completion-summary.js";
import type { Goal } from "../extensions/goal-loop-core.js";

export const fixtureGoal = {
  id: "20260917000000-fixture", objective: "Improve the drafting-to-completion experience",
  status: "complete", createdAt: "2026-09-17T00:00:00Z",
  completionSummary: "Outcome: Drafting now hands off clearly and completion reports explain the result.\nChanged: Phased questions and readable reports.\nEvidence: Renderer fixtures.\nTests: 12 passed, 0 failed, 1 skipped.\nUnresolved: Live provider not exercised.\nNext: none.",
  auditHistory: [{ approved: true, model: "fixture/model" }],
} as unknown as Goal;
export const fixtureGroups = ["Drafting", "Handoffs", "Status", "Summaries"].map(title => ({
  title, findings: [`Improved: ${title} now explains the next action (src/example.ts:42).`],
}));
export const fixtureGates = [
  { gate: "Unit tests", command: "bun test tests/", scope: "Renderer", notes: "12 passed, 0 failed, 1 skipped" },
  { gate: "Live provider", command: "node scripts/live.mjs", notes: "Not run — provider unavailable" },
];
export function fixtureRender() {
  return buildTerminalApprovalRender({ goal: fixtureGoal, status: "complete", approval: "— auditor fixture/model approved.", record: "— record: .pi-glla/archive/fixture.md", findingGroups: fixtureGroups, gateRows: fixtureGates, repoState: ["Branch main @ abc12345", "Tree clean"] });
}

test("four-area chat is outcome-first and grouped; archive retains detailed evidence", () => {
  const chat = fixtureRender().chatLines.join("\n");
  assert.match(chat.split("\n")[0]!, /Drafting now hands off/);
  assert.match(chat, /#### 1\. Drafting/);
  assert.doesNotMatch(chat, /\| Area \| Finding|\| Command \||bun test tests\/|node scripts\/live|abc12345|Final Repository State|src\/example\.ts:42/);
  assert.match(chat, /12 passed, 0 failed, 1 skipped/);
  assert.match(chat, /Not run — provider unavailable/);
  assert.match(chat, /Live provider not exercised/);
  assert.equal((chat.match(/auditor approved/g) ?? []).length, 1);
  const archive = buildRichArchiveSection(fixtureGoal, "complete", ".pi-glla/archive/fixture.md", fixtureGroups, fixtureGates).join("\n");
  assert.match(archive, /bun test tests\//);
  assert.match(archive, /src\/example\.ts:42/);
});
