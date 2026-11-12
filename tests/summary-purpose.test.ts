// Regression from the 2026-09-23 screenshots: the posted summary is a
// human account of what changed and what remains.
//
// Field 2026-11-11 ("i am not loving the goal completion summary, that should
// be more like how opencode does the summary upon task completion") replaced
// the section-per-contract shape with ONE report: headline, prose lede, a
// `Summary` carrying per-area `What changed · <area>` subsections, an
// always-on `Verification` gate table, `Follow-up items`, `Next steps`, and a
// single closing receipt line. The protections this file existed for are
// unchanged and are re-asserted in the new vocabulary: changes stay
// outcome-first (no machine receipts in chat), verification status is derived
// from the notes rather than claimed, a limitation reads as a follow-up rather
// than a second action, and the archive keeps the full evidence.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import type { Goal } from "../extensions/goal-loop-core.js";
import { CARD_SECTION, buildRichTerminalParts, buildTerminalApprovalRender, composeRichTerminalLines } from "../extensions/completion-summary.js";
import { seedGoal } from "./harness/mock-pi.js";

/** Section heading line, chat renders depth 2 and archive depth 3. */
function sectionLine(name: string, depth = 2): string {
  return `${"#".repeat(depth)} ${name}`;
}

function render(summary?: string, overrides: Record<string, unknown> = {}) {
  const goal = seedGoal({
    id: "20260923-purpose",
    objective: "ship the release",
    completionSummary: summary ?? "Outcome: Saves and release packages are consistent. Changed: Confirmed saves retain their revisions. Evidence: saved report. Tests: 747 passed, 0 failed. Unresolved: The signed-in browser flow was not checked. Next: Try the signed-in browser flow.",
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

test("chat report carries the changes, then verification, then the follow-ups, in one voice", () => {
  const lines = render().chatLines;
  const summary = lines.indexOf(sectionLine(CARD_SECTION.summary));
  const verification = lines.indexOf(sectionLine(CARD_SECTION.verification));
  const followUp = lines.indexOf(sectionLine(CARD_SECTION.followUp));
  assert.ok(summary >= 0, `the change body has its own section:\n${lines.join("\n")}`);
  assert.ok(verification > summary, "verification follows the changes");
  assert.ok(followUp > verification, "follow-ups close the report after verification");
  const text = lines.join("\n");
  assert.ok(text.includes("overlapping saves no longer discard confirmed revisions"), text);
  assert.ok(text.includes("Chrome and Firefox archives now contain matching version manifests"), text);
  assert.ok(text.includes("src/save.ts:42"), "the evidence pointer rides the finding");
  assert.ok(text.includes("The signed-in browser flow was not checked."), "the limitation is reported");
  assert.doesNotMatch(text, /Quality Gate|wxt build|Tests:/);
});

test("verification status is derived from the gate notes on both surfaces", () => {
  const chatLines = render().chatLines;
  // `747 passed, 0 failed` proves a pass; `PASS; archive created` is agent
  // wording with no counts, so the chat row keeps the honest raw result instead
  // of borrowing a PASS label.
  assert.ok(
    chatLines.includes("| Unit tests | bun test tests/ | PASS: 747 passed, 0 failed |"),
    chatLines.join("\n"),
  );
  assert.ok(
    chatLines.includes("| Chrome build | wxt build chrome | PASS; archive created |"),
    "unproven status never upgrades to PASS",
  );
  const archiveTable = buildRichTerminalParts({
    chat: false,
    outcome: "x",
    details: [],
    countsLine: "",
    gates: [
      { gate: "Unit tests", command: "bun test tests/", notes: "747 passed, 0 failed" },
      { gate: "Chrome build", notes: "PASS; archive created" },
    ],
  }).tableLines;
  assert.ok(
    archiveTable.includes("| Unit tests | bun test tests/ | — | PASS | 747 passed, 0 failed |"),
    archiveTable.join("\n"),
  );
  assert.ok(
    archiveTable.includes("| Chrome build | — | REPORTED | PASS; archive created |"),
    "REPORTED is derived, never claimed",
  );
});

test("a behavioral limitation reads as a follow-up, never as a second action", () => {
  const lines = render(undefined, {
    leftOut: "the repository-level legacy asset checker was intentionally not changed",
  }).chatLines;
  const followUp = lines.indexOf(sectionLine(CARD_SECTION.followUp));
  const nextSteps = lines.indexOf(sectionLine(CARD_SECTION.nextSteps));
  assert.ok(followUp >= 0, `the deliberate non-do is visible as a follow-up:\n${lines.join("\n")}`);
  assert.ok(nextSteps < 0 || followUp < nextSteps, "follow-ups lead any standalone next step");
  assert.ok(
    lines.slice(followUp, nextSteps < 0 ? undefined : nextSteps).join("\n").includes("legacy asset checker"),
    "the non-do stays in the follow-up section, complete",
  );
  assert.ok(!lines.some((line) => /Full Vitest suite/i.test(line)), "a test inventory never masquerades as a change");
});

test("the report closes with one compact receipt line, not a stack of bullets", () => {
  const lines = render().chatLines;
  const last = lines[lines.length - 1] ?? "";
  assert.ok(
    last.startsWith("completion audit approved (1 review)") && last.includes("record: .pi-glla/archive/20260923-purpose.md"),
    `the receipt closes the report, got: ${last}`,
  );
  assert.ok(!lines.some((line) => line.startsWith("\u2022 ")), `no legacy bullet trailer:\n${lines.join("\n")}`);
  assert.equal(lines.filter((line) => line.includes("completion audit approved")).length, 1, "the verdict is stated once");
});

test("legacy section names still compose a report instead of leaking as prose", () => {
  // A receipt queued by an older build keeps its own vocabulary; the composer
  // must still section it rather than treating the names as body text.
  const legacy = composeRichTerminalLines(buildRichTerminalParts({
    chat: true,
    outcome: "legacy receipt",
    countsLine: "",
    details: ["Unresolved: still open.", "Next: do the thing."],
    groups: [{ title: "Area", findings: ["Change: something happened (src/x.ts:1)"] }],
  })).join("\n");
  assert.ok(legacy.includes(sectionLine(CARD_SECTION.summary)), legacy);
  assert.ok(legacy.includes(sectionLine(CARD_SECTION.followUp)));
  assert.ok(legacy.includes(sectionLine(CARD_SECTION.nextSteps)));
  assert.doesNotMatch(legacy, /### /, "chat never leaks literal markdown heading prefixes");
});
