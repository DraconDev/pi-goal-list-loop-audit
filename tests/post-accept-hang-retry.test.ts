// pi-goal-list-loop-audit — v0.35.17
// tests/post-accept-hang-retry.test.ts
//
// Field (note.md Next §1, screenshot 20260821_152311): turns dispatched by
// ACCEPTING a Confirm dialog hang with zero provider stream activity often
// enough that users repeatedly return to "action needed - this won't fix
// itself" parked sessions. The zero-stream watchdog now supports a finite
// configurable retry budget: repeated silent attempts get recovery chances,
// then exhaustion parks permanently.
//
// Layers under test:
//   1. zombieRetryDecision (pure, goal-loop-backoff.ts) — the finite retry
//      budget: repeated consecutive silences retry until the limit, while
//      real stream activity between aborts starts a fresh streak.
//   2. Source pins — the scheduler is wired into abortZombieRun with the
//      supervisor-pause gate, the exact pauseReason supersede guard, and the
//      abort-key release that lets the watchdog re-abort a fully-silent retry.
//   3. Behavioral (MockPi harness) — end-to-end: busy+silent turns are
//      aborted and parked, delayed timers auto-resume/re-dispatch within the
//      budget, and the exhausted streak refuses another retry.

import { test, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import {
  DEFAULT_ZOMBIE_RETRY_MAX_ATTEMPTS,
  MAX_ZOMBIE_RETRY_ATTEMPTS,
  ZOMBIE_RETRY_DELAY_MS,
  zombieRetryDecision,
  type ZombieRetryStreak,
} from "../extensions/goal-loop-backoff.js";
import {
  __testOnlyResetZombieAutoRetry,
  __testOnlySetZombieRetryDelay,
  __testOnlySetZombieRetryMaxAttempts,
} from "../extensions/loops/goal-activation.js";
import activate, {
  __testOnlyLoadState,
  __testOnlyResetOwnerSession,
  __testOnlyResetStaleFlag,
} from "../extensions/loops/goal.js";
import { __testOnlyResetZombieRunWatchdog, __testOnlyHeartbeatTick, __testOnlySetZombieRunWindows } from "../extensions/goal-heartbeat.js";
import { readState } from "../extensions/goal-loop-core.js";
import { MockPi, makeMockCtx, tmpCwd, tick, type MockCtx } from "./harness/mock-pi.js";

const pi = new MockPi();
activate(pi.api);

const MAIN_SM = { name: "main-session-manager" };

// ---------------------------------------------------------------------------
// 1. Pure streak decision
// ---------------------------------------------------------------------------

test("v0.35.x zombieRetryDecision: repeated silence consumes the configured retry budget", () => {
  const first = zombieRetryDecision(1000, "goal-1", { key: "", count: 0, lastAbortStreamAt: 0 });
  assert.equal(first.retry, true);
  assert.equal(first.streak.count, 1);

  // A retried turn that actually streams advances the stream clock past the
  // recorded abort point — any LATER independent hang earns its own retry.
  const later = zombieRetryDecision(5000, "goal-1", first.streak);
  assert.equal(later.retry, true, "stream activity between aborts resets the streak");
  assert.equal(later.streak.count, 1);
});

test("v0.35.x zombieRetryDecision: exhaustion refuses without a retry storm", () => {
  const t = 42_000;
  const fresh: ZombieRetryStreak = { key: "", count: 0, lastAbortStreamAt: 0 };
  let current = fresh;
  for (let attempt = 1; attempt <= DEFAULT_ZOMBIE_RETRY_MAX_ATTEMPTS; attempt++) {
    const next = zombieRetryDecision(t, "goal-1", current);
    assert.equal(next.retry, true, `attempt ${attempt} stays inside the budget`);
    assert.equal(next.streak.count, attempt);
    current = next.streak;
  }
  const exhausted = zombieRetryDecision(t, "goal-1", current);
  assert.equal(exhausted.retry, false, "a silent streak cannot retry forever");
  assert.equal(exhausted.streak.count, DEFAULT_ZOMBIE_RETRY_MAX_ATTEMPTS + 1);
});

test("v0.35.x zombieRetryDecision: a different owner key always gets its own budget", () => {
  const first = zombieRetryDecision(100, "goal-A", { key: "goal-B", count: 2, lastAbortStreamAt: 100 });
  assert.equal(first.retry, true);
});

test("v0.35.x production retry defaults stay finite and bounded", () => {
  assert.ok(ZOMBIE_RETRY_DELAY_MS >= 30_000 && ZOMBIE_RETRY_DELAY_MS <= 5 * 60_000);
  assert.equal(DEFAULT_ZOMBIE_RETRY_MAX_ATTEMPTS, 3);
  assert.ok(MAX_ZOMBIE_RETRY_ATTEMPTS >= DEFAULT_ZOMBIE_RETRY_MAX_ATTEMPTS);
  assert.equal(zombieRetryDecision(1, "goal", { key: "", count: 0, lastAbortStreamAt: 0 }, 0).retry, false);
});

// ---------------------------------------------------------------------------
// 2. Source pins (house pattern for activation-internal wiring)
// ---------------------------------------------------------------------------

const ACTIVATION_SRC = fs.readFileSync(path.resolve("extensions/loops/goal-activation.ts"), "utf-8");

test("v0.35.17 source: the auto-retry is armed inside abortZombieRun behind the streak decision", () => {
  const callIdx = ACTIVATION_SRC.indexOf("scheduleZombieAutoRetry(current, generation, goal?.id, observedStreamAt, silentMinutes)");
  assert.ok(callIdx > 0, "abortZombieRun arms the bounded retry");
  // The call sits in the success tail of abortZombieRun: after ctx.abort(),
  // after the durable zombie_run_aborted ledger write.
  const fnStart = ACTIVATION_SRC.indexOf("export function abortZombieRun(");
  const fnBody = ACTIVATION_SRC.slice(fnStart, callIdx);
  assert.ok(fnBody.indexOf("current.abort()") !== -1, "the host turn is aborted before the retry arms");
  assert.ok(fnBody.indexOf('"zombie_run_aborted"') !== -1, "the abort is ledgered before the retry arms");
  assert.match(ACTIVATION_SRC, /zombie_auto_retry_scheduled/, "arming is durable in the ledger");
  assert.match(ACTIVATION_SRC, /zombie_auto_retry_refused_streak/, "a refused streak names itself in the ledger");
});

test("v0.35.17 source: the retry timer respects /glla pause and only clears ITS OWN park", () => {
  const timerIdx = ACTIVATION_SRC.indexOf("zombieRetryTimer = scheduleSessionTimeout(");
  const body = ACTIVATION_SRC.slice(timerIdx, timerIdx + 2600);
  assert.match(body, /supervisorPaused\(state\)/, "a frozen supervisor keeps the park standing");
  assert.match(body, /freshCtxForGeneration\(generation\)/, "the timer is generation-fenced");
  assert.match(body, /goal\.pauseReason !== ZOMBIE_PAUSE_REASON/, "a superseded pause is never cleared by the stale timer");
  assert.match(body, /abortedStandDown = false/, "the dispatch stand-down is released before re-dispatching");
  assert.match(body, /scheduleContinuation\(fresh, true\)/, "goal/list items re-dispatch through the durable continuation machinery");
  assert.match(body, /releaseZombieAbortKey\(\)/, "the heartbeat abort latch is released so a fully-silent retry can still be re-aborted");
});

test("v0.35.x source: the user-facing copy announces the bounded retry budget", () => {
  assert.match(
    ACTIVATION_SRC,
    /Automatic retry \$\{retryPlan\.attempt\}\/\$\{retryPlan\.maxAttempts\} starts in ~90s;/,
    "armed parks identify the retry attempt and budget",
  );
  assert.match(ACTIVATION_SRC, /zombieRetryMaxAttempts/, "the budget comes from GLLA settings");
});

// ---------------------------------------------------------------------------
// 3. Behavioral: full hang → abort/park → auto-resume → re-dispatch arc
// ---------------------------------------------------------------------------

function readLedger(cwd: string): Array<{ type: string; value: Record<string, unknown> }> {
  return fs.readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf-8")
    .trim().split("\n").filter(Boolean)
    .map((l) => JSON.parse(l));
}

async function freshSession(cwd: string): Promise<MockCtx> {
  const ctx = makeMockCtx(cwd, { sessionManager: MAIN_SM });
  await pi.fire("session_start", { reason: "reload" }, ctx);
  return ctx;
}

let currentCtx: MockCtx | null = null;

beforeEach(() => {
  __testOnlyResetStaleFlag();
  __testOnlyResetOwnerSession();
  __testOnlyResetZombieRunWatchdog();
  __testOnlyResetZombieAutoRetry();
  __testOnlySetZombieRetryMaxAttempts(DEFAULT_ZOMBIE_RETRY_MAX_ATTEMPTS);
});

afterEach(async () => {
  __testOnlySetZombieRunWindows(null);
  __testOnlySetZombieRetryDelay(null);
  __testOnlySetZombieRetryMaxAttempts(null);
  __testOnlyResetZombieRunWatchdog();
  __testOnlyResetZombieAutoRetry();
  if (currentCtx) {
    await pi.fire("session_shutdown", { reason: "quit" }, currentCtx).catch(() => {});
    currentCtx = null;
  }
});

test("v0.35.x behavioral: a hung post-accept turn aborts, parks, then AUTO-resumes within the budget", async () => {
  __testOnlySetZombieRunWindows(0, 0);
  __testOnlySetZombieRetryDelay(50);
  const cwd = tmpCwd();
  const ctx = await freshSession(cwd);
  currentCtx = ctx;
  ctx.isIdle = () => false; // host BUSY, zero stream events — the field signature
  let aborts = 0;
  ctx.abort = () => { aborts++; };

  await pi.runTool("list_add", { items: ["post-accept hang item — done when the bounded auto-retry lands"] }, ctx);
  assert.equal((readState(cwd).goal as { status?: string } | null)?.status, "active");

  (globalThis as any).compactionGraceUntil = 0;
  (globalThis as any).postCompletionSettleUntil = 0;
  __testOnlyHeartbeatTick();

  const parked = readState(cwd).goal as { status?: string; pauseKind?: string; pauseReason?: string } | null;
  assert.equal(aborts, 1, "the confirmed zero-stream turn is aborted once");
  assert.equal(parked?.status, "paused");
  assert.equal(parked?.pauseKind, "error");
  assert.match(parked?.pauseReason ?? "", /zero-stream abort/);
  const ledger = readLedger(cwd);
  assert.equal(ledger.filter((e) => e.type === "zombie_auto_retry_scheduled").length, 1);

  // The waystation: after the shrunk delay the supervisor resumes the goal
  // by itself and re-dispatches EXACTLY one continuation.
  const sendsBeforeAbort = pi.sent.length;
  ctx.isIdle = () => true; // the aborted host settles idle before the timer fires
  // Exercise the existing settle-delay path so the continuation cannot land
  // during the old 300ms sleep. This deterministically exposes two timers.
  (globalThis as any).postCompletionSettleUntil = Date.now() + 600;
  // The retry callback records its ledger entry BEFORE scheduling a second
  // timer for the continuation. A fixed sleep can settle between those two
  // timers under load; observe the actual send, then assert exactly once.
  const sendDeadline = Date.now() + 5_000;
  while (pi.sent.length === sendsBeforeAbort && Date.now() < sendDeadline) await tick(20);

  assert.equal((readState(cwd).goal as { status?: string } | null)?.status, "active", "the automatic retry un-parks the goal");
  assert.equal(readLedger(cwd).filter((e) => e.type === "zombie_auto_retry_dispatched").length, 1);
  assert.equal(pi.sent.length, sendsBeforeAbort + 1, "the first bounded retry dispatches once");
});

test("v0.35.x behavioral: repeated zero-stream aborts retry until exhaustion, then stay parked", async () => {
  __testOnlySetZombieRunWindows(0, 0);
  __testOnlySetZombieRetryDelay(40);
  const cwd = tmpCwd();
  const ctx = await freshSession(cwd);
  currentCtx = ctx;
  ctx.isIdle = () => false;
  let aborts = 0;
  ctx.abort = () => { aborts++; };

  await pi.runTool("list_add", { items: ["repeated-hang item — done when the bounded retry budget is exhausted"] }, ctx);
  (globalThis as any).compactionGraceUntil = 0;
  (globalThis as any).postCompletionSettleUntil = 0;

  // Each timer fires while the host is STILL busy-silent. The goal
  // re-activates and one fresh dispatch goes out until the default budget is
  // exhausted.
  for (let attempt = 1; attempt <= DEFAULT_ZOMBIE_RETRY_MAX_ATTEMPTS; attempt++) {
    __testOnlyHeartbeatTick();
    assert.equal(aborts, attempt, `silent attempt ${attempt} is aborted`);
    const scheduled = readLedger(cwd).filter((e) => e.type === "zombie_auto_retry_scheduled");
    assert.equal(scheduled.length, attempt, `silent attempt ${attempt} is scheduled within the budget`);
    await tick(200);
    assert.equal((readState(cwd).goal as { status?: string } | null)?.status, "active");
  }

  // The next consecutive silence is aborted and durably refused.
  const sendsAfterBudget = pi.sent.length;
  __testOnlyHeartbeatTick();
  assert.equal(aborts, DEFAULT_ZOMBIE_RETRY_MAX_ATTEMPTS + 1, "the exhausted retry is still safely aborted");
  assert.equal((readState(cwd).goal as { status?: string } | null)?.status, "paused", "the exhausted streak parks permanently");
  const ledger = readLedger(cwd);
  assert.equal(ledger.filter((e) => e.type === "zombie_auto_retry_scheduled").length, DEFAULT_ZOMBIE_RETRY_MAX_ATTEMPTS, "no retry is scheduled beyond the budget");
  assert.equal(ledger.filter((e) => e.type === "zombie_auto_retry_refused_streak").length, 1);

  await tick(300);
  assert.equal(pi.sent.length, sendsAfterBudget, "the exhausted park does not self-resume");
  assert.equal((readState(cwd).goal as { status?: string } | null)?.status, "paused");
});

test("v0.35.17 behavioral: /glla pause during the waystation freezes the automatic retry", async () => {
  __testOnlySetZombieRunWindows(0, 0);
  __testOnlySetZombieRetryDelay(40);
  const cwd = tmpCwd();
  const ctx = await freshSession(cwd);
  currentCtx = ctx;
  ctx.isIdle = () => false;
  let aborts = 0;
  ctx.abort = () => { aborts++; };

  await pi.runTool("list_add", { items: ["paused-supervisor item — done when pause keeps the park"] }, ctx);

  (globalThis as any).compactionGraceUntil = 0;
  (globalThis as any).postCompletionSettleUntil = 0;
  __testOnlyHeartbeatTick();
  assert.equal(aborts, 1, "the zero-stream abort lands (it stops token bleed)");
  assert.equal((readState(cwd).goal as { status?: string } | null)?.status, "paused");
  assert.equal(readLedger(cwd).filter((e) => e.type === "zombie_auto_retry_scheduled").length, 1);

  // Freeze the supervisor DURING the waystation, before the retry timer fires.
  await pi.command("glla", "pause", ctx);
  assert.equal(typeof (readState(cwd) as { supervisorPausedAt?: number }).supervisorPausedAt, "number");

  const sendsBefore = pi.sent.length;
  ctx.isIdle = () => true;
  await tick(300);
  assert.equal(
    (readState(cwd).goal as { status?: string } | null)?.status,
    "paused",
    "the frozen supervisor leaves the park standing",
  );
  assert.equal(pi.sent.length, sendsBefore, "no automatic dispatch under /glla pause");
});
