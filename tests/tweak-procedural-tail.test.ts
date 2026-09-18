// pi-goal-list-loop-audit
// tests/tweak-procedural-tail.test.ts
//
// Now 184316: `/goal tweak "<real objective>. Ensure both objective and
// verification contract are updated, then /goal resume."` stored the whole
// literal string — filing instructions and all — as the objective the loop
// then works against. The tweak must file what was SAID (the work) and drop
// the trailing procedural tail (instructions about the filing itself plus
// embedded slash-commands), the same way chatter already resolves against
// conversation instead of landing verbatim.

import { test } from "node:test";
import * as assert from "node:assert/strict";

import { stripTweakProceduralTail } from "../extensions/goal-loop-core.ts";

const FIELD_TEXT = "Produce 1000 new finished books using MiniMax-M3 primary and Agnes fallback, cap 1500, concurrency 48 and poll 15s. Require approved author kits/covers plus structural and hash-bound editorial checks. Park drafts for user go-live; verify 1000 distinct new reader-accessible books after user release. Preserve failure logs and demonstrate subsequent successful retries. Replace obsolete Hetzner and auto-publication verification clauses; establish the authoritative shelf artifact and baseline. Ensure both objective and verification contract are updated, then /goal resume.";

test("184316: trailing filing instruction with embedded command is stripped", () => {
  const stripped = stripTweakProceduralTail(FIELD_TEXT);
  assert.ok(!stripped.includes("/goal resume"), "embedded resume command must not land in the objective");
  assert.ok(!stripped.toLowerCase().includes("verification contract are updated"), "filing meta-instruction must not land in the objective");
  assert.ok(stripped.includes("Produce 1000 new finished books"), "the said work is kept");
  assert.ok(stripped.includes("authoritative shelf artifact"), "the last real sentence is kept");
});

test("single-sentence input passes through untouched", () => {
  assert.equal(stripTweakProceduralTail("Add a /goal tweak guard for empty input."), "Add a /goal tweak guard for empty input.");
  assert.equal(stripTweakProceduralTail("Fix the typo."), "Fix the typo.");
});

test("non-instructional trailing mention of a command is kept", () => {
  const text = "Build the dashboard. The handler is /goal resume.";
  assert.equal(stripTweakProceduralTail(text), text);
});

test("trailing 'then resume' instruction without filing nouns is stripped", () => {
  assert.equal(
    stripTweakProceduralTail("Rebuild the index shards. Then /goal resume to continue."),
    "Rebuild the index shards.",
  );
});

test("plain multi-sentence objective with no tail is unchanged", () => {
  const text = "Ship the shelf artifact. Verify 1000 distinct books after release. Preserve the failure logs.";
  assert.equal(stripTweakProceduralTail(text), text);
});
