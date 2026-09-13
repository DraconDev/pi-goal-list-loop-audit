// pi-goal-list-loop-audit — v0.38.41 (grilling standard)
//
// Field agreement 2026-09-09: batched questionnaires go odd when later
// questions depend on earlier answers, thin option descriptions strand
// the user with nothing to expand, and nobody is sure Esc-correct-reask
// is allowed. All three drafting prompts now carry the same three-part
// rule — roadmap-then-stages, rich options (consequence + preview, never
// padded), explicit Esc invitation. These pins fail if any prompt drops
// any part of it.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

const DRAFTING_PROMPTS = [
  "goal-loop-draft.md",
  "goal-loop-forever-draft.md",
  "goal-loop-plan.md",
];

function readPrompt(name: string): string {
  return fs.readFileSync(path.resolve("prompts", name), "utf-8");
}

for (const name of DRAFTING_PROMPTS) {
  test(`${name}: carries the roadmap-then-stages rule`, () => {
    const p = readPrompt(name).toLowerCase();
    assert.ok(p.includes("roadmap"), "the full roadmap is stated first");
    assert.ok(p.includes("stage"), "dependent questions are sequenced stage-by-stage");
  });

  test(`${name}: carries the rich-option standard`, () => {
    const p = readPrompt(name).toLowerCase();
    assert.ok(p.includes("concrete consequence"), "option descriptions state concrete consequences");
    assert.ok(p.includes("preview"), "previews ride wherever the end-state matters");
    assert.ok(p.includes("padded"), "padding to four options is banned");
  });

  test(`${name}: invites the Esc correction explicitly`, () => {
    const p = readPrompt(name);
    assert.ok(/\bEsc\b/.test(p), "the Esc key is named");
    assert.ok(/say\s+what's wrong/i.test(p), "the correction invitation is explicit");
  });
}

test("list drafting: pasted list-like seeds use supplied wording without an exactness choice", () => {
  const p = readPrompt("goal-loop-draft.md");
  assert.match(p, /multi-line,\s*\n?bulleted, numbered, or checklist-style seed/);
  assert.match(p, /propose the\s+\n?resulting items together through `items\[\]`/);
  assert.match(p, /Do not ask whether the user wants\s+the list exact or refined/);
  assert.match(p, /genuinely\s+\n?ambiguous individual item/);
});
