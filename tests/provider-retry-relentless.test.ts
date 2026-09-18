// pi-goal-list-loop-audit
// tests/provider-retry-relentless.test.ts
//
// Now 200751/200754: a provider error engaged the 5-error brake (auto-retry
// armed), then the agent called pause_goal itself ("blocked — waiting for
// manual action"). The armed retry's re-check required the pause reason to
// still be the exact brake string, so the timer fired and no-op'd — the
// goal sat parked on the user for 6h+ instead of hammering retries within
// the bounded envelope (ladder → escalating brakes → 6-brake park + hourly
// probes). The retry must anchor on the recovery episode, not the reason
// string; only an explicit user pause stands it down.

import { test } from "node:test";
import * as assert from "node:assert/strict";

import { shouldErrorBrakeRetryResume } from "../extensions/goal-loop-core.ts";

const EPISODE = "1725648000000:abc123";

function paused(overrides: Record<string, unknown> = {}) {
  return {
    status: "paused",
    pauseKind: "blocked",
    pauseReason: "5 consecutive errors (last: provider exploded)",
    recoveryEpisodeKey: EPISODE,
    ...overrides,
  } as Parameters<typeof shouldErrorBrakeRetryResume>[0];
}

test("200751: agent pause inside the brake episode does not kill the retry", () => {
  const goal = paused({
    pauseReason: "Re-read the active goal, performance report, and existing countdown tests after resync. The unresolved requirement remains controlled browser performance verification.",
  });
  assert.equal(shouldErrorBrakeRetryResume(goal, EPISODE), true);
});

test("untouched brake pause still resumes", () => {
  assert.equal(shouldErrorBrakeRetryResume(paused(), EPISODE), true);
});

test("untouched 6-brake park still probes", () => {
  const goal = paused({
    pauseReason: "provider recovery wall — 6 error-brakes in a row; the provider has been erroring for an extended window",
  });
  assert.equal(shouldErrorBrakeRetryResume(goal, EPISODE), true);
});

test("explicit user pause stands the retry down", () => {
  const goal = paused({ pauseKind: "blocked", pauseReason: "paused by user" });
  assert.equal(shouldErrorBrakeRetryResume(goal, EPISODE), false);
});

test("pending decision picker stands the retry down", () => {
  const goal = paused({ pauseKind: "decision", pauseReason: "Choose a or b" });
  assert.equal(shouldErrorBrakeRetryResume(goal, EPISODE), false);
});

test("active goal never resumes", () => {
  const goal = paused({ status: "active" });
  assert.equal(shouldErrorBrakeRetryResume(goal, EPISODE), false);
});

test("episode mismatch never resumes", () => {
  assert.equal(shouldErrorBrakeRetryResume(paused(), "other-episode"), false);
});

test("missing episode never resumes", () => {
  assert.equal(shouldErrorBrakeRetryResume(paused({ recoveryEpisodeKey: undefined }), EPISODE), false);
  assert.equal(shouldErrorBrakeRetryResume(paused(), ""), false);
});
