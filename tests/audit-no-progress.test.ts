// pi-goal-list-loop-audit — v0.39.69
// tests/audit-no-progress.test.ts
//
// Field 2026-11-10: "if the model runs out then the audit never completes".
//
// The operator's screenshot: a list item at `paused by GLLA · EXECUTION
// UNCONFIRMED · age 4h 24m`, with the transcript repeating
//
//   Warning: Auditor still failing — next auto-retry in 5m …
//   Auditor provider retry is due — starting a detached retry …
//
// and `next: /glla status to inspect execution`. The plan quota was gone for
// good. Three separate defects produced that shape:
//
//   1. the audit lane IGNORED the provider's quoted reset. The main lane has
//      honoured `resets <ISO>` since v0.38.69 (a weekly wall sleeps the
//      per-attempt envelope and re-evaluates); the audit lane re-armed a flat
//      five minutes at EVERY attempt, twelve times an hour, for the whole
//      outage.
//   2. there was NO no-progress stop at all: `unbounded` held at attempt 501.
//      A wall with no reset hint repeated forever and never asked the
//      operator anything.
//   3. a `provider-retry` used to re-walk the BURNED cursor, so the model that
//      was out of quota (or retired) was retried by name every five minutes
//      even when a configured fallback existed — the operator's rule is "if we
//      have a fallback model we should be using that too".
//
// What must hold:
//   - a quoted reset (even a week away) is WAITED FOR, not hammered, and it
//     suspends the no-progress escalation because the wait is scheduled;
//   - a wall with no reset hint keeps the durable cadence and escalates to a
//     decision after the long bound, so the audit never retries forever
//     without telling anyone;
//   - a model that no longer resolves escalates on a short grace instead of
//     burning six hours of launches;
//   - the provider-retry origin reseeds the candidate cursor but keeps the
//     episode clock, so reseeding cannot reset the no-progress bound.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import fs from "node:fs";

import {
  AUDIT_DEAD_MODEL_ESCALATE_MS,
  AUDIT_NO_PROGRESS_ESCALATE_MS,
  auditNoProgressEscalation,
  auditResetWaitMs,
} from "../extensions/auditor-lane.ts";
import { auditorRetryPlan } from "../extensions/loops/goal-auditor-hooks.ts";
import { reseededAuditorCursorClaim } from "../extensions/goal-loop-core.ts";
import { MAIN_MODEL_AUTO_RETRY_HORIZON_MS, MAIN_MODEL_MAX_RETRY_DELAY_MS } from "../extensions/main-model-recovery.ts";

const ago = (ms: number): string => new Date(Date.now() - ms).toISOString();
const ahead = (ms: number): string => new Date(Date.now() + ms).toISOString();
const HOUR = 3_600_000;

const quotaWall = (resetInMs?: number): string => resetInMs === undefined
  ? "429 quota exceeded, token plan limit reached"
  : `429 {"error":{"type":"quota_exceeded","message":"plan quota exhausted. resets ${ahead(resetInMs)}"}}`;
const RETIRED = "model not found: crouton-alpha";

function claim(diagnostic: string, overrides: Record<string, unknown> = {}): any {
  return {
    at: ago(8 * HOUR),
    completionSummary: "stored completion claim",
    retryAttempts: 12,
    retryFirstAt: ago(8 * HOUR),
    providerErrorDiagnostic: diagnostic,
    auditorFailureClass: "provider",
    ...overrides,
  };
}

test("a quoted reset is waited for instead of being hammered every five minutes", () => {
  // The exact field failure: the audit re-armed 300s at every attempt while
  // the provider had said when it would answer.
  const fiveHour = auditorRetryPlan(claim(quotaWall(5 * HOUR)), undefined, undefined, false);
  assert.ok(fiveHour.retryAfterSec >= 5 * HOUR / 1000 - 5, `waits for the quoted 5h reset, got ${fiveHour.retryAfterSec}s`);
  assert.ok(fiveHour.resetAt, "the plan names the reset deadline");
  // A weekly reset is waited for too (in per-attempt envelope slices).
  const weekly = auditorRetryPlan(claim(quotaWall(6 * 24 * HOUR)), undefined, undefined, false);
  assert.equal(weekly.retryAfterSec, MAIN_MODEL_MAX_RETRY_DELAY_MS / 1000,
    "a reset beyond the per-attempt envelope sleeps the envelope and re-evaluates");
  assert.ok(weekly.resetAt);
  // No hint, no waiting: the durable five-minute cadence stays.
  const bare = auditorRetryPlan(claim(quotaWall()), undefined, undefined, false);
  assert.equal(bare.retryAfterSec, 300, "a wall with no reset hint keeps the five-minute cadence");
  assert.equal(bare.resetAt, undefined);
});

test("waiting on a quoted reset suspends the no-progress escalation", () => {
  // A five-hour plan quota can legitimately swallow a whole audit, so elapsed
  // time alone must not escalate while the provider has named a deadline.
  const waiting = auditNoProgressEscalation(claim(quotaWall(5 * HOUR), { auditorNoProgressSince: ago(9 * HOUR) }));
  assert.equal(waiting?.reason, "waiting", "a scheduled wait is not a stall");
  assert.ok(waiting && "resetAt" in waiting && Number.isFinite(Date.parse(waiting.resetAt)));
});

test("a wall with no reset hint escalates after the long bound instead of retrying forever", () => {
  // Younger than the bound: keep retrying, say nothing.
  assert.equal(auditNoProgressEscalation(claim(quotaWall(), {
    auditorNoProgressSince: ago(AUDIT_NO_PROGRESS_ESCALATE_MS - HOUR),
  })), undefined, "a young episode keeps retrying");
  // Older than the bound: stop and ask.
  const escalated = auditNoProgressEscalation(claim(quotaWall(), {
    auditorNoProgressSince: ago(AUDIT_NO_PROGRESS_ESCALATE_MS + HOUR),
  }));
  assert.equal(escalated?.reason, "no-progress");
  // The bound must clear every quota window a single audit can legitimately
  // eat, and stay inside the day the field case proved is too long.
  assert.ok(AUDIT_NO_PROGRESS_ESCALATE_MS > 5 * HOUR, "a 5h plan quota is waited out, never escalated");
  assert.ok(AUDIT_NO_PROGRESS_ESCALATE_MS <= 12 * HOUR, "and the bound is well inside a working day");
});

test("a model that no longer resolves escalates on a short grace", () => {
  // Waiting cannot produce a model the provider no longer serves.
  assert.equal(auditNoProgressEscalation(claim(RETIRED, {
    auditorNoProgressSince: ago(AUDIT_DEAD_MODEL_ESCALATE_MS - 5 * 60_000),
  })), undefined, "a brief grace still absorbs a catalogue hiccup");
  const dead = auditNoProgressEscalation(claim(RETIRED, {
    auditorNoProgressSince: ago(AUDIT_DEAD_MODEL_ESCALATE_MS + 60_000),
  }));
  assert.equal(dead?.reason, "dead-model", "a retired model asks for a person, not another timer");
  assert.ok(AUDIT_DEAD_MODEL_ESCALATE_MS < AUDIT_NO_PROGRESS_ESCALATE_MS);
});

test("the episode stamp survives a cursor reseed but the cursor does not", () => {
  // Fix 3: the provider-retry origin reseeds candidates so a configured
  // fallback is actually used, but it must NOT reset the no-progress clock.
  const burned = claim(quotaWall(), {
    auditorNoProgressSince: ago(7 * HOUR),
    auditorFallbackExhausted: true,
    auditorCandidateRefs: ["provider/crouton-alpha"],
    auditorAttemptedRefs: ["provider/crouton-alpha"],
    auditorEvictedRefs: ["provider/crouton-alpha"],
    auditorConsecutiveIdenticalFailures: 4,
    exhaustedChain: "provider/crouton-alpha",
    retryAttempts: 12,
  });
  const reseeded = reseededAuditorCursorClaim(burned);
  for (const key of ["auditorCandidateRefs", "auditorAttemptedRefs", "auditorFallbackExhausted", "auditorConsecutiveIdenticalFailures", "exhaustedChain"]) {
    assert.equal(key in reseeded, false, `the cursor clears ${key}, so a fallback candidate is re-resolved`);
  }
  // Eviction is PROOF a ref is dead, not cycle state: a retired model must not
  // come back just because the cursor was reseeded.
  assert.deepEqual(reseeded.auditorEvictedRefs, burned.auditorEvictedRefs,
    "a ref proven unresolvable stays evicted across the reseed");
  assert.equal(reseeded.auditorNoProgressSince, burned.auditorNoProgressSince,
    "the episode clock survives, so reseeding cannot reset the no-progress bound");
  assert.equal(reseeded.retryAttempts, 12, "the attempt count survives too");
  assert.equal(reseeded.providerErrorDiagnostic, burned.providerErrorDiagnostic,
    "the quoted-reset wait is read from the diagnostic, so it must survive");
  assert.ok(MAIN_MODEL_AUTO_RETRY_HORIZON_MS > 0);
  assert.equal(auditResetWaitMs({ providerErrorDiagnostic: RETIRED }), undefined, "a dead model quotes no reset");
});

test("the escalation gate is wired into the dispatch path, for automatic origins only", () => {
  const source = fs.readFileSync("extensions/loops/goal-auditor-hooks.ts", "utf8");
  assert.match(source, /auditNoProgressEscalation\(pending\)/,
    "the dispatch path consults the no-progress bound before launching");
  assert.match(source, /audit_no_progress_escalated/,
    "the escalation is journaled as durable evidence");
  assert.match(source, /reason !== "waiting"/,
    "a scheduled reset wait never escalates");
  // The gate lives inside the automatic-origin branch (manual/agent consent
  // always dispatches).
  const gate = source.indexOf("auditNoProgressEscalation(pending)");
  const originGate = source.lastIndexOf('origin !== "manual" && origin !== "agent"', gate);
  assert.ok(originGate > 0 && originGate < gate, "the escalation only governs automatic origins");
});
