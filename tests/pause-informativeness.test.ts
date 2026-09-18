// pi-goal-list-loop-audit — v0.27.1
// tests/pause-informativeness.test.ts
//
// "We are pretty uninformative when the execution pauses." A decision-pause
// (pause_goal with reason + suggested action) reached the user truncated at
// ~60 chars — the actual choice was unreadable. Now: the widget WRAPS the
// reason/action over up to 3 lines each, a "saved — … · resumes exactly
// here" line answers "did I lose the work?", and the pause-time
// notification carries the FULL reason + action.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import { wrap, buildWidgetLines } from "../extensions/goal-loop-display.ts";
import type { Goal, State } from "../extensions/goal-loop-core.ts";
import { readGoalRuntimeSource } from "./harness/goal-source.js";

function pausedGoal(over: Partial<Goal> = {}): Goal {
  return {
    id: "g1", objective: "fix the thing", policy: "goal", status: "paused",
    createdAt: new Date(Date.now() - 60_000).toISOString(),
    pauseReason: "Paused to surface a dedup issue: when list_add was called with the 15 audit findings, items 1-2 (worldAimY + BOOST_*) were ALREADY on the list from a prior list_add call that triggered this audit",
    pauseSuggestedAction: "Choose: (a) keep both and mark them as the same work; (b) regenerate the list fresh",
    ...over,
  } as Goal;
}
const stateOf = (g: Goal): State => ({ goal: g }) as State;

test("wrap: short text stays one line; long text wraps at width; cap ellipsizes", () => {
  assert.deepEqual(wrap("hello world", 60, 3), ["hello world"]);
  const w = wrap("one two three four five six seven eight nine ten", 15, 3);
  assert.ok(w.every((l) => l.length <= 15), JSON.stringify(w));
  assert.ok(w.length > 1);
  const capped = wrap("word ".repeat(200), 20, 3);
  assert.equal(capped.length, 3);
  assert.ok(capped[2]!.endsWith("…"), "truncation marker on the last line");
  // over-long single word is hard-split
  assert.deepEqual(wrap("x".repeat(45), 20, 3), ["x".repeat(20), "x".repeat(20), "xxxxx"]);
});

test("paused card wraps the reason over multiple lines instead of truncating at 60", () => {
  const lines = buildWidgetLines(stateOf(pausedGoal()), null, Date.now(), undefined, 100)!;
  const reasonLines = lines.filter((l) => l.includes("dedup") || l.includes("ALREADY on the list") || l.includes("triggered this audit"));
  assert.ok(reasonLines.length >= 2, `reason wrapped over >= 2 lines: ${JSON.stringify(lines)}`);
  assert.ok(lines.every((l) => !l.endsWith("…") || l.includes("triggered this audit") === false), "reason not truncated at 60");
});

test("paused card answers 'did I lose the work?' with a saved line", () => {
  const g = pausedGoal({ usage: { tokensUsed: 41200, tokensLimit: 0 }, auditHistory: [{ approved: true }, { approved: false }, { approved: true }] as any });
  const lines = buildWidgetLines(stateOf(g), null, Date.now(), undefined, 100)!;
  assert.ok(lines.some((l) => l.includes("saved — 41.2k tok spent · 3 audits · resumes exactly here")), JSON.stringify(lines));
  // nothing spent yet → "awaiting first turn" (literal contract text)
  const bare = buildWidgetLines(stateOf(pausedGoal()), null, Date.now(), undefined, 100)!;
  assert.ok(bare.some((l) => l.includes("awaiting first turn — resumes exactly here")), JSON.stringify(bare));
});

test("paused card wraps the suggested action and closes the branch on its last line", () => {
  const lines = buildWidgetLines(stateOf(pausedGoal()), null, Date.now(), undefined, 100)!;
  assert.ok(lines.some((l) => l.startsWith("└─") && l.includes("regenerate the list fresh")), JSON.stringify(lines));
});

test("pause_goal tool notification carries the FULL reason AND suggested action", () => {
  const src = readGoalRuntimeSource();
  assert.match(src, /ctx\.ui\.notify\(`\$\{goalNoun\(\)\} paused: \$\{safePauseReason\}\$\{safePauseAction \? `\\n\\n→ \$\{safePauseAction\}`/);
  // external push carries both too (bounded), using the sanitized projections.
  assert.match(src, /notifyExternal\(ctx, `\$\{goalNoun\(\)\} paused: \$\{\(safePauseAction/);
});

const SRC = readGoalRuntimeSource();
const CONT = fs.readFileSync("extensions/goal-continuation.ts", "utf-8"); // decomposition step 5 (v0.34.113)
const HB = fs.readFileSync("extensions/goal-heartbeat.ts", "utf-8"); // decomposition step 4 (v0.34.112)
const CMDS = fs.readFileSync("extensions/goal-commands.ts", "utf-8");

test("pause_goal tool: structured kind/options/recommended/resumeAt persist to the goal (v0.28.22)", () => {
  // Source pin — the behavioral harness's runTool writes through the
  // registration ctx, not the test ctx, so a full e2e persistence assert
  // is order-fragile. The rendering half is pinned in display.test.ts.
  assert.match(SRC, /pauseKind: p\.kind,/);
  assert.match(SRC, /pauseOptions: p\.kind === "decision" && p\.options && p\.options\.length > 0 \? p\.options : undefined,/);
  assert.match(SRC, /pauseRecommended: p\.kind === "decision" && p\.recommended && p\.recommended >= 1 \? Math\.floor\(p\.recommended\) : undefined,/);
  // v0.38.63 (153404): agent-authored waits are clamped to the hourly
  // horizon — the stored value is the clamped projection, not the raw ask.
  assert.match(SRC, /pauseResumeAt: storedResumeAt,/);
  assert.match(SRC, /MAX_AGENT_WAIT_MS = 60 \* 60 \* 1000/);
  assert.match(SRC, /pause_wait_clamped/);
  // Resume clears the new fields alongside the old ones.
  assert.match(CMDS, /pauseKind: undefined, pauseOptions: undefined, pauseRecommended: undefined, pauseResumeAt: undefined/); // decomposition step 2: cmdResume moved
  // The extension's own pauses are classified at the source.
  const pairs: Array<[string, string]> = [
    ["pauseReason: `send-retry storm", "error"],
    ["pauseReason: `stalled: ${threshold} continuation refires", "error"],
    ["pauseReason: `auditor verdict: IMPOSSIBLE (partial) —", "decision"],
    ["pauseReason: `auditor retry:", "wait"],
    ["pauseReason: `auditor disapproved ${trailingDisapprovals}× consecutively", "decision"],
    ["pauseReason: `token limit exceeded", "error"],
    ["pauseReason: \"5 consecutive aborts", "blocked"],
    ["\"restored on session load — held for explicit resume\"", "blocked"],
  ];
  // v0.34.51: the 3-strike "reachedInfraCap / auditor infrastructure failed"
  // stop is gone — every infra failure enters the durable bounded retry plan.
  // The capped stop keeps the exhausted-chain diagnostic (auditor 22:39).
  assert.match(SRC, /auditor retry: \$\{exhaustedNotice\}automatic retry horizon reached \(\$\{plan\.attempt\} attempts\)/);
  for (const [anchor, kind] of pairs) {
    const esc = anchor.replace(/[.*+?^$()[\]\\|]/g, "\\$&");
    const source = anchor.includes("send-retry storm") ? CONT : SRC; // decomposition step 5: storm pauses moved to goal-continuation.ts
    assert.match(source, new RegExp(`pauseKind: "${kind}",[\\s\\S]{0,900}?${esc}`), `${anchor} → pauseKind ${kind}`);
  }
});

test("pause_goal description: teaches the real command surface + no-id vocabulary (v0.28.24)", () => {
  const m = SRC.match(/name: "pause_goal",[\s\S]{0,1400}?parameters:/);
  assert.ok(m, "pause_goal registration found");
  const desc = m![0];
  assert.match(desc, /\/list remove N/, "enumerates the real /list command");
  assert.match(desc, /NO \/goal drop|no \/goal drop/i, "kills the hallucinated command");
  assert.match(desc, /no command takes a goal id|NO command takes a goal id/i);
  assert.match(desc, /never show goal ids/i);
});

test("late pause calls cannot overwrite a paused or auditing lifecycle", () => {
  assert.match(SRC, /if \(state\.goal\.status !== "active"\) \{[\s\S]{0,240}pause request ignored/);
});

test("v0.28.30: pause/abort notifies name the policy (List item vs Goal) via goalNoun", () => {
  // User note: "we seem to call everything goal". A list item is not a goal.
  const src = readGoalRuntimeSource();
  const cmds = fs.readFileSync("extensions/goal-commands.ts", "utf-8"); // decomposition step 2
  assert.match(src, /const goalNoun = \(\): string => \(state\.goal\?\.policy === "list" \? "List item" : "Goal"\);/);
  const occurrences = src.split("${goalNoun()}").length - 1;
  assert.ok(occurrences >= 9, `goalNoun used across the notify surface (${occurrences} sites)`);
  assert.match(cmds, /const noun = goalNoun\(\);[\s\S]*`\$\{noun\} aborted\./);
  assert.match(HB, /`\$\{goalNoun\(\)\} appears wedged/);
});

// v0.34.98: paused-without-draft / decision surface. When the pause is
// kind="wait" or "blocked" AND resumeAt is > 6h away, the user is
// effectively locked out of progress for the entire workday. The fix:
// surface a tweak prompt at pause time so the user can pivot right now,
// instead of remembering the long wait later. Field evidence:
// Screenshot_20260808_080402 hellhunter paused kind="wait"
// resumeAt=2026-08-08T02:00:00Z — the user couldn't unblock without
// re-issuing the same objective later.
test("v0.34.98: long-wait pause (> 6h) surfaces a tweak-prompt notification + ledger entry", () => {
  const src = readGoalRuntimeSource();
  // The block lives in pause_goal's execute function, gated on a 6h
  // resumeAt window for wait/blocked kinds.
  assert.match(src, /const SIX_HOURS_MS = 6 \* 60 \* 60 \* 1000;/);
  assert.match(src, /const longWait = \(kind === "wait" \|\| kind === "blocked"\) && Number\.isFinite\(resumeAtMs\) && \(resumeAtMs - Date\.now\(\)\) > SIX_HOURS_MS;/);
  // The notify text names the tweak path and the wait.
  assert.match(src, /Pause scheduled for ~\$\{hours\}h\./, "the notify names the wait duration");
  assert.match(src, /If the objective no longer matches your intent, run/, "the notify offers the tweak path");
  // The ledger event records the pause + hours for auditing.
  assert.match(src, /appendLedger\(ctx\.cwd, "pause_long_wait_offer_tweak", \{[\s\S]*?hours,/);
});

test("v0.34.98: short-wait pause (≤ 6h) does NOT trigger the tweak offer", () => {
  // Source pin: the longWait gate explicitly requires > 6h; pauses
  // with shorter resumeAt or no resumeAt at all do not fire the
  // tweak-offer notify (the user is engaged and can wait).
  const src = readGoalRuntimeSource();
  const longWaitBlock = src.match(/const longWait = [\s\S]{0,300};/);
  assert.ok(longWaitBlock, "the longWait gate is present");
  assert.match(longWaitBlock![0], /> SIX_HOURS_MS/, "strictly greater than 6h");
  assert.doesNotMatch(longWaitBlock![0], />= SIX_HOURS_MS/, "not >= (6h exactly is allowed)");
});
