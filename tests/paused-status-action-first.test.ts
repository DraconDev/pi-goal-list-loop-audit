// Paused status lines that need the USER lead with the next action.
// Narrow terminals truncate the status tail — the resume command must come
// first, not ride after lifecycle/owner/activity where truncation kills it.
// Waits (nobody's move) deliberately keep lifecycle-first order.

import { test } from "node:test";
import * as assert from "node:assert/strict";

import { buildStatusText } from "../extensions/goal-loop-display.ts";
import type { Goal, State } from "../extensions/goal-loop-core.ts";

const NOW = Date.parse("2026-10-01T12:00:00Z");

function goalOf(overrides: Partial<Goal> = {}): Goal {
  return {
    id: "20261001120000-abcdef",
    objective: "Materialise views-per-hour into a stored, indexed column",
    status: "paused",
    policy: "goal",
    autoContinue: true,
    usage: { tokensUsed: 3_721_000, tokensLimit: 0 },
    createdAt: "2026-09-30T23:08:00Z",
    updatedAt: "2026-10-01T11:59:00Z",
    ...overrides,
  };
}

function assertActionFirst(status: string, next: string): void {
  const at = status.indexOf(next);
  assert.ok(at >= 0, `next action present:\n${status}`);
  for (const later of ["safely parked", "owner:", "queue empty", "last host activity"]) {
    const other = status.indexOf(later);
    assert.ok(other > at, `${next} precedes ${later}:\n${status}`);
  }
}

test("blocked status leads with the resume command", () => {
  const state = {
    goal: goalOf({ pauseKind: "blocked", pauseReason: "provider error" }),
    list: [],
  } as State;
  const status = buildStatusText(state, null, NOW)!;
  assert.match(status, /action needed/);
  assertActionFirst(status, "next: /goal resume");
});

test("decision status leads with the decision path", () => {
  const state = {
    goal: goalOf({ pauseKind: "decision", pauseReason: "pick one", pauseOptions: ["a", "b"] }),
    list: [],
  } as State;
  const status = buildStatusText(state, null, NOW)!;
  assert.match(status, /decision needed/);
  assertActionFirst(status, "next: user decision → /goal decide");
});

test("error status leads with the manual path", () => {
  const state = {
    goal: goalOf({ pauseKind: "error", pauseReason: "disk full" }),
    list: [],
  } as State;
  const status = buildStatusText(state, null, NOW)!;
  assert.match(status, /action needed/);
  assertActionFirst(status, "next: manual action → /goal resume");
});

test("manual recovery hold leads with resume", () => {
  const state = {
    goal: goalOf({ pauseKind: "blocked", pauseReason: "main model recovery — automatic probes stopped" }),
    list: [],
    mainModelRecovery: {
      primary: "provider/session-model",
      attempted: ["provider/session-model"],
      attempts: 9,
      manualResumeRequired: true,
      reason: "provider unavailable",
      kind: "goal",
    },
  } as State;
  const status = buildStatusText(state, null, NOW)!;
  assert.match(status, /manual recovery hold/);
  assert.match(status, /owner: main-model recovery/);
  assertActionFirst(status, "next: /goal resume");
});

test("supervised waits keep lifecycle-first order (nobody's move)", () => {
  const retryAt = new Date(NOW + 20 * 60_000).toISOString();
  const state = {
    goal: goalOf({ pauseKind: "wait", pauseReason: "main model recovery — retrying", pauseResumeAt: retryAt }),
    list: [],
    mainModelRecovery: {
      primary: "provider/session-model",
      attempted: ["provider/session-model"],
      attempts: 1,
      retryAt,
      reason: "provider unavailable",
      kind: "goal",
    },
  } as State;
  const status = buildStatusText(state, null, NOW)!;
  const parked = status.indexOf("safely parked");
  const next = status.indexOf("next: retrying automatically");
  assert.ok(parked >= 0 && next > parked, `wait stays lifecycle-first:\n${status}`);
});
