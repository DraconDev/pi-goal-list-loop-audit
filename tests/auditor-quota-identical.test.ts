// Relentless auto-continue: quota-identical auditor failures (field 150821).
// Red-first: isQuotaIdenticalParkExempt and freshAuditorCycleClaim do not
// exist yet. Quota walls are transient — hammering bounded retries is
// correct, parking with "check the auditor/model setup" is not. And a
// resumed/recovered cycle must reseed the dead chain, never re-walk it
// (the 3 -> 4 count bump came from re-walking).

import { test } from "node:test";
import * as assert from "node:assert/strict";

import { freshAuditorCycleClaim, isQuotaIdenticalParkExempt } from "../extensions/goal-loop-core.js";

test("rate-limit and plan-quota walls are exempt from the identical park", () => {
  assert.equal(isQuotaIdenticalParkExempt("429 Too Many Requests — slow down"), true);
  assert.equal(isQuotaIdenticalParkExempt("simply out of quota"), true);
  assert.equal(isQuotaIdenticalParkExempt("You exceeded your current quota, retry later"), true);
  assert.equal(isQuotaIdenticalParkExempt(undefined), false);
});

test("billing walls keep the park — retries cannot fix a paywall", () => {
  assert.equal(isQuotaIdenticalParkExempt("insufficient_quota: monthly limit exceeded"), false);
  assert.equal(isQuotaIdenticalParkExempt("payment required — buy credits"), false);
});

test("non-quota infra failures keep the identical park", () => {
  assert.equal(isQuotaIdenticalParkExempt("Model agnes/agnes-3.0-flash not found"), false);
  assert.equal(isQuotaIdenticalParkExempt("socket hang up"), false);
  assert.equal(isQuotaIdenticalParkExempt("worker exited before agent_settled"), false);
});

test("freshAuditorCycleClaim reseeds the dead chain and restarts the streak", () => {
  const reseeded = freshAuditorCycleClaim({
    auditorCandidateRefs: ["dead/ref"],
    auditorCandidateRef: "dead/ref",
    auditorRetryCandidateRef: "dead/ref",
    auditorAttemptedRefs: ["dead/ref"],
    auditorEvictedRefs: ["dead/ref"],
    auditorLastFailureFingerprint: "provider:dead",
    auditorConsecutiveIdenticalFailures: 3,
    auditorFailureCount: 2,
    auditorFallbackExhausted: true,
    auditorFailureAt: new Date().toISOString(),
    retryAttempts: 9,
    retryFirstAt: new Date().toISOString(),
    retryUntil: new Date().toISOString(),
    exhaustedChain: "dead/ref → deader/ref",
    providerErrorDiagnostic: "429 wall from last cycle",
  });
  assert.equal(reseeded.auditorCandidateRefs, undefined);
  assert.equal(reseeded.auditorLastFailureFingerprint, undefined);
  assert.equal(reseeded.auditorConsecutiveIdenticalFailures, undefined);
  assert.equal(reseeded.auditorFallbackExhausted, undefined);
  // v0.38.68 reviewer P2: stale chain/diagnostic must not render one cycle late.
  assert.equal((reseeded as Record<string, unknown>).exhaustedChain, undefined);
  assert.equal((reseeded as Record<string, unknown>).providerErrorDiagnostic, undefined);
  assert.equal(reseeded.retryAttempts, undefined);
  assert.equal(reseeded.retryUntil, undefined);
});
