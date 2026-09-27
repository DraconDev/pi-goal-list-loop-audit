// pi-goal-list-loop-audit — v0.38.101
// tests/audit-no-progress-detection.test.ts
//
// The no-progress stop is the one mechanism that correctly overrides
// aggressiveMode: `MAX_REPEATED_AUDIT_NO_PROGRESS` parks the goal with a
// decision card even when keep-going is on. It is also the only stop that is
// STATE-based rather than round-count-based, so it is the durable answer to
// "the loop never terminates".
//
// It was dead code. `countTrailingRepeatedDisapprovals` compared the first
// 2 000 characters for EXACT equality, which requires an LLM to emit
// byte-identical reports three rounds running. A real auditor rephrases, so
// `repeatedNoProgress` was permanently 1 and the detector never fired.
//
// Field 2026-09-27: goals at 20x, 20x and 14x consecutive disapprovals, all
// reporting "(cap 10)" while running.
//
// These tests use the objections the field actually produced, so the fix is
// pinned against the paraphrases that broke it — not against a convenient
// synthetic pair.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  auditDisapprovalContainment,
  auditDisapprovalSimilarity,
  auditDisapprovalTokens,
  auditDisapprovalFingerprint,
  countTrailingRepeatedDisapprovals,
  MAX_REPEATED_AUDIT_NO_PROGRESS,
  type AuditVerdict,
} from "../extensions/goal-loop-core.ts";

/** Build a trailing disapproval history from reports, oldest first. */
function rounds(reports: string[]): AuditVerdict[] {
  return reports.map((report, i) => ({
    at: `2026-09-27T0${i}:00:00.000Z`,
    approved: false,
    disapproved: true,
    model: "test/model",
    report,
    revision: 3,
  }));
}

test("v0.38.101 the no-progress stop is DEAD in production — this pins the defect", () => {
  // countTrailingRepeatedDisapprovals is the only state-based stop and the only
  // one that correctly overrides aggressiveMode. It compares the first 2000
  // characters for EXACT equality, which requires an LLM to emit byte-identical
  // reports three rounds running.
  //
  // This is the field shape: the same stuckness, reworded every round. The
  // counter returns 1, never reaching MAX_REPEATED_AUDIT_NO_PROGRESS, so the
  // stop never fires. This is why goals run to 20x, 20x and 14x consecutive
  // disapprovals while reporting "(cap 10)".
  //
  // Pinned deliberately: when the real fix lands (compare the STRUCTURED
  // objection set, not token overlap), THIS test flips. That flip is the
  // signal the defect is closed.
  const history = rounds([
    "## Required fixes\n1. Resolve the strike-registration finding at its actual cause.",
    "## Required fixes\n1. The strike-registration finding must be resolved at its actual cause, not at the probe.",
    "## Required fixes\n1. Resolve the strike registration finding at its actual cause rather than at the probe level.",
  ]);
  assert.equal(
    countTrailingRepeatedDisapprovals(history),
    1,
    "exact-text comparison cannot see a reworded objection — this is the defect",
  );
});

test("v0.38.101 the obvious fix was measured and REJECTED — do not re-add it blind", () => {
  // A token-similarity replacement was built. On short free text the progress
  // case outscores the repetition case, so no threshold separates them. These
  // assertions exist so nobody re-introduces it without reading the numbers.
  const older = "## Required fixes\n1. Resolve the strike-registration finding at its actual cause.";
  const restated = "## Required fixes\n1. The strike-registration finding must be resolved at its actual cause, not at the probe.";
  const superset = `${older}\n2. Add the buildable-state test.`;
  const newFinding = "## Required fixes\n1. Document the process-group containment fence.";

  const repetition = auditDisapprovalSimilarity(restated, older);
  const progressSameFindingPlusOne = auditDisapprovalSimilarity(superset, older);
  const progressEntirelyNew = auditDisapprovalSimilarity(newFinding, older);

  assert.ok(repetition >= 0.7, `restated reads as repetition: ${repetition.toFixed(3)}`);
  assert.ok(
    progressSameFindingPlusOne >= repetition,
    "THE FINDING: 'same finding + one new' must NOT be required to score below " +
      `'same finding reworded' — it does not (${progressSameFindingPlusOne.toFixed(3)} ` +
      `vs ${repetition.toFixed(3)}), so the two cannot be separated by a threshold`,
  );
  assert.ok(progressEntirelyNew < 0.4, `a wholly new finding does separate: ${progressEntirelyNew.toFixed(3)}`);

  // The blind spot that forced the symmetric form: each containment direction
  // alone scores a one-sided change as perfect repetition.
  assert.equal(auditDisapprovalContainment(superset, older), 1, "a superset fully contains the older round");
  assert.equal(auditDisapprovalContainment(older, superset), 1, "a shrunk set is fully contained the other way");
});

test("v0.38.101 the tokenizer is a useful diagnostic even though it cannot decide", () => {
  // Identifier-shaped tokens and rework-banner words are dropped so a restated
  // objection is not masked by "Goal 20260927013024-3nxfx (round 4 of rework)".
  const bare = "## Required fixes\n1. Resolve the strike-registration finding at its actual cause.";
  const bannered = "Goal 20260927013024-3nxfx (round 4 of rework). " + bare;
  assert.deepEqual(
    [...auditDisapprovalTokens(bannered)].sort(),
    [...auditDisapprovalTokens(bare)].sort(),
    "a rework banner must not change the significant-token set",
  );
  assert.ok(!auditDisapprovalTokens("attempt 1ea97e7f on commit 1ea97e7f").has("1ea97e7f"));
});

test("v0.38.101 the exact-text fingerprint is unchanged", () => {
  // auditDisapprovalFingerprint is exported and pinned elsewhere; the rejected
  // experiment did not alter the comparison that is still in force.
  assert.equal(auditDisapprovalFingerprint("  Hello   World  "), "hello world");
  assert.equal(
    auditDisapprovalFingerprint("at 2026-09-27T01:02:03.000Z ok"),
    auditDisapprovalFingerprint("at 2026-09-28T09:09:09.000Z ok"),
  );
});
