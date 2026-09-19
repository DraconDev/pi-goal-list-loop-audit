// pi-goal-list-loop-audit — rich-summary 172705 triage gaps.
//
// Field 20260918_172705: the Done card showed duplicated rows (Changed×2,
// Tests×2, Unresolved×2 from repeated claim details) and a "0 turns"
// duration segment from untracked telemetry. Pins:
//   1. Exact-duplicate detail lines collapse to one per bucket (near-
//      duplicates with different wording still render — that prose belongs
//      to the agent's claim, not the renderer).
//   2. A zero turns count is omitted (untracked, not known) while elapsed
//      and audit counts still render.

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
