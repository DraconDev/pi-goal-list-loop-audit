// pi-goal-list-loop-audit — v0.27.2
// tests/length-continue.test.ts
//
// Folded-in auto-continue for output-token truncation (standalone
// pi-length-continue deprecated). Tracker state machine + goal.ts wiring:
// the agent_end length path runs BEFORE all turn bookkeeping (a truncated
// turn is not a completed turn, not a stall, no loop measure on half a
// response) and works with no goal active.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import {
  LENGTH_CONTINUE_MAX,
  LENGTH_CONTINUE_TEXT,
  isContextStarvedLengthStop,
  makeLengthContinueTracker,
} from "../extensions/length-continue.ts";
import { readGoalRuntimeSource } from "./harness/goal-source.js";

test("tracker: fires up to MAX consecutive, gives up once, resets on a normal turn", () => {
  const t = makeLengthContinueTracker();
  assert.deepEqual(t.tick(true), { fire: true, giveUpNow: false, consecutive: 1 });
  assert.deepEqual(t.tick(true), { fire: true, giveUpNow: false, consecutive: 2 });
  assert.deepEqual(t.tick(true), { fire: true, giveUpNow: false, consecutive: 3 });
  // cap exceeded: no fire, give-up exactly once
  assert.deepEqual(t.tick(true), { fire: false, giveUpNow: true, consecutive: 4 });
  assert.deepEqual(t.tick(true), { fire: false, giveUpNow: false, consecutive: 5 });
  // normal turn resets the streak AND the give-up latch
  assert.deepEqual(t.tick(false), { fire: false, giveUpNow: false, consecutive: 0 });
  assert.deepEqual(t.tick(true), { fire: true, giveUpNow: false, consecutive: 1 });
});

test("continue text carries the root-cause mitigation (split large writes)", () => {
  assert.equal(LENGTH_CONTINUE_MAX, 3);
  assert.match(LENGTH_CONTINUE_TEXT, /EXACTLY where you stopped/i);
  assert.match(LENGTH_CONTINUE_TEXT, /split large file writes/i);
});

test("v0.34.19: tiny-output length at a nearly full context is context starvation, not a real output cap", () => {
  const message = { stopReason: "length", usage: { output: 1 } };
  assert.equal(isContextStarvedLengthStop(message, { tokens: 198_116, contextWindow: 200_000, percent: 99.058 }), true);
  assert.equal(isContextStarvedLengthStop(message, { tokens: 198_116, contextWindow: 200_000, percent: null }), true, "derives percent from tokens/contextWindow");
  assert.equal(isContextStarvedLengthStop(message, { tokens: 180_000, contextWindow: 200_000, percent: 90 }), true, "90% threshold is inclusive");
  assert.equal(isContextStarvedLengthStop(message, { tokens: 179_999, contextWindow: 200_000, percent: 89.9995 }), false);
  assert.equal(isContextStarvedLengthStop({ stopReason: "length", usage: { output: 4_096 } }, { percent: 99.1 }), false, "a large output means the model really hit its response cap");
  assert.equal(isContextStarvedLengthStop({ stopReason: "length" }, { percent: 99.1 }), false, "missing output usage fails open to legacy length-continue");
  assert.equal(isContextStarvedLengthStop({ stopReason: "stop", usage: { output: 1 } }, { percent: 99.1 }), false);
});

const SRC = readGoalRuntimeSource();
const ACT = fs.readFileSync("extensions/loops/goal-activation.ts", "utf-8");
const CONT = fs.readFileSync("extensions/goal-continuation.ts", "utf-8"); // decomposition step 5 (v0.34.113)

test("agent_end: length path runs BEFORE nudge accounting, telemetry, and goal gating", () => {
  // Window sized generously: the contract is ORDER (length path first), not
  // distance — prior 5000-char window broke when P1/P3 (0.28.4) added ~1100
  // chars between the length path and the goal gate; v0.34.25/26 added ~2000
  // more (silent-swap absorb branch + durable exhaustion pause).
  // Keep the source window above the lifecycle handler's pre-gate recovery
  // block; provider-pane recovery adds a bounded branch before the gate.
  const handler = SRC.slice(SRC.indexOf('pi.on("agent_end"'), SRC.indexOf('pi.on("agent_end"') + 20500);
  const lengthIdx = handler.indexOf('tickLengthContinue(lastA?.stopReason === "length" && !contextStarvedLength)');
  assert.ok(lengthIdx > 0, "length tick present");
  assert.ok(handler.indexOf("isContextStarvedLengthStop(rawLastA, contextUsage)") < lengthIdx, "context-starvation classification runs before the tracker");
  assert.ok(handler.indexOf('length_continue_deferred_context_full') > lengthIdx, "context-starvation ledger is emitted by the defer path");
  // before the no-tool nudge accounting (stall brake) …
  assert.ok(lengthIdx < handler.indexOf("accountTurnForNudges"), "before nudge accounting");
  // … before per-goal telemetry …
  assert.ok(lengthIdx < handler.indexOf("state.goal.telemetry"), "before telemetry");
  // … and before the "no goal → return" gate (works in plain sessions)
  // v0.38.10: window 20000 → 20500 — the starvation branch gained the
  // emergency-compactor trigger (one fire-and-forget call + one comment
  // line) before the gate. Order contract unchanged.
  assert.ok(lengthIdx < handler.indexOf('if (!state.goal) return;'), "before goal gating");
  // truncated turns return early — no continuation scheduling on half a response
  // v0.34.116: window bumped to 5000 — the post-`contextStarvedLength` early
  // return now lives further down (the context-overflow fallback branch runs
  // first), so the 3400-char window clipped the assertion. v0.38.10: 5000 →
  // 5500 — the starvation branch gained the emergency-compactor trigger.
  // Factual contract (the inner `if (lastA?.stopReason === "length" && ...)`
  // block exists) is unchanged.
  const early = handler.slice(lengthIdx, lengthIdx + 5500);
  assert.match(early, /if \(lastA\?\.stopReason === "length"\) \{\s*\n\s*if \(lc\.fire && !ctx\.hasPendingMessages\(\)\) sendLengthContinue\(ctx, lc\.consecutive\);\s*\n\s*return;\s*\n\s*\}/);
});

test("sendLengthContinue: stale-api terminal guard + admitted-session reset", () => {
  assert.match(CONT, /function sendLengthContinue\(ctx: ExtensionContext, consecutive: number\)/); // decomposition step 5: moved
  assert.match(CONT, /if \(flags\.sessionHandoffPending \|\| flags\.initialSessionLoadPending \|\| !flags\.extensionApi \|\| flags\.extensionApiStale \|\| continuationDispatchStoodDown \|\| pendingContinuationDispatch \|\| flags\.abortedStandDown\) return;/, "lifecycle, blank-start, stale-runtime, in-flight dispatch, and abort-latch guards short-circuit the send (flags accessor re-spelling; audit 2026-09-07 task 5 added the latch)");
  assert.match(CONT, /kind: "length",\s*\n\s*marker: content\.slice\(0, 80\)/, "length sends use the effective per-context dispatch proof");
  assert.match(CONT, /flags\.extensionApi\.sendMessage\(\{\s*\n\s*customType: GOAL_EVENT_ENTRY,\s*\n\s*content,/);
  assert.match(CONT, /appendLedger\(ctx\.cwd, "length_continue_sent", \{ consecutive, attemptId: attempt\.id \}\)/);
  assert.match(CONT, /if \(isStaleApiError\(err\)\)/); // v0.34.117: the stale guard now wraps an auto-recovery call + terminal fallback
  assert.match(CONT, /if \(!attemptFreshSessionRecovery\(ctx, "sendLengthContinue"\)\) goStaleTerminal\(ctx, "sendLengthContinue"\);/); // v0.34.117: auto-recover before terminal park
  assert.match(ACT, /extensionApi = pi;[\s\S]*?resetLengthContinue\(\);/); // reset follows host admission, not factory evaluation
  // give-up is surfaced once via notify + external push
  assert.match(SRC, /lc\.giveUpNow/);
});

test("sendLengthContinue: active goals get completion-aware recovery guidance", () => {
  assert.match(CONT, /const GOAL_LENGTH_CONTINUE_TEXT = \[/, "goal-specific recovery text exists");
  assert.match(CONT, /const content = state\.goal\?\.status === "active" \? GOAL_LENGTH_CONTINUE_TEXT : LENGTH_CONTINUE_TEXT;/, "active goals select the completion-aware text while plain sessions keep the generic text");
  assert.match(CONT, /If the goal is satisfied, do not start another research, audit, or implementation pass\. Call complete_goal now/, "the recovery instruction explicitly offers closure instead of another blind work pass");
  assert.match(CONT, /lastContinuationSentPayload = \{ content, display: true \}/, "the retry payload matches the text actually sent");
});
