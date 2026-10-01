// Active-goal liveness for main-model work (field 2026-10-01: supervised
// projects "look stuck" with no visible progress). The head lifesign used to
// render only from tracked subagent rows, and the last-action row showed the
// call duration but never recency — so main-model work had NO liveness
// evidence anywhere while the status stayed deliberately quiet ("head owns
// liveness"). The head now falls back to host stream evidence with the same
// fresh/aging/stale bands, and stamped actions carry their recency.

import { test } from "node:test";
import * as assert from "node:assert/strict";

import { buildWidgetLines, type DisplayTheme } from "../extensions/goal-loop-display.ts";
import { headLifesign, type Goal, type State } from "../extensions/goal-loop-core.ts";

const NOW = Date.parse("2026-10-01T12:00:00Z");
const theme: DisplayTheme = { fg: (color, text) => `<${color}>${text}</>` };

function goalOf(overrides: Partial<Goal> = {}): Goal {
  return {
    id: "20261001120000-abcdef",
    objective: "Do the thing",
    status: "active",
    policy: "goal",
    autoContinue: true,
    usage: { tokensUsed: 12_400, tokensLimit: 0 },
    createdAt: "2026-10-01T11:57:00Z",
    updatedAt: "2026-10-01T11:59:00Z",
    ...overrides,
  };
}

test("headLifesign falls back to host stream silence with the same bands", () => {
  assert.deepEqual(headLifesign(undefined, 45_000), { band: "fresh", freshestMs: 45_000, breath: "●" });
  assert.equal(headLifesign(undefined, 12 * 60_000)?.band, "aging");
  assert.equal(headLifesign(undefined, 47 * 60_000)?.band, "stale");
  // The fallback never claims hung (that requires row evidence) and never
  // invents a readout from missing or negative input.
  assert.equal(headLifesign(undefined, 400 * 60_000)?.band, "stale");
  assert.equal(headLifesign(undefined, undefined), undefined);
  assert.equal(headLifesign(undefined, Number.NaN), undefined);
  assert.equal(headLifesign(undefined, -1), undefined);
});

test("tracked rows win over the stream fallback", () => {
  const rows = [{ status: "running", silentMs: 10_000, toolUses: 3, outputTokens: 100 } as never];
  const live = headLifesign(rows, 400 * 60_000)!;
  assert.equal(live.band, "fresh");
  assert.equal(live.freshestMs, 10_000);
});

test("active head shows main-model stream age without tracked rows", () => {
  const lines = buildWidgetLines(
    { goal: goalOf(), list: [] } as State, null, NOW, undefined, undefined,
    { activity: "working", lastStreamActivityAt: NOW - 45_000 },
  )!;
  assert.match(lines[0]!, /stream 45s/);
});

test("stale main-model stream paints the head error, aging paints warning", () => {
  const stale = buildWidgetLines(
    { goal: goalOf(), list: [] } as State, null, NOW, theme, undefined,
    { activity: "busy", lastStreamActivityAt: NOW - 47 * 60_000 },
  )!;
  assert.match(stale[0]!, /<error>stream 47m00s<\/>/);
  const aging = buildWidgetLines(
    { goal: goalOf(), list: [] } as State, null, NOW, theme, undefined,
    { activity: "busy", lastStreamActivityAt: NOW - 12 * 60_000 },
  )!;
  assert.match(aging[0]!, /<warning>stream 12m00s<\/>/);
});

test("future or missing stream evidence invents no head readout", () => {
  const future = buildWidgetLines(
    { goal: goalOf(), list: [] } as State, null, NOW, undefined, undefined,
    { activity: "working", lastStreamActivityAt: NOW + 60_000, lastActivityAt: NOW + 60_000 },
  )!;
  assert.doesNotMatch(future.join("\n"), /stream /);
  const bare = buildWidgetLines({ goal: goalOf(), list: [] } as State, null, NOW)!;
  assert.doesNotMatch(bare.join("\n"), /stream /);
});

test("stamped last action carries bucketed recency", () => {
  const lines = buildWidgetLines(
    { goal: goalOf(), list: [] } as State, null, NOW, undefined, 120,
    { recent: [{ name: "edit", arg: "goal.ts", ms: 12_000, ok: true, at: NOW - 185_000 }] },
  )!;
  assert.match(lines.join("\n"), /✓ edit goal\.ts \(12s\) · 3m 00s ago/);
});

test("unstamped or future-stamped actions carry no recency", () => {
  const unstamped = buildWidgetLines(
    { goal: goalOf(), list: [] } as State, null, NOW, undefined, 120,
    { recent: [{ name: "edit", arg: "goal.ts", ms: 12_000, ok: true }] },
  )!;
  assert.doesNotMatch(unstamped.join("\n"), /ago/);
  const future = buildWidgetLines(
    { goal: goalOf(), list: [] } as State, null, NOW, undefined, 120,
    { recent: [{ name: "edit", arg: "goal.ts", ms: 12_000, ok: true, at: NOW + 60_000 }] },
  )!;
  assert.doesNotMatch(future.join("\n"), /ago/);
});
