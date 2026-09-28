// pi-goal-list-loop-audit — v0.38.104 empty provider responses.
//
// Field 2026-09-27 (darklord, screenshot 045352): the turn died with
// `Error: Provider returned an empty response` and the goal sat at 0/29 tasks,
// "last host activity 49m 21s ago", "Attempts: 5 · failing 58m".
//
// It matched no quota signal and no deterministic-client marker, so it fell to
// the blind ladder — where attempt 1 is 5s but attempt 2 is 15m, 3 is 30m, 4
// is 60m. For a failure that normally clears on the next call that is exactly
// backwards, and from the outside it looks completely unretried.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  mainModelFailureDelayMs,
  isEmptyProviderResponse,
  EMPTY_RESPONSE_EAGER_ATTEMPTS,
  type MainModelFailure,
} from "../extensions/main-model-recovery.ts";
import { isQuotaError, isDeterministicProviderError } from "../extensions/quota-retry.ts";

const failure = (raw: string): MainModelFailure => ({ kind: "provider" as any, raw });

test("v0.38.104 the field error is recognised as an empty response", () => {
  assert.equal(isEmptyProviderResponse("Provider returned an empty response"), true);
  // The family, not just the exact sentence the field produced.
  for (const raw of [
    "the provider returned an empty completion",
    "Empty response from the API",
    "no response was received from the model",
    "Model produced empty output",
  ]) {
    assert.equal(isEmptyProviderResponse(raw), true, raw);
  }
});

test("v0.38.104 a message that merely CONTAINS 'empty' is not a provider glitch", () => {
  // Narrow markers on purpose: "empty array" is a normal test-fixture phrase
  // and must not drag a goal into an eager-retry loop.
  for (const raw of [
    "expected an empty array, got 3 items",
    "the empty test fixture failed",
    "no response body present in the fixture",
  ]) {
    assert.equal(isEmptyProviderResponse(raw), false, raw);
  }
});

test("v0.38.104 an empty response is neither a quota wall nor a deterministic client error", () => {
  // Pinned because those two classifiers decide escalation; an empty response
  // must stay on the transient path.
  const raw = "Provider returned an empty response";
  assert.equal(isQuotaError(raw), false);
  assert.equal(isDeterministicProviderError(raw), false);
});

test("v0.38.104 an empty response retries EAGERLY, not on the 15-minute ladder", () => {
  const f = failure("Provider returned an empty response");
  for (let attempt = 1; attempt <= EMPTY_RESPONSE_EAGER_ATTEMPTS; attempt++) {
    assert.equal(
      mainModelFailureDelayMs(f, attempt),
      5_000,
      `attempt ${attempt} must stay eager — this is what 49m of no host activity looked like`,
    );
  }
});

test("v0.38.104 the eager window is bounded, then the normal ladder takes over", () => {
  const f = failure("Provider returned an empty response");
  const after = mainModelFailureDelayMs(f, EMPTY_RESPONSE_EAGER_ATTEMPTS + 1);
  assert.ok(after > 5_000, `attempt ${EMPTY_RESPONSE_EAGER_ATTEMPTS + 1} must fall back to the ladder, got ${after}`);
  assert.equal(after, mainModelFailureDelayMs(f, EMPTY_RESPONSE_EAGER_ATTEMPTS + 1), "and must equal the plain ladder");
});

test("v0.38.104 other failures keep the historical ladder untouched", () => {
  // No regression for every other family: attempt 1 eager, then exponential.
  for (const raw of ["HTTP 500", "connection reset", "stream aborted"]) {
    const f = failure(raw);
    assert.equal(mainModelFailureDelayMs(f, 1), 5_000, raw);
    assert.ok(mainModelFailureDelayMs(f, 2) > 5_000, `${raw} must still back off`);
  }
});

test("v0.38.104 a quota wall still wins over the eager empty-response path", () => {
  // A reset hint must not be shortened by the eager branch: a real wall needs
  // to sleep until the provider says it is allowed again. The hint must be in
  // the RAW TEXT -- quotaResetSleepMs parses upstream hints from the provider
  // message, and the legacy `resetAt` field is explicitly never consulted.
  const wall: MainModelFailure = {
    kind: "provider" as any,
    raw: "429 Too Many Requests. retry after 600 seconds -- provider returned an empty response",
  };
  const delay = mainModelFailureDelayMs(wall, 2);
  assert.ok(delay > 60_000, `a reset hint must still be honoured, got ${delay}ms`);
  assert.equal(delay, 600_000, "and it must be the provider's own window, not the eager 5s");
});

test("v0.38.105 the FIRST attempt honours the upstream reset hint too (no 5s probe of a named wall)", () => {
  // The `attempt <= 1` eager return used to sit ABOVE the hint check, so the
  // very first 429 with `Retry-After` slept 5s and immediately probed the
  // wall the provider had just named — exactly the hammering the branch was
  // written to prevent, and a direct contradiction of its own comment.
  const hinted: MainModelFailure = {
    kind: "provider" as any,
    raw: "HTTP 429 Too Many Requests\nRetry-After: 14400",
  };
  assert.equal(mainModelFailureDelayMs(hinted, 1), 14_400_000, "attempt 1 sleeps to the provider's own reset");

  const floor: MainModelFailure = {
    kind: "provider" as any,
    raw: "rate limit reached, resets at 2026-09-28T12:00:00Z",
  };
  const nowMs = Date.parse("2026-09-28T11:00:00Z");
  const floored = mainModelFailureDelayMs(floor, 1, 15, nowMs);
  assert.ok(floored > 60_000, `an absolute reset must not be shortened, got ${floored}ms`);
  assert.equal(floored, Math.min(Math.max(3_600_000, 5_000), 5 * 3_600_000), "and it is the remaining window");

  // The eager quantum still applies when there is no upstream hint.
  const plain = failure("Provider returned an empty response");
  assert.equal(mainModelFailureDelayMs(plain, 1), 5_000, "an unhinted first failure is still eager");
});
