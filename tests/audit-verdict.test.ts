/**
 * Tests for v0.24.2 audit-hardening (Claude Code / Codex CLI lessons):
 * - parseAuditorVerdict: the <impossible> third verdict (goal-loop-auditor.ts)
 * - countTrailingDisapprovals: the disapproval cap input (goal-loop-core.ts)
 * Real modules, no copies (v0.23.7).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAuditorVerdict } from "../extensions/goal-loop-shield.ts";
import { countTrailingDisapprovals, type AuditVerdict } from "../extensions/goal-loop-core.ts";

const v = (partial: Partial<AuditVerdict>): AuditVerdict => ({
  at: "2026-07-23T00:00:00Z",
  approved: false,
  disapproved: false,
  model: "test/model",
  ...partial,
});

// ---- parseAuditorVerdict ----

test("parseAuditorVerdict: approved", () => {
  const r = parseAuditorVerdict("All evidence checks out.\n\n<approved/>");
  assert.deepEqual(r, { approved: true, disapproved: false, impossible: false, impossibleReason: undefined });
});

test("parseAuditorVerdict: disapproved", () => {
  const r = parseAuditorVerdict("Item 3 has no evidence.\n\n<disapproved/>");
  assert.equal(r.disapproved, true);
  assert.equal(r.impossible, false);
});

test("parseAuditorVerdict: impossible with reason", () => {
  const r = parseAuditorVerdict("The repo has no such API and never did.\n\n<impossible>target API does not exist in this codebase</impossible>");
  assert.equal(r.impossible, true);
  assert.equal(r.impossibleReason, "target API does not exist in this codebase");
  assert.equal(r.approved, false);
});

test("parseAuditorVerdict: verdict read from the LAST block that mentions a tag", () => {
  const out = "<disapproved/> mentioned early in reasoning\n\nMore analysis here.\n\nFinal answer:\n<approved/>";
  const r = parseAuditorVerdict(out);
  assert.equal(r.approved, true, "later verdict wins");
});

test("parseAuditorVerdict: impossible reason clipped to 300 chars", () => {
  const long = "x".repeat(400);
  const r = parseAuditorVerdict(`<impossible>${long}</impossible>`);
  assert.equal(r.impossibleReason!.length, 300);
});

// ---- countTrailingDisapprovals ----

test("countTrailingDisapprovals: empty and all-clean histories", () => {
  assert.equal(countTrailingDisapprovals([]), 0);
  assert.equal(countTrailingDisapprovals([v({ approved: true })]), 0);
});

test("countTrailingDisapprovals: counts only the trailing streak", () => {
  const h = [
    v({ disapproved: true }),
    v({ disapproved: true }),
    v({ error: "auditor stalled" }), // infra error breaks the streak
    v({ disapproved: true }),
  ];
  assert.equal(countTrailingDisapprovals(h), 1);
});

test("countTrailingDisapprovals: shield-blocked approval breaks the streak", () => {
  const h = [
    v({ disapproved: true }),
    v({ approved: true, regressionShieldPassed: false }), // shield-blocked: NOT a disapproval
    v({ disapproved: true }),
    v({ disapproved: true }),
  ];
  assert.equal(countTrailingDisapprovals(h), 2);
});

test("countTrailingDisapprovals: impossible is its own verdict, not a disapproval", () => {
  const h = [v({ disapproved: true }), v({ impossible: true })];
  assert.equal(countTrailingDisapprovals(h), 0);
});
