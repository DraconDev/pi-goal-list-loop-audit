// pi-goal-list-loop-audit — v0.34.104
// tests/image1-list-stall-and-count-fix.test.ts
//
// [Image-#1] 2026-08-08 10:29 π-dracon-platform — two distinct problems
// captured in the same screenshot, both fixed as one batch:
//
//   1. List-item stall after audit completion — the queue auto-advances
//      immediately after a completion, firing a continuation at pi while
//      pi is still settling the completion acknowledgement. The v0.34.88
//      no-turn-start watchdog (30s + 60s retry) declared the new item
//      unacknowledged → queue stuck for manual /list resume even though
//      pi was about to start a turn on its own. Fix: a bounded settle
//      window (LIST_COMPLETION_SETTLE_MS = 15s) delays the FIRST
//      continuation dispatched from the list-complete cascade; any agent
//      activity during the window cancels the deferred send.
//
//   2. "29/28 pass" cosmetic bug — the completionSummary text said
//      "29/28 pass, 0 fail" (more tests passing than existed). The agent
//      generated the string; the plugin persisted it verbatim. Fix:
//      validateCompletionSummary scans for impossible counts at capture
//      time, ledgers `completion_summary_impossible_count`, and appends
//      a "Counts appear inconsistent: X passed vs Y total" note to the
//      recap so the user + auditor see the discrepancy.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { readGoalRuntimeSource } from "./harness/goal-source.js";

const SRC = readGoalRuntimeSource();
const CONT = fs.readFileSync(path.resolve("extensions/goal-continuation.ts"), "utf-8"); // decomposition step 5 (v0.34.113)

// ---------------------------------------------------------------- Problem 1

test("v0.34.104 [Image-#1] Problem 1: LIST_COMPLETION_SETTLE_MS constant + flag exist", () => {
  assert.match(SRC, /const LIST_COMPLETION_SETTLE_MS = Number\(process\.env\.GLLA_LIST_COMPLETION_SETTLE_MS \?\? 15_000\);/);
  assert.match(SRC, /let postCompletionSettleUntil = 0;/);
});

test("v0.34.104 [Image-#1] Problem 1: archiveCurrentGoal arms the settle window BEFORE activating the next item", () => {
  const archive = SRC.slice(SRC.indexOf("if (goal.policy === \"list\" && status === \"complete\")"));
  // The flag is armed before the cascade, so the scheduleContinuation inside
  // activateNextListItem picks up the settle delay instead of dispatching in
  // the same millisecond as completion acknowledgement:
  assert.match(archive, /postCompletionSettleUntil = Date\.now\(\) \+ LIST_COMPLETION_SETTLE_MS;/);
  assert.match(archive, /"list_completion_settle_armed"/);
  // Ordering: arm runs before advance:
  const advanceAt = archive.indexOf("activateNextListItem(ctx)");
  const armAt = archive.indexOf("postCompletionSettleUntil = Date.now()");
  assert.ok(advanceAt > -1 && armAt > -1 && armAt < advanceAt, "the arm precedes activation so the scheduled continuation picks up the settle delay");
});

test("v0.34.104 [Image-#1] Problem 1: scheduleContinuation honours the settle window", () => {
  const sched = CONT.slice(CONT.indexOf("function scheduleContinuation"), CONT.indexOf("function sendContinuation")); // decomposition step 5
  assert.match(sched, /const settleRemaining = flags\.postCompletionSettleUntil - Date\.now\(\);/); // flag accessor re-spelling (decomposition step 5)
  assert.match(sched, /if \(settleRemaining > 0\) \{\s*\n\s*delay = Math\.max\(delay, settleRemaining\);/);
  assert.match(sched, /"list_completion_settle_pending"/);
});

test("v0.34.104 [Image-#1] Problem 1: agent activity during settle cancels the deferred send", () => {
  const ack = CONT.slice(CONT.indexOf("function dispatchStartAcknowledged"), CONT.indexOf("function dispatchAccepted")); // decomposition step 5
  const settleClearAt = ack.indexOf("list_completion_settle_cleared");
  const pendingGuardAt = ack.indexOf("const record = pendingContinuationDispatch;");
  assert.ok(settleClearAt > -1 && settleClearAt < pendingGuardAt, "settle-clear precedes the pending-dispatch guard");
  assert.match(ack, /clearContinuationTimer\(\);\s*\n\s*continuationScheduledFor = null;/);
  assert.match(ack, /postCompletionSettleUntil = 0;/);
});

test("v0.34.104 [Image-#1] Problem 1: sendContinuation honors an early settle callback", () => {
  const send = CONT.slice(CONT.indexOf("function sendContinuation"), CONT.indexOf("function sendStallEscalation")); // decomposition step 5
  assert.match(send, /const settleRemaining = flags\.postCompletionSettleUntil - Date\.now\(\);/);
  assert.match(send, /if \(settleRemaining > 0\)[\s\S]*scheduleSessionTimeout\(\(\) => sendContinuation\(goalId\), settleRemaining\)/);
  assert.match(send, /postCompletionSettleUntil = 0;/);
});

// ---------------------------------------------------------------- Problem 2

test("v0.34.104 [Image-#1] Problem 2: validateCompletionSummary exists and is wired into complete_goal capture", () => {
  assert.match(SRC, /function validateCompletionSummary\(text: string, ctx: ExtensionContext\): string/);
  // v0.34.119: validation happens BEFORE beginCompletionAudit so the
  // amended text reaches pendingCompletion and the detached auditor too.
  assert.match(SRC, /const validated = p\.completionSummary\?\.trim\(\) \? validateCompletionSummary\(p\.completionSummary, ctx\) : p\.completionSummary;/);
  assert.match(SRC, /const validatedSummary = validated\?\.trim\(\) \|\| undefined;/);
  // v0.34.119: validation happens BEFORE beginCompletionAudit so the
  // amended text reaches pendingCompletion and the detached auditor too.
  // v0.34.128: finalSummary (the version-less already-shipped label) is
  // derived from validatedSummary and flows into BOTH beginCompletionAudit
  // and the detached auditor — the pinned wiring below.
  assert.match(SRC, /const finalSummary = versionlessAlreadyShipped && validatedSummary/);
  // v0.38.69 (Antigravity port): the density lint sits between
  // finalSummary and the claim — claimedSummary carries an optional NOTE
  // annotation, and THAT flows into BOTH beginCompletionAudit and the
  // detached auditor.
  assert.match(SRC, /const densityNote = completionSummaryDensityNote\(finalSummary, sanitizedGroups, sanitizedGates\);/);
  assert.match(SRC, /const completionClaim = beginCompletionAudit\(ctx, \{\s*completionSummary: claimedSummary,/s);
  assert.match(SRC, /completionSummary: claimedSummary,\s*\n\s*verificationSummary: p\.verificationSummary,/s);
});

test("v0.34.104 [Image-#1] Problem 2: impossible X/Y pass counts match the field regex (29/28)", () => {
  const field = "deals/verification.ts verified. bun test \u2192 29/28 pass, 0 fail, 75 expect() calls.";
  const ratio = /(\d{1,4})\s*\/\s*(\d{1,4})\s*(?:tests?\s+)?pass(?:es|ed)?\b/i;
  const m = ratio.exec(field);
  assert.ok(m, "the field text matches the X/Y pass regex");
  assert.equal(Number(m[1]), 29);
  assert.equal(Number(m[2]), 28);
  assert.ok(Number(m[1]) > Number(m[2]), "the field case IS the impossible-count case");
});

test("v0.34.104 [Image-#1] Problem 2: ledger event `completion_summary_impossible_count` is the canonical key", () => {
  assert.match(SRC, /"completion_summary_impossible_count"/);
  assert.match(SRC, /flags,\s*\n\s*excerpt: text\.slice\(0, 240\),/);
});

test("v0.34.104 [Image-#1] Problem 2: clean input early-returns before any ledger work", () => {
  const helper = SRC.slice(SRC.indexOf("function validateCompletionSummary"), SRC.indexOf("function beginCompletionAudit"));
  const earlyReturn = helper.indexOf("if (flags.length === 0) return text;");
  const ledgerCall = helper.indexOf('"completion_summary_impossible_count"');
  assert.ok(earlyReturn > -1 && earlyReturn < ledgerCall, "clean input returns text before any ledger work");
});