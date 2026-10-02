// Paused-card owner honesty (screenshot 2026-10-01): a goal parked on a
// mainModelRecovery REMNANT — the object exists but no retry timer, model
// switch, or manual hold is live — must not claim "owner: main-model
// recovery" while the banner says "blocked — resume to continue".
// The owner names live recovery only; otherwise the pause kind owns the
// card, so the user sees one coherent next action.

import { test } from "node:test";
import * as assert from "node:assert/strict";

import { buildStatusText, buildWidgetLines } from "../extensions/goal-loop-display.ts";
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

test("stale recovery remnant does not own a blocked pause", () => {
  const state = {
    goal: goalOf({
      pauseKind: "blocked",
      pauseReason: "All contract items are met except the cold read is now INTERMITTENT",
      pauseSuggestedAction: "Run /goal resume to fix the dead-stream restart in apis/libs/api-core.",
    }),
    list: [],
    mainModelRecovery: {
      primary: "provider/session-model",
      attempted: ["provider/session-model"],
      attempts: 1,
      reason: "provider unavailable",
      kind: "goal",
    },
  } as State;
  const status = buildStatusText(state, null, NOW)!;
  assert.doesNotMatch(status, /owner: main-model recovery/, `no stale owner claim:\n${status}`);
  assert.match(status, /owner: manual action/, `pause kind owns the card:\n${status}`);
  const text = buildWidgetLines(state, null, NOW)!.join("\n");
  assert.doesNotMatch(text, /owner: main-model recovery/, `no stale owner claim:\n${text}`);
  assert.match(text, /owner: manual action/, `pause kind owns the card:\n${text}`);
  assert.match(text, /blocked — resume to continue/, `banner names the action:\n${text}`);
});

test("live recovery timer still owns a blocked pause", () => {
  const retryAt = new Date(NOW + 20 * 60_000).toISOString();
  const state = {
    goal: goalOf({ pauseKind: "blocked", pauseReason: "provider error" }),
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
  assert.match(status, /owner: main-model recovery/, `live recovery owns the card:\n${status}`);
  const text = buildWidgetLines(state, null, NOW)!.join("\n");
  assert.match(text, /owner: main-model recovery/, `live recovery owns the card:\n${text}`);
});
