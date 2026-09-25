// pi-goal-list-loop-audit — v0.38.99
// tests/audit-lifecycle.test.ts
//
// The detached completion audit has ONE durable lifecycle, projected from the
// stored claim. These tests pin the projection itself: every objective-visible
// state, the terminality rule (an unresolved audit is never terminal), the
// no-progress classification that survives a restart, and the settlement
// state machine that gates every terminal render.

import { test } from "node:test";
import * as assert from "node:assert/strict";

import {
  AUDIT_ACTIVITY_PERSIST_MS,
  AUDIT_NO_PROGRESS_MS,
  auditLifecycleLine,
  auditLifecycleProjection,
  auditPhaseOwnsAttempt,
  fmtAge,
  isSettlingClaim,
  normalizeAuditPhase,
  settlementAllowsTerminalRender,
  settlementPark,
  settlementStep,
  type AuditClaimLike,
} from "../extensions/audit-lifecycle.ts";

const NOW = Date.parse("2026-09-25T12:00:00.000Z");
const ago = (ms: number): string => new Date(NOW - ms).toISOString();

function claim(overrides: Partial<AuditClaimLike> = {}): AuditClaimLike {
  return { at: ago(60_000), phase: "running", ...overrides };
}

// ---- the five objective states, each from its own durable evidence ----

test("lifecycle: a fresh claim is STARTING, not running — the launch window is represented", () => {
  const projection = auditLifecycleProjection(claim({ at: ago(30_000), phase: "starting", startedAt: ago(8_000) }), { now: NOW })!;
  assert.equal(projection.state, "starting");
  assert.equal(projection.phase, "starting");
  assert.equal(projection.terminal, false, "starting is never terminal");
  assert.equal(projection.stale, false);
  // v0.38.99: launch time is NOT worker evidence. A claim waiting for its
  // first worker event has NO lastActivityAt, and the launch age is its own
  // named fact. The previous shape back-filled `lastActivityAt` from
  // `startedAt`, which made a launch look like auditor activity.
  assert.equal(projection.lastActivityAt, undefined, "no worker event means no last activity");
  assert.equal(projection.lastEvent, "claim-stored");
  assert.equal(projection.claimRunMs, 8_000, "the launch age is exposed as its own fact");
  assert.match(auditLifecycleLine(projection)!, /^starting · launched 8s ago, no worker event yet/);
});

test("lifecycle: the launch window is reported as no-first-event once it passes the window", () => {
  const stuck = auditLifecycleProjection(claim({ phase: "starting", startedAt: ago(AUDIT_NO_PROGRESS_MS + 120_000), at: ago(AUDIT_NO_PROGRESS_MS + 100_000) }), { now: NOW })!;
  assert.equal(stuck.stale, true, "a claim with no worker event past the window is a stuck launch");
  assert.equal(stuck.lastEvent, "claim-stored", "and the evidence kind stays honest");
  assert.match(auditLifecycleLine(stuck)!, /no first event for 11m 40s/, "the no-first-event age is quoted from the launch, not rounded away");
  assert.match(stuck.nextAction, /\/goal cancel discards the claim/, "the next action is still real");
});

test("lifecycle: a starting claim that HAS produced worker activity is running, with the worker's own stamp", () => {
  const live = auditLifecycleProjection(claim({ at: ago(700_000), phase: "running", startedAt: ago(600_000), lastActivityAt: ago(20_000) }), { now: NOW })!;
  assert.equal(live.lastActivityAt, ago(20_000), "the durable stamp is the worker's own event");
  assert.equal(live.lastEvent, "worker-activity");
  assert.equal(live.idleMs, 20_000);
  assert.match(auditLifecycleLine(live)!, /last worker activity 20s ago/);
});

test("lifecycle: a park is a park, not worker activity", () => {
  const parked = auditLifecycleProjection(claim({ at: ago(180_000), phase: "recovery-pending", recoveryAt: ago(30_000), startedAt: ago(120_000), lastActivityAt: ago(120_000) }), { now: NOW })!;
  assert.equal(parked.state, "recovery-needed");
  assert.equal(parked.lastEvent, "parked", "the park is newer than the last worker event, and is quoted as the park");
  assert.equal(parked.idleMs, 30_000, "the park time is the freshest durable fact");
  assert.match(auditLifecycleLine(parked)!, /^recovery needed · parked 30s ago/);
});

test("lifecycle: a settling claim reports the applied verdict, not a worker event", () => {
  const settling = auditLifecycleProjection(claim({ at: ago(100_000), phase: "settling", verdictAt: ago(4_000), startedAt: ago(90_000) }), { now: NOW })!;
  assert.equal(settling.state, "settling");
  assert.equal(settling.lastActivityAt, undefined, "no worker event is invented for a settlement");
  assert.equal(settling.lastEvent, "verdict-applied");
  assert.equal(settling.sinceLastEventMs, 4_000);
  assert.equal(settling.terminal, false, "an unresolved settlement is not a completion");
  assert.equal(isSettlingClaim(claim({ phase: "settling" })), true);
  assert.match(settling.nextAction, /archiving the approved goal/);
  assert.match(auditLifecycleLine(settling)!, /^settling · verdict applied 4s ago/);
});

test("lifecycle: running with last activity, and a quiet one reported as no progress", () => {
  const moving = auditLifecycleProjection(claim({ at: ago(25 * 60_000), phase: "running", startedAt: ago(20 * 60_000), lastActivityAt: ago(45_000) }), { now: NOW })!;
  assert.equal(moving.state, "running");
  assert.equal(moving.idleMs, 45_000);
  assert.equal(moving.stale, false);
  assert.match(auditLifecycleLine(moving)!, /last worker activity 45s ago/);

  // `at` older than the worker stamp, so the stamp is the freshest evidence.
  const silent = auditLifecycleProjection(claim({ at: ago(45 * 60_000), phase: "running", startedAt: ago(40 * 60_000), lastActivityAt: ago(AUDIT_NO_PROGRESS_MS + 60_000) }), { now: NOW })!;
  assert.equal(silent.stale, true, "an attempt this process owns with no durable progress past the window is no-progress");
  assert.match(auditLifecycleLine(silent)!, /no progress for 11m/);
  // The next action must be a real command, not a promise.
  assert.match(silent.nextAction, /\/goal resume retries the stored claim/);
});

test("lifecycle: the activity heartbeat is throttled, so a chatty auditor cannot flood the ledger", () => {
  assert.ok(AUDIT_ACTIVITY_PERSIST_MS >= 15_000, "the persist cadence is a heartbeat, not per-event logging");
  assert.ok(AUDIT_NO_PROGRESS_MS > AUDIT_ACTIVITY_PERSIST_MS, "no-progress must be looser than the heartbeat");
});

test("lifecycle: an applied approval awaiting its archive is SETTLING — never terminal", () => {
  const projection = auditLifecycleProjection(claim({ phase: "settling", verdictAt: ago(4_000), startedAt: ago(90_000) }), { now: NOW })!;
  assert.equal(projection.phase, "settling");
  assert.equal(projection.terminal, false, "an unresolved settlement is not a completion");
  assert.match(projection.nextAction, /archiving the approved goal/);
});

test("lifecycle: approved is a SETTLEMENT state, and only the settlement may claim it", () => {
  const unresolved = claim({ phase: "settling", verdictAt: ago(4_000) });
  assert.equal(auditLifecycleProjection(unresolved, { now: NOW })!.terminal, false);
  const settled = auditLifecycleProjection(unresolved, { now: NOW, settled: true })!;
  assert.equal(settled.state, "approved");
  assert.equal(settled.terminal, true);
  assert.match(settled.nextAction, /settlement durable/);
  assert.match(auditLifecycleLine(settled)!, /^approved · settled 4s ago/);
  // A claim can never carry `approved` as a durable phase: the archive
  // releases the claim, so an approved claim cannot outlive its settlement.
  assert.equal(normalizeAuditPhase("approved"), "recovery-pending", "no durable approved phase exists");
});

test("lifecycle: an interrupted or unknown claim is RECOVERY NEEDED with a real next action", () => {
  const legacy = auditLifecycleProjection({ at: ago(5 * 60_000), completionSummary: "claim" } as AuditClaimLike, { now: NOW })!;
  assert.equal(legacy.state, "recovery-needed");
  assert.equal(legacy.legacy, true);
  assert.equal(legacy.terminal, false);
  assert.match(legacy.nextAction, /\/goal resume retries the stored claim/);
  assert.match(auditLifecycleLine(legacy)!, /^recovery needed · parked /);

  const parked = auditLifecycleProjection(claim({ at: ago(180_000), phase: "recovery-pending", recoveryAt: ago(30_000), startedAt: ago(120_000) }), { now: NOW })!;
  assert.equal(parked.state, "recovery-needed");
  // The park time is the freshest durable fact for a parked claim — not the
  // start of the attempt that was interrupted.
  assert.equal(parked.idleMs, 30_000);
  assert.equal(parked.lastEvent, "parked");
});

test("lifecycle: a retry-waiting claim is distinct, and names the armed retry", () => {
  const waiting = auditLifecycleProjection(claim({ phase: "retry-waiting", recoveryRetryAt: new Date(NOW + 42_000).toISOString() }), { now: NOW })!;
  assert.equal(waiting.state, "retry-waiting");
  assert.equal(waiting.terminal, false);
  assert.match(waiting.nextAction, /auto-retry in 42s/);
});

test("lifecycle: phase migration and attempt ownership stay explicit", () => {
  assert.equal(normalizeAuditPhase("quota-waiting"), "retry-waiting", "the v0.34.142 spelling migrates on read");
  assert.equal(normalizeAuditPhase(undefined), "recovery-pending");
  assert.equal(normalizeAuditPhase("nonsense"), "recovery-pending");
  assert.equal(auditPhaseOwnsAttempt("starting"), true);
  assert.equal(auditPhaseOwnsAttempt("running"), true);
  assert.equal(auditPhaseOwnsAttempt("settling"), true);
  assert.equal(auditPhaseOwnsAttempt("recovery-pending"), false);
  assert.equal(auditPhaseOwnsAttempt("retry-waiting"), false);
  assert.equal(isSettlingClaim(undefined), false);
});

test("lifecycle: a claim with no usable timestamp never invents an age", () => {
  const projection = auditLifecycleProjection({ phase: "running" } as AuditClaimLike, { now: NOW })!;
  assert.equal(projection.idleMs, undefined);
  assert.equal(projection.ageMs, 0);
  assert.equal(projection.lastEvent, "none");
  assert.equal(projection.stale, false, "no evidence is not evidence of a stall");
  assert.match(auditLifecycleLine(projection)!, /no worker event recorded/);
});

test("lifecycle: a future activity stamp clamps instead of rendering a negative age", () => {
  const projection = auditLifecycleProjection(claim({ phase: "running", lastActivityAt: new Date(NOW + 60_000).toISOString() }), { now: NOW })!;
  assert.equal(projection.idleMs, 0);
  assert.equal(projection.stale, false);
});

// ---- the settlement state machine: the terminality gate ----

test("settlement: an unresolved claim can never reach a terminal render", () => {
  const unresolved = { verdictPersisted: false, archived: false, renderPersisted: false, delivered: false };
  assert.equal(settlementStep(unresolved).step, "persist-verdict");
  assert.equal(settlementStep(unresolved).terminal, false);
  assert.equal(settlementAllowsTerminalRender(unresolved), false);

  // Verdict durable, archive missing — the crash window the lifecycle exists
  // for. A summary is still refused.
  const crashWindow = { ...unresolved, verdictPersisted: true };
  assert.equal(settlementStep(crashWindow).step, "archive");
  assert.equal(settlementAllowsTerminalRender(crashWindow), false, "no terminal render before the archive lands");

  const archived = { ...crashWindow, archived: true };
  assert.equal(settlementAllowsTerminalRender(archived), true);
  assert.equal(settlementStep(archived).step, "persist-render");
  assert.equal(settlementStep({ ...archived, renderPersisted: true }).step, "deliver-render");
  const done = settlementStep({ ...archived, renderPersisted: true, delivered: true });
  assert.equal(done.step, "settled");
  assert.equal(done.terminal, true);
  assert.equal(done.parked, false);
});

test("settlement: a failed write or archive parks instead of claiming success", () => {
  for (const stage of ["verdict", "archive"] as const) {
    const parked = settlementPark(stage);
    assert.equal(parked.parked, true);
    assert.equal(parked.terminal, false);
    assert.equal(parked.step, stage === "verdict" ? "park-verdict" : "park-archive");
  }
});

test("lifecycle: the age formatter is the shared vocabulary", () => {
  assert.equal(fmtAge(-5), "0s");
  assert.equal(fmtAge(45_000), "45s");
  assert.equal(fmtAge(45_000 + 60_000), "1m 45s");
  assert.equal(fmtAge(2 * 3_600_000 + 5 * 60_000), "2h 05m");
});
