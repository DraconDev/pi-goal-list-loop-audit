// Relentless auto-continue: truthful status while auto-retry is armed
// (field 151113). The card showed "paused" while the glla recovery timer
// was actively auto-retrying with the next probe scheduled — the user asked
// "but is it actually working cause we show paused". A supervised auditor
// wait with an armed retry is RECOVERING, not paused.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import { buildWidgetLines, buildStatusText } from "../extensions/goal-loop-display.ts";
import type { Goal, State } from "../extensions/goal-loop-core.ts";

function auditorRetryGoal(): Goal {
  const at = new Date(Date.now() + 49 * 60_000).toISOString();
  return {
    id: "g1",
    objective: "Army transfer API + UI",
    policy: "goal",
    status: "paused",
    createdAt: new Date(Date.now() - 60_000).toISOString(),
    pauseKind: "wait",
    pauseReason: "auditor retry: provider 429 quota wall",
    pauseResumeAt: at,
    pauseSuggestedAction: "Auto-retry continues — or resume now",
    recoveryEpisodeKey: "test-episode:quota",
    pendingCompletion: {
      phase: "retry-waiting",
      recoveryRetryAt: at,
    },
  } as unknown as Goal;
}
const stateOf = (g: Goal): State => ({ goal: g, list: [], loop: null }) as unknown as State;

test("151113: supervised auditor wait with armed retry renders recovering, not paused", () => {
  const lines = buildWidgetLines(stateOf(auditorRetryGoal()), null, Date.now(), undefined, 100)!;
  const text = lines.join("\n");
  assert.match(text, /recovering/, `head says recovering:\n${text}`);
});

test("151113: status line keeps the auto-retrying countdown for the armed wait", () => {
  const status = buildStatusText(stateOf(auditorRetryGoal()), null, Date.now(), undefined, undefined, 100)!;
  assert.match(status, /auto-retrying/, `status auto-retries:\n${status}`);
});

test("151113: bare user wait with no armed retry still renders paused, never recovering", () => {
  const g = auditorRetryGoal();
  delete (g as unknown as Record<string, unknown>).pendingCompletion;
  (g as unknown as Record<string, unknown>).recoveryEpisodeKey = undefined;
  g.pauseResumeAt = undefined;
  const lines = buildWidgetLines(stateOf(g), null, Date.now(), undefined, 100)!;
  const text = lines.join("\n");
  assert.doesNotMatch(text, /recovering/, `no false recovering:\n${text}`);
});
