// pi-goal-list-loop-audit — Now 021655: false manual action.
//
// Field case (Screenshot_20260918_021655): the agent paused to wait on a
// background reviewer ("Waiting on async round-2 reviewer 40ff41ff ...
// will resume on native completion notification") and correctly told the
// user "No manual action". But the goal card still rendered
// "blocked — waiting for manual action" with owner "manual action" and the
// status line read "action needed" — a manual action that does not exist.
// A pause that waits on a background subagent (native wake resumes the
// goal) must render as waiting, never as action needed.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import { buildWidgetLines, buildStatusText, type DisplayTheme } from "../extensions/goal-loop-display.ts";
import type { Goal, State } from "../extensions/goal-loop-core.ts";

// Marker theme: records the color ride without real ANSI (lifesign precedent).
const MARKER = { fg: (c: string, t: string) => `[${c}]${t}[/]` } as unknown as DisplayTheme;

// "standby" does not exist yet — red baseline. Cast keeps tsc clean while
// the behavior is missing, so the failure is behavioral, not a type error.
const STANDBY = "standby" as Goal["pauseKind"];

function standbyGoal(over: Partial<Goal> = {}): Goal {
  return {
    id: "g1", objective: "EVE-09 fix verification", policy: "list", status: "paused",
    createdAt: new Date(Date.now() - 60_000).toISOString(),
    pauseKind: STANDBY,
    pauseReason: "Waiting on async round-2 reviewer 40ff41ff for EVE-09 fix verification; will resume on native completion notification then refresh evidence and claim",
    pauseSuggestedAction: "Run /list resume when reviewer completes, or check reviewer status",
    ...over,
  } as Goal;
}
const stateOf = (g: Goal): State => ({ goal: g, list: [] }) as unknown as State;

test("021655: standby pause does not render 'waiting for manual action'", () => {
  const lines = buildWidgetLines(stateOf(standbyGoal()), null, Date.now(), undefined, 100)!;
  const text = lines.join("\n");
  assert.doesNotMatch(text, /waiting for manual action/, `no false manual action:\n${text}`);
  assert.doesNotMatch(text, /action needed/, `no false action-needed:\n${text}`);
});

test("021655: standby pause names the background agent as owner, not manual action", () => {
  const lines = buildWidgetLines(stateOf(standbyGoal()), null, Date.now(), undefined, 100)!;
  const owner = lines.find((l) => l.includes("owner:"));
  assert.ok(owner, `lifecycle owner line present:\n${lines.join("\n")}`);
  assert.match(owner!, /owner: background agent/, `standby owned by background agent:\n${owner}`);
});

test("021655: standby status line waits instead of demanding action", () => {
  const status = buildStatusText(stateOf(standbyGoal()), null, Date.now(), undefined, undefined, 100)!;
  assert.doesNotMatch(status, /action needed/, `status claims no action:\n${status}`);
  assert.match(status, /waiting on background agent/, `status waits:\n${status}`);
});

test("v0.38.90: standby reason renders dim (monitoring narration, not a call to action)", () => {
  const lines = buildWidgetLines(stateOf(standbyGoal()), null, Date.now(), MARKER, 100)!;
  const reasonRows = lines.filter((l) => l.includes("reviewer"));
  assert.ok(reasonRows.length >= 1, `reason renders:\\n${lines.join("\\n")}`);
  assert.ok(reasonRows.every((l) => l.includes("[dim]")), `reason rows dim:\\n${reasonRows.join("\\n")}`);
  assert.ok(reasonRows.every((l) => !l.includes("[warning]")), `reason rows never warning:\\n${reasonRows.join("\\n")}`);
});

test("v0.38.90: standby reason caps at 2 wrapped rows like decisions/waits", () => {
  const long = standbyGoal({ pauseReason: `alpha ${"beta ".repeat(120).trim()} omega` });
  const lines = buildWidgetLines(stateOf(long), null, Date.now(), MARKER, 100)!;
  const reasonRows = lines.filter((l) => l.includes("beta"));
  assert.ok(reasonRows.length >= 1, `long reason renders:\\n${lines.join("\\n")}`);
  assert.ok(reasonRows.length <= 2, `reason capped at 2 rows, got ${reasonRows.length}:\\n${reasonRows.join("\\n")}`);
});

test("021655: neighboring kinds keep their manual-action rendering", () => {
  const blocked = buildWidgetLines(
    stateOf(standbyGoal({ pauseKind: "blocked", pauseReason: "provider 429, manual retry" })), null, Date.now(), undefined, 100)!;
  assert.ok(blocked.some((l) => l.includes("waiting for manual action")), "blocked still names manual action");
  const err = buildStatusText(
    stateOf(standbyGoal({ pauseKind: "error", pauseReason: "operation failed" })), null, Date.now(), undefined, undefined, 100)!;
  assert.match(err, /action needed/, "error still demands action");
});
