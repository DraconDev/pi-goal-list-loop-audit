// pi-goal-list-loop-audit — v0.38.31 paused-overdue pins (2026-09-08).
//
// Field report (screenshot 20260908_180721): a recovery-timer wait whose
// retry time passed long ago on a held host claimed "paused" + "safely
// parked" + "next: resuming now" + "auto-retrying · now" simultaneously for
// over an hour, then closed with two generic boilerplate lines identical on
// every recovery wait. "resuming now" is a transient truth: past the grace
// window the card must name the timer, and the wait tail carries no
// objective-specific facts worth the rows.

import { test } from "node:test";
import * as assert from "node:assert/strict";

import {
  buildStatusText,
  buildWidgetLines,
  PAUSED_RESUME_GRACE_MS,
} from "../extensions/goal-loop-display.js";
import type { Goal, State } from "../extensions/goal-loop-core.js";

const NOW = Date.parse("2026-09-08T18:00:00Z");

function waitGoal(overrides: Record<string, unknown> = {}): Goal {
  return {
    id: "20260908160425-test",
    objective: "Run ONE project audit pass and leave the project in a known state",
    status: "paused",
    policy: "goal",
    autoContinue: true,
    usage: { tokensUsed: 0, tokensLimit: 0 },
    createdAt: "2026-09-08T17:00:00Z",
    updatedAt: "2026-09-08T17:00:00Z",
    pauseKind: "wait",
    pauseReason: "main model recovery — retrying in 60m (provider unavailable)",
    pauseSuggestedAction:
      "The provider failure is being retried automatically with adaptive backoff for as long as it remains recoverable; configured fallback models are tried in order. /goal resume retries immediately; /goal cancel stops it.",
    // v0.38.57: these fixtures describe a SUPERVISED recovery wait, so they
    // carry the durable evidence the real writer (goal-recovery.ts:792)
    // always persists; a bare timed pause without it renders as the user's
    // own wait (see tests/truthful-pause-labels.test.ts).
    recoveryEpisodeKey: "20260908160425:provider",
    ...overrides,
  } as unknown as Goal;
}

function stateOf(goal: Goal): State {
  return { goal, list: [] } as unknown as State;
}

// An hour-overdue retry on a held host must not promise an imminent resume.
test("v0.38.31: overdue wait names the recovery timer, never resuming now", () => {
  const overdueAt = new Date(NOW - 3_600_000).toISOString();
  const state = stateOf(waitGoal({ pauseResumeAt: overdueAt }));
  const widget = buildWidgetLines(state, null, NOW, undefined, 200)!;
  const text = widget.join("\n");
  assert.doesNotMatch(text, /resuming now/);
  assert.match(text, /next: recovery timer/);
  assert.match(text, /auto-retrying · overdue — waiting on recovery timer/);
});

// The status bar carries the same overdue wording, not "resuming…".
test("v0.38.31: overdue wait status bar reads retry overdue", () => {
  const overdueAt = new Date(NOW - 3_600_000).toISOString();
  const state = stateOf(waitGoal({ pauseResumeAt: overdueAt }));
  const status = buildStatusText(state, null, NOW)!;
  assert.doesNotMatch(status, /resuming…/);
  assert.match(status, /retry overdue/);
  assert.match(status, /next: recovery timer/);
});

// A freshly-passed retry is genuinely imminent — the grace window keeps it.
test("v0.38.31: in-grace wait keeps resuming now", () => {
  assert.ok(PAUSED_RESUME_GRACE_MS > 0);
  const justPassed = new Date(NOW - 30_000).toISOString();
  const state = stateOf(waitGoal({ pauseResumeAt: justPassed }));
  const widget = buildWidgetLines(state, null, NOW, undefined, 200)!;
  const text = widget.join("\n");
  assert.match(text, /next: resuming now/);
  assert.match(text, /auto-retrying · now/);
});

// Future retries keep the countdown on both surfaces.
test("v0.38.31: future wait keeps the countdown", () => {
  const future = new Date(NOW + 20 * 60_000).toISOString();
  const state = stateOf(waitGoal({ pauseResumeAt: future }));
  const widget = buildWidgetLines(state, null, NOW, undefined, 200)!;
  assert.ok(widget.some((l) => l.includes("next: auto-retry in")), widget.join("\n"));
  assert.ok(widget.some((l) => l.includes("auto-retrying · next probe in")), widget.join("\n"));
  const status = buildStatusText(state, null, NOW)!;
  assert.match(status, /auto-retry in/);
});

// Recovery-timer waits end at the auto-retry row: no stock boilerplate, no
// generic awaiting/saved tail, tree closed on the previous row.
test("v0.38.31: wait card drops the generic tail and closes the tree", () => {
  const overdueAt = new Date(NOW - 3_600_000).toISOString();
  const state = stateOf(waitGoal({ pauseResumeAt: overdueAt }));
  const widget = buildWidgetLines(state, null, NOW, undefined, 200)!;
  const text = widget.join("\n");
  assert.doesNotMatch(text, /being retried automatically/);
  assert.doesNotMatch(text, /awaiting first turn/);
  assert.doesNotMatch(text, /resumes exactly here/);
  const last = widget[widget.length - 1]!;
  assert.match(last, /^└─/);
  assert.match(last, /auto-retrying · overdue/);
});

// Non-wait pauses still answer "did I lose the work" with action + saved.
test("v0.38.31: error pause keeps suggested action and saved tail", () => {
  const err = waitGoal({
    pauseKind: "error",
    pauseReason: "disk write failed",
    pauseSuggestedAction: "Free disk space, then /goal resume.",
    usage: { tokensUsed: 5000, tokensLimit: 1_000_000 },
  });
  const state = stateOf(err);
  const widget = buildWidgetLines(state, null, NOW, undefined, 200)!;
  const text = widget.join("\n");
  assert.match(text, /Free disk space/);
  assert.match(text, /saved — .*resumes exactly here/);
});
