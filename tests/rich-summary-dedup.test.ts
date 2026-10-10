// pi-goal-list-loop-audit — rich-summary 172705 triage gaps.
//
// Field 20260918_172705: the Done card showed duplicated rows (Changed×2,
// Tests×2, Unresolved×2 from repeated claim details) and a "0 turns"
// duration segment from untracked telemetry. Pins:
//   1. Exact-duplicate detail lines collapse to one per bucket (findings
//      near-duplicates with different wording still render — that prose
//      belongs to the agent's claim, not the renderer).
//   2. A zero turns count is omitted (untracked, not known) while elapsed
//      and audit counts still render.
//   3. Shared-topic wording never proves two claims equivalent. Preserve
//      qualifiers and actions; collapse only exact duplicate details.

import { test } from "node:test";
import * as assert from "node:assert/strict";

import {
  buildDurationLine,
  partitionRichDetails,
} from "../extensions/completion-summary.js";

test("172705: exact-duplicate details render once per bucket", () => {
  const parts = partitionRichDetails([
    "Changed: provisioned the host.",
    "Tests: validator OK.",
    "Changed: provisioned the host.",
    "Tests: validator OK.",
    "Unresolved: none.",
    "Changed: provisioned the host plus docs.", // near-dupe: kept
  ]);
  assert.deepEqual(parts.findings, [
    "Changed: provisioned the host.",
    "Changed: provisioned the host plus docs.",
  ]);
  assert.deepEqual(parts.tests, ["Tests: validator OK."]);
  assert.deepEqual(parts.next, ["Unresolved: none."]);
});

test("same-label paraphrases remain intact rather than guessing equivalence", () => {
  const first = "Unresolved: The fix is NOT live. The installed binary is 0.112.42 built before this change, and the guard is still running that old binary — a release cut was explicitly out of scope, so activation happens at the next release.";
  const restatement = "Unresolved: the fix is still not live — the installed binary is 0.112.42 built before this work, so activation needs a release cut, which was explicitly out of scope.";
  const parts = partitionRichDetails([first, restatement]);
  assert.deepEqual(parts.next, [first, restatement], 'paraphrased qualifiers must not be silently discarded');
});

test("2026-10-02: problem and action across labels always both render", () => {
  const problem = "Unresolved: the fix is still not live — the installed binary is 0.112.42 built before this work, so activation needs a release cut.";
  const action = "Next: Cut a release to activate the TTL, then confirm the first expiry pass in the journal.";
  const parts = partitionRichDetails([problem, action]);
  assert.deepEqual(parts.next, [problem, action]);
});

test("2026-10-02: distinct same-label next steps both render", () => {
  const one = "Next: Cut a release to activate the TTL.";
  const two = "Next: Confirm the first expiry pass in the journal.";
  const parts = partitionRichDetails([one, two]);
  assert.deepEqual(parts.next, [one, two]);
});

test("172705: zero turns omitted, elapsed and audits kept", () => {
  const line = buildDurationLine({
    telemetry: { turns: 0, fileWrites: 0, bashCalls: 0 },
    createdAt: new Date(Date.now() - 65_000).toISOString(),
    auditHistory: [{ at: new Date().toISOString(), approved: true } as never],
  } as never);
  assert.ok(line, "line still renders");
  assert.doesNotMatch(line!, /0 turns/, "untracked zero turns never renders");
  assert.match(line!, /elapsed/, "elapsed kept");
  assert.match(line!, /1 audit/, "audit count kept");
});
