// Post-test/verdict Lead contract: human surfaces show an outcome first and
// a concrete reason/evidence second, while legacy claims migrate on read.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildRichArchiveSection,
  buildRichTerminalParts,
  buildTerminalApprovalRender,
  composeRichTerminalLines,
} from "../extensions/completion-summary.js";
import { buildWidgetLines } from "../extensions/goal-loop-display.js";
import { normalizeFindingLead } from "../extensions/finding-lead.js";
import type { Goal } from "../extensions/goal-loop-core.js";
import { seedGoal } from "./harness/mock-pi.js";

const SUMMARY = [
  "Outcome: The browser-action popup is complete for users.",
  "Changed: popup renderer and onboarding flow.",
  "Evidence: native screenshot and source pointers.",
  "Tests: focused renderer tests passed.",
  "Unresolved: none",
  "Next: none",
].join("\n");

function goal(overrides: Partial<Goal> = {}): Goal {
  return seedGoal({
    id: "lead-contract",
    objective: "improve the browser popup",
    status: "complete",
    completionSummary: SUMMARY,
    createdAt: "2026-09-24T00:00:00.000Z",
    updatedAt: "2026-09-24T00:05:00.000Z",
    ...overrides,
  }) as unknown as Goal;
}

test("canonical and legacy Lead inputs render the same outcome/evidence", () => {
  const canonical = buildRichTerminalParts({
    outcome: "popup complete",
    details: [],
    countsLine: "",
    groups: [{ title: "Popup", findings: ["Users can complete a browser-action fill — src/popup.ts:120-184"] }],
  });
  const legacy = buildRichTerminalParts({
    outcome: "popup complete",
    details: [],
    countsLine: "",
    groups: [{ title: "Popup", findings: ["Lead: Users can complete a browser-action fill — src/popup.ts:120-184"] }],
  });
  assert.deepEqual(canonical.findingLines, legacy.findingLines);
  assert.equal(canonical.findingLines[1], "- **Users can complete a browser-action fill** — src/popup.ts:120-184");
  assert.doesNotMatch(canonical.findingLines.join("\n"), /Lead/);
});

test("legacy topical and semantic labels are not exposed as finding labels", () => {
  for (const input of [
    "Paragraph routing: Multi-sentence prose stays one list item (src/router.ts:42)",
    "Outcome: Users can complete a real fill (src/popup.ts:42)",
    "Fix: The popup now renders (src/popup.ts:42)",
  ]) {
    const parts = buildRichTerminalParts({
      outcome: "done",
      details: [],
      countsLine: "",
      groups: [{ title: "Area", findings: [input] }],
    });
    const line = parts.findingLines.find((l) => l.startsWith("- "));
    assert.ok(line, `rendered ${input}`);
    assert.doesNotMatch(line, /\*\*Lead\*\*|\*\*Paragraph routing\*\*|\*\*Outcome\*\*|\*\*Fix\*\*/);
    assert.match(line, /— .*src\//, `evidence retained for ${input}`);
  }
});

test("technical-only legacy claims stay out of default chat", () => {
  const parts = buildRichTerminalParts({
    chat: true,
    outcome: "done",
    details: [],
    countsLine: "",
    groups: [
      { title: "Proof", findings: ["Tests: 12 passed, 0 failed"] },
      { title: "Outcome", findings: ["Users can complete the form — src/popup.ts:42"] },
    ],
  });
  const text = composeRichTerminalLines(parts).join("\n");
  assert.doesNotMatch(text, /12 passed/);
  assert.doesNotMatch(text, /\*\*Tests\*\*/);
  assert.match(text, /Users can complete the form/);
});

test("archive table uses outcome/evidence columns and keeps proof", () => {
  const parts = buildRichTerminalParts({
    outcome: "done",
    details: [],
    countsLine: "",
    groups: [1, 2, 3, 4].map((n) => ({
      title: `Area ${n}`,
      findings: [`Users can complete action ${n} — src/area-${n}.ts:${n}`],
      tests: [`proof ${n}`],
    })),
  });
  assert.equal(parts.findingLines[0], "| Area | User-visible outcome | Evidence / reason |");
  assert.ok(parts.findingLines.some((l) => l.includes("src/area-1.ts:1")));
  assert.ok(parts.findingLines.some((l) => l.includes("Evidence: proof 1")));
  assert.doesNotMatch(parts.findingLines.join("\n"), /Lead|Finding \| Evidence/);
});

test("widget projects the normalized outcome without legacy Lead or technical labels", () => {
  const widget = buildWidgetLines({ goal: goal({ completionSummary: SUMMARY.replace("Outcome: The browser-action popup is complete for users.", "Outcome: Lead: The browser-action popup is complete for users.") }), list: [] }, null, Date.parse("2026-09-24T00:05:00.000Z"))!;
  assert.match(widget.join("\n"), /browser-action popup is complete/);
  assert.doesNotMatch(widget.join("\n"), /Lead:|Tests:|verdict/);
});

test("terminal and archive human sections share the What Changed contract", () => {
  const findingGroups = [{ title: "Popup", findings: ["Users can complete a browser-action fill — src/popup.ts:42"] }];
  const rendered = buildTerminalApprovalRender({
    goal: goal(),
    status: "complete",
    approval: "— completion audit approved.",
    record: "— record: .pi-glla/archive/lead-contract.md",
    findingGroups,
  });
  const chat = rendered.chatLines.join("\n");
  const archive = buildRichArchiveSection(goal(), "complete", ".pi-glla/archive/lead-contract.md", findingGroups).join("\n");
  assert.match(chat, /### What Changed/);
  assert.match(archive, /### What Changed/);
  assert.match(chat, /Users can complete a browser-action fill/);
  assert.match(archive, /Users can complete a browser-action fill/);
  assert.doesNotMatch(chat, /\*\*Lead\*\*|Lead:|Tests:|Test Results|auditor verdict|### Verification Summary/);
  assert.doesNotMatch(archive, /\*\*Lead\*\*|Lead:|Test Results|auditor verdict|### Verification Summary/);
});

test("normalization is raw-preserving and does not split path/version colons", () => {
  const parsed = normalizeFindingLead("Lead: Users can complete the form (src/popup.ts:42)");
  assert.equal(parsed.raw.startsWith("Lead:"), true);
  assert.equal(parsed.outcome, "Users can complete the form");
  assert.deepEqual(parsed.evidence, ["src/popup.ts:42"]);
  assert.equal(parsed.legacyLead, true);
  assert.equal(normalizeFindingLead("Gemini 3: users see the form (src/popup.ts:42)").outcome, "Gemini 3: users see the form");
  assert.deepEqual(normalizeFindingLead("Gemini 3: users see the form (src/popup.ts:42)").evidence, ["src/popup.ts:42"]);
});

test("normalization strips dash-separated label prefixes (Lead –/Tests –)", () => {
  // Field case 2026-09-24: the model wrote "- Lead – ..." and the dash
  // variant leaked into chat because only the colon form was recognized.
  const lead = normalizeFindingLead("Lead – The popup is complete (src/popup.ts:42)");
  assert.equal(lead.outcome, "The popup is complete");
  assert.equal(lead.legacyLead, true);
  assert.deepEqual(lead.evidence, ["src/popup.ts:42"]);
  const em = normalizeFindingLead("Lead — The popup is complete");
  assert.equal(em.outcome, "The popup is complete");
  assert.equal(em.legacyLead, true);
  const hyphen = normalizeFindingLead("Lead - The popup is complete");
  assert.equal(hyphen.outcome, "The popup is complete");
  const tests = normalizeFindingLead("Tests – 3 pass (src/popup.test.ts:1)");
  assert.equal(tests.outcome, "3 pass");
  assert.equal(tests.technical, true);
  const nested = normalizeFindingLead("Lead – Tests – 3 pass");
  assert.equal(nested.outcome, "3 pass");
  assert.equal(nested.technical, true);
  // Prose that merely starts with a label word is untouched: no separator,
  // no strip. Hyphenated words are not separators either.
  assert.equal(normalizeFindingLead("Lead with the summary (src/popup.ts:42)").outcome, "Lead with the summary");
  assert.equal(normalizeFindingLead("Lead-up to the fix is complete").outcome, "Lead-up to the fix is complete");
});

test("archive preserves technical group findings and Verdict details as evidence instead of dropping them", () => {
  const parts = buildRichTerminalParts({
    outcome: "done",
    details: ["Verdict: the auditor approved after a retry"],
    countsLine: "",
    groups: [
      { title: "Proof", findings: ["Tests: 12 passed, 0 failed"] },
      { title: "Review", findings: ["Audit: manual spot-check of the queue"] },
    ],
  });
  const text = composeRichTerminalLines(parts).join("\n");
  assert.match(text, /12 passed, 0 failed/, "group Tests finding preserved in the archive evidence");
  assert.match(text, /manual spot-check/, "group Audit finding preserved in the archive evidence");
  assert.match(text, /auditor approved after a retry/, "flat Verdict detail preserved in the archive evidence");
});

test("chat still suppresses technical findings after the archive-preservation fix", () => {
  const parts = buildRichTerminalParts({
    chat: true,
    outcome: "done",
    details: ["Verdict: the auditor approved after a retry"],
    countsLine: "",
    groups: [
      { title: "Proof", findings: ["Tests: 12 passed, 0 failed"] },
      { title: "Review", findings: ["Audit: manual spot-check of the queue"] },
    ],
  });
  const text = composeRichTerminalLines(parts).join("\n");
  assert.doesNotMatch(text, /12 passed/);
  assert.doesNotMatch(text, /manual spot-check/);
  assert.doesNotMatch(text, /auditor approved after a retry/);
});
