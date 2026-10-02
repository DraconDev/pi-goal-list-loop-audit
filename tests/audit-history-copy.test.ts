import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { appendAuditVerdict, type AuditVerdict } from "../extensions/goal-loop-core.js";

const HOOKS = fs.readFileSync("extensions/loops/goal-auditor-hooks.ts", "utf-8");
const TOOLS = fs.readFileSync("extensions/loops/goal-tools.ts", "utf-8");

function verdict(overrides: Partial<AuditVerdict> = {}): AuditVerdict {
  return { at: "2026-10-02T00:00:00Z", ...overrides } as AuditVerdict;
}

test("A9 premise: appendAuditVerdict mutates the passed history in place (array + entries)", () => {
  // This in-place contract is WHY the apply path must copy before append:
  // a failed updateGoal after an in-place push would leave phantom verdicts
  // in RAM. If this ever stops mutating in place, the A9 copy is dead code.
  const prior = verdict({ disapproved: true });
  const history: AuditVerdict[] = [prior];
  const out = appendAuditVerdict(history, verdict({ disapproved: true, at: "2026-10-02T00:01:00Z" }));
  assert.equal(out, history, "returns the SAME array (pushes in place)");
  assert.equal(history.length, 2);
  assert.equal(prior.superseded, true, "older live rounds are marked on the SAME entry objects");
  assert.ok(prior.supersededBy?.startsWith("disapproval:"));
});

test("A9 (pin): the apply path copies auditHistory before appendAuditVerdict can touch it", () => {
  assert.match(
    HOOKS,
    /const history = \(state\.goal\.auditHistory \?\? \[\]\)\.map\(\(v\) => \(\{\.\.\.v\}\)\);[^]*?appendAuditVerdict\(history, \{/,
    "per-entry copy precedes the mutating append",
  );
  assert.doesNotMatch(HOOKS, /appendAuditVerdict\(state\.goal\.auditHistory/, "the live array is never passed to the in-place push");
});
