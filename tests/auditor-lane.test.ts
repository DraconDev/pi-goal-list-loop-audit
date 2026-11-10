// pi-goal-list-loop-audit — v0.39.68
// tests/auditor-lane.test.ts
//
// v0.39.68 (field 2026-11-09): the audit lane's provider/auditor lane
// decision must read the RECORDED failure class first.
//
// What was broken: the audit lane already records a typed class for every
// auditor failure (`no-verdict`, `timeout`, `transport`, `provider`,
// `context-exhausted`), but the lane decisions re-parsed the RAW TEXT.
// v0.39.67 widened the text test to admit unclassified failures ("in fact
// all errors"), so "Error: worker exited with code 1" — classified
// `no-verdict`, i.e. the auditor's own failure — started counting as a
// provider wall.
//
// The consequence was that the audit lane's whole bound machinery was
// switched off for the failures it was built for: the identical-failure
// slowdown marker fires only for a BOUNDED plan, the 24h dispatch horizon
// binds only for a non-provider diagnostic, and the one-shot marker is
// bypassed only by a recoverable one. An auditor that kept dying with its
// own crash text moved onto the provider lane's unbounded five-minute
// cadence — a fresh detached auditor every five minutes, forever, with no
// slowdown marker and no horizon.
//
// What must hold:
//   - the recorded class decides the lane; the text decides only when no
//     class was recorded (a claim parked before the class existed),
//   - an auditor-owned failure keeps the bounded ladder, the slowdown
//     marker and the horizon,
//   - a provider wall keeps v0.39.67's widened behaviour: five-minute
//     cadence, unbounded, durable retry authority.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import fs from "node:fs";

import { claimUsesProviderLane, isAuditorOwnedFailureClass } from "../extensions/auditor-lane.ts";
import { auditorRetryPlan } from "../extensions/loops/goal-auditor-hooks.ts";
import { ownsPersistentProviderWait } from "../extensions/persistent-provider-recovery.ts";
import { AUDITOR_IDENTICAL_FAILURE_PARK_THRESHOLD, trackAuditorIdenticalFailure } from "../extensions/goal-loop-core.ts";

const CRASH = "Error: worker exited with code 1";
const NO_VERDICT = "auditor produced no verdict marker";
const QUOTA = "429 rate limit exceeded";

function claim(overrides: Record<string, unknown> = {}): any {
  const now = new Date().toISOString();
  return {
    at: now,
    completionSummary: "stored completion claim",
    retryAttempts: 0,
    retryFirstAt: now,
    ...overrides,
  };
}

test("the recorded class decides the lane, not the raw text", () => {
  // The auditor's own failure: the text alone would call this a provider
  // wall, and the class says otherwise.
  assert.equal(claimUsesProviderLane({ auditorFailureClass: "no-verdict", providerErrorDiagnostic: CRASH }), false);
  assert.equal(claimUsesProviderLane({ auditorFailureClass: "no-verdict", providerErrorDiagnostic: NO_VERDICT }), false);
  // A transcript that is already too big reproduces the same wall on retry.
  assert.equal(claimUsesProviderLane({ auditorFailureClass: "context-exhausted", providerErrorDiagnostic: "context length exceeded" }), false);
  // A provider wall stays a provider wall — including an unparseable one,
  // which is the v0.39.67 "all errors" rule.
  assert.equal(claimUsesProviderLane({ auditorFailureClass: "provider", providerErrorDiagnostic: CRASH }), true);
  assert.equal(claimUsesProviderLane({ auditorFailureClass: "provider", providerErrorDiagnostic: "provider returned 503" }), true);
  assert.equal(claimUsesProviderLane({ auditorFailureClass: "provider", providerErrorDiagnostic: QUOTA }), true);
});

test("a claim with no recorded class falls back to the text test", () => {
  // A claim parked before the class existed must keep today's behaviour —
  // the fix must not silently change a legacy claim's lane.
  assert.equal(claimUsesProviderLane({ providerErrorDiagnostic: QUOTA }), true);
  assert.equal(claimUsesProviderLane({ providerErrorDiagnostic: CRASH }), true);
  assert.equal(claimUsesProviderLane({ providerErrorDiagnostic: NO_VERDICT }), false);
  assert.equal(claimUsesProviderLane(undefined), false);
});

test("the auditor's own classes are exactly the two a retry cannot fix", () => {
  assert.equal(isAuditorOwnedFailureClass("no-verdict"), true);
  assert.equal(isAuditorOwnedFailureClass("context-exhausted"), true);
  // A timeout or a transport failure is usually provider-caused and keeps
  // the widened text test.
  assert.equal(isAuditorOwnedFailureClass("timeout"), false);
  assert.equal(isAuditorOwnedFailureClass("transport"), false);
  assert.equal(isAuditorOwnedFailureClass("provider"), false);
  assert.equal(isAuditorOwnedFailureClass(undefined), false);
});

test("an auditor-owned failure keeps the bounded ladder and the horizon", () => {
  const first = auditorRetryPlan(claim({ auditorFailureClass: "no-verdict", providerErrorDiagnostic: CRASH }), undefined, undefined, false);
  assert.equal(first.unbounded, false, "an auditor-owned failure is not on the unbounded provider cadence");
  assert.equal(first.automatic, true, "it still retries automatically inside the horizon");
  assert.ok(first.autoRetryUntil, "the conservative horizon is still recorded");
  const later = auditorRetryPlan(claim({ auditorFailureClass: "no-verdict", providerErrorDiagnostic: CRASH, retryAttempts: 4 }), undefined, undefined, false);
  assert.equal(later.unbounded, false, "the bound holds for every attempt");
  assert.notEqual(later.retryAfterSec, 300, "it does not take the provider lane's five-minute cadence");
});

test("a provider wall keeps the five-minute unbounded cadence", () => {
  // v0.39.67's behaviour, unchanged: a named provider wall retries with
  // durable authority and never hits the conservative horizon.
  for (const diagnostic of [QUOTA, "provider returned 503", CRASH]) {
    const plan = auditorRetryPlan(claim({ auditorFailureClass: "provider", providerErrorDiagnostic: diagnostic }), undefined, undefined, false);
    assert.equal(plan.unbounded, true, `a provider wall is unbounded: ${diagnostic}`);
    assert.equal(plan.retryAfterSec, 300, `a provider wall retries every five minutes: ${diagnostic}`);
    assert.equal(plan.automatic, true);
  }
});

test("the identical-failure slowdown marker still fires for the auditor's own failures", () => {
  // The park site arms the slowdown only when the plan is bounded — the
  // marker is the audit lane's visible "this is not getting better" signal.
  const owned = auditorRetryPlan(claim({ auditorFailureClass: "no-verdict", providerErrorDiagnostic: CRASH }), undefined, undefined, false);
  const provider = auditorRetryPlan(claim({ auditorFailureClass: "provider", providerErrorDiagnostic: CRASH }), undefined, undefined, false);
  assert.equal(!owned.unbounded, true, "the auditor's own failures keep the slowdown marker");
  assert.equal(!provider.unbounded, false, "a provider wall keeps the hammer cadence instead");
  const streak = trackAuditorIdenticalFailure({ auditorLastFailureFingerprint: "f", auditorConsecutiveIdenticalFailures: AUDITOR_IDENTICAL_FAILURE_PARK_THRESHOLD - 1 } as any, "f");
  assert.equal(streak.identicalParkDue, true, "the streak threshold still fires");
});

test("the persistent provider lane owns a provider claim but not an auditor-owned one", () => {
  const parked = (cls: string) => ({
    goal: {
      id: "g1",
      status: "paused",
      pauseSource: "system",
      pauseKind: "wait",
      pauseReason: "auditor retry: provider error",
      pauseResumeAt: new Date(Date.now() + 60_000).toISOString(),
      pendingCompletion: {
        attemptId: "attempt-1",
        phase: "retry-waiting",
        recoveryEpisodeKey: "episode-1",
        providerErrorDiagnostic: CRASH,
        auditorFailureClass: cls,
        at: new Date().toISOString(),
      },
    },
    list: [],
    loop: null,
    mainModelRecovery: null,
  }) as any;
  assert.equal(ownsPersistentProviderWait(parked("provider")), true, "a provider claim rides the durable provider cadence");
  assert.equal(ownsPersistentProviderWait(parked("no-verdict")), false, "an auditor-owned claim keeps the auditor's own ladder");
});

test("the audit lane decides its lane through the class-aware helper", () => {
  // Structural guard: a text-only lane decision is the bug this file pins,
  // and it can come back with one edit. The audit lane must not consult the
  // raw text predicate at all.
  const source = fs.readFileSync("extensions/loops/goal-auditor-hooks.ts", "utf8");
  assert.equal(/isRecoverableProviderError/.test(source), false,
    "the audit lane's lane decision goes through claimUsesProviderLane (extensions/auditor-lane.ts)");
  // Both plan sites must pass the class of THIS failure, not the claim's
  // previous one.
  for (const file of ["extensions/loops/goal-auditor-hooks.ts", "extensions/loops/goal-tools.ts"]) {
    const text = fs.readFileSync(file, "utf8");
    assert.match(text, /auditorRetryPlan\(\{[^}]*auditorFailureClass:/,
      `${file}: the retry plan reads the class of the failure it is planning for`);
  }
});
