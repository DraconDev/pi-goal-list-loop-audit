// pi-goal-list-loop-audit — v0.5.0
// tests/heartbeat.test.ts
//
// Unit tests for the heartbeat self-watchdog: stall detection and
// nudge accounting. This replaces the external pi-compaction-continue
// plugin for our loops — liveness is the loop's own job.

import { test } from "node:test";
import * as assert from "node:assert/strict";

import {
  accountTurnForNudges,
  BACKOFF_HARD_CAP_MS,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_MAX_NUDGES,
  HEARTBEAT_STALL_MS,
  shouldHeartbeatRefire,
  shouldWedgeAlert,
  WEDGE_ALERT_DEFAULT_MINUTES,
  MEASURE_TIMEOUT_MS,
  AUDITOR_STALL_MS,
} from "../extensions/goal-loop-backoff.ts";

// ---- shouldHeartbeatRefire ----

test("fires: supervising + idle + no timer + quiet long enough", () => {
  assert.equal(shouldHeartbeatRefire({
    supervising: true,
    sessionIdle: true,
    timerPending: false,
    msSinceActivity: HEARTBEAT_STALL_MS,
  }), true);
});

test("does not fire when not supervising", () => {
  assert.equal(shouldHeartbeatRefire({
    supervising: false,
    sessionIdle: true,
    timerPending: false,
    msSinceActivity: HEARTBEAT_STALL_MS * 10,
  }), false);
});

test("does not fire when session is busy", () => {
  assert.equal(shouldHeartbeatRefire({
    supervising: true,
    sessionIdle: false,
    timerPending: false,
    msSinceActivity: HEARTBEAT_STALL_MS * 10,
  }), false);
});

test("does not fire when a continuation is already scheduled", () => {
  assert.equal(shouldHeartbeatRefire({
    supervising: true,
    sessionIdle: true,
    timerPending: true,
    msSinceActivity: HEARTBEAT_STALL_MS * 10,
  }), false);
});

test("does not fire before the stall threshold", () => {
  assert.equal(shouldHeartbeatRefire({
    supervising: true,
    sessionIdle: true,
    timerPending: false,
    msSinceActivity: HEARTBEAT_STALL_MS - 1,
  }), false);
});

test("custom stall threshold is honored", () => {
  assert.equal(shouldHeartbeatRefire({
    supervising: true,
    sessionIdle: true,
    timerPending: false,
    msSinceActivity: 5_000,
    stallMs: 5_000,
  }), true);
});

// ---- accountTurnForNudges ----

test("zero-tool turn increments the nudge count", () => {
  assert.equal(accountTurnForNudges(0, 0), 1);
  assert.equal(accountTurnForNudges(0, 1), 2);
  assert.equal(accountTurnForNudges(0, 2), HEARTBEAT_MAX_NUDGES);
});

test("tool-using turn resets the count", () => {
  assert.equal(accountTurnForNudges(1, 2), 0);
  assert.equal(accountTurnForNudges(7, 0), 0);
});

// ---- v0.23.2: wedge alert (busy-but-silent = hung command) ----

test("shouldWedgeAlert: fires when supervising + busy + silent past threshold", () => {
  assert.equal(shouldWedgeAlert({
    supervising: true, sessionBusy: true,
    silentMs: 46 * 60_000, msSinceLastAlert: 46 * 60_000, thresholdMs: 45 * 60_000,
  }), true);
});

test("shouldWedgeAlert: silent below threshold does not fire", () => {
  assert.equal(shouldWedgeAlert({
    supervising: true, sessionBusy: true,
    silentMs: 10 * 60_000, msSinceLastAlert: 100 * 60_000, thresholdMs: 45 * 60_000,
  }), false);
});

test("shouldWedgeAlert: idle session is the heartbeat's job, not ours", () => {
  assert.equal(shouldWedgeAlert({
    supervising: true, sessionBusy: false,
    silentMs: 100 * 60_000, msSinceLastAlert: 100 * 60_000, thresholdMs: 45 * 60_000,
  }), false);
});

test("shouldWedgeAlert: not supervising never fires", () => {
  assert.equal(shouldWedgeAlert({
    supervising: false, sessionBusy: true,
    silentMs: 100 * 60_000, msSinceLastAlert: 100 * 60_000, thresholdMs: 45 * 60_000,
  }), false);
});

test("shouldWedgeAlert: throttled to once per threshold interval", () => {
  assert.equal(shouldWedgeAlert({
    supervising: true, sessionBusy: true,
    silentMs: 100 * 60_000, msSinceLastAlert: 5 * 60_000, thresholdMs: 45 * 60_000,
  }), false);
});

test("shouldWedgeAlert: threshold 0 disables", () => {
  assert.equal(shouldWedgeAlert({
    supervising: true, sessionBusy: true,
    silentMs: 100 * 60_000, msSinceLastAlert: 100 * 60_000, thresholdMs: 0,
  }), false);
});

// ---- v0.23.3: timing defaults stay tight (regression guards) ----

test("timing defaults: wedge 30m, measure 10m, auditor stall 10m", () => {
  assert.equal(WEDGE_ALERT_DEFAULT_MINUTES, 30);
  assert.equal(MEASURE_TIMEOUT_MS, 10 * 60_000);
  assert.equal(AUDITOR_STALL_MS, 10 * 60_000);
  // The family invariant: every wait has a bound, every bound is minutes
  // not hours, and no bound is infinite.
  for (const ms of [HEARTBEAT_INTERVAL_MS, HEARTBEAT_STALL_MS, MEASURE_TIMEOUT_MS, AUDITOR_STALL_MS, BACKOFF_HARD_CAP_MS]) {
    assert.ok(ms > 0 && ms <= 30 * 60_000, `bound out of range: ${ms}`);
  }
});
