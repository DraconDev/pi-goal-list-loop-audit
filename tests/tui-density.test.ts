// v0.38.8 (TUI density): per-surface pins + 80-column width guard.
import { test } from "node:test";
import * as assert from "node:assert/strict";

import { buildStatusText, buildWidgetLines } from "../extensions/goal-loop-display.js";
import { buildStarvationLadderMessage } from "../extensions/loops/goal-ui.js";
import { settingsTabLabel } from "../extensions/settings-menu.js";
import type { Goal } from "../extensions/goal-loop-core.js";

const NOW = Date.parse("2026-09-03T10:00:00.000Z");
function verdict(over: Record<string, unknown> = {}): any {
  return { at: "2026-09-03T08:00:00.000Z", approved: false, disapproved: false, model: "m", ...over };
}
function goalWithHistory(): Goal {
  return {
    id: "20260903000000-den01",
    objective: "Dense widget goal with a fairly long objective that must still fit",
    verificationContract: "pins",
    status: "active",
    policy: "goal",
    autoContinue: true,
    createdAt: "2026-09-03T06:00:00.000Z",
    updatedAt: "2026-09-03T09:00:00.000Z",
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0, turns: 0, tokensUsed: 12_000, tokensLimit: 0 },
    taskList: { tasks: [
      { id: "t1", title: "First task", status: "complete" },
      { id: "t2", title: "Second task", status: "in_progress" },
    ] },
    auditHistory: [
      verdict({ approved: true, at: "2026-09-03T06:30:00.000Z" }),
      verdict({ disapproved: true, report: "gap", at: "2026-09-03T08:00:00.000Z" }),
    ],
  } as unknown as Goal;
}

test("widget carries the audits row only with history", () => {
  const withH = buildWidgetLines({ goal: goalWithHistory(), list: [] } as any, null, NOW)!;
  const row = withH.find((l) => l.includes("audits:"));
  assert.ok(row, "audits row present");
  assert.match(row!, /2 reviews/);
  assert.match(row!, /1 disapproved/);
  assert.match(row!, /last disapproved/);
  const clean = goalWithHistory();
  (clean as any).auditHistory = [];
  const withoutH = buildWidgetLines({ goal: clean, list: [] } as any, null, NOW)!;
  assert.equal(withoutH.some((l) => l.includes("audits:")), false, "no history means no row");
});

test("widget fits 80 columns at width 80", () => {
  const lines = buildWidgetLines({ goal: goalWithHistory(), list: [] } as any, null, NOW, undefined, 80) ?? [];
  assert.ok(lines.length > 0);
  for (const line of lines) {
    assert.ok(line.length <= 80, `line fits 80 cols (${line.length}): ${line.slice(0, 60)}…`);
  }
});

test("paused status carries the tally", () => {
  const g = { ...goalWithHistory(), status: "paused", pauseKind: "blocked", pauseReason: "held" } as unknown as Goal;
  const text = buildStatusText({ goal: g, list: [] } as any, null, NOW)!;
  assert.match(text, /1 disapproved/);
  assert.match(text, /last disapproved/);
  const clean = { ...g, auditHistory: [] } as unknown as Goal;
  const cleanText = buildStatusText({ goal: clean, list: [] } as any, null, NOW)!;
  assert.equal(/reviews/.test(cleanText), false, "no history means no tally noise");
});

test("ladder is one recovery per line", () => {
  const msg = buildStarvationLadderMessage({ percent: 124.5, streak: 3 });
  const lines = msg.split("\n");
  const ln = (i: number): string => lines[i] ?? "";
  assert.equal(lines.length, 6);
  assert.match(ln(0), /context starvation/);
  assert.match(ln(1), /in order/);
  assert.match(ln(2), /^\(1\) run \/compact again/);
  assert.match(ln(3), /^\(2\) switch to a larger-context model/);
  assert.match(ln(4), /^\(3\) \/new, then \/goal resume/);
  assert.match(ln(4), /durable on disk/);
  assert.match(ln(4), /no summarization needed/);
  assert.match(ln(5), /stay parked/);
  for (const line of lines) {
    assert.ok(line.length <= 200, `banner line stays notifiable (${line.length})`);
  }
});

test("settings tab labels carry row counts", () => {
  assert.equal(settingsTabLabel("Keep-going", 8), "Keep-going (8)");
  assert.equal(settingsTabLabel("Other", 0), "Other");
});
