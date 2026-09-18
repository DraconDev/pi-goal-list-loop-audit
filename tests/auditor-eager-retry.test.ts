// pi-goal-list-loop-audit — v0.34.141
// tests/auditor-eager-retry.test.ts
//
// The auditor does not probe or check quota state. It retries infrastructure
// failures uniformly: one eager 5s retry, then probes just after each local
// hour starts so a possible reset at 15:00/16:00 is picked up quickly.

import { test } from "node:test";
import * as assert from "node:assert/strict";

import { auditorRetryPlan, runDetachedCompletionWithFallback } from "../extensions/loops/goal.js";
import { readGoalRuntimeSource } from "./harness/goal-source.js";

const SRC = readGoalRuntimeSource();

/** Minimal claim the plan reads: generic retryAttempts / retryFirstAt / retryUntil. */
function claim(over: Partial<Record<string, unknown>> = {}): any {
  return {
    phase: "auditing" as const,
    claim: "done",
    goalId: "g-1",
    attemptId: "a-1",
    ...over,
  };
}

function providerFailure(retryAfterSec: number, fromUpstream: boolean, signal?: "rate-limit" | "plan-quota" | "billing"): any {
  return { raw: "", retryAfterSec, fromUpstream, signal };
}

test("eager: first attempt is 5s for every provider failure family", () => {
  for (const failure of [
    providerFailure(0, false),
    providerFailure(0, false, "rate-limit"),
    providerFailure(0, false, "plan-quota"),
    providerFailure(0, false, "billing"),
  ]) {
    const plan = auditorRetryPlan(claim(), failure, 60);
    assert.equal(plan.attempt, 1);
    assert.equal(plan.retryAfterSec, 5, "the first probe is eager regardless of provider wording");
    assert.equal(plan.automatic, true);
  }
});

test("hourly: later attempts keep the slot diagnostic but cap the wait at 15m", () => {
  // Post-drafting stuck cluster (field 111629/111716/111957): the uncapped
  // :00:30 slot wait read "auto-retry in 44m 03s" — stuck-looking. The
  // slot stays diagnostic metadata (requestedSec); the persisted wait caps.
  const plan = auditorRetryPlan(
    claim({ retryAttempts: 1, retryFirstAt: new Date().toISOString() }),
    providerFailure(0, false, "plan-quota"),
    60,
  );
  assert.equal(plan.attempt, 2);
  assert.ok(plan.requestedSec >= 60, `hourly slot must floor at 60s, got ${plan.requestedSec}`);
  assert.ok(plan.requestedSec <= 60 * 60, `hourly slot stays within one hour, got ${plan.requestedSec}`);
  assert.ok(plan.retryAfterSec >= 60, `capped wait keeps the 60s floor, got ${plan.retryAfterSec}`);
  assert.ok(plan.retryAfterSec <= 15 * 60, `capped wait never exceeds 15m, got ${plan.retryAfterSec}`);
  assert.equal(plan.retryAfterSec, Math.min(plan.requestedSec, 15 * 60));
});

test("hourly: rate-limit, billing, and transient-shaped failures share the same later schedule", () => {
  const attempts = [
    providerFailure(0, false),
    providerFailure(0, false, "rate-limit"),
    providerFailure(0, false, "plan-quota"),
    providerFailure(0, false, "billing"),
  ].map((failure) => auditorRetryPlan(
    claim({ retryAttempts: 1, retryFirstAt: new Date().toISOString() }),
    failure,
    1,
  ));
  assert.deepEqual(attempts.map((plan) => plan.retryAfterSec), [
    attempts[0]!.retryAfterSec,
    attempts[0]!.retryAfterSec,
    attempts[0]!.retryAfterSec,
    attempts[0]!.retryAfterSec,
  ]);
});

test("eager: an upstream Retry-After hint does not suppress the uniform retry", () => {
  const first = auditorRetryPlan(claim(), providerFailure(3600, true, "rate-limit"), 60);
  assert.equal(first.attempt, 1);
  assert.equal(first.retryAfterSec, 5, "the scheduler retries instead of waiting on a quota hint");

  const later = auditorRetryPlan(
    claim({ retryAttempts: 1, retryFirstAt: first.firstAt, retryUntil: first.autoRetryUntil }),
    providerFailure(7200, true, "billing"),
    60,
  );
  assert.equal(later.retryAfterSec, Math.min(later.requestedSec, 15 * 60), "the later retry caps the hour-aligned slot at 15m");
  assert.ok(later.retryAfterSec <= 15 * 60);
});

test("eager: detached auditor retries an account-shaped failure once before durable parking", async () => {
  const waits: number[] = [];
  let calls = 0;
  const outcome = await runDetachedCompletionWithFallback(
    [{ model: "provider/model", via: "test" }],
    async () => {
      calls++;
      return { approved: false, disapproved: false, output: "", model: "provider/model", error: "Token Plan limit reached" };
    },
    { sleep: async (ms) => { waits.push(ms); }, shouldRetry: () => true },
  );
  assert.equal(outcome.retriedOnce, true);
  assert.equal(calls, 2, "account-shaped text does not suppress the eager retry");
  assert.deepEqual(waits, [5000], "the first retry uses the uniform eager delay");
});

test("eager: a second recoverable provider error remains infrastructure after the one retry", async () => {
  const waits: number[] = [];
  let calls = 0;
  const outcome = await runDetachedCompletionWithFallback(
    [{ model: "provider/model", via: "test" }],
    async () => {
      calls++;
      return {
        approved: false,
        disapproved: false,
        output: "",
        model: "provider/model",
        error: calls === 1 ? "503 upstream unavailable" : "429 transient provider failure",
      };
    },
    { sleep: async (ms) => { waits.push(ms); }, shouldRetry: () => true },
  );
  assert.equal(calls, 2, "the same candidate gets exactly one eager retry");
  assert.equal(outcome.retriedOnce, true);
  assert.equal(outcome.fallbackUsed, false, "there is no next candidate to mislabel as a semantic verdict");
  assert.equal(outcome.result.approved, false);
  assert.equal(outcome.result.disapproved, false);
  assert.equal(outcome.result.error, "429 transient provider failure", "the final provider failure is retained as infrastructure evidence");
  assert.deepEqual(waits, [5000]);
});

test("eager: conservative attempts remain bounded by the existing durable safety window", () => {
  const horizon = new Date(Date.now() + 2 * 60_000).toISOString();
  const plan = auditorRetryPlan(claim({ retryAttempts: 4, retryFirstAt: new Date().toISOString(), retryUntil: horizon }), providerFailure(0, false), 60);
  assert.equal(plan.attempt, 5);
  assert.ok(plan.retryAfterSec >= 1);
  assert.equal(plan.unbounded, false);
});

test("unified: no auditor-only attempt cap inside the shared horizon", () => {
  // The retired MAX_AUDITOR_AUTO_RETRY_ATTEMPTS=5 cap stopped the ladder at
  // attempt 5; the shared 24h horizon is now the only conservative stop —
  // same as the main-model envelope.
  const firstAt = new Date().toISOString();
  const plan = auditorRetryPlan(
    claim({ retryAttempts: 9, retryFirstAt: firstAt, retryUntil: new Date(Date.now() + 12 * 60 * 60_000).toISOString() }),
    providerFailure(0, false),
    60,
  );
  assert.equal(plan.attempt, 10);
  assert.equal(plan.automatic, true, "attempt 10 inside the horizon still retries");
  assert.equal(plan.unbounded, false);
});

test("aggressive auditor recovery respects the fixed recovery horizon", () => {
  const plan = auditorRetryPlan(
    claim({ retryAttempts: 50, retryFirstAt: new Date(0).toISOString(), retryUntil: new Date(1).toISOString() }),
    providerFailure(0, false),
    60,
    true,
  );
  assert.equal(plan.attempt, 51);
  assert.equal(plan.automatic, false);
  assert.equal(plan.unbounded, false);
});

test("manual-started timer retries preserve automatic provenance and clear exhausted cycle state", () => {
  assert.doesNotMatch(SRC, /retryStoredCompletionAudit\(origin\);/);
  assert.match(SRC, /retryStoredCompletionAudit\("provider-retry"\);/);
  const burnedCycle = SRC.slice(SRC.indexOf('const burnCopy ='), SRC.indexOf('chainExhaustedToLadder = true;'));
  for (const field of ['auditorAttemptedRefs', 'auditorRetryAttemptStartedAt', 'auditorFailureCount']) {
    assert.ok(burnedCycle.includes(`${field}: undefined`), `fresh cycle clears ${field}`);
  }
});

test("automatic plans advance counters while preserving their original envelope", () => {
  let stored = claim();
  let originalFirst: string | undefined;
  let originalUntil: string | undefined;
  for (let i = 1; i <= 4; i++) {
    const plan = auditorRetryPlan(stored, undefined, undefined, true);
    originalFirst ??= plan.firstAt;
    originalUntil ??= plan.autoRetryUntil;
    assert.equal(plan.attempt, i);
    assert.equal(plan.firstAt, originalFirst);
    assert.equal(plan.autoRetryUntil, originalUntil);
    assert.ok(i === 1 ? plan.retryAfterSec === 5 : plan.retryAfterSec >= 60);
    stored = claim({ retryAttempts: plan.attempt, retryFirstAt: plan.firstAt, retryUntil: plan.autoRetryUntil });
  }
});

test("source pins: uniform eager retry and hourly probe wording are present at both dispatch sites", () => {
  assert.match(SRC, /const EAGER_AUDITOR_RETRY_SEC = 5;/);
  assert.match(SRC, /attempt === 1\s*\?\s*EAGER_AUDITOR_RETRY_SEC/);
  assert.match(SRC, /nextHourlyProbeMs\(now\)/);
  assert.match(SRC, /fmtRetryDelay\(plan\.retryAfterSec\)/);
  assert.match(SRC, /fmtRetryDelay\(plan\.retryAfterSec\)/);
  assert.match(SRC, /uniform retry schedule/);
  assert.doesNotMatch(SRC, /quota\.signal === "rate-limit"/);
  assert.doesNotMatch(SRC, /quotaRetryDelaySeconds\(attempt, baseMinutes\)/);
});
