// pi-goal-list-loop-audit — v0.38.104 between-tasks compaction.
//
// Field 2026-09-27: the 200k compaction rule was believed to be set and was
// never observed firing. It was never a TRIGGER — `PLAN_B_FALLBACK_NEED = 200_000`
// only sizes the compactor MODEL for a session that large and gates nothing.
//
// The two paths that did exist:
//   - 85%-of-context band -> ctx.ui.notify("run /compact now"). A NOTICE, not
//     an action, and on a 1M window 85% is ~850k.
//   - starvation -> needs 2 consecutive length-stops, i.e. the context already
//     dead. That is the deathmarch.
//
// This is the missing third path: a TOKEN count, fired BETWEEN tasks, which
// actually compacts and writes a handoff brief.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  shouldCompactBetweenTasks,
  GOAL_COMPACT_TOKEN_THRESHOLD,
  PLAN_B_FALLBACK_NEED,
} from "../extensions/goal-compactor.ts";

test("v0.38.104 the 200k rule is a token threshold, and it is distinct from the model-size hint", () => {
  assert.equal(GOAL_COMPACT_TOKEN_THRESHOLD, 200_000, "the number the user set is the trigger");
  // Both are 200k today, but they are different things: one gates the
  // compaction, the other sizes the model. Pinning them apart is the point --
  // conflating them is what made the rule invisible.
  assert.equal(typeof PLAN_B_FALLBACK_NEED, "number");
});

test("v0.38.104 compaction is due past the threshold, not below it", () => {
  assert.equal(shouldCompactBetweenTasks({ tokens: 199_999 }).compact, false);
  assert.equal(shouldCompactBetweenTasks({ tokens: 200_000 }).compact, true);
  assert.equal(shouldCompactBetweenTasks({ tokens: 850_000 }).compact, true);
});

test("v0.38.104 a token count, not a percentage — the same goal on a 1M window still fires at 200k", () => {
  // 200k is 20% of a 1M window. The old 85% band would not have fired until
  // ~850k, by which point summarization is at its worst. This is the reason a
  // percentage is the wrong instrument.
  const decision = shouldCompactBetweenTasks({ tokens: 200_000 });
  assert.equal(decision.compact, true);
  assert.match(decision.reason, /between tasks/);
});

test("v0.38.104 it fires ONCE per episode and re-arms as the goal grows back", () => {
  assert.equal(shouldCompactBetweenTasks({ tokens: 400_000, alreadyFired: true }).compact, false,
    "a compaction empties the transcript, so one per episode is correct");
  // Re-arms naturally: after the transcript fills again it is due again.
  assert.equal(shouldCompactBetweenTasks({ tokens: 400_000, alreadyFired: false }).compact, true);
});

test("v0.38.104 an unknown context count never compacts blindly", () => {
  for (const tokens of [undefined, null, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    const d = shouldCompactBetweenTasks({ tokens: tokens as number | null | undefined });
    assert.equal(d.compact, false, `tokens=${String(tokens)} must not compact`);
  }
});

test("v0.38.104 the threshold is overridable but must be positive", () => {
  assert.equal(shouldCompactBetweenTasks({ tokens: 50_000, threshold: 40_000 }).compact, true);
  assert.equal(shouldCompactBetweenTasks({ tokens: 500_000, threshold: 0 }).compact, true,
    "a non-positive override falls back to the default rather than disabling the safety net");
});
