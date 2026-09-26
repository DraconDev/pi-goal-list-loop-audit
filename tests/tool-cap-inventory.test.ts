// pi-goal-list-loop-audit — 2026-09-26 cap audit (darklord gateRows.7.notes
// refusal): no tool value may ever refuse a whole claim. Bounds live in
// handlers/sanitizers (clip, never refuse); schemas accept to the documented
// 10k-char guard. Short display labels (gate name 120, group title 120) clip
// at the trust boundary with a named justification instead of refusing.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";

import { sanitizeGateRows, sanitizeFindingGroups, buildDurableChoiceRecord } from "../extensions/goal-loop-core.js";

const TOOLS_SRC = fs.readFileSync("extensions/loops/goal-tools.ts", "utf-8");

function toolSchemaRegion(toolName: string): string {
  const start = TOOLS_SRC.indexOf(`name: "${toolName}"`);
  assert.ok(start >= 0, `${toolName} registered`);
  const paramsStart = TOOLS_SRC.indexOf("parameters: Type.Object({", start);
  // The parameters block ends at the matching close for execute's object;
  // bound the scan to a generous window past the parameters keyword.
  return TOOLS_SRC.slice(paramsStart, paramsStart + 12000);
}

test("cap inventory: no tool schema refuses past the documented guard", () => {
  // Every maxLength in the three user-facing claim/judgment/resume schemas
  // must meet the 10k guard. Smaller bounds would refuse whole claims at
  // the validation boundary before handlers can clip (darklord 2026-09-26).
  for (const tool of ["complete_goal", "record_goal_judgment", "resume_goal"]) {
    const region = toolSchemaRegion(tool);
    for (const m of region.matchAll(/maxLength:\s*(\d+)/g)) {
      assert.ok(Number(m[1]) >= 10000, `${tool}: maxLength ${m[1]} below the 10k guard`);
    }
  }
});

test("darklord replay: oversized gate notes are accepted and preserved", () => {
  // The refused shape: an 800-char gate notes value (past the old 400 cap).
  const notes = `bulk run green: ${"pass ".repeat(150)}fin.`;
  assert.ok(notes.length > 400, "fixture exceeds the old refusal bound");
  const rows = sanitizeGateRows([{ gate: "Unit Tests", notes }]);
  assert.equal(rows?.length, 1, "the row survives");
  assert.equal(rows?.[0]?.notes, notes.replace(/\s+/g, " ").trim(), "in-guard notes pass through untouched");
});

test("judgment and resume values clip at handlers instead of refusing", () => {
  const reason = `fix the card: ${"detail ".repeat(120)}done.`;
  assert.ok(reason.length > 500, "fixture exceeds the old refusal bound");
  const record = buildDurableChoiceRecord("inline", reason, undefined);
  assert.ok(record.reason.length <= 500, "ledger record stays bounded");
  assert.doesNotMatch(record.reason, /\s$/, "clause-aware cut, never a dangling break");
  assert.ok(!TOOLS_SRC.includes('(p.reason ?? "").slice(0, 200)'), "no mid-word ledger slice on resume reason");
  assert.ok(TOOLS_SRC.includes('clipSummaryValue(p.reason ?? "", 200)'), "resume ledger excerpt clips clause-aware");
});

test("cap audit gaps: judgment record and group titles clip clause-aware", () => {
  // 2026-09-26 auditor repair: buildDurableChoiceRecord and the group-title
  // sanitizer kept mid-word slices while every twin went clause-aware.
  const words = `fix the card: ${"word ".repeat(200)}done.`;
  const record = buildDurableChoiceRecord("inline", words, undefined);
  assert.ok(record.reason.length <= 500, "ledger record stays bounded");
  assert.ok(record.reason.endsWith("…"), "over-long reasons end at a clause cut, not mid-word");

  const longTitle = `Area with many words ${"word ".repeat(40)}end`;
  const groups = sanitizeFindingGroups([{ title: longTitle, findings: ["Lead: body"] }]);
  const title = groups?.[0]?.title ?? "";
  assert.ok(title.length <= 120, "display-label bound kept");
  assert.ok(title.endsWith("…"), "over-long titles end at a clause cut, not mid-word");
  assert.doesNotMatch(title, /word $/, "no dangling partial word");
});
