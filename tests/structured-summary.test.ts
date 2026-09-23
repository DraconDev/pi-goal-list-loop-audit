// pi-goal-list-loop-audit — structured-long summaries (field 2026-09-16,
// the keyword-review close): a section-structured Outcome is a working
// document, not a status ping — it renders in full as the card's
// `### Summary` section. Structure (##/### headers) is the price of
// length; the headline echo, verification, one-action Next, recap, and
// every recycled payload keep their bounds.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import type { Goal } from "../extensions/goal-loop-core.js";
import {
  buildRichArchiveSection,
  buildRichTerminalParts,
  buildTerminalApprovalRender,
  countSectionHeaders,
  isSectionStructured,
  rawLabelValue,
  RICH_STRUCTURED_MIN_HEADERS,
  RICH_STRUCTURED_VALUE_BUDGET,
  structuredSummaryLines,
} from "../extensions/completion-summary.js";
import { seedGoal } from "./harness/mock-pi.js";

const STRUCTURED = [
  "Outcome: shipped the keyword review",
  "## Part 1: current keywords",
  "### 1. Triggers",
  "| Keyword | Effect |",
  "| --- | --- |",
  "| Focus | draw a card |",
  "## Part 2: rollout",
  "Slice 1 lands first.",
  "Changed: cards.ts",
  "Evidence: review doc plus gates",
  "Tests: bun test 10 pass, 0 fail",
  "Unresolved: none",
  "Next: implement slice 1",
].join("\n");

const PLAIN = [
  "Outcome: shipped the keyword review",
  "Changed: cards.ts",
  "Evidence: review doc plus gates",
  "Tests: bun test 10 pass, 0 fail",
  "Unresolved: none",
  "Next: implement slice 1",
].join("\n");

function structuredGoal(summary: string): Goal {
  return seedGoal({
    id: "20260916-structured",
    objective: "review the keyword system",
    completionSummary: summary,
    telemetry: { turns: 9, fileWrites: 4, bashCalls: 2 },
    auditHistory: [
      { at: "2026-09-16T00:00:00.000Z", approved: true, disapproved: false, model: "auditor-model", report: "fine" },
    ],
  }) as unknown as Goal;
}

function render(summary: string) {
  return buildTerminalApprovalRender({
    goal: structuredGoal(summary),
    status: "complete",
    stopReason: "auditor approved (detached)",
    archivePath: ".pi-glla/archive/20260916-structured.md",
    approval: "— auditor auditor-model approved.",
    record: "— record: .pi-glla/archive/20260916-structured.md",
  });
}

test("renderer removes empty evidence parentheses without losing the finding", () => {
  const parts = buildRichTerminalParts({
    outcome: "Collision handling corrected", details: [], countsLine: "",
    groups: [{ title: "Gameplay", findings: ["Fix: Updated collision handling (game.ts:120)."] }],
  });
  const text = parts.findingLines.join("\n");
  assert.match(text, /Updated collision handling/);
  assert.match(text, /game\.ts:120/);
  assert.doesNotMatch(text, /\(\s*\)/);
});

test("headline echo uses the Outcome lead paragraph, never flattened headers", () => {
  const { chatLines } = render(STRUCTURED);
  const headline = chatLines[0] ?? "";
  assert.ok(headline.startsWith("## Done — "), "headline leads with the outcome");
  assert.doesNotMatch(headline, /## Part|### /, `no flattened markdown in the headline, got: ${headline}`);
  assert.match(headline, /shipped the keyword review/, "the lead outcome text survives");
});

test("detector: two ##/### headers earn the structured path, one does not", () => {
  assert.equal(isSectionStructured("Outcome: plain text"), false, "no headers");
  assert.equal(isSectionStructured("Outcome: intro\n## Only part\nmore"), false, "single header stays clipped");
  assert.equal(isSectionStructured("Outcome: intro\n## A\n## B"), true, "two ## headers");
  assert.equal(isSectionStructured("Outcome: intro\n### A\n#### B"), true, "###/#### count");
  assert.equal(isSectionStructured("Outcome: intro\n# Title\n# Again"), false, "H1 titles do not count");
  assert.equal(isSectionStructured("Outcome: intro\n##\n## B"), false, "header needs text");
  assert.equal(RICH_STRUCTURED_MIN_HEADERS, 2, "threshold pinned");
});

test("extractor preserves newlines and tables, segments other labels", () => {
  const lines = structuredSummaryLines(STRUCTURED);
  assert.ok(lines, "structured Outcome yields lines");
  assert.ok(lines!.includes("## Part 1: current keywords"), "headers survive");
  assert.ok(lines!.includes("### 1. Triggers"), "sub-headers survive");
  assert.ok(lines!.includes("| Focus | draw a card |"), "table rows survive verbatim");
  assert.ok(!lines!.some((line) => /^Changed:/.test(line)), "Changed stays out of the Outcome body");
  assert.equal(structuredSummaryLines(PLAIN), null, "unstructured Outcome stays on the clipped path");
  assert.equal(structuredSummaryLines(undefined), null, "absent stays absent");
});

test("extractor: last line-anchored restatement wins", () => {
  const doubled = ["Outcome: first draft", "## A", "Outcome: final wording", "## B", "## C", "Changed: x"].join("\n");
  const value = rawLabelValue(doubled, "Outcome:");
  assert.ok(value?.startsWith("final wording"), `last restatement wins, got: ${JSON.stringify(value?.slice(0, 30))}`);
  assert.ok(value?.includes("## C"), "body runs to the next label");
});

test("card: structured Outcome renders a full ### Summary section, headline stays short", () => {
  const { chatLines } = render(STRUCTURED);
  assert.equal(chatLines[0], "## Done — shipped the keyword review", "outcome opens");
  const summaryIdx = chatLines.indexOf("### Summary");
  assert.ok(summaryIdx > 0, "Summary section present");
  const findingsIdx = chatLines.indexOf("### What Changed");
  const tableIdx = chatLines.indexOf("### Verification");
  const nextIdx = chatLines.indexOf("### Next");
  assert.ok(summaryIdx < findingsIdx && findingsIdx < tableIdx && tableIdx < nextIdx, "Summary rides the headline, change-first order preserved");
  const summaryBlock = chatLines.slice(summaryIdx + 1, findingsIdx - 1);
  assert.ok(summaryBlock.includes("| Focus | draw a card |"), "full table text in chat");
  assert.ok(summaryBlock.includes("Slice 1 lands first."), "full prose in chat");
  const headline = chatLines[0] ?? "";
  assert.ok(headline.startsWith("## Done — "), "headline leads with the outcome");
  assert.ok(headline.length < 300, `headline echo stays short, got ${headline.length} chars`);
});

test("card: unstructured summaries keep today's shape — no Summary section", () => {
  const { chatLines } = render(PLAIN);
  assert.ok(!chatLines.includes("### Summary"), "no Summary section without structure");
  assert.equal(chatLines[0], "## Done — shipped the keyword review", "outcome-first headline");
});

test("card: one-action Next survives the structured body", () => {
  const { chatLines } = render(STRUCTURED);
  const nextIdx = chatLines.indexOf("### Next");
  const nextBlock = chatLines.slice(nextIdx + 1).filter((line) => line.startsWith("- "));
  assert.equal(nextBlock.length, 1, `exactly one Next action, got: ${JSON.stringify(nextBlock)}`);
  assert.match(nextBlock[0] ?? "", /implement slice 1/, "the concrete action survives");
});

test("card: machine paths stay archive-only inside structured lines", () => {
  const withPaths = STRUCTURED.replace("Slice 1 lands first.", "Slice 1 lands first (log /tmp/glla-abc123.log).");
  const { chatLines } = render(withPaths);
  assert.ok(!chatLines.some((line) => line.includes("/tmp/glla-abc123.log")), "tmp path stripped from chat");
  assert.ok(chatLines.some((line) => line.includes("Slice 1 lands first")), "human text survives the strip");
});

test("guard: pathological structured values end with an honest pointer", () => {
  const big = ["Outcome: big doc", "## A", "## B", `body ${"x".repeat(RICH_STRUCTURED_VALUE_BUDGET + 20)}`, "Changed: x"].join("\n");
  const lines = structuredSummaryLines(big);
  assert.ok(lines, "guard still yields lines");
  const text = lines!.join("\n");
  assert.ok(text.length < RICH_STRUCTURED_VALUE_BUDGET + 200, `bounded, got ${text.length}`);
  assert.ok(text.endsWith("… (truncated for chat — full text in the archived record.)"), "honest truncation pointer");
});

test("doctrine: horizon lives in Summary, Next names only the immediate move", () => {
  const withRoadmap = STRUCTURED
    .replace("## Part 2: rollout\nSlice 1 lands first.", "## Part 2: rollout\nSlice 1 lands first.\n## Part 3: later slices\nSlices 2 and 3 follow after slice 1.");
  const { chatLines } = render(withRoadmap);
  const summaryIdx = chatLines.indexOf("### Summary");
  const findingsIdx = chatLines.indexOf("### What Changed");
  const summaryBlock = chatLines.slice(summaryIdx + 1, findingsIdx - 1);
  assert.ok(summaryBlock.some((line) => line.includes("Slices 2 and 3 follow")), "horizon stays visible in Summary");
  const nextIdx = chatLines.indexOf("### Next");
  const nextBlock = chatLines.slice(nextIdx + 1).filter((line) => line.startsWith("- "));
  assert.equal(nextBlock.length, 1, `one immediate move, got: ${JSON.stringify(nextBlock)}`);
  assert.match(nextBlock[0] ?? "", /implement slice 1/, "the immediate move leads");
});

test("archive human layer carries the same Summary section", () => {
  const section = buildRichArchiveSection(structuredGoal(STRUCTURED), "complete", ".pi-glla/archive/20260916-structured.md");
  assert.ok(section.includes("### Summary"), "archive parity");
  assert.ok(section.includes("| Focus | draw a card |"), "archive keeps full text");
  assert.ok(section.some((line) => line.startsWith("• record: ")), "record pointer still closes");
});
