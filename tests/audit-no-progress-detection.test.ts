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

  // The blind spot that forced the symmetric form. auditDisapprovalContainment
  // divides by its FIRST argument, so whenever that argument's tokens are a
  // subset of the other side it scores a perfect 1.00 — which reads as
  // "repetition" for a change that was actually one-sided progress.
  const threeFindings = "## Required fixes\n1. Anchor the index rows.\n2. Delete the stale loadout files.\n3. Add a buildable-state test.";
  const oneRemaining = "## Required fixes\n3. Add a buildable-state test.";
  assert.equal(
    auditDisapprovalContainment(oneRemaining, threeFindings),
    1,
    "a shrunk set is a subset of the older round and scores a perfect 1.00 on its own",
  );
  // The symmetric form is what rescues it: the reverse direction divides by the
  // larger set and drops well below the threshold.
  assert.ok(
    auditDisapprovalSimilarity(oneRemaining, threeFindings) < 0.6,
    "min-of-both-directions reads a shrunk set as progress",
  );
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

test("v0.38.105 deterministic mechanical pre-audit rows are transparent to the no-progress stop", () => {
  // Field 2026-10-08 (clean-web /pol/ inspection goal, 16:54): the goal's
  // verification contract named `bun run peek` with a /pol/ URL inline. The
  // deterministic pre-audit fast-fail ran the command BARE (no URL), the
  // script threw "give at least one URL", and the same byte-identical report
  // was emitted three rounds running. The state-based no-progress stop
  // paused the goal with a decision card whose recommended answer was
  // self-evident: the goal agent could fix the script (and did, commit
  // a951e6c019, 17:15). The detector was conflating a red contract command
  // with an auditor opinion. A failing gate is a gate; the goal agent reads
  // it and continues. Mechanical rows are transparent to the streak,
  // matching the cap-counted `countTrailingComparableDisapprovals`.
  const gateReport = "<disapproved/>\n\nDeterministic Pre-Audit Fast-Fail: Mechanical contract check failed: `bun run peek` (exit code 1)\n\n<evidence>\n[mechanical check retried once after a failed first attempt (exit 1); second attempt also failed — output tail below]\n$ node scripts/browser-test/peek.mjs\nError: give at least one URL: bun run peek -- https://example.com\n</evidence>";
  const gateHistory = Array.from({ length: 10 }, () => ({
    at: "2026-10-08T16:54:00.000Z",
    model: "deterministic-pre-audit",
    report: gateReport,
    approved: false,
    disapproved: true,
    revision: 0,
  }));
  assert.equal(
    countTrailingRepeatedDisapprovals(gateHistory),
    0,
    "ten identical mechanical pre-audit fast-fails must NOT form a no-progress streak",
  );
  assert.ok(
    countTrailingRepeatedDisapprovals(gateHistory) < 3,
    "the no-progress stop (MAX_REPEATED_AUDIT_NO_PROGRESS = 3) cannot fire on a mechanical gate alone",
  );
  // Auditor rows are unaffected: the same detector still works on a real
  // auditor disagreement. Sanity check that the real-auditor case still
  // counts byte-identical reports (today's exact-text contract).
  const auditorReport = "<disapproved/>\nThe verifier rejects the readiness artifact at its actual cause.";
  const auditorHistory = Array.from({ length: 3 }, () => ({
    at: "2026-10-08T17:00:00.000Z",
    model: "auditor/test",
    report: auditorReport,
    approved: false,
    disapproved: true,
    revision: 0,
  }));
  assert.equal(
    countTrailingRepeatedDisapprovals(auditorHistory),
    3,
    "three byte-identical real-auditor disapprovals still trigger the stop",
  );
  // Mixed history: the gate rows are transparent, the auditor rows are
  // counted. The exact-text comparison is still in force for the auditor.
  const mixed = [...gateHistory, ...auditorHistory];
  assert.equal(
    countTrailingRepeatedDisapprovals(mixed),
    3,
    "transparent gate rows do not break the auditor streak",
  );
  // The reverse direction: a real auditor streak followed by transparent
  // gate rows. Walking backward, the gate rows are skipped and the auditor
  // rows still form their identical-fingerprint streak of 3.
  const reversed = [...auditorHistory, ...gateHistory];
  assert.equal(
    countTrailingRepeatedDisapprovals(reversed),
    3,
    "transparent gate rows do not break a real auditor streak",
  );
  // An interleaved history proves the gate rows are TRANSPARENT, not
  // resetting: a stair-step of auditor + gate + auditor + gate with
  // identical auditor reports counts the auditor rows end-to-end (the
  // gates do not break the streak because they are skipped, not counted
  // against). Identical-fingerprint is computed on the immediately previous
  // counted row, so three auditor rows interleaved with three gate rows
  // still read as 3.
  const interleaved: Array<{ at: string; model: string; report: string; approved: false; disapproved: true; revision: number }> = [];
  for (let i = 0; i < 3; i++) {
    interleaved.push({ at: `2026-10-08T16:5${i}:30.000Z`, model: "auditor/test", report: auditorReport, approved: false, disapproved: true, revision: 0 });
    interleaved.push({ at: `2026-10-08T16:5${i}:00.000Z`, model: "deterministic-pre-audit", report: gateReport, approved: false, disapproved: true, revision: 0 });
  }
  assert.equal(
    countTrailingRepeatedDisapprovals(interleaved),
    3,
    "transparent gate rows between identical auditor reports do not break the streak",
  );
});
