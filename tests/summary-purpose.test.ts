// Regression from the 2026-09-23 screenshots: the posted summary is a
// human account of what changed and what remains. Verification is a compact
// supporting tail, not the main body; raw counts, commands, statuses and
// reviewer choreography do not replace the change story.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import type { Goal } from "../extensions/goal-loop-core.js";
import { buildTerminalApprovalRender } from "../extensions/completion-summary.js";
import { seedGoal } from "./harness/mock-pi.js";

function render(summary?: string, overrides: Record<string, unknown> = {}) {
  const goal = seedGoal({
    id: "20260923-purpose",
    objective: "ship the release",
    completionSummary: summary,
    telemetry: { turns: 1, fileWrites: 0, bashCalls: 0 },
    auditHistory: [{ at: "2026-09-23T22:00:00.000Z", approved: true, disapproved: false, model: "m", report: "approved" }],
  }) as unknown as Goal;
  return buildTerminalApprovalRender({
    goal,
    status: "complete",
    stopReason: "auditor approved",
    archivePath: ".pi-glla/archive/20260923-purpose.md",
    approval: "— auditor m approved.",
    record: "— record: .pi-glla/archive/20260923-purpose.md",
    findingGroups: [
      { title: "Persistence", findings: ["Save ordering: overlapping saves no longer discard confirmed revisions (src/save.ts:42)."] },
      { title: "Release", findings: ["Packaging: the Chrome and Firefox archives now contain matching version manifests (scripts/pack.ts:80)."] },
    ],
    gateRows: [
      { gate: "Unit tests", command: "bun test tests/", scope: "all tests", notes: "747 passed, 0 failed" },
      { gate: "Chrome build", command: "wxt build chrome", scope: "production", notes: "PASS; archive created" },
    ],
    ...overrides,
  });
}

test("chat summary leads with durable change facts and relegates verification", () => {
  const lines = render().chatLines;
  const changes = lines.findIndex((line) => line === "### What Changed");
  const risks = lines.findIndex((line) => line === "### Remaining");
  const verification = lines.findIndex((line) => line === "### Verification");
  assert.ok(changes >= 0, "change account has its own primary section");
  assert.ok(risks > changes, "remaining risks follow changes");
  assert.ok(verification > risks, "verification is a compact supporting tail");
  assert.ok(lines.join("\n").includes("Save ordering"));
  assert.ok(lines.join("\n").includes("Packaging"));
});

test("chat verification is one aggregate tail, not a gate-by-gate test report", () => {
  const lines = render().chatLines;
  const start = lines.indexOf("### Verification");
  const end = lines.indexOf("• auditor approved (1 verdict).");
  const block = lines.slice(start, end).filter((line) => line && (line === "### Verification" || (!line.startsWith("###") && !line.startsWith("- "))));
  assert.deepEqual(block, ["### Verification", "1 passed, 1 reported."], "verification is a single aggregate sentence");
  assert.doesNotMatch(block.join("\n"), /Quality Gate|\| Unit tests \||\| Chrome build \|/);
  assert.doesNotMatch(block.join("\n"), /bun test|wxt build|747 passed/);
});

test("behavioral limitation belongs under Remaining, not a second technical Next", () => {
  const lines = render(undefined, {
    leftOut: "the repository-level legacy asset checker was intentionally not changed",
  }).chatLines;
  const remaining = lines.indexOf("### Remaining");
  const next = lines.indexOf("### Next");
  assert.ok(remaining >= 0, "non-do is visible as a remaining concern");
  assert.ok(remaining < next, "remaining concerns lead the optional next step");
  assert.ok(lines.slice(remaining, next).join("\n").includes("legacy asset checker"));
  assert.ok(!lines.some((line) => /Full Vitest suite/i.test(line)), "test inventory does not masquerade as a change area");
});
