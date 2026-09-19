// pi-goal-list-loop-audit — completion-claim evidence-density lint.
//
// Antigravity port (survey 2026-09-19): a walkthrough always ships areas +
// counts + duration; GLLA richness rides optional agent params, so a flat
// six-label claim with zero path:line tokens and zero gate rows still
// passes. (The full-report pointer half is already satisfied in-tree: every
// terminal path ends with `— record: <archive path>`.) Pins:
//   1. A claim with evidence tokens passes the lint (no annotation).
//   2. Tokens inside finding groups count (shape parity counts as density).
//   3. Gate rows count as density even without path:line tokens.
//   4. Zero tokens AND zero gates → a NOTE annotation naming both remedies.

import { test } from "node:test";
import * as assert from "node:assert/strict";

import { completionSummaryDensityNote } from "../extensions/completion-summary.js";

const SIX_LABEL_FLAT = [
  "Outcome: wired the probe.",
  "Changed: the probe schedule.",
  "Evidence: manual testing looked good.",
  "Tests: the suite passed.",
  "Unresolved: none.",
  "Next: none.",
].join(" ");

test("density lint: evidence tokens in the summary pass", () => {
  const summary = `${SIX_LABEL_FLAT} See extensions/goal-recovery.ts:847 for the timer.`;
  assert.equal(completionSummaryDensityNote(summary), undefined);
});

test("density lint: tokens inside finding groups count", () => {
  assert.equal(
    completionSummaryDensityNote(SIX_LABEL_FLAT, [
      { title: "Probe", findings: ["Timer: moved to reset per extensions/goal-recovery.ts:847"] },
    ]),
    undefined,
  );
});

test("density lint: gate rows count as density without tokens", () => {
  assert.equal(
    completionSummaryDensityNote(SIX_LABEL_FLAT, undefined, [
      { gate: "Unit Tests", scope: "recovery", notes: "47 pass, 0 fail" },
    ]),
    undefined,
  );
});

test("density lint: zero tokens and zero gates is annotated", () => {
  const note = completionSummaryDensityNote(SIX_LABEL_FLAT);
  assert.ok(note, "a flat claim with no verifiable pointers is flagged");
  assert.match(note!, /path:line/i, "the annotation names evidence tokens");
  assert.match(note!, /gate/i, "the annotation names gate rows");
});
