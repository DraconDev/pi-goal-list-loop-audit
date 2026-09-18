// tests/audit-stuck-batch.test.ts
//
// Audit-stuck batch (goal 20260918115619-bqw4v6): an auditor retry loop
// that can never land a verdict must terminate visibly instead of spinning
// forever. Field evidence: screenshots 124541 (dead-model spin),
// 124544 (resume/probe deadlock), 124536 (queue pile-up).

import { test } from "node:test";
import * as assert from "node:assert/strict";

import {
  isUnresolvableAuditorModelRefError,
  filterEvictedAuditorRefs,
} from "../extensions/goal-loop-core.ts";
import {
  runAuditorFallbackWithPolicy,
  type AuditorFallbackCandidate,
  type GoalAuditorResult,
} from "../extensions/goal-loop-auditor-process.ts";

function result(overrides: Partial<GoalAuditorResult> = {}): GoalAuditorResult {
  return {
    approved: false,
    disapproved: false,
    output: "",
    model: "test/model",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 124541: dead-model spin — "Model not found" must evict, never re-arm verbatim.
// ---------------------------------------------------------------------------

test("124541: model-not-found shapes are unresolvable auditor refs", () => {
  assert.equal(isUnresolvableAuditorModelRefError("Model not found: agnes/agnes-3.0-flash"), true);
  assert.equal(isUnresolvableAuditorModelRefError("model not found"), true);
  assert.equal(isUnresolvableAuditorModelRefError("no available model matching 'agnes/old'"), true);
  assert.equal(isUnresolvableAuditorModelRefError("no configured auth for provider p"), true);
  assert.equal(isUnresolvableAuditorModelRefError("503 upstream unavailable"), false);
  assert.equal(isUnresolvableAuditorModelRefError("Auditor stalled — no progress in 5m"), false);
  assert.equal(isUnresolvableAuditorModelRefError(undefined), false);
});

test("124541: walker does not spend the same-ref retry on an unresolvable ref", async () => {
  const candidates: AuditorFallbackCandidate[] = [
    { ref: "agnes/agnes-3.0-flash", model: { provider: "agnes", id: "agnes-3.0-flash" }, via: "setting" },
    { ref: "test/live", model: { provider: "test", id: "live" }, via: "fallback-pin" },
  ];
  const calls: string[] = [];
  const outcome = await runAuditorFallbackWithPolicy(candidates, async (candidate) => {
    const ref = candidate.ref!;
    calls.push(ref);
    return ref === "agnes/agnes-3.0-flash"
      ? result({ error: "Model not found: agnes/agnes-3.0-flash", model: ref })
      : result({ approved: true, model: ref });
  }, {
    retryBaseMinutes: 1,
    sleep: async () => {},
    shouldRetry: () => true,
  });
  assert.equal(outcome.result.approved, true, "the live fallback lands the verdict");
  assert.deepEqual(
    calls.filter((ref) => ref === "agnes/agnes-3.0-flash"),
    ["agnes/agnes-3.0-flash"],
    "the dead ref is attempted exactly once — no same-ref retry burn",
  );
  assert.equal(outcome.retriedOnce, false, "skipping the doomed retry is not a retry");
});

test("124541: re-seed filters evicted refs so the next episode starts live", () => {
  const configured = ["agnes/agnes-3.0-flash", "test/live", "test/other"];
  assert.deepEqual(
    filterEvictedAuditorRefs(configured, ["agnes/agnes-3.0-flash"]),
    ["test/live", "test/other"],
  );
  assert.deepEqual(
    filterEvictedAuditorRefs(configured, ["AGNES/AGNES-3.0-FLASH"]),
    ["test/live", "test/other"],
    "eviction matches case-insensitively like the walker cursor",
  );
  assert.deepEqual(filterEvictedAuditorRefs(configured, undefined), configured);
  assert.deepEqual(filterEvictedAuditorRefs(configured, []), configured);
});
