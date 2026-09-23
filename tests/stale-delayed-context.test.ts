// pi-goal-list-loop-audit — v0.34.20
// Regression pins for delayed work crossing a pi session replacement.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import { readGoalRuntimeSource } from "./harness/goal-source.js";

const GOAL = readGoalRuntimeSource();
const CMDS = fs.readFileSync("extensions/goal-commands.ts", "utf8");
const LOOP = fs.readFileSync("extensions/goal-loop.ts", "utf8");
const CORE = fs.readFileSync("extensions/goal-loop-core.ts", "utf8");

function between(source: string, start: string, end: string): string {
  const a = source.indexOf(start);
  const b = source.indexOf(end, a + start.length);
  assert.ok(a >= 0, `missing start marker: ${start}`);
  assert.ok(b > a, `missing end marker: ${end}`);
  return source.slice(a, b);
}

test("v0.34.20: registered agent tools resolve the invocation context", () => {
  assert.match(GOAL, /function registerAgentTools\(pi: any\): void/);
  assert.match(GOAL, /function currentToolContext\(execCtx: unknown\): ExtensionContext \| null/);
  assert.match(GOAL, /const toolCtx = currentToolContext\(execCtx\)/);
  assert.match(GOAL, /const ctx = currentToolContext\(execCtx\)/);
  assert.match(GOAL, /let toolsRegistered = false/);
  assert.doesNotMatch(GOAL, /registeredCtx/);
  assert.doesNotMatch(GOAL, /registeredCtx\?\./);
});

test("v0.34.20: provider retry timers have one session-boundary adapter", () => {
  const directCalls = GOAL.match(/scheduleProviderRetry\(/g) ?? [];
  assert.equal(directCalls.length, 1, "goal.ts may call the generic timer only through its adapter");
  assert.match(GOAL, /function scheduleProviderRetryForSession\(/);
  assert.match(GOAL, /const generation = sessionGeneration;/);
  assert.match(GOAL, /const current = freshCtxForGeneration\(generation\);/);
  assert.match(GOAL, /fire: \(ctx: ExtensionContext\) => void \| Promise<void>/);
  assert.match(GOAL, /scheduleProviderRetryForSession\(liveCtx, plan\.retryAfterSec, result\.error, \(fresh(?:: ExtensionContext)?\) =>/);
  assert.match(GOAL, /scheduleProviderRetryForSession\(ctx, cooldownMs \/ 1000, reason, \(fresh(?:: ExtensionContext)?\) =>/);
});

test("v0.34.20: detached fan-out revalidates after user confirmation", () => {
  const fanout = between(GOAL, "async function fanOutListAuditFindings", "function archiveCurrentGoal");
  assert.match(fanout, /async function fanOutListAuditFindings\(cwd: string, generation: number\)/);
  assert.match(fanout, /freshCtxForGeneration\(generation\)/);
  const confirm = fanout.indexOf("await beforeConfirm.ui.confirm");
  const after = fanout.indexOf("const afterConfirm = freshCtxForGeneration(generation)");
  assert.ok(confirm >= 0 && after > confirm, "confirmation result is checked against the same session generation");
  assert.match(GOAL, /fanOutListAuditFindings\(fanoutCwd, fanoutGeneration\)/);
  assert.doesNotMatch(GOAL, /fanOutListAuditFindings\(ctx\)/);
});

test("v0.34.22: detached completion audits persist lifecycle claims and stop applying after replacement", () => {
  const complete = between(GOAL, 'name: "complete_goal"', 'name: "pause_goal"');
  const claim = complete.indexOf("beginCompletionAudit(ctx");
  const auditor = complete.indexOf("runDetachedGoalCompletionAuditor");
  assert.ok(claim >= 0 && auditor > claim, "the completion claim is durable before the auditor starts");
  assert.match(GOAL, /function beginCompletionAudit\(ctx: ExtensionContext/);
  assert.match(GOAL, /phase: "running"/);
  assert.match(GOAL, /startedAt: new Date\(startedMs\)\.toISOString\(\)/);
  assert.doesNotMatch(GOAL, /wallDeadlineAt: new Date\(startedMs/);
  assert.match(complete, /shouldRetry: \(\) => detachedAuditContext\(auditGeneration, auditGoalId, auditAttemptId\) !== null/);
  assert.match(complete, /completionAuditGeneration = auditGeneration/);
  assert.match(complete, /const auditContextAfterRun = freshCtxForGeneration\(auditGeneration\)/);
  // v0.37.0: the dispatch spreads the effective per-tool budget into the
  // display progress; the lifecycle guard (generation-scoped publish) is
  // what this pin protects.
  assert.match(complete, /publishDetachedAuditProgress\(auditGeneration, auditGoalId, auditAttemptId, \{ \.\.\.progress, toolTimeoutMs \}\)/);
  assert.match(complete, /detachedAuditContext\(auditGeneration, auditGoalId, auditAttemptId\)/);
  assert.match(complete, /if \(!auditContextAfterRun \|\| !state\.goal \|\| state\.goal\.id !== auditGoalId\)/);
  assert.match(GOAL, /shouldRetry: \(\) => detachedAuditContext\(generation, goalId, claim\.attemptId!\) !== null/);
  assert.match(GOAL, /async function retryStoredCompletionAudit\(origin: CompletionAuditOrigin = "provider-retry"(, exemptLoadHold = false)?\)/);
  assert.doesNotMatch(GOAL, /retryStoredCompletionAudit\(ctx,/);
});

test("v0.34.20: generic infra retry supports a lifecycle guard before and after backoff", () => {
  assert.match(CORE, /shouldRetry\?: \(\) => boolean/);
  assert.match(CORE, /if \(opts\.shouldRetry\) \{/);
  assert.match(CORE, /if \(!opts\.shouldRetry\(\)\) return \{ result: first, retriedOnce: false \}/);
});

test("v0.34.20: manual resume consumes a stored completion claim directly", () => {
  const resume = between(CMDS, "async function cmdResume", "async function cmdCancel");
  assert.match(resume, /const storedCompletion = state\.goal\.pendingCompletion/);
  assert.match(resume, /if \(storedCompletion\) \{/);
  assert.match(resume, /void retryStoredCompletionAudit\("manual"\)/);
});

test("v0.34.20: loop measurement and branch cleanup rebind after async work", () => {
  const tick = between(LOOP, "async function runLoopTick", "async function finishLoopGit");
  assert.match(tick, /const generation = flags\.sessionGeneration/); // flag accessor re-spelling (decomposition step 2)
  assert.match(tick, /const rebind = \(\): boolean =>/);
  // v0.35.4: the tick captures state.loop before its first await and must
  // rebind the LOOP OBJECT too — a concurrent /loop stop/pause/park/refine
  // replaces state.loop (spread sites) while runMeasure is up to 10 min in
  // flight; mutations on the stale object never persist and finishLoopGit
  // runs git against the wrong run.
  assert.match(tick, /let loop = state\.loop!;/);
  assert.match(tick, /const rebindLoop = \(\): boolean =>/);
  assert.match(tick, /if \(state\.loop === loop\) return true;/);
  assert.match(tick, /if \(replaced && replaced\.active\) \{\n\s*loop = replaced;/);
  assert.match(tick, /appendLedger\(ctx\.cwd, "loop_tick_abandoned"/);
  assert.match(tick, /await runMeasure\(ctx, loop\.measureCmd!\);\n  if \(!rebindLoop\(\)\) return;/);
  assert.match(tick, /await runGit\(ctx, \["rev-parse", "HEAD"\]\);\n  if \(!rebindLoop\(\)\) return;/);
  assert.match(tick, /if \(await finishLoopGit\(ctx, loop\)\) return;\n\s*if \(!rebindLoop\(\)\) return;/);
  assert.doesNotMatch(tick, /await runMeasure\(ctx, loop\.measureCmd!\);\n  if \(!rebind\(\)\) return;/);
  // v0.35.4: branch=1 terminal stops must not erase the final iteration's
  // work (finishLoopGit resets --hard), and flat/null measures are not
  // regressions (v0.29.10/E5) — only worse-than-best values hard-reset.
  assert.match(tick, /const commitPendingTerminalWork = async \(\): Promise<boolean> =>/);
  assert.match(tick, /} else if \(value !== null && value !== loop\.bestValue\) \{/);
  assert.match(tick, /if \(!await commitPendingTerminalWork\(\)\) return;\n    if \(await finishLoopGit\(ctx, loop\)\) return;/);
  const finish = between(LOOP, "async function finishLoopGit", "interface LoopConfig");
  assert.match(finish, /const afterReset = freshCtxForGeneration\(generation\)/);
  assert.match(finish, /const afterCheckout = freshCtxForGeneration\(generation\)/);
  assert.match(GOAL, /let completionAuditGeneration: number \| null = null/);
  assert.match(GOAL, /function ownsDetachedAudit\(generation: number, goalId: string, attemptId: string\)/);
  assert.match(GOAL, /state\.goal\.pendingCompletion\?\.attemptId === attemptId/);
});
