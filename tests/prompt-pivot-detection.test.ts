// pi-goal-list-loop-audit — v0.25.0
// tests/prompt-pivot-detection.test.ts
//
// Eager-continuation contract items 26 + 28 (Section G): pivot detection in
// the continuation prompt, and the aggressiveMode full-audit directive.
//
// Item 28 as drafted asked for a live-LLM behavior assertion ("the agent
// spawns 3+ subagents") — not unit-testable in this repo (no LLM harness).
// The deterministic core is tested instead: objective classification and
// the conditional directive the orchestrator injects.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import { isFullAuditObjective } from "../extensions/goal-loop-core.ts";

const prompt = fs.readFileSync(
  path.resolve("prompts", "goal-loop-continuation.md"),
  "utf-8",
);

test("continuation prompt has the PIVOT DETECTION section (item 26)", () => {
  assert.match(prompt, /PIVOT DETECTION/);
  assert.match(prompt, /full audit/i);
  assert.match(prompt, /propose_task_list|task list/i);
  assert.match(prompt, /survey|systematically/i);
});

test("isFullAuditObjective classifies survey pivots (item 28)", () => {
  assert.equal(isFullAuditObjective("lets do a full audit on the project"), true);
  assert.equal(isFullAuditObjective("survey the project and mark a tasklist"), true);
  assert.equal(isFullAuditObjective("find all problems in the UI"), true);
  assert.equal(isFullAuditObjective("fix the saves-3 screen bug"), false);
  assert.equal(isFullAuditObjective("ship the menu-3 glyph fix"), false);
});

test("orchestrator injects the FULL-AUDIT directive conditionally (item 28)", () => {
  const src = fs.readFileSync(
    path.resolve("extensions", "goal-continuation.ts"),
    "utf-8",
  ); // decomposition step 5 (v0.34.113): continuationPrompt moved
  assert.match(src, /FULL-AUDIT MODE \(aggressiveMode \+ survey objective\)/);
  assert.match(src, /effSettings\.aggressiveMode && isFullAuditObjective\(goal\.objective\)/);
});

test("continuation prompt includes the latest auditor report verbatim", () => {
  const src = fs.readFileSync(path.resolve("extensions", "goal-continuation.ts"), "utf-8");
  // v0.38.21: the block argues the latest LIVE disapproval (round-scoped),
  // falling back to the last entry for impossible/shield/approval paths.
  assert.match(src, /LATEST AUDITOR \$\{label\} \(\$\{shownAudit\.at\}\)/);
  assert.match(src, /liveDisapproval\(historyForAudit\)/);
  assert.match(src, /shownAudit\.report/);
  assert.match(src, /full report/);
  assert.match(src, /REGRESSION SHIELD BLOCKED/);
  assert.match(src, /Settled rounds \(superseded, do not relitigate\)/);
});

test("stale-approval directive mirrors the numeric-revision gate, never legacy entries", () => {
  const src = fs.readFileSync(path.resolve("extensions", "goal-continuation.ts"), "utf-8");
  // the directive must fire only when the gate would reject: a NUMERIC
  // audited revision differing from the current one; legacy entries without
  // a revision field pass the gate unchanged and must not be called stale.
  assert.match(src, /typeof lastAudit\.revision === "number"/);
  assert.match(src, /lastAudit\.revision !== \(goal\.revision \?\? 0\)/);
  assert.doesNotMatch(src, /lastAudit\??\.revision \?\? 0/);
  // the gate's real escapes — a bare complete_goal retry is rejected.
  assert.match(src, /\/goal verify/);
  assert.match(src, /newObjective/);
});
