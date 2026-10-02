// pi-goal-list-loop-audit — Remaining/Next problem+action pairing.
//
// Field 2026-10-02 (note.md): "Next and remaining is pretty much the same
// no?" — the card listed a problem under ### Remaining ("Unresolved: the fix
// is still not live ... activation needs a release cut") and the same fact
// again under ### Next ("Next: Cut a release ..."), burying what mattered.
// Pins: a Next action that resolves an Unresolved problem renders inline
// under that problem (`→ Next:`); ### Next keeps only standalone actions.
// Left out (decided scope, not a problem) never pairs. The archive machine
// layer keeps the verbatim recap — only the human projection pairs.

import { test } from "node:test";
import * as assert from "node:assert/strict";

import {
  buildRichTerminalParts,
  composeRichTerminalLines,
} from "../extensions/completion-summary.js";

const PROBLEM =
  "Unresolved: the fix is still not live — the installed binary is 0.112.42 built before this work, so activation needs a release cut.";
const RESOLVING_ACTION =
  "Next: Cut a release to activate the TTL, then confirm the first expiry pass in the journal.";
const STANDALONE_ACTION = "Next: Audit the remaining game fixtures for stale high scores.";

function parts(details: string[]) {
  return buildRichTerminalParts({
    chat: true,
    outcome: "TTL guard shipped",
    details,
    countsLine: "completion review: approved (1 review).",
  });
}

test("pairing: resolving action rides inline under its problem", () => {
  const p = parts([PROBLEM, RESOLVING_ACTION]);
  assert.equal(p.nextLines.length, 0, "paired action leaves ### Next");
  assert.match(p.remainingLines.join("\n"), /Unresolved/, "problem still renders");
  const arrow = p.remainingLines.find((line) => line.includes("→ Next:"));
  assert.ok(arrow, "resolving action renders as an inline → Next: line");
  assert.match(arrow!, /Cut a release/, "action prose kept verbatim");
});

test("pairing: standalone actions stay in ### Next", () => {
  const p = parts([PROBLEM, RESOLVING_ACTION, STANDALONE_ACTION]);
  assert.equal(p.nextLines.length, 1, "only the standalone action stays");
  assert.match(p.nextLines[0]!, /Audit the remaining game fixtures/);
  const card = composeRichTerminalLines(p).join("\n");
  assert.match(card, /### Remaining/, "Remaining section renders");
  assert.match(card, /### Next/, "Next section renders for the standalone action");
});

test("pairing: fully paired card omits an empty ### Next", () => {
  const card = composeRichTerminalLines(parts([PROBLEM, RESOLVING_ACTION])).join("\n");
  assert.match(card, /### Remaining/);
  assert.doesNotMatch(card, /### Next/, "no empty Next section");
});

test("pairing: unrelated problem and action do not pair", () => {
  const other = "Unresolved: guard clean --rust still lists protected candidates in its dry-run preview.";
  const p = parts([other, RESOLVING_ACTION]);
  assert.equal(p.nextLines.length, 1, "action stays standalone");
  assert.ok(!p.remainingLines.some((line) => line.includes("→")), "no arrow under the unrelated problem");
});

test("pairing: Left out never pairs, even on shared words", () => {
  const leftOut = "Left out: No release cut, so the fix is not live; activation happens at the next release.";
  const p = parts([leftOut, RESOLVING_ACTION]);
  assert.equal(p.nextLines.length, 1, "action stays in ### Next");
  assert.ok(!p.remainingLines.some((line) => line.includes("→")), "decided scope carries no resolving action");
});

test("pairing: several actions can resolve one problem", () => {
  const second = "Next: Cut a release candidate and smoke the expiry journal entry.";
  const p = parts([PROBLEM, RESOLVING_ACTION, second]);
  assert.equal(p.nextLines.length, 0, "both actions pair");
  const arrows = p.remainingLines.filter((line) => line.includes("→ Next:"));
  assert.equal(arrows.length, 2, "both actions render inline");
});
