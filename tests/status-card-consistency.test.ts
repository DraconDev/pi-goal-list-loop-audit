// pi-goal-list-loop-audit — v0.40.1
// tests/status-card-consistency.test.ts
//
// Field screenshots (2026-11-13), two status cards from one rig:
//   1. the version folded onto the last row ("… /goal resume to retry once ·
//      v0.40.0") on one card, but sat on its own "└─ v0.40.0" row on the other
//      — the fold only happened when the last row already read `└─`;
//   2. a fresh pi with no conversation loaded showed the previous session's
//      provider-recovery state as "EXECUTION UNCONFIRMED", the durable-defer
//      plaques, and "next: /glla status" — while the line above it said GLLA
//      was waiting for the conversation to load.
// Also pinned: a compact card trimmed to its row budget kept the version only
// if the closer survived the trim, and a waiting card printed a second,
// contradictory "next:" inside its lifecycle row.

import { test } from "node:test";
import * as assert from "node:assert/strict";

import { buildWidgetLines } from "../extensions/goal-loop-display.ts";
import { projectUiStatus, type UiStatusContext } from "../extensions/ui-status.ts";

const NOW = Date.parse("2026-11-13T11:53:55Z");
const plain = (lines: string[] | undefined) => (lines ?? []).map((l) => l.replace(/\u001b\[[0-9;]*m/g, ""));

function activeGoal(extra: Record<string, unknown> = {}): any {
  return {
    goal: {
      id: "g", objective: "Fix the pipeline writer", status: "active", policy: "goal", autoContinue: true,
      usage: { tokensUsed: 205_000, tokensLimit: 1_000_000 },
      createdAt: new Date(NOW - 18 * 3600e3).toISOString(), updatedAt: new Date(NOW).toISOString(),
      durableDeferRecommendation: { durableFix: "Implement the writer and keep writes chunked", deferRecommendations: [] },
      ...extra,
    },
    list: [],
  };
}

function pausedForRecovery(): any {
  const state = activeGoal({
    status: "paused", pauseKind: "wait", pauseSource: "system",
    pauseReason: "main model recovery — retrying in 5m (main model unknown — provider error)",
    pauseResumeAt: new Date(NOW + 3600e3).toISOString(),
  });
  state.mainModelRecovery = {
    primary: "provider/model", active: "provider/model", owner: { kind: "goal", id: "g" }, kind: "goal",
    attempts: 4, sameModelRetries: 4, reason: "provider error", retryAt: new Date(NOW + 300e3).toISOString(),
    firstFailureAt: new Date(NOW - 3600e3).toISOString(),
  };
  return state;
}

const card = (state: any, context: Partial<UiStatusContext>, compactAuditCard = true, width = 120) =>
  plain(buildWidgetLines(state, undefined, NOW, undefined, width, {
    uiStatusContext: { now: NOW, generation: 1, ...context } as UiStatusContext,
    compactAuditCard, cardVersionTail: "· v0.40.1",
    durableDeferRecommendation: state.goal.durableDeferRecommendation,
  } as never));

test("the version always rides the card's final row — never a row of its own", () => {
  for (const [label, state, ctx, compact] of [
    ["active, unconfirmed (last row was ├─ before closing)", activeGoal(), {}, true],
    ["active, detailed", activeGoal(), {}, false],
    ["paused for recovery, waiting for load", pausedForRecovery(), { loadPending: true }, true],
    ["paused for recovery, detailed", pausedForRecovery(), {}, false],
  ] as const) {
    const lines = card(state, ctx, compact);
    const last = lines.at(-1)!;
    assert.match(last, /^└─ .+ · v0\.40\.1$/, `${label}: version folds onto the closer:\n${lines.join("\n")}`);
    assert.ok(!lines.some((l) => /^\s*[└├]─ v0\.40\.1$/.test(l)), `${label}: no bare version row`);
    assert.equal(lines.filter((l) => l.includes("v0.40.1")).length, 1, `${label}: shown once`);
  }
});

test("a compact card trimmed to its row budget keeps the version on its footer", () => {
  const lines = card(pausedForRecovery(), {}, true);
  assert.match(lines.at(-1)!, /^└─ more: \/glla status · v0\.40\.1$/, lines.join("\n"));
});

test("no conversation loaded yet: the card says so and names the one action", () => {
  const state = pausedForRecovery();
  const status = projectUiStatus(state, { now: NOW, generation: 1, loadPending: true });
  assert.equal(status.execution, "blocked");
  assert.equal(status.actionability, "user");
  assert.equal(status.blocker, "Waiting for pi to load the conversation");
  assert.match(status.nextAction, /Load or resume the conversation in pi, or run \/glla resume/);

  const text = card(state, { loadPending: true }).join("\n");
  assert.match(text, /BLOCKED/);
  assert.match(text, /├─ next: Load or resume the conversation in pi, or run \/glla resume/);
  assert.match(text, /why: Waiting for pi to load the conversation/);
  assert.doesNotMatch(text, /EXECUTION UNCONFIRMED|to inspect execution/);
  assert.equal((text.match(/next:/g) ?? []).length, 1, `one next action, not a competing lifecycle "next:":\n${text}`);
  assert.doesNotMatch(text, /judgment:|selected: inline/, "a decision already made does not crowd the waiting card");

  const active = card(activeGoal(), { loadPending: true }).join("\n");
  assert.match(active, /next: Load or resume the conversation/);
  assert.doesNotMatch(active, /EXECUTION UNCONFIRMED|judgment:/);
});

test("without a pending load the projection is unchanged", () => {
  const status = projectUiStatus(activeGoal(), { now: NOW, generation: 1 });
  assert.equal(status.execution, "unconfirmed");
  assert.match(status.nextAction, /\/glla status to inspect execution/);
});
