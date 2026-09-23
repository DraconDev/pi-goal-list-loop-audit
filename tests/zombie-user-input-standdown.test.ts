// Tests for the v0.36.1 zombie-watchdog user-input stand-down
// (extensions/goal-heartbeat.ts). Field case: resuming a goal whose turn
// re-opened a decision popup / drafting confirm / ask_user_question looked
// like a hung provider stream (BUSY + zero stream activity), so the zombie
// watchdog aborted the dialog mid-answer and parked the run; the bounded
// auto-retry re-opened the SAME dialog and the second silence parked it
// permanently. A human-input wait must stand the zombie branch down exactly
// like a subagent wait.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { isUserInputWaitCall } from "../extensions/goal-heartbeat.ts";

const HEARTBEAT_SRC = fs.readFileSync("extensions/goal-heartbeat.ts", "utf-8");

test("user-input wait set covers glla dialogs and structured-question tools", () => {
  // glla goal-toolkit verbs whose handlers await Confirm/select pickers:
  for (const name of [
    "pause_goal",
    "propose_goal_draft",
    "propose_loop_draft",
    "propose_loop_refine",
    "propose_task_list",
    "list_add",
    "list_activate",
    // external structured-question provider:
    "ask_user_question",
  ]) {
    assert.equal(isUserInputWaitCall({ name }), true, `${name} is a user-input wait`);
  }
});

test("execution/reads/subagent tools are NOT user-input waits", () => {
  for (const name of ["bash", "read", "edit", "Agent", "subagent_wait", undefined]) {
    assert.equal(isUserInputWaitCall({ name: name as string | undefined }), false);
  }
  assert.equal(isUserInputWaitCall({}), false);
});

test("zombie branch stands down on human-input waits with its own ledger event", () => {
  // The carve-out condition must include the user-input check BESIDE the
  // subagent one, and the stand-down ledger must name which kind fired:
  assert.match(
    HEARTBEAT_SRC,
    /if \(subagentWaitInFlight \|\| userInputWaitInFlight\) \{/,
    "both wait kinds share the stand-down branch",
  );
  assert.match(HEARTBEAT_SRC, /zombie_run_stood_down_user_input/);
  assert.match(HEARTBEAT_SRC, /zombie_run_stood_down_subagent_wait/);
});

test("stand-down ledger is latched per silent episode, not per tick", () => {
  // Field 2026-09-22: 219 zombie_run_stood_down_user_input entries in a day
  // — the branch logged on EVERY heartbeat tick while a user-input wait was
  // pending, unlike the abort path's abortKey latch. Same key space, same
  // releases: one entry per episode, fresh attempts re-log.
  assert.match(HEARTBEAT_SRC, /let lastZombieStandDownKey = "";/, "latch declared beside the abort latch");
  assert.match(HEARTBEAT_SRC, /standDownKey !== lastZombieStandDownKey/, "repeat ticks are suppressed");
  assert.match(HEARTBEAT_SRC, /lastZombieStandDownKey = standDownKey;/, "first occurrence claims the latch");
  const resetAt = HEARTBEAT_SRC.indexOf("export function __testOnlyResetZombieRunWatchdog");
  assert.ok(resetAt >= 0, "watchdog reset exists");
  assert.match(
    HEARTBEAT_SRC.slice(resetAt, resetAt + 400),
    /lastZombieStandDownKey = "";/,
    "test reset releases the stand-down latch",
  );
  const releaseAt = HEARTBEAT_SRC.indexOf("export function releaseZombieAbortKey");
  assert.ok(releaseAt >= 0, "abort-latch release exists");
  assert.match(
    HEARTBEAT_SRC.slice(releaseAt, releaseAt + 400),
    /lastZombieStandDownKey = "";/,
    "a retried attempt re-arms stand-down logging with the abort latch",
  );
});

test("the abort path is untouched when NO human-input tool is in flight", () => {
  // A genuinely hung stream (no tools at all) must still reach abortZombieRun
  // after the grace window — the carve-out is additive, not a replacement.
  assert.match(HEARTBEAT_SRC, /abortZombieRun\(\s*ctx,\s+flags\.sessionGeneration,/);
  assert.match(HEARTBEAT_SRC, /USER_INPUT_WAIT_TOOL_NAMES/);
});
