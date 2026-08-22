// pi-goal-list-loop-audit — v0.26.1
// tests/stall-handling.test.ts
//
// Stall handling: send-path ledger instrumentation, refire-streak
// escalation, compaction hook, widget surface. Motivating incident:
// hegemon 2026-07-25/26 — 619 heartbeat_refires over 23.5h with zero
// loop turns; the send path was silent and the nudge counter (which
// counts TURNS) could never catch a zombie that runs none.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  DEFAULT_STALL_ESCALATION_REFIRES,
  nextHourlyProbeMs,
  shouldEscalateStall,
} from "../extensions/goal-loop-core.ts";
import { loadSettings, saveSettings } from "../extensions/goal-settings.ts";
import { buildStatusText, buildWidgetLines } from "../extensions/goal-loop-display.ts";
import { readGoalRuntimeSource } from "./harness/goal-source.js";

const SRC = readGoalRuntimeSource();
const CONT = fs.readFileSync("extensions/goal-continuation.ts", "utf-8"); // decomposition step 5 (v0.34.113)
const HEARTBEAT_SRC = fs.readFileSync("extensions/goal-heartbeat.ts", "utf-8"); // decomposition step 4 (v0.34.112)
const LOOP = fs.readFileSync("extensions/goal-loop.ts", "utf-8");
const CMDS = fs.readFileSync("extensions/goal-commands.ts", "utf-8");

test("escalation gate: threshold semantics (0 = never, N = fire at streak N)", () => {
  assert.equal(shouldEscalateStall(5, 5), true);
  assert.equal(shouldEscalateStall(4, 5), false);
  assert.equal(shouldEscalateStall(6, 5), true);
  assert.equal(shouldEscalateStall(999, 0), false, "0 disables escalation (legacy spin)");
  assert.equal(DEFAULT_STALL_ESCALATION_REFIRES, 5);
});

test("send paths are ledgered: sent AND failed, loop and goal", () => {
  for (const ev of ["goal_continuation_sent", "goal_continuation_send_failed"]) {
    assert.ok(CONT.includes(`"${ev}"`), `missing ledger event ${ev} (decomposition step 5: sendContinuation moved)`);
  }
  for (const ev of ["loop_turn_sent", "loop_turn_send_failed"]) {
    assert.ok(LOOP.includes(`"${ev}"`), `missing ledger event ${ev} (moved to goal-loop.ts, decomposition step 2)`);
  }
  // The failure branch must capture the error message (was: silent catch).
  assert.match(LOOP, /loop_turn_send_failed", \{ error: err instanceof Error/);
});

test("refire streak: incremented on refire, ledgered, reset only on REAL activity", () => {
  assert.match(HEARTBEAT_SRC, /flags\.consecutiveStalls\+\+;\n\s*appendLedger\(ctx\.cwd, "heartbeat_refire", \{ nudgesSoFar: flags\.heartbeatNudges, consecutiveStalls: flags\.consecutiveStalls \}\)/);
  // agent_end and tool_call are real activity:
  assert.match(SRC, /if \(isForeignCtx\(ctx\)\) return;\n\s*noteActivity\(true\);/);
  assert.match(SRC, /toolCallsThisTurn\+\+;\n\s*noteActivity\(true\);/);
  // the heartbeat refire itself must NOT reset the streak:
  const def = SRC.match(/function noteActivity\(real = false\): void \{[\s\S]*?\}/)![0];
  assert.match(def, /if \(real\) \{ consecutiveStalls = 0;/);
});

test("escalation: streak at threshold stops the loop / pauses the goal, loudly", () => {
  // v0.26.5: the escalation block is shared via escalateStallNow(ctx, threshold):
  assert.match(SRC, /function escalateStallNow\(ctx: ExtensionContext, threshold: number\): boolean/);
  assert.match(SRC, /appendLedger\(ctx\.cwd, "stall_escalated", \{ threshold, kind:/);
  assert.match(SRC, /stalled: \$\{threshold\} continuation refires landed no turn/);
  assert.match(SRC, /notifyExternal\(ctx, "Loop stopped: stalled \(continuation not landing\)\."\)/);
  assert.match(SRC, /notifyExternal\(ctx, `\$\{goalNoun\(\)\} paused: stalled \(continuation not landing\)\."?`?\)/);
  // the escalation return happens BEFORE the schedule (no more refires):
  assert.match(SRC, /function escalateStallNow\(ctx: ExtensionContext, threshold: number\): boolean/, "escalateStallNow stays goal.ts-owned (decomposition step 4)");
  assert.ok(!HEARTBEAT_SRC.includes('"stall_escalated"'), "stall_escalated ledger stays in goal.ts inside escalateStallNow");
  const escCall = HEARTBEAT_SRC.indexOf("if (escalateStallNow(ctx, stallEscalation)) return;");
  const refireScheduleIdx = HEARTBEAT_SRC.indexOf('re-firing continuation (stall');
  assert.ok(escCall > 0 && escCall < refireScheduleIdx, "escalation precedes the refire schedule");
});

test("session_compact hook: re-arms the chain when idle with no timer pending", () => {
  assert.match(SRC, /pi\.on\("session_compact", async \(_event: any, ctx: ExtensionContext\) => \{/);
  assert.match(SRC, /appendLedger\(ctx\.cwd, "session_compact", \{\}\)/);
  assert.match(SRC, /appendLedger\(c\.cwd, "compaction_refire", \{\}\)/);
  // only when nothing is scheduled and the session is idle:
  assert.match(SRC, /c\.isIdle\(\) && !c\.hasPendingMessages\(\) && !continuationTimerPending\(\) && !loopTimerPending\(\) && isSupervising\(\)/); // timer re-spelled via accessor (decomposition step 5)
});

test("widget + status surface the streak only while nonzero", () => {
  const loop = {
    active: true, target: "reconcile the spec", measureCmd: "", iteration: 0,
    maxIterations: 0, stallCount: 0, plateauWindow: 5, startedAt: new Date(Date.now() - 3600_000).toISOString(),
    history: [],
  };
  const state: any = { loop, goal: undefined, list: [] };
  const quiet = buildWidgetLines(state, null, Date.now(), undefined, undefined, { stalls: 0 })!;
  const stalled = buildWidgetLines(state, null, Date.now(), undefined, undefined, { stalls: 3 })!;
  assert.ok(!quiet.some((l) => l.includes("stalls:")), "no stalls note at 0");
  assert.ok(stalled.some((l) => l.includes("stalls:3")), "stalls note at 3");
  const statusQuiet = buildStatusText(state, null, Date.now(), undefined, { stalls: 0 })!;
  const statusStalled = buildStatusText(state, null, Date.now(), undefined, { stalls: 7 })!;
  assert.ok(!statusQuiet.includes("stalls:"));
  assert.ok(statusStalled.includes("stalls:7"));
});

test("settings: stallEscalationRefires round-trips through save/load", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "glla-stall-"));
  saveSettings("project", dir, { stallEscalationRefires: 3 });
  assert.equal(loadSettings(dir).stallEscalationRefires, 3);
  saveSettings("project", dir, { stallEscalationRefires: 0 });
  assert.equal(loadSettings(dir).stallEscalationRefires, 0, "0 persists (never-escalate opt-out)");
});

test("/glla surface: bare command opens settings; arguments are actions", () => {
  // Settings are edited in the table; the nonempty namespace is reserved for
  // operational verbs and must not expose section or key=value routes.
  assert.doesNotMatch(SRC, /\["stall-brakes",/);
  assert.doesNotMatch(SRC, /\["stallescalation=",/);
  assert.doesNotMatch(SRC, /\^\(keep-going\|agents\|auditor\|stall-brakes\|subagents\|other\)\\b/);
  assert.match(CMDS, /Unknown \/glla action/);
  assert.doesNotMatch(SRC, /const kvRe =/);
});

// =================================================================
// v0.28.4 — P1–P3 (audit Stream 5): nudge before the brake; unclosed-status
// block in every continuation; post-restore grace.
// =================================================================

const PROMPT = fs.readFileSync("prompts/goal-loop-continuation.md", "utf-8");

test("P1: graduated stall escalation entry before the brake (sender + wiring)", () => {
  assert.match(CONT, /function sendStallEscalation\(ctx: ExtensionContext, nudges: number\): void/); // decomposition step 5: moved
  assert.match(CONT, /\[STALL WARNING \$\{nudges\}\/\$\{HEARTBEAT_MAX_NUDGES\}\] The last turn produced no tool calls\./);
  assert.match(CONT, /If the goal is DONE, call complete_goal NOW — prose closes nothing/);
  assert.match(CONT, /If you are BLOCKED, call pause_goal with the blocker and a suggested action\./);
  assert.match(CONT, /ONE more unproductive turn pauses the goal\./);
  assert.match(CONT, /appendLedger\(ctx\.cwd, "stall_escalation_nudge", \{ nudges, remaining \}\)/);
  // wired at nudge>=1 for active goals only (loops keep runLoopTick), and the
  // send path is stale-aware like every other autonomous send:
  assert.match(SRC, /if \(heartbeatNudges >= 1 && state\.goal && state\.goal\.status === "active" && !isLoopActive\(\)\)/);
  assert.match(CONT, /goStaleTerminal\(ctx, "sendStallEscalation"\)/); // decomposition step 5: sendStallEscalation moved
});

test("P2: every continuation carries the unclosed-status block", () => {
  assert.match(PROMPT, /## State\n\n\*\*State: ACTIVE — not yet auditor-approved\.\*\*/);
  assert.match(PROMPT, /Prose closes nothing/);
  assert.match(PROMPT, /A done-but-unclosed goal is a bug, not a resting state\./);
  // and the STALLS section names the graduated warning:
  assert.match(PROMPT, /\[STALL WARNING n\/3\]/);
});

test("P3: post-restore grace — armed on restore resume, skips accounting, ledgered", () => {
  assert.match(SRC, /let postRestoreGraceTurns = 0;/);
  assert.match(SRC, /postRestoreGraceTurns = 2;\n        scheduleContinuation\(ctx, true\);/);
  assert.match(SRC, /appendLedger\(ctx\.cwd, "post_restore_grace", \{ remaining: postRestoreGraceTurns \}\)/);
  // grace check sits BEFORE the accounting call:
  const graceIdx = SRC.indexOf("if (postRestoreGraceTurns > 0) {");
  const acctIdx = SRC.indexOf("heartbeatNudges = accountTurnForNudgesRich(");
  assert.ok(graceIdx > 0 && graceIdx < acctIdx, "grace precedes nudge accounting");
});

test("v0.28.24: session_compact resets the send-rearm storm streaks + opens the post-compaction grace", () => {
  // π-web nearly escalated a "send-retry storm" pause during a legitimate
  // 3.5-minute compaction; junk-runner burned all 5 stall refires in the 5
  // minutes right after a 196k-token compact. Both are fixed at the hook:
  const hookIdx = SRC.indexOf('pi.on("session_compact"');
  const resetIdx = SRC.indexOf("setContinuationRearmStreak(0); setContinuationRearmSince(0);\n    loopRearmStreak = 0; loopRearmSince = 0;\n    compactionGraceUntil = Date.now() + COMPACTION_GRACE_MS;");
  assert.ok(hookIdx > 0 && resetIdx > hookIdx, "streak reset + grace arm inside the session_compact hook (continuation streaks re-spelled via setters, decomposition step 5)");
});

test("v0.34.82: heartbeat refuses to refire a continuation while pi is context-starved (no compaction landing)", () => {
  // Field (screenshot 2026-08-07 16:50:55): user-level settings had
  // `compaction.enabled:false`; the agent_end yield path correctly refused
  // to send a 1-token length-continue, but the heartbeat kept refiring
  // full turns against the same near-full context, draining the session
  // from 98% to 120% over six retries. The user only saw "stalled".
  // The new gate watches consecutive `length_continue_deferred_context_full`
  // events; once the streak crosses the threshold and no `session_compact`
  // has landed, the heartbeat stops scheduling new continuations and posts
  // a one-shot "compaction appears off — run /compact" notify.
  assert.match(SRC, /let contextStarvedStreak = 0;/);
  assert.match(SRC, /const CONTEXT_STARVATION_REFUSE_THRESHOLD = 2;/);
  assert.match(SRC, /const CONTEXT_STARVATION_RECENT_WINDOW_MS = 90_000;/);
  // The yield path records the streak in the ledger so postmortem sees it.
  assert.match(SRC, /appendLedger\(ctx\.cwd, "length_continue_deferred_context_full", \{[\s\S]*?starvedStreak: starved\.streak,[\s\S]*?\}\)/);
  // The heartbeat gate is a one-shot "compaction appears off" path.
  assert.match(HEARTBEAT_SRC, /if \(isContextStarvedRefused\(\)\) \{/);
  assert.match(HEARTBEAT_SRC, /appendLedger\(ctx\.cwd, "continuation_refused_context_starved", \{ streak: flags\.contextStarvedStreak, sinceMs: Date\.now\(\) - flags\.lastContextStarvedAt \}\)/);
  assert.match(HEARTBEAT_SRC, /auto-compaction appears to be off[\s\S]*?Run `\/compact`/);
  // A real compaction clears the streak so the heartbeat can refire again.
  const compactIdx = SRC.indexOf('pi.on("session_compact"');
  const clearIdx = SRC.indexOf("onCompactionLanded();");
  assert.ok(compactIdx > 0 && clearIdx > compactIdx, "session_compact hook clears the starvation streak");
  // The gate is BEFORE scheduleContinuation in the heartbeat path, so the
  // refire short-circuits before any work is scheduled.
  const refireIdx = HEARTBEAT_SRC.indexOf("if (isLoopActive()) {\n    scheduleLoopTick(ctx);");
  const gateIdx = HEARTBEAT_SRC.indexOf("if (isContextStarvedRefused()) {");
  assert.ok(gateIdx > 0 && refireIdx > 0, "both gate and refire branches present");
  assert.ok(gateIdx < refireIdx, "refuse gate precedes the refire schedule");
});

test("v0.29.21: session_compact arms a SECOND settle refire at grace expiry", () => {
  // Field (hellhunter 2026-07-31): auto-compact at 195.8k after two
  // output-limit turns → zero continuation rearm attempts after the
  // compact event → ~4 min of apparent death until the post-grace
  // heartbeat recovered (04:31 → 04:34:48). The 2s settle almost always
  // loses (pi is mid-compact then); the grace-expiry settle fires the
  // moment the machinery un-suppresses instead of waiting a heartbeat
  // interval.
  const hookIdx = SRC.indexOf('pi.on("session_compact"');
  const firstSettleIdx = SRC.indexOf("scheduleSessionTimeout(() => {", hookIdx);
  const graceSettleIdx = SRC.indexOf("scheduleSessionTimeout(() => {", firstSettleIdx + 1);
  assert.ok(hookIdx > 0 && firstSettleIdx > hookIdx && graceSettleIdx > firstSettleIdx, "grace settle inside the session_compact hook, after the fast settle");
  const block = SRC.slice(graceSettleIdx, graceSettleIdx + 900);
  assert.match(block, /appendLedger\(c\.cwd, "compaction_grace_refire", \{\}\)/, "ledger event names the recovery");
  assert.ok(block.includes("if (isLoopActive()) scheduleLoopTick(c);"), "loop refire line");
  assert.ok(block.includes("else scheduleContinuation(c, true);"), "goal refire line");
  assert.match(block, /COMPACTION_GRACE_MS \+ 2_000/, "fires at grace expiry (+2s epsilon)");
  assert.match(block, /c\.isIdle\(\) && !c\.hasPendingMessages\(\) && !continuationTimerPending\(\) && !loopTimerPending\(\)/, "same guards as the 2s settle (timer accessor re-spelling, decomposition step 5)");
  assert.match(block, /!abortedStandDown/, "user stand-down still wins");
  assert.ok(SRC.includes("const sessionTimeouts = new Set<NodeJS.Timeout>();"), "settle timer is tracked for shutdown cleanup");
  assert.match(SRC, /const COMPACTION_GRACE_MS = 3 \* 60_000;/);
  // the grace check gates the heartbeat's stall/refire machinery:
  assert.match(HEARTBEAT_SRC, /if \(Date\.now\(\) < flags\.compactionGraceUntil\) return;/);
  const graceGate = HEARTBEAT_SRC.indexOf("if (Date.now() < flags.compactionGraceUntil) return;");
  const refire = HEARTBEAT_SRC.indexOf('appendLedger(ctx.cwd, "heartbeat_refire"');
  assert.ok(graceGate > 0 && graceGate < refire, "grace gate precedes the refire path");
});

test("v0.29.1: completion lifecycle survives the wedged-queue window (storm suppression + stranded recovery + brake cap)", () => {
  const src = readGoalRuntimeSource();
  // 1. The storm escalation NEVER pauses the audit lifecycle — an isolated
  //    auditor's minutes of silence is the storm detector's exact trigger
  //    shape (pully/hellhunter/junk-runner: "complete ending in a pause
  //    retry storm"). The audit lifecycle owns its own pauses.
  const escIdx = CONT.indexOf("function escalateSendRearmStorm"); // decomposition step 5: moved
  const esc = CONT.slice(escIdx, escIdx + 3000);
  assert.ok(esc.indexOf('status === "auditing" || completionAuditInFlight || state.goal.pendingCompletion') < esc.indexOf('state.goal.status === "active"'),
    "the audit-lifecycle suppression precedes the active-goal pause");
  assert.match(esc, /send_rearm_escalated_suppressed/);
  // 2. Stranded-audit watchdog: "auditing" with no in-flight audit = the
  //    result never landed (pully: 12h+ stuck). Release the stored claim as
  //    infrastructure/no-verdict; a heartbeat must not launch a blind retry.
  const hbIdx = HEARTBEAT_SRC.indexOf("function heartbeatTick");
  // v0.34.94: increased slice size to cover the new self-heal block added
  // between the stale-probe check and the stranded-audit watchdog — the
  // pending_latch_stuck event the assertion targets has grown further into
  // the heartbeatTick body as new features land.
  const hb = HEARTBEAT_SRC.slice(hbIdx, hbIdx + 24000); // v0.35.x: heartbeat releases stranded audits before latch handling
  assert.match(hb, /stranded_audit_recovered/);
  assert.match(hb, /state\.goal\?\.status === "auditing" &&\s*\n\s*!flags\.completionAuditInFlight/);
  assert.match(hb, /Completion audit blocked — no verdict/);
  assert.doesNotMatch(hb, /retryStoredCompletionAudit\("session-recovery"\)/);
  assert.ok(hb.indexOf("stranded_audit_recovered") < hb.indexOf("pending_latch_stuck"),
    "stranded-audit recovery runs before the latch watchdog");
  // 3. Error-brake cycle cap: the v0.28.25 ladder slows the thrash but never
  //    stops it (4+ pause↔retry cycles in all three incident ledgers).
  assert.match(src, /if \(brakeStreak >= 6\) \{/);
  assert.match(src, /error_brake_capped/);
  assert.match(src, /6 error-brakes in a row; the provider has been erroring for an extended window/);
});

test("v0.29.9: hourly top-of-hour probe — the park keeps retrying on clock-hour boundaries", () => {
  const src = readGoalRuntimeSource();
  // The park is no longer terminal: a blind retry is scheduled for the next
  // :00:30 slot via the generic provider-retry timer.
  assert.match(src, /const probeMs = Math\.max\(1_000, nextHourlyProbeMs\(Date\.now\(\)\) - Date\.now\(\)\);/);
  assert.ok(src.includes('"Hourly provider retry"'));
  assert.match(src, /hourly_provider_retry/);
  assert.match(src, /via: "hourly-provider-retry"/);
  // The probe ONLY fires while still error-parked (user pauses/resumes/
  // cancels are never stomped), and it re-checks kind + reason.
  assert.match(src, /state\.goal\.pauseKind === "error"\s*\n\s*&& \(state\.goal\.pauseReason \?\? ""\)\.includes\("error-brakes in a row"\)/);
  // The park messaging names the hourly retry (no more "no more auto-retries").
  assert.match(src, /Probing at :00:30 after each hour starts/);
  assert.ok(!src.includes("no more auto-retries"), "park is no longer terminal");
});

test("v0.34.142: nextHourlyProbeMs selects the next :00:30 slot", () => {
  const t = new Date(2026, 6, 30, 10, 47, 30).getTime();
  const next = new Date(nextHourlyProbeMs(t));
  assert.equal(next.getHours(), 11);
  assert.equal(next.getMinutes(), 0);
  assert.equal(next.getSeconds(), 30);
  assert.ok(next.getTime() > t);
});

test("v0.29.1: zombie-twin guard — drafts/enqueues duplicating a goal completed <24h ago are refused loudly", () => {
  const src = readGoalRuntimeSource();
  const cmds = fs.readFileSync("extensions/goal-commands.ts", "utf-8");
  // Junk-runner field case: the just-approved close re-drafted itself 3
  // minutes later and autoaccept waved it in (9h of storm for nothing).
  // (decomposition step 2: the enqueue-side guard moved to goal-commands.ts)
  assert.match(cmds, /const DUPLICATE_LOOKBACK_MS = 24 \* 60 \* 60 \* 1000;/);
  assert.match(cmds, /function recentlyCompletedObjectives\(cwd: string\)/);
  // goal_archived carries the objective going forward (retro fallback reads
  // the archived file's ## Objective section):
  assert.match(src, /appendLedger\(ctx\.cwd, "goal_archived", \{ goalId: goal\.id, status, stopReason, objective: goal\.objective\.slice\(0, 300\) \}\)/);
  assert.match(cmds, /md\.split\("## Objective"\)/);
  // enqueue path filters + reports:
  assert.match(cmds, /list_duplicate_skipped/);
  assert.match(cmds, /Skipped \$\{skipped\} item\(s\) duplicating work COMPLETED in the last 24h/);
  // draft path refuses before activation (autoaccept OR confirmed alike):
  const draftIdx = src.indexOf("draft_duplicate_skipped");
  assert.ok(draftIdx > -1 && src.slice(draftIdx - 1600, draftIdx).includes("recentlyCompletedObjectives(liveCtx.cwd).has(normalizeObjective(p.objective.trim()))"));
  assert.match(src, /This draft duplicates a goal that was COMPLETED within the last 24 hours/);
});

test("v0.29.2: git discipline law — no invented identities or branches, in every execution prompt", () => {
  // Field-observed 2026-07-30: a phase agent branded itself
  // "phase-e-agent <phase-e@local>" on main-history commits; other projects
  // gained invented local git configs (darklord-dev@dracon.local). The
  // global identity was correct all along — agents just improvised.
  const cont = fs.readFileSync("prompts/goal-loop-continuation.md", "utf-8");
  assert.match(cont, /Git discipline: never touch identity or branches/);
  assert.match(cont, /no `git config user\.\*`/);
  assert.match(cont, /phase-e-agent <phase-e@local>/);
  assert.match(cont, /never invent one/);
  const metric = fs.readFileSync("prompts/goal-loop-forever.md", "utf-8");
  assert.match(metric, /Git discipline: commit with the repo's configured identity as-is/);
  assert.match(metric, /never invent `<task>-agent/);
  const metricless = fs.readFileSync("prompts/goal-loop-forever-metricless.md", "utf-8");
  assert.match(metricless, /Git discipline: commit with the repo's configured identity as-is/);
  const forever = fs.readFileSync("extensions/goal-loop-forever.ts", "utf-8");
  assert.match(forever, /repo's configured\s*\n?\s*\*?\s*identity, on the current branch — no invented/);
});

test("v0.29.3/0.29.6: no empty allowlist warning; stacked states AUTO-ARBITRATE (picker superseded)", () => {
  const src = readGoalRuntimeSource();
  const cmds = fs.readFileSync("extensions/goal-commands.ts", "utf-8");
  // 1. The tool-heal warn used to fire with "0 agent tool(s) … re-activated
  //    ()" at every pi start (darklord screenshot). Warn only on a real heal.
  assert.match(src, /if \(!toolHealNotified && missing\.length > 0\) \{/);
  // 2. v0.29.6: the arbitration picker is GONE — stacked states resolve
  //    deterministically at load (most recent activity keeps the slot;
  //    the loser is archived, never wiped). The notify names /glla wipe
  //    for users who want the full clean slate.
  assert.match(src, /Stacked state auto-arbitrated \(one active thing\)/);
  assert.ok(src.includes("stacked_state_auto_arbitrated"));
  assert.ok(!src.includes("Wipe everything — clean slate for stale leftovers"), "the picker's wipe option is superseded by auto-arbitration");
  // 3. The decision prompt still executes wipe-labelled options if a
  //    future pause offers one (cmdGllaWipe keeps its own Confirm —
  //    destructive actions keep their gate).
  assert.ok(cmds.includes("/\\(\\/glla wipe\\)\\s*$/.test(label)"));
  assert.match(cmds, /await cmdGllaWipe\(ctx\);\s*\n\s*return true;/);
});

test("v0.29.4: user aborts stand the chain down and never count toward stalls (the Esc-spam loop)", () => {
  const src = readGoalRuntimeSource();
  // Pully field case 2026-07-30: launch auto-fired, the user Esc-spammed,
  // every abort re-fired the continuation AND counted toward the stall
  // brake — STALL WARNING 1/3, 2/3, then a bogus "stalled" pause.
  // 1. Aborted turns are exempt from the unproductive-turn accounting
  //    (same shape as the 0.28.13 provider-error exemption):
  assert.match(src, /else if \(lastA\?\.stopReason === "aborted"\) \{/);
  assert.match(src, /stall_nudge_exempt_aborted/);
  // 2. An abort stands the chain DOWN — no fall-through to
  //    scheduleContinuation. The stand-down return sits inside the aborted
  //    branch, before the healthy-turn else:
  const abortIdx = src.indexOf('else if (stopReason === "aborted")');
  const block = src.slice(abortIdx, abortIdx + 2200);
  assert.match(block, /abort_stand_down/);
  assert.match(block, /standing down — turn aborted by user \(not counted toward stalls\)/);
  assert.ok(block.indexOf("abort_stand_down") < block.indexOf("} else {"),
    "the stand-down returns before the healthy-turn branch — no re-fire");
  // 3. The 5-abort loud pause remains as the backstop:
  assert.match(block, /5 consecutive aborts \(user interrupted\)/);
});

test("v0.29.5: the stand-down survives the heartbeat + autoResume is GLOBAL-only", () => {
  const src = readGoalRuntimeSource();
  const settings = fs.readFileSync("extensions/goal-settings.ts", "utf-8");
  // 1. Without a stand-down flag the 60s heartbeat refire would defeat the
  //    0.29.4 abort stand-down within a minute (isSupervising + idle + no
  //    timer = refire, and the goal stays ACTIVE while standing down):
  assert.match(src, /let abortedStandDown = false;/);
  assert.match(src, /abortedStandDown = true; \/\/ v0\.29\.5: heartbeat\/compaction refires must not resurrect/);
  assert.match(HEARTBEAT_SRC, /if \(flags\.abortedStandDown\) return;\n  if \(!fire\) return;/);
  // 2. Any explicit schedule ends the stand-down (resume/activate):
  assert.match(CONT, /flags\.abortedStandDown = false; \/\/ v0\.29\.5: any explicit schedule ends the stand-down/); // decomposition step 5: scheduleContinuation moved
  // 3. The post-compaction refire also respects it:
  assert.match(src, /isSupervising\(\) && !abortedStandDown\) \{/);
  // 4. autoResume is GLOBAL-only (user directive: "not supporting project
  //    level setting for it now, just global") — the restore gate and the
  //    reviewer enqueue gate read loadGlobalSettings(), never the project
  //    cascade. junk-runner had a stale project-local opt-in that kept
  //    auto-firing its list at every bare pi launch.
  assert.match(settings, /export function loadGlobalSettings\(\): Settings \{/);
  // v0.35.23: consent reads the RAW global autoResume — the aggressive
  // coercion used to flip the documented hold-by-default into stock
  // auto-resume on every load. Still global-only, never project cascade.
  assert.match(src, /const autoResumeSetting = loadGlobalSettings\(\)\.autoResume;/);
  assert.match(src, /autoActivate: loadGlobalSettings\(\)\.autoResume === true/);
  assert.ok(!src.includes("resolveEffectiveAggressiveSettings(loadSettings(ctx.cwd)).autoResume"), "no project-cascade autoResume read remains");
});

test("v0.35.x — zombie-run watchdog: busy + zero stream events gets bounded abort and recovery guidance", () => {
  // Field (hellhunter + hegemon 2026-07-30): MiniMax streams died silently
  // (no error, no timeout — pi has no read timeout). pi reported BUSY
  // forever, continuations queued into the void, and the busy flag hid
  // the wedge from every other watchdog (busy≠wedged law). The detector
  // uses a stream-only clock (message_update / tool_call / agent_start /
  // turn_start / agent_end) — heartbeat-internal noteActivity() must never
  // touch it. The first window warns; the bounded grace then parks + aborts
  // once, leaving explicit resume/cancel recovery instead of 85–96m ACTIVE.
  const SRC = readGoalRuntimeSource();
  assert.ok(HEARTBEAT_SRC.includes("ZOMBIE_RUN_SILENT_MS = 20 * 60_000"), "20-min silence threshold");
  assert.ok(HEARTBEAT_SRC.includes("ZOMBIE_RUN_ABORT_GRACE_MS = 10 * 60_000"), "bounded abort grace");
  assert.ok(HEARTBEAT_SRC.includes("ZOMBIE_RUN_ALERT_THROTTLE_MS = 10 * 60_000"), "alert throttle");
  assert.ok(SRC.includes("let lastStreamActivityAt = Date.now();"), "separate stream clock");
  assert.match(HEARTBEAT_SRC, /isSupervising\(\) && !idle && streamSilentMs >= zombieWarningMs/, "branch fires on busy + stream-silent");
  assert.match(HEARTBEAT_SRC, /abortZombieRun\(ctx, flags\.sessionGeneration, state\.goal\?\.id, flags\.lastStreamActivityAt\)/, "bounded abort is generation/stream fenced");
  assert.match(HEARTBEAT_SRC, /appendLedger\(ctx\.cwd, "zombie_run_suspected"/, "warning ledgered");
  assert.match(SRC, /"zombie_run_aborted"/, "abort path is durable");
  assert.ok(HEARTBEAT_SRC.includes("Automatic cleanup will abort it after the bounded grace window"), "first warning explains the bounded cleanup");
  assert.match(SRC, /pi\.on\("message_update"/, "stream deltas feed the clock");
  assert.match(SRC, /pi\.on\("agent_start"/, "run starts feed the clock");
  assert.match(SRC, /pi\.on\("turn_start"/, "turn starts feed the clock");
  // the heartbeat's own bookkeeping must NOT reset the stream clock:
  const noteIdx = SRC.indexOf("function noteActivity(real = false): void {");
  const noteBody = SRC.slice(noteIdx, noteIdx + 220);
  assert.ok(!noteBody.includes("lastStreamActivityAt"), "noteActivity never touches the stream clock");
});

test("v0.35.x — a rejected zombie cleanup does not consume the abort latch", () => {
  const call = HEARTBEAT_SRC.indexOf("if (abortZombieRun(ctx, flags.sessionGeneration, state.goal?.id, flags.lastStreamActivityAt))");
  const latch = HEARTBEAT_SRC.indexOf("lastZombieAbortKey = abortKey", call);
  assert.ok(call >= 0, "the watchdog calls the activation-owned abort");
  assert.ok(latch > call, "the abort key is committed only after abortZombieRun succeeds");
  assert.doesNotMatch(
    HEARTBEAT_SRC.slice(Math.max(0, call - 260), call),
    /lastZombieAbortKey\s*=\s*abortKey/,
    "a failed guard must remain eligible for a later heartbeat cleanup attempt",
  );
});

test("v0.32.1: post-compaction resume debt + deterministic resync (pi-goal-x's lesson)", () => {
  const SRC = readGoalRuntimeSource();
  assert.match(SRC, /let postCompactResumeOwed = false;/);
  assert.match(SRC, /let postCompactResyncPending = false;/);
  assert.match(SRC, /postCompactResumeOwed = true;/); // armed in session_compact
  assert.match(HEARTBEAT_SRC, /compaction_resume_owed_refire/); // heartbeat retries the debt every post-grace tick
  assert.match(CONT, /\[POST-COMPACTION RESYNC\]/); // deterministic re-anchor block (decomposition step 5: buildPostCompactResync moved)
  assert.match(CONT, /content: resync \+ continuationPrompt/); // goal path prepends (decomposition step 5: sendContinuation moved)
  assert.match(LOOP, /content: loopResync \+ loopPrompt/); // loop path prepends (moved to goal-loop.ts, decomposition step 2)
  assert.match(CONT, /resync: Boolean\(resync\)/, "dispatch records whether resync was sent (decomposition step 5: sendContinuation moved)");
  assert.match(CONT, /if \(record\.resync\) flags\.postCompactResyncPending = false;/, "resync is consumed only after start acknowledgement (decomposition step 5: dispatchStartAcknowledged moved + flags re-spelling)");
  // discharged by a real turn start (agent_start), not by the send itself.
  // v0.34.27 may absorb a file-backed replacement before the stream clock;
  // pin the behavior inside the handler rather than obsolete adjacency.
  const agentStart = SRC.slice(SRC.indexOf('pi.on("agent_start"'), SRC.indexOf('pi.on("agent_start"') + 900);
  assert.match(agentStart, /lastStreamActivityAt = Date\.now\(\);/, "agent_start updates the stream clock");
  assert.match(agentStart, /postCompactResumeOwed = false;/, "agent_start discharges compaction debt");
  assert.match(agentStart, /dispatchStartAcknowledged\(ctx, "agent_start"\)/, "agent_start acknowledges an accepted dispatch");
});

// ---------- v0.34.5: subagent-aware wedge alert ----------

test("v0.34.5: wedge alert names a subagent wait when the in-flight call is one", () => {
  const g = readGoalRuntimeSource();
  assert.match(HEARTBEAT_SRC, /SUBAGENT WAIT/, "the alert names the wait type");
  // v0.35.26 (issue #13): the wedge hint consumes the shared
  // isSubagentWaitCall predicate — same name set as the zombie stand-down,
  // extended with the pi-subagents registrations ("subagent", "subagent_wait").
  assert.match(HEARTBEAT_SRC, /\.filter\(isSubagentWaitCall\)/, "detects waits via the shared predicate");
  assert.match(HEARTBEAT_SRC, /"subagent",[\s\S]*?"subagent_wait",/, "the set covers the pi-subagents tool names");
  assert.match(HEARTBEAT_SRC, /tool-use\/token counters have stopped moving between checks is hung, not thinking/, "the liveness check is in the message");
  assert.match(HEARTBEAT_SRC, /subagentWait: subWaits\.size > 0/, "ledger marks subagent waits distinctly");
});

// ---------- v0.34.11: unanswered-continuation watchdog ----------

test("v0.34.11: unanswered-continuation watchdog (accepted send, no turn — hellhunter list-transition wedge)", () => {
  const g = readGoalRuntimeSource();
  assert.match(CONT, /const CONTINUATION_START_TIMEOUT_MS = Number\(process\.env\.GLLA_CONTINUATION_START_TIMEOUT_MS \?\? 30_000\);/, "bounded start-proof timeout (v0.34.88: 30s first window, was 150s; decomposition step 5: moved)");
  assert.match(CONT, /const NO_TURN_START_RETRY_BACKOFF_MS = 60_000;/, "single auto-retry backoff after the first window (decomposition step 5: moved)");
  assert.match(CONT, /if \(!record\.retryCount && retryContinuationDispatch\(current, record\)\) return;/, "exactly ONE automatic retry before unacknowledged (decomposition step 5: moved)");
  assert.match(g, /const CONTINUATION_UNANSWERED_THROTTLE_MS = 300_000;/, "legacy re-alert throttle remains documented");
  // Disarm signal: real activity (agent_end/tool_call via noteActivity(true)) AFTER the last send.
  assert.match(g, /if \(real\) \{ consecutiveStalls = 0; lastRealActivityAt = lastActivityAt; \}/, "real activity stamps lastRealActivityAt");
  assert.match(g, /pendingContinuationDispatch/, "accepted dispatch owns the watchdog before a generic heartbeat refire");
  assert.match(g, /dispatchStartAcknowledged\(ctx, "before_agent_start", event\?\.prompt\)/, "prompt-specific start proof");
  assert.match(CONT, /dispatchStartUnacknowledged\(current, record\)/, "missing proof fails closed (decomposition step 5: watchdog moved)");
  assert.match(CONT, /continuation_start_unacknowledged/);
  assert.match(CONT, /Automatic re-sends are stopped/, "no blind resend storm (decomposition step 5: moved)");
});

// ---------- v0.34.12: eager-continuation settle + wait countdown ----------

test("v0.34.12: eager continuation settles 2.5s past agent_end (hellhunter 60s-per-turn blackhole tax)", () => {
  const g = readGoalRuntimeSource();
  assert.match(g, /const EAGER_CONTINUATION_SETTLE_MS = Number\(process\.env\.GLLA_EAGER_SETTLE_MS \?\? 2_500\);/, "2.5s default, env-overridable");
  assert.match(g, /scheduleContinuation\(ctx, false, EAGER_CONTINUATION_SETTLE_MS\);\n  \}\);/, "agent_end eager path settles");
  // Test harness zeroes it so tick() flushes keep working.
  const setup = fs.readFileSync(path.resolve("tests/harness/setup.ts"), "utf-8");
  assert.match(setup, /process\.env\.GLLA_EAGER_SETTLE_MS \?\?= "0";/);
});

test("v0.34.12 + v0.34.64: wait-pause status line counts down live + ticker survives the wait (pully field request)", () => {
  const d = fs.readFileSync(path.resolve("extensions/goal-loop-display.ts"), "utf-8");
  assert.match(d, /rms <= 0 \? " · resuming…" : ` · auto-retry in \$\{fmtElapsed\(rms\)\}`/, "live countdown, honest past-resumeAt");
  const g = readGoalRuntimeSource();
  assert.match(g, /const auditVisible = state\.goal\?\.status === "auditing";/, "ticker keeps detached-auditor clocks live between worker events");
  assert.match(g, /isSupervising\(\) \|\| auditVisible \|\| \(state\.goal\?\.status === "paused" && !!state\.goal\.pauseResumeAt\)/, "ticker keeps rendering through a timed wait");
});

// ---------- v0.34.16: lifecycle recovery ("keep going unless we MUST stop") ----------

test("v0.34.16: wedges hand off through pi lifecycle — no terminal self-reload", () => {
  const g = readGoalRuntimeSource();
  assert.match(g, /const SESSION_HANDOFF_FILE = "session-handoff\.json";/, "durable handoff marker");
  assert.match(g, /writeSessionHandoff\(ctx, shutdownReason\);/, "shutdown persists resume debt");
  assert.match(g, /clearSessionOwnedTimers\(\);/, "shutdown clears old-context timers");
  assert.match(g, /const handoffResume = consumeSessionHandoff\(ctx\.cwd, ownerClaim\.previousGeneration, ownerClaim\.previousOwnerSessionId\);/, "fresh session consumes matching debt");
  assert.ok(!g.includes("attemptAutoReload"), "no terminal transport");
  assert.ok(!g.includes("auto_reload_injected"), "no reload injection ledger");
  assert.match(HEARTBEAT_SRC, /A fresh session_start will rebind the/, "watchdogs explain the lifecycle cure");
  assert.match(g, /const recoveryResume = consumeRecoveryResume\(ctx\.cwd\);/, "old markers remain one-release compatible");
});

// ---------- v0.34.14: /reload rebind always resumes + auditor streak law ----------

test("v0.34.14: /reload rebind resumes mid-work — the 'list is not continuing' fix (hellhunter)", () => {
  const g = readGoalRuntimeSource();
  assert.match(g, /const SESSION_OWNER_FILE = "session-owner\.json";/, "pid sidecar");
  assert.match(g, /function markSessionOwnerShutdown\(cwd: string, reason: string\): void/, "shutdown reason is persisted for the next lifecycle");
  assert.match(g, /const shutdownReason = previous\.shutdownReason\?\.trim\(\)\.toLowerCase\(\);/, "shutdown reason is classified");
  assert.match(g, /rebind: previous\.pid === process\.pid && !hadShutdown,/, "proper shutdown requires matching handoff consent");
  assert.match(g, /const ownerClaim = claimSessionOwnerAndDetectRebind\(ctx\.cwd, sessionGeneration, sessionManagerId\(ctx\)\);/, "restore claims the generation-bound owner");
  assert.match(g, /appendLedger\(ctx\.cwd, "rebind_resume", \{ pid: process\.pid \}\);/, "rebind resumes are ledger-visible");
  // Cold boots (new pid) still honor autoresume=off; validated handoffs,
  // rebinds, and SAME-PID successors are explicit same-process continuations
  // (v0.35.23: different-pid crash successors hold like any cold load).
  assert.ok(g.includes("(autoResume || explicitRecovery || sameProcessSuccessorResume)"), "loop branch includes validated successor consent");
  assert.ok((g.match(/if \(autoResume \|\| recoveryResume \|\| rebindResume \|\| handoffResume\) \{/g) ?? []).length >= 1, "goal branch keeps its existing lifecycle consent");
});

test("v0.34.51: the hanging-verification cause is named by the timeout branch (pully ssh/sudo stall)", () => {
  const g = readGoalRuntimeSource();
  // The 3-strike pause is gone; a hanging verification command is now caught
  // by the auditor watchdog timeout, which names the cause before asking for
  // an explicit resume.
  assert.match(g, /Check long-running verification commands, then \$\{activeGoalSurfaceCommand\("resume"\)\} to retry the isolated auditor\./, "timeout action names long-running commands");
  assert.match(g, /completion audit timed out — no verifier verdict was produced/, "timeout copy is sanitized while the diagnostic is retained separately");
  assert.match(g, /Watchdog timeouts are infrastructure failures, but retain the exact/, "timeout branch keeps its identity comment");
  assert.ok(!g.includes("a verification command is hanging (ssh/sudo/long test runs stall the stream)"), "3-strike pauseReason gone");
  assert.ok(!g.includes("model broken or a verification command hanging"), "3-strike notify gone");
});

// ---------- v0.34.15: persisted error brake + quota cards + queue-stuck probe ----------

test("v0.34.15: errorBrakeStreak persists ON THE GOAL — the 6-brake park survives /reload (hegemon 429 churn)", () => {
  const g = readGoalRuntimeSource();
  const core = fs.readFileSync(path.resolve("extensions/goal-loop-core.ts"), "utf-8");
  const schema = fs.readFileSync(path.resolve("schemas/goal.schema.json"), "utf-8");
  assert.match(core, /errorBrakeStreak\?: number;/);
  assert.match(schema, /"errorBrakeStreak": \{ "type": "number" \}/);
  assert.match(g, /const brakeStreak = state\.goal!\.errorBrakeStreak \?\? 0;/);
  assert.match(g, /errorBrakeStreak: brakeStreak \+ 1,/);
  assert.ok(!g.includes("let errorBrakeStreak"), "module-state streak gone — reloads no longer reset the ladder");
});

test("provider failures use one generic recovery card", () => {
  const g = readGoalRuntimeSource();
  assert.doesNotMatch(g, /const quotaWall|failureCopy\.signal|Provider request-rate wall|Provider account\/usage wall/);
  assert.match(g, /provider failure|main-model recovery/);
});

test("v0.34.16: queue-stuck probe — a send queued-without-a-turn is reported without terminal injection", () => {
  const g = readGoalRuntimeSource();
  assert.match(CONT, /GLLA_QUEUE_STUCK_MS \?\? 45_000/); // decomposition step 5: queueStuckProbeMs moved
  assert.match(CONT, /appendLedger\(ctx\.cwd, "queue_stuck_detected"/);
  assert.match(HEARTBEAT_SRC, /A fresh session_start will rebind the/);
  assert.match(CONT, /if \(flags\.lastRealActivityAt > sentAt\) return;/, "real work disarms (flags accessor re-spelling)");
  assert.match(CONT, /if \(!ctx\.hasPendingMessages\(\)\) return;/, "consumed message = healthy — even an instant 429 consumes");
  assert.match(CONT, /if \(!ctx\.isIdle\(\)\) return;/, "running turn = healthy");
  assert.match(CONT, /if \(!isSupervising\(\)\) return;/, "paused/completed disarms");
  assert.ok((CONT.match(/armQueueStuckProbe\(lastContinuationSentAt\);/g) ?? []).length >= 2, "armed on goal + stall sends (decomposition step 5: send paths moved)");
  assert.match(CONT, /const ctx = freshCtx\(\);\n      if \(!ctx\) return;.*no fresh lifecycle context/s, "probe resolves a fresh ctx at fire time instead of retaining the sender ctx");
});
