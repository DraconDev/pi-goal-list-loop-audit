// pi-goal-list-loop-audit — v0.28.5
// tests/retry-bounds.test.ts
//
// Pins the v0.28.5 silent-retry-loop bounds (audit findings E2, E3, E8 —
// audit/WRONG-OR-NOT-PREMIUM-2026-07-28.md Stream 2):
//   E2  auditor infra errors retried FOREVER (the 39-error incident): each
//       infra failure rescheduled a continuation unconditionally. Now a
//       persisted auditInfraStreak pauses the goal loudly at 3.
//   E3  the 50ms BACKOFF_IDLE_RETRY re-arm loop spun for HOURS with zero
//       ledger events while idle watchdogs stayed suppressed. Now counted,
//       ledgered (start + every 30s), escalated loudly past 5 minutes.
//   E8  the consecutive-errors brake paused with the literal reason
//       "5 consecutive errors: error" (stopReason, not the provider error),
//       counted USER ABORTS as errors, and had no recovery — the 10:07
//       incident lost 1.5h of the audit goal to a 60s provider flake.
//       Now: real error text in the reason, aborts braked separately with
//       no auto-resume (user intent), errors get ONE capped 60s auto-resume.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import { readGoalRuntimeSource } from "./harness/goal-source.js";

const SRC = readGoalRuntimeSource();
const CONT = fs.readFileSync("extensions/goal-continuation.ts", "utf-8"); // decomposition step 5 (v0.34.113)
const RECOVERY = fs.readFileSync("extensions/goal-recovery.ts", "utf-8"); // decomposition step 3 (v0.34.111)
const LOOP = fs.readFileSync("extensions/goal-loop.ts", "utf-8");
const CORE = fs.readFileSync("extensions/goal-loop-core.ts", "utf-8");
const PROVIDER_RETRY = fs.readFileSync("extensions/quota-retry.ts", "utf-8");
const SCHEMA = fs.readFileSync("schemas/goal.schema.json", "utf-8");

test("E2: persisted auditInfraStreak field (type + schema)", () => {
  assert.match(CORE, /auditInfraStreak\?: number;/);
  assert.match(SCHEMA, /"auditInfraStreak": \{ "type": "number" \}/);
});

test("E2: auditor infra errors enter the durable bounded retry plan (v0.34.51 — no 3-strike stop)", () => {
  // The 3-strike breaker is GONE: every non-timeout infrastructure failure
  // preserves the claim on the durable bounded one-shot schedule. Bounds are
  // the plan's 5h probe cap + 24h horizon, not "we decided it's broken".
  assert.ok(!SRC.includes("const infraStreak = (state.goal.auditInfraStreak ?? 0) + 1;"), "3-strike streak counter gone");
  assert.ok(!SRC.includes("const reachedInfraCap = infraStreak >= 3;"), "3-strike cap gone");
  assert.ok(!SRC.includes("auditor infrastructure failed ${infraStreak}× in a row"), "3-strike wording gone");
  assert.ok(!SRC.includes("audit_infra_waiting\", { goalId, attemptId: claim.attemptId, error: result.error.slice(0, 240), infraStreak }"), "3-strike ledger payload gone");
  // The stranded-audit no-verdict blocker keeps its own distinct wording
  // ("Fix the auditor/session issue" — a different feature from the
  // 3-strike stop):
  assert.match(RECOVERY, /The completion claim is stored and was not judged\. Fix the auditor\/session issue/); // decomposition step 3 (v0.34.111)
  // The durable plan owns the wait: retry-waiting phase, wait-kind pause,
  // conservative horizon stop, aggressive unbounded retry, and a re-checked
  // auto-resume callback.
  assert.match(SRC, /phase: "retry-waiting" as const/);
  assert.match(SRC, /auditor retry: automatic retry horizon reached \(\$\{plan\.attempt\} attempts\)/);
  assert.match(SRC, /startsWith\("auditor retry:"\)/);
  // a real auditor run still clears the persisted streak:
  // v0.34.14: only a CLEAN run clears — a stalled run returns partial output
  // (auditorRan true) WITH result.error set; clearing on those meant the
  // old 3-strike breaker never engaged (pully: 4h of 10-min stall cycles).
  assert.match(SRC, /if \(auditorRan && !result\.error && \(state\.goal\.auditInfraStreak \?\? 0\) > 0\) updateGoal\(\{ auditInfraStreak: undefined \}, ctx\);/);
  assert.match(SRC, /auditInfraStreak: undefined, \/\/ durable retry owns the wait — infra streak broken/);
});

test("v0.36.0: aggressive recovery has no wall-clock episode horizon", () => {
  assert.match(RECOVERY, /const normalizedRecovery = aggressive \? \{ \.\.\.normalizedBase, autoRetryUntil: undefined \} : normalizedBase;/);
  assert.match(RECOVERY, /!aggressive && Number\.isFinite\(deadlineMs\)/);
  assert.match(RECOVERY, /autoRetryUntil: aggressive \? undefined : mainModelAutoRetryUntil/);
  assert.match(RECOVERY, /adaptive backoff for as long as it remains recoverable/);
  assert.match(SRC, /auditorRetryPlan\(durableClaim, undefined, undefined, aggressive\)/);
  assert.match(SRC.replace(/\s+/g, " "), /aggressive \|\| \(attempt < MAX_AUDITOR_AUTO_RETRY_ATTEMPTS/);
});

test("v0.36.0: aggressive auditor disapprovals become durable TODOs and stop on repeated no-progress", () => {
  assert.match(SRC, /const durableObjections = result\.disapproved && effectiveCap\.aggressiveMode/);
  assert.match(SRC, /appendLedger\(ctx\.cwd, "audit_objections_todo"/);
  assert.match(SRC, /countTrailingRepeatedDisapprovals\(history\)/);
  assert.match(SRC, /audit_no_progress_stop/);
  assert.match(SRC, /pendingTasks: effectiveCap\.aggressiveMode \? durableObjections : undefined/);
  assert.match(SRC, /ordinary disapproval becomes the current durable/);
});

test("E3: send-retry re-arms counted, ledgered, escalated", () => {
  assert.match(CONT, /appendLedger\(ctx\.cwd, "send_rearm_start", \{ kind \}\)/); // decomposition step 5: accountSendRearm moved
  assert.match(CONT, /appendLedger\(ctx\.cwd, "send_rearm_storm", \{ kind, streak/);
  // v0.34.102: a storm with NO accepted dispatch since it began surfaces
  // the "no turn started" diagnostic (field: dracon-platform 091828):
  assert.match(CONT, /appendLedger\(ctx\.cwd, "rearm_no_turn_started", \{ streak/);
  // wired into both send paths' re-arm sites:
  assert.match(CONT, /accountSendRearm\(ctx, "continuation"\);/);
  assert.match(LOOP, /\} else accountSendRearm\(ctx, "loop"\);/); // v0.33.1: null-ctx probes + backs off (moved to goal-loop.ts)
  assert.match(LOOP, /if \(probeExtensionApiStale\(\)\) return;\s*\n\s*flags\.loopRearmStreak\+\+;/); // v0.33.1 (flag accessor re-spelling)
  // a landed send clears the storm:
  assert.match(CONT, /continuationRearmStreak = 0; continuationRearmSince = 0; \/\/ v0\.28\.5 \(E3\)/); // decomposition step 5: sendContinuation moved
  assert.match(LOOP, /flags\.loopRearmStreak = 0; flags\.loopRearmSince = 0; \/\/ v0\.28\.5 \(E3\)/); // flag accessor re-spelling
});

test("v0.28.29: busy-retry cadence backs off (no more flat 50ms spins)", () => {
  assert.match(CONT, /function sendRearmDelayMs\(streak: number\): number/); // decomposition step 5: moved
  assert.match(CONT, /if \(streak <= 4\) return 50;/);
  assert.match(CONT, /if \(streak <= 8\) return 250;/);
  assert.match(CONT, /if \(streak <= 12\) return 1_000;/);
  assert.match(CONT, /return 30_000;/);
  assert.match(CONT, /scheduleSessionTimeout\(\(\) => sendContinuation\(goalId\), sendRearmDelayMs\(continuationRearmStreak\)\)/);
  assert.match(LOOP, /scheduleSessionTimeout\(\(\) => sendLoopTurn\(\), sendRearmDelayMs\(flags\.loopRearmStreak\)\)/); // flag accessor re-spelling
});

test("v0.28.29: escalation is TIME-based and ACTIVITY-gated (busy ≠ wedged — the polis false positive)", () => {
  // v0.34.108: the flat SEND_REARM_ESCALATE_AFTER_MS constant was dead code
  // (superseded by sendStormEscalateMs()'s knowledge-aware threshold) and
  // was removed. The activity gate and the 5m silent window remain.
  assert.match(CONT, /const SEND_REARM_ESCALATE_SILENT_MS = 5 \* 60_000;/); // decomposition step 5: moved
  assert.ok(!SRC.includes("SEND_REARM_ESCALATE_AFTER_MS"), "flat escalation constant removed (v0.34.108 dead-code sweep)");
  assert.ok(!CONT.includes("SEND_REARM_ESCALATE_AFTER_MS"), "flat escalation constant removed (v0.34.108 dead-code sweep)");
  // v0.34.57: the flat 15m check became the generic branch of the
  // knowledge-aware threshold — the activity gate is unchanged.
  assert.match(CONT, /elapsed >= sendStormEscalateMs\(\) && Date\.now\(\) - flags\.lastActivityAt >= SEND_REARM_ESCALATE_SILENT_MS/);
  assert.match(CONT, /const SEND_REARM_LEDGER_MILESTONES_MS = \[2 \* 60_000, 5 \* 60_000, 10 \* 60_000\];/);
  assert.match(CONT, /"send_rearm_escalated", \{ kind, afterMinutes: mins, silentMinutes: silent \}/);
  assert.ok(!SRC.includes("SEND_REARM_ESCALATE_AT"), "count-based escalation constant gone");
  assert.ok(!CONT.includes("SEND_REARM_ESCALATE_AT"), "count-based escalation constant gone");
  assert.ok(!SRC.includes("SEND_REARM_LEDGER_EVERY"), "count-based ledger constant gone");
  assert.ok(!CONT.includes("SEND_REARM_LEDGER_EVERY"), "count-based ledger constant gone");
});

test("E3: provider-held send storms enter durable main-model recovery", () => {
  assert.match(CONT, /function escalateSendRearmStorm\(ctx: ExtensionContext, kind: "continuation" \| "loop"\): void/); // decomposition step 5: moved
  assert.match(CONT, /send-retry storm: \$\{mins\}m of re-arms with no session activity for \$\{silent\}m — the session never went idle for the continuation/);
  // v0.34.31: a supervising goal/loop rotates through configured backups and
  // installs a durable retry probe instead of making Escape the recovery plan.
  assert.match(CONT, /void recoverMainModelFromSendStorm\(ctx, kind\);/);
  assert.match(CONT, /backup when possible, and install a durable recovery probe/);
  // The old restart-first guidance must not be the active loop-storm path.
  assert.ok(!SRC.includes("Press Escape to cancel the stuck run (pi's own rate-limit retry holds it; pi prints"));
  assert.ok(!SRC.includes("Restart pi, then /goal resume."), "restart-first storm guidance gone");
  assert.ok(!SRC.includes("Restart pi, then /loop resume"), "restart-first loop guidance gone");
});

test("E8: the error brake carries the REAL error text, not stopReason", () => {
  assert.match(SRC, /const rawErrorText = normalizeProviderErrorText\(rawLastA, text\)/, "structured provider error metadata and visible text are normalized");
  assert.match(SRC, /const detail = rawErrorText\s*\n\s*\? ` \(last: \$\{failureCopy\.sensitive \? failureCopy\.display/);
  // v0.34.26: generic errors keep the legacy reason shape, while provider
  // walls use only a safe classification and retain raw text in diagnostics.
  assert.match(SRC, /const reason = outputLimitWall\n\s+\? `output-token limit — the provider rejected \$\{consecutiveErrorIterations\} overlong responses`\n\s+: `5 consecutive errors\$\{detail\}`;/);
  assert.ok(!SRC.includes('pauseReason: `5 consecutive errors: ${stopReason}`'), "old literal-'error' shape gone");
});

test("v0.34.26: output-token-limit provider errors are classified as a deterministic wall, not a flake", () => {
  assert.match(SRC, /const outputLimitWall = \/output\[ -\]\?token\|max_\?tokens\|length limit\|output length\|too many tokens\/i\.test\(rawErrorText\);/);
  // the deterministic branch pauses with pauseKind error and never schedules
  // the flake ladder or hourly probes — it sits BEFORE the 6-brake park:
  const wallIdx = SRC.indexOf("if (outputLimitWall) {");
  const capIdx = SRC.indexOf("if (brakeStreak >= 6) {");
  assert.ok(wallIdx > 0 && capIdx > wallIdx, "output-limit branch precedes the 6-brake park");
  const wallBranch = SRC.slice(wallIdx, capIdx);
  assert.match(wallBranch, /pauseKind: "error",/);
  assert.match(wallBranch, /Deterministic wall — the provider rejects this response shape every time/);
  assert.match(wallBranch, /activeGoalSurfaceCommand\("resume"\)\}/); // v0.34.51 mode-aware
  assert.ok(!wallBranch.includes("scheduleProviderRetryForSession"), "no flake auto-resume for a deterministic wall");
  assert.ok(!wallBranch.includes("pauseResumeAt"), "no wait-timer for a deterministic wall");
});

test("v0.34.36: a loop whose continuation never starts is durably stopped and resumable", () => {
  assert.match(CONT, /if \(record\.kind === "loop" && state\.loop\?\.active\)/); // decomposition step 5: retryContinuationDispatch moved
  assert.match(CONT, /stopReason: `stalled: continuation start acknowledgement timed out/);
  assert.match(LOOP, /!!r\?\.startsWith\("stalled:"\)/);
});

test("v0.34.51: stored-claim auditor retries enter the durable plan on ANY infra error", () => {
  const retry = SRC.slice(SRC.indexOf("async function retryStoredCompletionAudit"));
  // timeout branch first (a hanging command keeps its loud pause)…
  assert.match(retry, /isAuditorNoVerdictInfrastructureError\(result\.error, result\.infrastructureClass\)\) \{[\s\S]{0,220}?Watchdog timeouts stay ahead/);
  // …then the widened durable branch — no kind gate, neutral wording:
  assert.match(retry, /ANY infrastructure failure enters the durable retry plan/);
  assert.match(retry, /phase: "retry-waiting" as const/);
  assert.match(retry, /startsWith\("auditor retry:"\)/);
  assert.ok(!retry.includes("audit_infra_waiting\", { goalId, attemptId: claim.attemptId, error: result.error.slice(0, 240), infraStreak }"), "3-strike ledger payload gone from stored-claim retries");
});

test("v0.34.26: length-continue exhaustion is a durable paused state, not a transient notify", () => {
  assert.match(SRC, /appendLedger\(ctx\.cwd, "length_continue_exhausted", \{ consecutive: lc\.consecutive \}\);/);
  assert.match(SRC, /pauseReason: `output-token limit — \$\{LENGTH_CONTINUE_MAX\} responses in a row were truncated mid-artifact; auto-continue exhausted`,/);
  assert.match(SRC, /pauseKind: "error",/);
  assert.match(SRC, /then \$\{activeGoalSurfaceCommand\("resume"\)\} — the truncation budget restarts fresh\./); // v0.34.51 mode-aware
  // the sticky gaveUp tracker resets so an explicit resume gets a fresh budget:
  assert.match(SRC, /resetLengthContinue\(\);/);
  // loop path: explicit stop reason with preserved iteration:
  assert.match(SRC, /state\.loop\.stopReason = `output-token limit — \$\{LENGTH_CONTINUE_MAX\} consecutive truncated responses \(iteration \$\{state\.loop\.iteration\} preserved/);
});

test("E8: user aborts braked SEPARATELY — honest message, no auto-resume", () => {
  assert.match(SRC, /let consecutiveAbortIterations = 0;/);
  assert.match(SRC, /\} else if \(stopReason === "aborted"\) \{/);
  assert.match(SRC, /pauseReason: "5 consecutive aborts \(user interrupted\)"/);
  // abort branch must NOT schedule an auto-resume (user intent):
  const abortBranch = SRC.slice(SRC.indexOf('} else if (stopReason === "aborted") {'), SRC.indexOf("} else {", SRC.indexOf('} else if (stopReason === "aborted") {')));
  assert.ok(!abortBranch.includes("scheduleQuotaRetry"), "no auto-resume for user aborts");
});

test("E8: provider-error brake gets ONE capped escalating auto-resume with reason re-check (v0.28.25)", () => {
  // v0.28.25: the cooldown escalates per consecutive brake — 60s, 2m, 4m,
  // 8m, 16m cap. First brake is still 60s (60_000 * 2^0).
  assert.match(SRC, /const cooldownMs = 60_000 \* 2 \*\* Math\.min\(brakeStreak, 4\);/);
  assert.match(SRC, /errorBrakeStreak: brakeStreak \+ 1,/, "v0.34.15: the rung is stamped ON THE GOAL (survives /reload)");
  assert.match(SRC, /scheduleProviderRetryForSession\(ctx, cooldownMs \/ 1000, reason, \(fresh(?:: ExtensionContext)?\) => \{/);
  assert.match(SRC, /if \(\(state\.goal\?\.errorBrakeStreak \?\? 0\) > 0\) updateGoal\(\{ errorBrakeStreak: undefined \}, ctx\);/, "a healthy turn clears the persisted brake streak");
  assert.match(SRC, /\(state\.goal\.pauseReason \?\? ""\)\.startsWith\("5 consecutive errors"\)/);
  assert.match(SRC, /appendLedger\(fresh\.cwd, "goal_resumed", \{ via: "error-brake-retry" \}\)/);
  // The generic scheduler still accepts a caller label:
  assert.match(PROVIDER_RETRY, /label = "Provider retry",/);
});

test("v0.28.25: inter-error retries ride an exponential ladder, not the immediate continuation", () => {
  // dracon-utilities: 5 concurrent-limit 403s retried back-to-back (delay 0
  // at agent_end — the session is idle), then the brake cycled for 1h 38m.
  assert.match(SRC, /const ERROR_RETRY_LADDER_MS = \[5_000, 15_000, 45_000, 90_000, 180_000\];/);
  assert.match(SRC, /appendLedger\(ctx\.cwd, "error_retry_backoff", \{ attempt: consecutiveErrorIterations, delayMs: retryDelayMs \}\);/);
  assert.match(SRC, /scheduleContinuation\(ctx, true, retryDelayMs\);/);
  // the ladder return sits inside the error branch, before the generic fall-through:
  const ladderIdx = SRC.indexOf("scheduleContinuation(ctx, true, retryDelayMs);");
  const abortBranch = SRC.indexOf('} else if (stopReason === "aborted") {');
  assert.ok(ladderIdx > 0 && abortBranch > ladderIdx, "ladder return precedes the aborted branch");
  // and scheduleContinuation honors an explicit delay:
  assert.match(CONT, /function scheduleContinuation\(ctx: ExtensionContext, force = false, delayMs\?: number\): void \{/); // decomposition step 5: moved
  assert.match(CONT, /delay = delayMs \?\? \(ctx\.isIdle\(\)/);
});

test("v0.28.26: quota-blocked audits store the claim + the retry re-runs the AUDITOR directly (no agent turn)", () => {
  // π-games incident: quota-blocked complete_goal → resume re-engaged the
  // agent → the model hallucinated closure and repeated itself into a
  // continuation storm + 14 compactions in 35 minutes.
  // 1. the claim is persisted at the quota block:
  assert.match(SRC, /pendingCompletion: pending/);
  assert.match(SRC, /phase: "retry-waiting" as const/);
  // 2. the retry callback prefers the direct-audit path (v0.34.51: any
  //    infra error, not just quota):
  const cbIdx = SRC.indexOf('(state.goal.pauseReason ?? "").startsWith("auditor retry:")');
  const directIdx = SRC.indexOf("void retryStoredCompletionAudit();");
  assert.ok(cbIdx > 0 && directIdx > cbIdx, "direct-audit branch inside the quota callback");
  const legacyIdx = SRC.indexOf('appendLedger(fresh.cwd, "goal_resumed", { via: "provider-retry" });');
  assert.ok(legacyIdx > directIdx, "agent-resume is the FALLBACK (no stored claim), not the default");
  // 3. the retry function re-runs the auditor with the stored claim:
  //    v0.35.23: optional exemptLoadHold param — only the main-model-
  //    recovery trigger passes it (pinned provider-heal consent).
  assert.match(SRC, /async function retryStoredCompletionAudit\(origin: CompletionAuditOrigin = "provider-retry", exemptLoadHold = false\): Promise<void> \{/);
  assert.match(SRC, /completionSummary: claim\.completionSummary,/);
  assert.match(SRC, /verificationSummary: claim\.verificationSummary,/);
  // 4. approved → archive (cascade inside archiveCurrentGoal); claim cleared:
  assert.match(SRC, /const archived = archiveCurrentGoal\(liveCtx, "complete", `auditor \$\{result\.model\} approved \(\$\{origin\}\)`, \{\}, \{ findingGroups: claim\.findingGroups, gateRows: claim\.gateRows \}\)/, "v0.38.52: the audited claim's finding groups + gate rows ride into the archive");
  assert.match(SRC, /if \(!archived\) \{[\s\S]*?goal_archive_failed_after_approval/);
  assert.match(SRC, /updateGoal\(\{ auditHistory: history, pendingCompletion: undefined \}, liveCtx\)/);
  // 5. still-failing → re-pause with the claim PRESERVED + another scheduled retry:
  assert.match(SRC, /auditor retry: retry in \$\{plan\.retryAfterSec\}s \(uniform schedule\)/);
  assert.match(SRC, /retryUntil: plan\.autoRetryUntil/);
  // 6. any other verdict hands back to the agent:
  assert.match(SRC, /appendLedger\(liveCtx\.cwd, "provider_retry_audit_verdict", \{/);
});

test("v0.28.26: pendingCompletion typed + schematized", () => {
  const CORE = fs.readFileSync("extensions/goal-loop-core.ts", "utf-8");
  assert.match(CORE, /export interface PendingCompletion/);
  assert.match(CORE, /pendingCompletion\?: PendingCompletion;/);
  const SCHEMA = fs.readFileSync("schemas/goal.schema.json", "utf-8");
  assert.match(SCHEMA, /"pendingCompletion": \{ "\$ref": "#\/definitions\/pendingCompletion" \}/);
  assert.match(SCHEMA, /"phase": \{ "type": "string", "enum": \["running", "recovery-pending", "retry-waiting", "quota-waiting"\]/);
});
