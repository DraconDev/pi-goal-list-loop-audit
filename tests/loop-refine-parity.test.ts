// pi-goal-list-loop-audit — loop-sweep parity (field 2026-09-16): the
// slash side (RESUMABLE_STOP) and the agent side
// (isRefinableStoppedLoopReason) agree on what a stopped loop allows.
// Parked loops are refinable on both surfaces; terminal stops are not.
// The one deliberate divergence: a broken measure is agent-fixable
// (tool refines it) but slash-unresumable (resume must not restart it).

import { test } from "node:test";
import * as assert from "node:assert/strict";
import { RESUMABLE_STOP } from "../extensions/goal-loop.js";
import { HELD_ON_RESTORE, isRefinableStoppedLoopReason } from "../extensions/goal-loop-forever.js";

const PARKED = [
  "paused by user (/loop pause)",
  HELD_ON_RESTORE,
  "stopped: automatic zero-stream abort — no stream opened (/loop resume to retry)",
  "stopped by user — operator hold",
  "plateau — no improvement in 5 consecutive measurements",
  "stalled: continuation start acknowledgement timed out",
  "stuck — no progress",
  "provider errors — 429 storm",
  "time bound reached (2h); best: 3",
  "token budget exhausted (1,000); best: 3",
  "metric never moved — 10 measurements without one success",
];

const TERMINAL = [
  "stopped by user (/loop stop)",
  "completed: cleaned up by user",
  "max iterations reached (50)",
  undefined,
  "",
];

test("parked loops are refinable on both surfaces", () => {
  for (const reason of PARKED) {
    assert.equal(RESUMABLE_STOP(reason), true, `slash resumable: ${reason}`);
    assert.equal(isRefinableStoppedLoopReason(reason), true, `tool refinable: ${reason}`);
  }
});

test("terminal stops are refinable on neither surface", () => {
  for (const reason of TERMINAL) {
    assert.equal(RESUMABLE_STOP(reason), false, `slash refuses: ${reason}`);
    assert.equal(isRefinableStoppedLoopReason(reason), false, `tool refuses: ${reason}`);
  }
});

test("broken measure is the deliberate divergence: tool fixes, slash will not resume", () => {
  const reason = "measure command broken — 5 consecutive null measures";
  assert.equal(isRefinableStoppedLoopReason(reason), true, "the agent repairs the measure here");
  assert.equal(RESUMABLE_STOP(reason), false, "slash resume must not restart a broken loop");
});
