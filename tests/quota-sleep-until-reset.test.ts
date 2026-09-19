// pi-goal-list-loop-audit — quota sleep-until-reset.
//
// Antigravity port (survey 2026-09-19): agy survives quota walls by sleeping
// through them (walkthrough.md "Quota resets in ~4.5 hours" as an explicit
// remainder; Run-layer backoff preserving completed work), while GLLA's
// main-model envelope ladders blindly into a known wall — a `resetAt=00:07`
// still climbs the 15m→30m→… ladder instead of sleeping until reset. Pins:
//   1. Quota-class failures (rate-limit/plan-quota signals) carrying an
//      explicit upstream reset hint sleep exactly until reset.
//   2. The eager first retry stays eager (5s) even with a hint present.
//   3. Hints never widen the envelope: capped at the 5h per-attempt max.
//   4. Non-quota signals (transient, billing, unknown) ignore hints and keep
//      the blind ladder — error prose still cannot choose a cadence there,
//      and billing still heads for the park.
//   5. The classifier stays opaque (kind/quotaSignal pins untouched).

import { test } from "node:test";
import * as assert from "node:assert/strict";

import {
  classifyMainModelFailure,
  mainModelFailureDelayMs,
  MAIN_MODEL_MAX_RETRY_DELAY_MS,
} from "../extensions/main-model-recovery.js";

const HOUR_MS = 60 * 60_000;

test("quota sleep-until-reset: explicit upstream hint sleeps to reset, eager first retry preserved", () => {
  const raw = "429 Too Many Requests — quota resets in 2 hours; retry in 2 hours";
  const failure = classifyMainModelFailure(raw);
  assert.equal(mainModelFailureDelayMs(failure, 1, 15), 5_000, "first retry stays eager");
  assert.equal(mainModelFailureDelayMs(failure, 2, 15), 2 * HOUR_MS, "sleeps exactly until reset");
});

test("quota sleep-until-reset: hint never widens the 5h envelope", () => {
  const raw = "429 Too Many Requests; retry in 1 week";
  const failure = classifyMainModelFailure(raw);
  assert.equal(
    mainModelFailureDelayMs(failure, 2, 15),
    MAIN_MODEL_MAX_RETRY_DELAY_MS,
    "a week-long hint clamps to the per-attempt cap",
  );
});

test("quota sleep-until-reset: hintless quota failures keep the blind ladder", () => {
  const failure = classifyMainModelFailure("429 Too Many Requests");
  assert.equal(mainModelFailureDelayMs(failure, 2, 15), 30 * 60_000);
});

test("quota sleep-until-reset: non-quota signals ignore hints", () => {
  const transient = classifyMainModelFailure("503 Service Unavailable; retry in 2 hours");
  assert.equal(mainModelFailureDelayMs(transient, 2, 15), 30 * 60_000, "transient keeps the ladder");
  const billing = classifyMainModelFailure("insufficient credits — buy credits; retry in 2 hours");
  assert.equal(mainModelFailureDelayMs(billing, 2, 15), 30 * 60_000, "billing keeps the ladder toward its park");
});
