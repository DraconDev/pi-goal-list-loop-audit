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
import { CARD_SECTION, composeRichTerminalLines, buildRichTerminalParts, buildTerminalApprovalRender } from "../extensions/completion-summary.js";
import { seedGoal } from "./harness/mock-pi.js";

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
  const summary = lines.indexOf(CARD_SECTION.summary);
  const verification = lines.indexOf(CARD_SECTION.verification);
  const followUp = lines.indexOf(CARD_SECTION.followUp);
  // Report order (field 2026-11-11): the changes are the body, the gate table
  // reports what was checked, and the limitations close it.
  assert.ok(summary >= 0, "the change body has its own section");
  assert.ok(verification > summary, "verification follows the changes");
  assert.ok(followUp > verification, "follow-ups close the report after verification");
  const text = lines.join("\n");
  // The findings survive as outcome-first prose with their repo-relative
  // evidence inline — never as a numbered list of opaque fragments.
  assert.ok(text.includes("overlapping saves no longer discard confirmed revisions"), text);
  assert.ok(text.includes("Chrome and Firefox archives now contain matching version manifests"), text);
  assert.ok(text.includes("src/save.ts:42"), "the evidence pointer rides the finding");
  assert.ok(text.includes("The signed-in browser flow was not checked."), "the limitation is reported");
  // Machine bookkeeping stays out of the default human view.
  assert.doesNotMatch(text, /Quality Gate|wxt build|Tests:/);
});

test("verification status is derived from the gate notes on both surfaces", () => {
  const chat = render().chatLines.join("\n");
  // `747 passed, 0 failed` proves a pass; `PASS; archive created` is agent
  // wording with no counts, so it stays REPORTED-shaped and never borrows the
  // first row's status. The chat table prints PASS only where notes prove it.
  assert.match(chat, /\| Unit tests \| bun test tests\/ \| PASS: 747 passed, 0 failed \|/, chat);
  assert.match(chat, /\| Chrome build \| wxt build chrome \| PASS; archive created \|/, chat);
  const whole = buildRichTerminalParts({
    chat: false,
    outcome: "x",
    details: [],
    countsLine: "",
    gates: render().chatLines.length > 0 ? [
      { gate: "Unit tests", command: "bun test tests/", notes: "747 passed, 0 failed" },
      { gate: "Chrome build", notes: "PASS; archive created" },
    ] : [],
  }).tableLines.join("\n");
  // The archive keeps the wide inventory with mechanically derived statuses.
  assert.match(whole, /\| Unit tests \| bun test tests\/ \| — \| PASS \| 747 passed, 0 failed \|/, whole);
  assert.match(whole, /\| Chrome build \| — \| REPORTED \| PASS; archive created \|/, whole);
});

test("a behavioral limitation reads as a follow-up, never as a second action", () => {
  const lines = render(undefined, {
    leftOut: "the repository-level legacy asset checker was intentionally not changed",
  }).chatLines;
  const followUp = lines.indexOf(CARD_SECTION.followUp);
  const nextSteps = lines.indexOf(CARD_SECTION.nextSteps);
  assert.ok(followUp >= 0, "the deliberate non-do is visible as a follow-up");
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
  assert.match(last, /completion audit approved (1 review) · record: .pi-glla\/archive\/20260923-purpose\.md\./, last);
  assert.ok(!lines.some((line) => line.startsWith("• ")), `no legacy bullet trailer:\n${lines.join("\n")}`);
  assert.equal(lines.filter((line) => /completion audit approved/.test(line)).length, 1, "the verdict is stated once");
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
  assert.match(legacy, /^## Summary$/m, legacy);
  assert.match(legacy, /^## Follow-up items$/m, legacy);
  assert.match(legacy, /^## Next steps$/m, legacy);
  assert.doesNotMatch(legacy, /^### /m, "chat never leaks literal markdown heading prefixes");
});
