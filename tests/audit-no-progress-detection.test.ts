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
  auditDisapprovalFingerprint,
  countTrailingRepeatedDisapprovals,
  AUDIT_NO_PROGRESS_CONTAINMENT,
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

test("v0.38.101 a reworded but identical objection counts as repetition", () => {
  // The same stuckness across three rounds, phrased differently each time.
  // Before the fix this returned 1 (dead detector). The stop at
  // MAX_REPEATED_AUDIT_NO_PROGRESS is what actually halts a stuck goal.
  const history = rounds([
    "## Required fixes\n1. The index is not in a known buildable state; the loadout files are stale.",
    "## Required fixes\n1. The index is not in a known, buildable state — the two loadout files remain stale.",
    "## Required fixes\n1. The index is not in a known buildable state; the loadout files are still stale.",
  ]);
  const repeated = countTrailingRepeatedDisapprovals(history);
  assert.ok(
    repeated >= MAX_REPEATED_AUDIT_NO_PROGRESS,
    `reworded repetition must reach the stop threshold, got ${repeated}`,
  );
});

test("v0.38.101 a restated field objection is detected across three rounds", () => {
  // Real report shape from the loops observed on 2026-09-27. Each round
  // rephrases the same gap, so the counter climbs and the stop fires.
  const history = rounds([
    "## Required fixes\n1. Resolve the strike-registration finding at its actual cause.",
    "## Required fixes\n1. The strike-registration finding must be resolved at its actual cause, not at the probe.",
    "## Required fixes\n1. Resolve the strike registration finding at its actual cause rather than at the probe level.",
  ]);
  assert.ok(
    countTrailingRepeatedDisapprovals(history) >= MAX_REPEATED_AUDIT_NO_PROGRESS,
    "a restated objection must reach the stop threshold",
  );
});

test("v0.38.101 a round that ADDS a real observation is treated as progress", () => {
  // The football case: the same L31-L117 gap persists, but the round also
  // surfaces a new observation ("the seven documented non-passes"). That is
  // new material, so this is progress and the run breaks. Documenting the
  // bias deliberately: a false stop on a moving goal is worse than a late
  // stop on a stuck one, because the stop asks a human.
  const history = rounds([
    "## Required fixes\n1. Close L31, L32, L33 and L117 with real two-sided anchored index rows, and delete the 'no anchor exists' rows.",
    "## Required fixes\n1. The seven documented non-passes were avoidable; close L31, L32, L33 and L117 with real anchored index rows instead of documenting them.",
    "## Required fixes\n1. Seven documented non-passes remain avoidable. Close L31, L32, L33 and L117 with genuine two-sided anchored index rows.",
  ]);
  assert.equal(
    countTrailingRepeatedDisapprovals(history),
    1,
    "new material in a round is progress, not a stuck loop",
  );
});

test("v0.38.101 a superset round (old finding + one new) is progress, not repetition", () => {
  // The newer report CONTAINS the older one entirely, so an older-denominated
  // similarity measure scores it 1.00 and would halt a moving goal. This is
  // the case that fixes the denominator.
  const older = "## Required fixes\n1. Guard the stale resume path in the dispatcher.";
  const newer = "## Required fixes\n1. Guard the stale resume path in the dispatcher.\n2. Add the buildable-state test.";
  const score = auditDisapprovalSimilarity(newer, older);
  assert.ok(score < AUDIT_NO_PROGRESS_CONTAINMENT, `a superset must read as progress, got ${score.toFixed(3)}`);
  assert.equal(countTrailingRepeatedDisapprovals(rounds([older, newer])), 1);
});

test("v0.38.101 a shrinking objection set is progress in BOTH directions", () => {
  // The other blind spot: three findings closed down to one. The newer report
  // is fully contained in the older, so a newer-denominated measure alone would
  // score 1.00 and halt a converging goal.
  const older = "## Required fixes\n1. Anchor the index rows.\n2. Delete the stale loadout files.\n3. Add a buildable-state test.";
  const newer = "## Required fixes\n1. Add a buildable-state test.";
  assert.ok(
    auditDisapprovalSimilarity(newer, older) < AUDIT_NO_PROGRESS_CONTAINMENT,
    "a shrunk set must read as progress",
  );
  assert.equal(countTrailingRepeatedDisapprovals(rounds([older, newer])), 1);
});

test("v0.38.101 the threshold sits in a measured gap, not on a cliff", () => {
  // Pin the separation the threshold was chosen from, so a later tweak to the
  // tokenizer or stopwords cannot quietly move the decision boundary onto a
  // progress case.
  const older = "## Required fixes\n1. Resolve the strike-registration finding at its actual cause.";
  const restated = "## Required fixes\n1. The strike-registration finding must be resolved at its actual cause, not at the probe.";
  const superset = `${older}\n2. Add the buildable-state test.`;
  const repetition = auditDisapprovalSimilarity(restated, older);
  const progress = Math.max(
    auditDisapprovalSimilarity(superset, older),
    auditDisapprovalSimilarity("## Required fixes\n1. Document the process-group containment fence.", older),
  );
  assert.ok(repetition >= AUDIT_NO_PROGRESS_CONTAINMENT, `restated must be repetition: ${repetition}`);
  assert.ok(progress < AUDIT_NO_PROGRESS_CONTAINMENT, `progress must not be repetition: ${progress}`);
  assert.ok(repetition - progress > 0.1, `the gap must have margin, got ${(repetition - progress).toFixed(3)}`);
});

test("v0.38.101 genuine progress is never mistaken for a stuck loop", () => {
  // Each round surfaces materially NEW findings. This goal IS converging, so
  // the detector must stay silent and let aggressiveMode keep going.
  const history = rounds([
    "## Required fixes\n1. Guard the stale resume path in the continuation dispatcher.",
    "## Required fixes\n1. Add a regression test for the compaction latch failure mode.",
    "## Required fixes\n1. Document the process-group containment fence in the audit doc.",
  ]);
  assert.equal(
    countTrailingRepeatedDisapprovals(history),
    1,
    "distinct new material each round is progress, not repetition",
  );
});

test("v0.38.101 a shrinking objection set is progress", () => {
  // The agent closed two of three findings; the remaining one is a subset of
  // what was already known. That is a converging goal.
  const history = rounds([
    "## Required fixes\n1. Anchor the index rows.\n2. Delete the stale loadout files.\n3. Add a buildable-state test.",
    "## Required fixes\n1. Add a buildable-state test.",
  ]);
  assert.equal(countTrailingRepeatedDisapprovals(history), 1);
});

test("v0.38.101 containment is asymmetric — a later preamble does not mask repetition", () => {
  // The newer round carries extra wrapper text (a goal id, a "round 4" banner)
  // that the older one lacked. Symmetric similarity would under-read this as
  // progress; containment (denominated by the OLDER report) correctly reads it
  // as the same objection. Argument order is (newer, older).
  const older = "## Required fixes\n1. Resolve the strike-registration finding at its actual cause.";
  const newer =
    "Goal: 20260927013024-3nxfx (round 4 of rework). ## Required fixes\n1. Resolve the strike-registration finding at its actual cause.";
  const score = auditDisapprovalSimilarity(newer, older);
  assert.ok(score >= AUDIT_NO_PROGRESS_CONTAINMENT, `expected repetition, got ${score.toFixed(3)}`);
});

test("v0.38.101 containment ignores prose that carries no signal", () => {
  // Two unrelated rounds that share only function words must NOT score as
  // repetition — otherwise the detector fires on a moving goal.
  const older = "## Required fixes\n1. Guard the stale resume path in the dispatcher.";
  const newer = "## Required fixes\n1. Document the process-group containment fence.";
  const score = auditDisapprovalSimilarity(newer, older);
  assert.ok(
    score < AUDIT_NO_PROGRESS_CONTAINMENT,
    `unrelated findings must not read as repetition, got ${score.toFixed(3)}`,
  );
});

test("v0.38.101 an approval or an error still terminates the run", () => {
  const history: AuditVerdict[] = [
    ...rounds(["## Required fixes\n1. Same thing again, worded the same way, padded out.", "## Required fixes\n1. Same thing again, worded the same way, padded out."]),
    { at: "2026-09-27T09:00:00.000Z", approved: true, disapproved: false, model: "test/model", report: "verified", revision: 3 },
  ];
  assert.equal(countTrailingRepeatedDisapprovals(history), 0, "an approval ends the repetition run");
});

test("v0.38.101 the exact-text fingerprint is unchanged for compatibility", () => {
  // auditDisapprovalFingerprint is exported and pinned elsewhere; the fix adds
  // containment rather than altering it.
  assert.equal(
    auditDisapprovalFingerprint("  Hello   World  "),
    "hello world",
  );
  assert.equal(
    auditDisapprovalFingerprint("at 2026-09-27T01:02:03.000Z ok"),
    auditDisapprovalFingerprint("at 2026-09-28T09:09:09.000Z ok"),
  );
});
