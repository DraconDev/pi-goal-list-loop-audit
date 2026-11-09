// pi-goal-list-loop-audit — v0.39.67
// tests/concurrency-wall-retry.test.ts
//
// Field 2026-11-09 (operator report + Screenshot_20261109_052717.png context):
//
//   Error: 400: {"code":"tier_limit_exceeded","message":"[code=tier_limit_exceeded]
//   membership concurrency limit exceeded: 11/10 resets 2026-11-09T15:27:00Z",
//   "type":"tier_limit_exceeded"}
//
// "such error too we should be retrying, in fact all errors".
//
// Three separate things were wrong with this shape:
//
//   1. The reset instant was DISCARDED. `parseQuotaError` only understood
//      `resets at <date>` / `available at <date>`; this provider writes
//      `resets <ISO>` with no preposition, so the explicit deadline fell
//      through to the flat 3600s default.
//   2. The class was easy to misfile. It arrives as HTTP 400 and contains
//      "limit exceeded", so only the quota vocabulary keeps it out of the
//      deterministic-client-error bucket — and a provider rewording it
//      ("tier_limit", "concurrency limit") had no dedicated marker.
//   3. A concurrency wall is NOT a spent plan. Sleeping to the quoted reset
//      (hours away) would idle a healthy rig behind a limit that lifts as soon
//      as any in-flight request finishes, so it must retry promptly even
//      though a reset hint exists.
//
// The operator's standing rule is "all errors": the durable gate
// (`isRecoverableProviderError`) now admits unclassified failures too, matching
// the live lane that has failed open since v0.38.104. The explicit refusals
// (aborts, prompt-policy, context overflow, deterministic client errors,
// auditor no-verdict prose) are pinned below so "all errors" cannot quietly
// become "no exceptions".

import { test } from "node:test";
import assert from "node:assert/strict";

import { isConcurrencyWall, parseQuotaError, quotaSignal, isDeterministicProviderError } from "../extensions/quota-retry.ts";
import {
  classifyMainModelFailure,
  isEagerRetryFailure,
  isRecoverableProviderError,
  mainModelFailureDelayMs,
  quotaResetSleepMs,
} from "../extensions/main-model-recovery.ts";
import { classifyCompactionFailure } from "../extensions/compaction-failure.ts";

/** The operator's exact string (one line, verbatim). */
const FIELD_ERROR = 'Error: 400: {"code":"tier_limit_exceeded","message":"[code=tier_limit_exceeded] membership concurrency limit exceeded: 11/10 resets 2026-11-09T15:27:00Z","type":"tier_limit_exceeded"}';
const NOW = Date.parse("2026-11-09T13:00:00Z");
const RESET_IN_SEC = (Date.parse("2026-11-09T15:27:00Z") - NOW) / 1000; // 8820

test("the field error is a quota wall, never a deterministic client error", () => {
  assert.equal(quotaSignal(FIELD_ERROR), "plan-quota");
  assert.equal(isConcurrencyWall(FIELD_ERROR), true);
  // Both halves matter: a 400 that is treated as deterministic is parked
  // forever, and a 400 that is treated as unknown has no retry authority.
  assert.equal(isDeterministicProviderError(FIELD_ERROR), false);
  assert.equal(classifyMainModelFailure(FIELD_ERROR).kind, "unknown");
});

test("the provider's `resets <ISO>` deadline is parsed instead of the flat default", () => {
  const parsed = parseQuotaError(FIELD_ERROR, 3600, NOW);
  assert.equal(parsed.fromUpstream, true, "the explicit reset counts as an upstream hint");
  assert.equal(parsed.resetAt, "2026-11-09T15:27:00.000Z");
  assert.equal(parsed.retryAfterSec, RESET_IN_SEC);
});

test("the existing `resets at` / `available at` shapes still parse, and a bare date does not", () => {
  for (const text of [
    "quota exhausted, available at 2026-11-09T15:27:00Z",
    "rate limit resets at 2026-11-09T15:27:00Z",
    "quota resets 2026-11-09T15:27:00Z",
  ]) {
    assert.equal(parseQuotaError(text, 3600, NOW).retryAfterSec, RESET_IN_SEC, text);
  }
  // A date without a time is prose, not a hint — parsing it would invent a
  // midnight deadline from an announcement.
  assert.equal(parseQuotaError("quota resets 2026-11-09 as announced", 3600, NOW).fromUpstream, false);
});

test("a concurrency wall retries promptly — the quoted reset is a bound, not a sleep", () => {
  const failure = classifyMainModelFailure(FIELD_ERROR);
  assert.equal(isEagerRetryFailure(failure), true, "the live lane probes for a free slot");
  // Even though the reset hint exists (so quotaResetSleepMs would answer), the
  // concurrency branch wins: a slot frees when any in-flight request finishes.
  assert.ok(quotaResetSleepMs(failure, NOW) !== undefined, "the hint is available as an upper bound");
  const delays = [1, 2, 10, 11, 12].map(attempt => mainModelFailureDelayMs(failure, attempt, 15, NOW));
  assert.deepEqual(delays.slice(0, 3), [5_000, 5_000, 5_000], "eager 5s quantum while the limit may lift");
  assert.ok(delays[3]! <= 60_000, `attempt 11 backs off to minutes, not the reset (${delays[3]})`);
  assert.ok(delays.every(ms => ms < RESET_IN_SEC * 1000 / 4), "no attempt sleeps to the reset instant");
});

test("a NON-concurrency quota wall still honours its reset hint", () => {
  const text = "Error: 402: quota exhausted for this month, resets 2026-11-09T15:27:00Z";
  const failure = classifyMainModelFailure(text);
  assert.equal(isConcurrencyWall(text), false);
  assert.equal(isEagerRetryFailure(failure), false, "a spent plan is not hammered");
  assert.equal(mainModelFailureDelayMs(failure, 1, 15, NOW), Math.min(RESET_IN_SEC * 1000, 5 * 60 * 60_000));
});

test("the field error has durable retry authority and never parks as terminal", () => {
  assert.equal(isRecoverableProviderError(FIELD_ERROR), true);
  assert.notEqual(
    classifyCompactionFailure({ errorMessage: FIELD_ERROR, willRetry: true }).kind,
    "other-terminal",
    "a compaction that hits a concurrency wall must keep its retry, not park terminally",
  );
});

test("operator rule — unclassified provider failures also keep durable authority", () => {
  // The live lane has failed open to `unknown` since v0.38.104: it retries ten
  // times at 5s. The durable gate used to refuse the same string, which is the
  // lane disagreement that parked retryable work.
  for (const raw of ["Error: kablam", "Error: internal widget exploded", "Error: 400: something new"]) {
    assert.equal(classifyMainModelFailure(raw).kind, "unknown", raw);
    assert.equal(isEagerRetryFailure(classifyMainModelFailure(raw)), true, `${raw} retries in the live lane`);
    assert.equal(isRecoverableProviderError(raw), true, `${raw} keeps durable authority too`);
  }
});

test("'all errors' is not 'no exceptions': the refusal set is unchanged", () => {
  // Auditor no-verdict prose has its own retry plan; main-model recovery would
  // replace it. These are the strings tests/rework-round-scope.test.ts and the
  // abort suites pin to their own owners.
  for (const raw of [
    "auditor produced no verdict marker",
    "auditor worker exited without an atomic result",
    "auditor produced no output",
    "worker exited without a verdict",
  ]) {
    assert.equal(isRecoverableProviderError(raw), false, raw);
    assert.equal(classifyCompactionFailure({ errorMessage: raw, willRetry: false }).kind, "other-terminal", raw);
  }
  for (const raw of ["user aborted", "turn aborted: user interrupt", "This operation was aborted"]) {
    assert.equal(isRecoverableProviderError(raw), false, `${raw} is a user abort`);
  }
  assert.equal(isRecoverableProviderError('400: {"message":"maximum context length is 1048576 tokens"}'), false);
  assert.equal(isRecoverableProviderError('BadRequestError: Image count 12 exceeds limit 4. "code":"400"'), false,
    "a deterministic client error cannot succeed on an identical retry");
});
