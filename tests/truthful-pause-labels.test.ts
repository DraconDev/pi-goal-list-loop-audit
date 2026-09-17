// pi-goal-list-loop-audit — 2026-09-16 truthful pause labels
//
// Field concern (screenshot 20260916_195540): one surface said the goal
// was paused, another said a supervised recovery timer owned it, and a
// merely OLD queued goal wore a "monitoring" badge with no evidence any
// external process was watched. Pins:
//   1. A deliberate user wait (pause_goal kind=wait) keeps its own
//      scheduled-wait voice (or waiting for you without a timer) — never "auto-retrying",
//      never a "glla recovery timer" owner.
//   2. Internal retry pauses (durable recovery evidence present:
//      pendingCompletion / recoveryEpisodeKey / mainModelRecovery) keep
//      the existing auto-retry/recovery labels.
//   3. Neither queued turns, age, nor monitoring keywords prove a watcher.
//      With no runtime monitoring producer, these goals remain queued.
//
// These are display-projection changes only; durable lifecycle and
// consent semantics do not move.

import { test } from "node:test";
import * as assert from "node:assert/strict";

import {
  buildStatusText,
  buildWidgetLines,
  isMonitorGoal,
} from "../extensions/goal-loop-display.js";
import type { Goal, State } from "../extensions/goal-loop-core.js";

const NOW = Date.parse("2026-09-16T20:00:00Z");

function goalOf(overrides: Partial<Goal> = {}): Goal {
  return {
    id: "20260916200000-abcdef",
    objective: "Watch the nightly job",
    status: "active",
    policy: "goal",
    autoContinue: true,
    usage: { tokensUsed: 5_000, tokensLimit: 0 },
    createdAt: "2026-09-16T19:55:00Z",
    updatedAt: "2026-09-16T19:55:00Z",
    ...overrides,
  } as Goal;
}

const stateOf = (goal: Goal, extra: Record<string, unknown> = {}): State =>
  ({ goal, list: [], ...extra }) as unknown as State;

test("deliberate user wait is never labeled supervised recovery", () => {
  // pause_goal with kind=wait persists EXACTLY these fields — no
  // pendingCompletion, no recoveryEpisodeKey, no mainModelRecovery.
  const user = goalOf({
    status: "paused",
    pauseKind: "wait",
    pauseReason: "waiting for the deploy window",
    pauseResumeAt: new Date(NOW + 45 * 60_000).toISOString(),
    pauseSuggestedAction: "Resume after the deploy finishes.",
  });
  const state = stateOf(user);
  const status = buildStatusText(state, null, NOW)!;
  assert.doesNotMatch(status, /auto-retrying/, "a user wait is not an auto-retry");
  assert.doesNotMatch(status, /recovering|recovery/, "a user wait is not supervised recovery");
  const widget = buildWidgetLines(state, null, NOW, undefined, 200)!;
  const text = widget.join("\n");
  assert.doesNotMatch(text, /auto-retrying/, "widget must not promise auto-retry on a user wait");
  assert.doesNotMatch(text, /owner: glla recovery timer/, "user wait names no glla recovery timer");
  assert.match(text, /scheduled wait/i, "a timer is not waiting for user input");
  assert.match(status, /next: auto-continue in/);
  assert.doesNotMatch(text, /auto-retry|waiting for you/i);
});

test("deliberate wait transitions stay truthful with absent, due, or overdue timers", () => {
  for (const offset of [undefined, -30_000, -3_600_000]) {
    const goal = goalOf({
      status: "paused", pauseKind: "wait",
      pauseResumeAt: offset === undefined ? undefined : new Date(NOW + offset).toISOString(),
    });
    const state = stateOf(goal);
    const text = [buildStatusText(state, null, NOW), ...buildWidgetLines(state, null, NOW, undefined, 200)!].join("\n");
    assert.doesNotMatch(text, /auto-retry|recovery|in -/);
    if (offset === undefined) assert.match(text, /waiting for you/);
    else if (offset === -30_000) assert.match(text, /resuming now/);
    else {
      assert.match(text, /auto-continue overdue/);
      assert.match(text, /next: \/goal resume/);
      assert.doesNotMatch(text, /resuming now/);
    }
  }
});

test("internal retry pauses keep the supervised recovery labels", () => {
  const internal = goalOf({
    status: "paused",
    pauseKind: "wait",
    pauseReason: "auditor retry: provider busy",
    pauseResumeAt: new Date(NOW + 10 * 60_000).toISOString(),
    pauseSuggestedAction: "Auto-retry in 10m — or /goal resume to retry now.",
    // The durable fence: an internal pause carries machine-owned evidence.
    recoveryEpisodeKey: "20260916200000:x",
  } as Partial<Goal>);
  const status = buildStatusText(stateOf(internal), null, NOW)!;
  assert.match(status, /auto-retrying/, "internal retry keeps the auto-retry promise");
  const widget = buildWidgetLines(stateOf(internal), null, NOW, undefined, 200)!;
  assert.ok(widget.some((l) => l.includes("auto-retrying") || l.includes("next: auto-retry in")), widget.join("\n"));
});

test("queued healthz implementation never claims a monitor or next check", () => {
  const goal = goalOf({ objective: "Implement a healthz endpoint; no monitoring process exists" });
  const extras = { activity: "queued" as const, turnPending: true };
  const text = [buildStatusText(stateOf(goal), null, NOW, undefined, extras),
    ...buildWidgetLines(stateOf(goal), null, NOW, undefined, 200, extras)!].join("\n");
  assert.doesNotMatch(text, /MONITORING|next check/);
  assert.match(text, /QUEUED|queued/);
});

test("age alone never earns the monitoring label on a queued goal", () => {
  const old = goalOf({
    objective: "Grow the music catalog",
    createdAt: "2026-07-20T12:00:00Z",
  });
  assert.equal(isMonitorGoal(old, NOW), false, "old-but-ordinary queued work is not monitoring");
  const daemon = goalOf({ objective: "Keep the book-daemon health monitor running" });
  assert.equal(isMonitorGoal(daemon, NOW), false, "watch-job intent is not evidence of a running monitor");
  const status = buildStatusText(
    stateOf(old),
    null,
    NOW,
    undefined,
    { activity: "queued", turnPending: true, lastActivityAt: NOW - 5_000 },
  )!;
  assert.doesNotMatch(status, /MONITORING/, "no monitoring badge without runtime evidence");
  assert.match(status, /QUEUED|queued/, "it still reads as queued work");
});
