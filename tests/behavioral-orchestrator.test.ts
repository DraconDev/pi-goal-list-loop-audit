// pi-goal-list-loop-audit — v0.28.7
// tests/behavioral-orchestrator.test.ts
//
// Behavioral pins for goal.ts's ORCHESTRATOR paths (audit Stream 4: T1, T2,
// T3, T5) — the first tests that register goal.ts on a fake ExtensionAPI and
// DRIVE its handlers instead of regex-matching its source.
//
// FILE-LEVEL DESIGN (do not reorder casually):
// goal.ts is a singleton module; bun test shares module state process-wide
// (verified). The stale-handle flag (extensionApiStale) LATCHES and cannot
// be un-latched from outside. Therefore this file runs:
//   1-5  T3 restore-gate branches   (sends must land — clean flag required)
//   6    T5 foreign-session guards  (needs ownerSession claimed by test 1)
//   7    T2 stale send → terminal   (clean→latched transition observable;
//                                    LATCHES the flag from here on)
//   8    T1a stale confirm          (works with the flag latched)
//   9    T1b stale creation         (works with the flag latched)
// Every test uses its own tmp cwd; session_start re-reads state from that
// cwd's .pi-glla, so tests stay independent despite shared module state.

import { resetLengthContinue } from "../extensions/length-continue.js";
import { resetContinuationDispatchState, clearContinuationTimer, continuationDispatchStoodDownRef, continuationTimerPending, pendingContinuationDispatchRef, scheduleContinuation, setPendingContinuationDispatchRef } from "../extensions/goal-continuation.js";
import { test, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import activate, { __testOnlyDisplayActivityFor, __testOnlyLastConfirmDialog, __testOnlyLoadState, __testOnlyResetOwnerSession, __testOnlyResetStaleFlag, __testOnlyResetTerminalFlags, __testOnlyResetToolActivity, __testOnlyRunFanOutListAuditFindings, __testOnlySetAuditorRecoveryRetryDelay, __testOnlySetContinuationRetryBackoff, __testOnlySetContinuationStartTimeout, __testOnlySetSessionReplacementUntil, runDetachedCompletionWithFallback } from "../extensions/loops/goal.js";
import { __testOnlyResetZombieAutoRetry, __testOnlySetZombieRetryMaxAttempts } from "../extensions/loops/goal-activation.js";
import { __testOnlyHeartbeatTick, __testOnlySetZombieRunWindows, __testOnlyResetZombieRunWatchdog, __testOnlyClearSubagentHangProbes, __testOnlySubagentHangProbes, upsertSubagentHangProbe, endSubagentHangProbe } from "../extensions/goal-heartbeat.js";
import { mainModelRecoverySucceeded } from "../extensions/goal-recovery.js";
import { isProviderRetryPending } from "../extensions/quota-retry.js";

// v0.29.5: autoResume is GLOBAL-only now — tests opt in by writing the
// harness's global settings path, and afterEach resets it so the opt-in
// never leaks into later tests (module state is shared process-wide).
const GLOBAL_SETTINGS_PATH = process.env.GLLA_GLOBAL_SETTINGS_PATH!;
function setGlobalAutoResume(v: boolean): void {
  fs.writeFileSync(GLOBAL_SETTINGS_PATH, JSON.stringify(v ? { autoResume: true, aggressiveMode: false } : { aggressiveMode: false }));
}
function setGlobalSettings(value: Record<string, unknown>): void {
  fs.writeFileSync(GLOBAL_SETTINGS_PATH, JSON.stringify(value));
}
afterEach(() => setGlobalAutoResume(false));

import { appendAuditLog, queueItemSidecarCount, readState, writeQueueItemFile } from "../extensions/goal-loop-core.js";
import { MockPi, invalidateHostSession, makeMockCtx, tmpCwd, seedState, seedGoal, seedLoop, staleError, tick, type MockCtx } from "./harness/mock-pi.js";
import { readGoalRuntimeSource } from "./harness/goal-source.js";

const GOAL_SRC = readGoalRuntimeSource();

const pi = new MockPi();
activate(pi.api);

const MAIN_SM = { name: "main-session-manager" };

function ownerCtx(cwd: string): MockCtx {
  return makeMockCtx(cwd, { sessionManager: MAIN_SM });
}

async function freshSession(cwd: string, reason: string): Promise<MockCtx> {
  const ctx = ownerCtx(cwd);
  await pi.fire("session_start", { reason }, ctx);
  return ctx;
}

// Real pi emits before_agent_start for an accepted follow-up before agent_end.
// Keep the harness explicit about that proof so the continuation watchdog does
// not confuse a test fixture's agent_end with the dispatch it is meant to settle.
async function acknowledgeLastContinuation(ctx: MockCtx): Promise<void> {
  const prompt = pi.sent.at(-1)?.message.content;
  if (prompt) await pi.fire("before_agent_start", { prompt }, ctx);
}

async function waitUntil(predicate: () => boolean, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for detached-auditor state");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function readLedger(cwd: string): Array<{ type: string; value: Record<string, unknown> }> {
  const file = path.join(cwd, ".pi-glla", "active.jsonl");
  return fs.readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { type: string; value: Record<string, unknown> });
}

function ledgerEvent(cwd: string, type: string): { type: string; value: Record<string, unknown> } {
  const event = readLedger(cwd).find((entry) => entry.type === type);
  assert.ok(event, `ledger event ${type} exists`);
  return event!;
}

function assertCompactRecap(message: string, context: string): void {
  for (const label of ["Outcome:", "Changed:", "Evidence:", "Tests:", "Unresolved:", "Next:"]) {
    assert.match(message, new RegExp(label), `${context} includes ${label}`);
  }
}

function writeFakeAuditorError(cwd: string, error: string, delayMs = 0): string {
  const script = path.join(cwd, "fake-auditor-error-pi.mjs");
  fs.writeFileSync(script, `#!/usr/bin/env node
let input = "";
let handled = false;
const error = ${JSON.stringify(error)};
process.stdin.on("data", async (chunk) => {
  input += chunk;
  if (handled || !input.includes("\\n")) return;
  handled = true;
  await new Promise((resolve) => setTimeout(resolve, ${delayMs}));
  process.stdout.write(JSON.stringify({ type: "error", errorMessage: error }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "agent_settled" }) + "\\n");
});
`);
  fs.chmodSync(script, 0o700);
  return script;
}

function writeFakeAuditor(cwd: string, verdict: "approved" | "disapproved", delayMs = 0, reportOverride?: string): string {
  const script = path.join(cwd, "fake-auditor-pi.mjs");
  fs.writeFileSync(script, `#!/usr/bin/env node
let input = "";
let handled = false;
process.stdin.on("data", async (chunk) => {
  input += chunk;
  if (handled || !input.includes("\\n")) return;
  handled = true;
  await new Promise((resolve) => setTimeout(resolve, ${delayMs}));
  const emit = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
  const report = ${JSON.stringify(reportOverride ?? (verdict === "approved" ? "<evidence>\\npinned\\n</evidence>\\n<approved/>" : "## Required fixes\\n- fix the pinned gap\\n<disapproved/>"))};
  emit({ type: "tool_execution_start", toolCallId: "fake-read", toolName: "read", args: { path: "README.md" } });
  emit({ type: "tool_execution_end", toolCallId: "fake-read" });
  emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: report } });
  emit({ type: "agent_settled" });
});
// Keep stdin open: pi RPC treats EOF as shutdown, not end-of-prompt.
`);
  fs.chmodSync(script, 0o700);
  return script;
}

// ────────────────────────────────────────────────────────────────────
// T3 — session_start restore-gate branches (goal.ts session_start handler)
// ────────────────────────────────────────────────────────────────────

test("T3a: active goal + human load (startup) + default settings → HELD for explicit resume", async () => {
  // Keep this first restore-gate assertion hermetic even when Bun reuses the
  // preload settings path across serial worker files.
  setGlobalAutoResume(false);
  const cwd = tmpCwd();
  seedState(cwd, { goal: seedGoal() });
  const ctx = await freshSession(cwd, "startup");
  const g = readState(cwd).goal as { status: string; pauseReason?: string; pauseSuggestedAction?: string };
  assert.equal(g.status, "paused");
  assert.equal(g.pauseReason, "restored on session load — held for explicit resume");
  assert.match(g.pauseSuggestedAction ?? "", /\/goal resume to continue/);
  assert.ok(ctx.ui.matching("held on restore").length >= 1, "held notify shown");
});

test("v0.34.18: blank startup waits for the transcript before autoresume, while explicit resume and loaded history still work", async () => {
  const session = MAIN_SM as { buildSessionContext?: () => { messages: unknown[] } };
  session.buildSessionContext = () => ({ messages: [] });
  try {
    const cwd = tmpCwd();
    seedState(cwd, { goal: seedGoal() });
    setGlobalAutoResume(true);
    pi.sent.length = 0;
    const ctx = await freshSession(cwd, "startup");
    await tick();
    assert.equal((readState(cwd).goal as { status: string }).status, "active", "the blank startup does not pause or mutate the saved goal");
    assert.equal(pi.sent.length, 0, "blank startup sends no continuation");
    assert.ok(ctx.ui.matching("has not loaded a conversation yet").length >= 1, "the initialization barrier is visible");
    assert.ok(fs.readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf8").includes('"session_waiting_for_load"'), "the wait is ledgered");

    await pi.command("goal", "resume", ctx);
    await tick();
    assert.ok(pi.sent.length >= 1, "explicit /goal resume releases the startup barrier");

    const listCwd = tmpCwd();
    seedState(listCwd, { list: [{ id: "blank-head", objective: "queued blank-start item — done when pinned", addedAt: new Date().toISOString() }] });
    pi.sent.length = 0;
    await freshSession(listCwd, "startup");
    await tick();
    const listState = readState(listCwd);
    assert.equal(listState.goal, null, "blank startup does not activate the queue head");
    assert.equal(listState.list?.length, 1, "blank startup preserves the queued item");
    assert.equal(pi.sent.length, 0, "blank startup sends no list continuation");

    const loopCwd = tmpCwd();
    seedState(loopCwd, { loop: seedLoop() });
    pi.sent.length = 0;
    await freshSession(loopCwd, "startup");
    await tick();
    assert.equal((readState(loopCwd).loop as { active: boolean }).active, true, "blank startup does not deactivate the loop");
    assert.equal(pi.sent.length, 0, "blank startup sends no loop continuation");

    session.buildSessionContext = () => ({ messages: [{ role: "user", content: "restored" }] });
    const loadedCwd = tmpCwd();
    seedState(loadedCwd, { goal: seedGoal() });
    pi.sent.length = 0;
    const loaded = await freshSession(loadedCwd, "startup");
    await tick();
    assert.equal((readState(loadedCwd).goal as { status: string }).status, "active", "loaded startup history permits autoresume");
    assert.ok(loaded.ui.matching("resuming goal").length >= 1, "loaded startup announces autoresume");
    assert.ok(pi.sent.length >= 1, "loaded startup sends the continuation");
  } finally {
    delete session.buildSessionContext;
  }
});

test("v0.34.121: blank startup closes a legacy terminal slot when its archive exists", async () => {
  __testOnlyResetStaleFlag();
  const session = MAIN_SM as { buildSessionContext?: () => { messages: unknown[] } };
  const previous = session.buildSessionContext;
  session.buildSessionContext = () => ({ messages: [] });
  try {
    const cwd = tmpCwd();
    const goal = seedGoal({ status: "complete", objective: "legacy completed objective" });
    fs.mkdirSync(path.join(cwd, ".pi-glla", "archive"), { recursive: true });
    fs.writeFileSync(path.join(cwd, ".pi-glla", "archive", `${goal.id}.md`), "**Status**: complete\n");
    seedState(cwd, { goal });
    await freshSession(cwd, "startup");
    assert.equal(readState(cwd).goal, null, "blank startup closes the archived terminal slot");
    assert.ok(fs.readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf8").includes("terminal_goal_slot_closed"), "closure is ledgered before the blank-start return");
  } finally {
    if (previous) session.buildSessionContext = previous;
    else delete session.buildSessionContext;
  }
});

test("T3c (v0.28.21): interrupted goal HELDS by default — the 0.28.3 exemption is superseded; autoresume=on auto-resumes", async () => {
  // Default: even an infra-interrupted goal loads HELD (user directive:
  // "load it on session load but not auto start it"). The marker STAYS.
  const cwd = tmpCwd();
  seedState(cwd, { goal: seedGoal({ interruptedAt: new Date().toISOString(), interruptedReason: "extension api stale (sendContinuation)" }) });
  pi.sent.length = 0;
  const ctx = await freshSession(cwd, "startup");
  await tick();
  const g = readState(cwd).goal as { status: string; interruptedAt?: string };
  assert.equal(g.status, "paused", "held like everything else by default");
  assert.ok(g.interruptedAt, "interrupt marker PRESERVED (no auto-resume happened)");
  assert.ok(ctx.ui.matching("held on restore").length >= 1, "held notify");
  assert.equal(pi.sent.length, 0, "no continuation fired");

  // Opt-in: autoresume=on keeps the 0.28.3 recovery semantics.
  const cwd2 = tmpCwd();
  seedState(cwd2, { goal: seedGoal({ interruptedAt: new Date().toISOString(), interruptedReason: "extension api stale (sendContinuation)" }) });
  setGlobalAutoResume(true);
  pi.sent.length = 0;
  const ctx2 = await freshSession(cwd2, "startup");
  await tick();
  const g2 = readState(cwd2).goal as { status: string; interruptedAt?: string };
  assert.equal(g2.status, "active", "autoresume=on auto-resumes");
  assert.equal(g2.interruptedAt, undefined, "interrupt marker cleared by the auto-resume it promised");
  assert.ok(ctx2.ui.matching("auto-resumed after the stale-handle interrupt").length >= 1, "interrupt-resume notify");
  assert.ok(pi.sent.length >= 1, "continuation actually sent");
});

test("T3b (v0.28.21): active goal + reload → HELD by default; autoresume=on → auto-resumes", async () => {
  const cwd = tmpCwd();
  seedState(cwd, { goal: seedGoal() });
  pi.sent.length = 0;
  const ctx = await freshSession(cwd, "reload");
  await tick();
  const g = readState(cwd).goal as { status: string };
  assert.equal(g.status, "paused", "reload HOLDS by default now");
  assert.ok(ctx.ui.matching("held on restore").length >= 1, "held notify");
  assert.equal(pi.sent.length, 0, "no continuation fired");

  const cwd2 = tmpCwd();
  seedState(cwd2, { goal: seedGoal() });
  setGlobalAutoResume(true);
  pi.sent.length = 0;
  const ctx2 = await freshSession(cwd2, "reload");
  await tick();
  const g2 = readState(cwd2).goal as { status: string };
  assert.equal(g2.status, "active");
  assert.ok(ctx2.ui.matching("resuming goal").length >= 1, "resume notify");
  assert.ok(pi.sent.length >= 1, "continuation actually sent");
});

test("v0.35.x: list cancel archives the active item, does not relabel it as active, and preserves its audit history", async () => {
  const cwd = tmpCwd();
  const priorAuditReport = "auditor report: required fix remains recorded";
  seedState(cwd, {
    goal: seedGoal({
      policy: "list",
      objective: "cancelled list item — done when its archive is truthful",
      auditHistory: [{
        at: new Date().toISOString(),
        approved: false,
        disapproved: true,
        model: "fixture-auditor",
        report: priorAuditReport,
      }],
    }),
    list: [
      { id: "waiting-1", objective: "waiting item one", addedAt: new Date().toISOString() },
      { id: "waiting-2", objective: "waiting item two", addedAt: new Date().toISOString() },
    ],
  });
  setGlobalAutoResume(true);
  const ctx = await freshSession(cwd, "startup");
  await tick();

  await pi.command("list", "cancel", ctx);
  const afterCancel = readState(cwd);
  assert.equal(afterCancel.goal, null, "/list cancel closes the active list item after archiving it");
  assert.deepEqual(afterCancel.list, [], "list cancel drops waiting items, rather than leaving a hidden retry queue");
  const archivedPath = fs.readdirSync(path.join(cwd, ".pi-glla", "archive"))[0]!;
  const archive = fs.readFileSync(path.join(cwd, ".pi-glla", "archive", archivedPath), "utf8");
  assert.match(archive, /\*\*Status\*\*: aborted/);
  assert.match(archive, /\*\*Policy\*\*: list/);
  assert.match(archive, /\*\*Stop reason\*\*: list cancelled/);
  assert.match(archive, /disapproved — `fixture-auditor`/, "the archive keeps the prior verdict classification");
  const listCancelNotice = ctx.ui.notifies.find((notice) => notice.message.includes("List cancelled"))?.message ?? "";
  assertCompactRecap(listCancelNotice, "/list cancel notification");

  const archived = ledgerEvent(cwd, "goal_archived");
  assert.equal(archived.value.status, "aborted");
  assert.equal(archived.value.stopReason, "list cancelled");
  const cancelledEvent = ledgerEvent(cwd, "list_cancelled");
  assert.equal(cancelledEvent.value.abortedActive, true);
  assert.equal(cancelledEvent.value.dropped, 2);
  const ledgerTypes = readLedger(cwd).map((entry) => entry.type);
  assert.equal(ledgerTypes.filter((type) => type === "audit_started").length, 0, "cancel does not invent a new audit");

  const sentAfterCancel = pi.sent.length;
  await pi.command("list", "resume", ctx);
  assert.equal(pi.sent.length, sentAfterCancel, "resume does not dispatch after the objective is closed");
  const status = await pi.runTool("list_status", {}, ctx);
  assert.match(status.content[0]?.text ?? "", /no active list|empty/i, "list_status no longer presents a closed item as live");
  await pi.command("list", "show", ctx);
  assert.match(ctx.ui.notifies.at(-1)?.message ?? "", /Active: \(none\)/, "/list show is truthful after cancellation");
});

test("v0.36.0: /goal cancel archives a standalone goal with a compact six-label recap", async () => {
  __testOnlyResetStaleFlag();
  const cwd = tmpCwd();
  seedState(cwd, {
    goal: seedGoal({ policy: "goal", objective: "standalone cancel objective — done when pinned" }),
  });
  const ctx = await freshSession(cwd, "startup");
  await pi.command("goal", "cancel", ctx);
  const after = readState(cwd);
  assert.equal(after.goal, null, "goal cancel closes the archived objective");
  const archivedPath = fs.readdirSync(path.join(cwd, ".pi-glla", "archive"))[0]!;
  const archive = fs.readFileSync(path.join(cwd, ".pi-glla", "archive", archivedPath), "utf8");
  assert.match(archive, /\*\*Status\*\*: aborted/);
  assert.match(archive, /\*\*Stop reason\*\*: user cancelled/);
  const cancelNotice = ctx.ui.notifies.find((notice) => notice.message.includes("aborted"))?.message ?? "";
  assertCompactRecap(cancelNotice, "/goal cancel notification");
});

test("v0.36.0: /list next archives the skipped active item with a compact recap", async () => {
  __testOnlyResetStaleFlag();
  const cwd = tmpCwd();
  const skippedId = "list-next-skipped";
  seedState(cwd, {
    goal: seedGoal({ id: skippedId, policy: "list", objective: "skipped active item — done when pinned" }),
    list: [{ id: "list-next-target", objective: "selected next item — done when pinned", addedAt: new Date().toISOString() }],
  });
  setGlobalAutoResume(true);
  const ctx = await freshSession(cwd, "reload");
  ctx.ui.selectImpl = async (_title, options) => options.find((option) => option === "Replace current objective") ?? options[0];
  await pi.command("list", "next", ctx);
  await tick();
  const after = readState(cwd);
  assert.match((after.goal as { objective: string }).objective, /selected next item/);
  const archive = fs.readFileSync(path.join(cwd, ".pi-glla", "archive", `${skippedId}.md`), "utf8");
  assert.match(archive, /\*\*Status\*\*: aborted/);
  assert.match(archive, /\*\*Stop reason\*\*: skipped via \/list next/);
  const notice = ctx.ui.notifies.find((entry) => entry.message.includes("Previous list item skipped"))?.message ?? "";
  assertCompactRecap(notice, "/list next skip notification");
});

test("v0.36.1: bare /goal start uses one clear active-branch request", async () => {
  __testOnlyResetStaleFlag();
  const session = MAIN_SM as { getBranch?: () => unknown[] };
  const previousBranch = session.getBranch;
  session.getBranch = () => [
    { type: "message", message: { role: "assistant", content: "Ignore this assistant-authored plan." } },
    { type: "message", message: { role: "user", content: "Implement the bounded start handoff — done when the focused test passes" } },
  ];
  const cwd = tmpCwd();
  const ctx = await freshSession(cwd, "startup");
  try {
    await pi.command("goal", "start", ctx);
    const goal = readState(cwd).goal;
    assert.equal(goal?.objective, "Implement the bounded start handoff — done when the focused test passes");
    assert.ok(ctx.ui.matching("Inferred from").length >= 1, "the inherited candidate is visible before activation");
    await pi.command("goal", "cancel", ctx);
  } finally {
    if (previousBranch) session.getBranch = previousBranch;
    else delete session.getBranch;
    await pi.fire("session_shutdown", { reason: "quit" }, ctx);
  }
});

test("v0.36.1: bare /list start activates the hydrated queue head", async () => {
  __testOnlyResetStaleFlag();
  const cwd = tmpCwd();
  seedState(cwd, { list: [{ id: "bare-list-head", objective: "queued bare-start item — done when pinned", addedAt: new Date().toISOString() }] });
  const ctx = await freshSession(cwd, "startup");
  await pi.command("list", "start", ctx);
  const after = readState(cwd);
  assert.equal(after.goal?.objective, "queued bare-start item — done when pinned");
  assert.deepEqual(after.list, [], "queue-head activation consumes the waiting item");
  assert.ok(ctx.ui.matching("activated").length >= 1, "explicit start activation is visible");
  await pi.command("goal", "cancel", ctx);
  await pi.fire("session_shutdown", { reason: "quit" }, ctx);
});

test("v0.36.1: bare /loop start infers only a target and uses the metricless path", async () => {
  __testOnlyResetStaleFlag();
  const session = MAIN_SM as { getBranch?: () => unknown[] };
  const previousBranch = session.getBranch;
  session.getBranch = () => [
    { type: "message", message: { role: "user", content: "Improve the bounded start handoff" } },
  ];
  const cwd = tmpCwd();
  const ctx = await freshSession(cwd, "startup");
  try {
    await pi.command("loop", "start", ctx);
    const loop = readState(cwd).loop;
    assert.equal(loop?.target, "Improve the bounded start handoff");
    assert.equal(loop?.measureCmd, undefined, "bare inference does not invent a measure");
    assert.equal(loop?.maxIterations, 0, "bare inference preserves the unbounded metricless start default");
    assert.ok(ctx.ui.matching("metricless").length >= 1, "the metricless consent/path is visible");
    await pi.command("loop", "stop", ctx);
  } finally {
    if (previousBranch) session.getBranch = previousBranch;
    else delete session.getBranch;
    await pi.fire("session_shutdown", { reason: "quit" }, ctx);
  }
});

test("v0.36.0: aborted detached audit can complete without audit only after archive success", async () => {
  __testOnlyResetStaleFlag();
  const cwd = tmpCwd();
  const fakePi = writeFakeAuditor(cwd, "approved", 5_000);
  const previous = process.env.GLLA_PI_BINARY;
  process.env.GLLA_PI_BINARY = fakePi;
  const ctx = await freshSession(cwd, "startup");
  const controller = new AbortController();
  let confirmationTitle = "";
  ctx.ui.confirmImpl = async (title) => {
    confirmationTitle = title;
    return true;
  };
  try {
    await pi.command("goal", "complete without audit target — done when pinned", ctx);
    await tick();
    const queued = pi.runTool("complete_goal", {
      completionSummary: "The without-audit escape path is covered.",
      verificationSummary: "The worker is deliberately aborted before a verdict.",
    }, ctx, controller.signal);
    await waitUntil(() => (readState(cwd).goal as { status?: string } | null)?.status === "auditing");
    controller.abort();
    await queued;
    await waitUntil(() => readState(cwd).goal === null);
    const notices = ctx.ui.notifies.map((entry) => entry.message).join("\n");
    const notice = ctx.ui.notifies.find((entry) => entry.message.includes("completed without audit (your choice)"))?.message ?? "";
    assert.equal(confirmationTitle, "Audit aborted", "the explicit audit-abort choice was presented");
    assert.match(notice, /^✓ done — Objective "complete without audit target/, "the briefing leads with the archived objective");
    assert.match(notice, /— completed without audit \(your choice\)\./, "the no-audit trailer closes the briefing");
    assert.doesNotMatch(notice, /not recorded/, "system placeholders never reach the briefing");
    assert.ok(fs.readdirSync(path.join(cwd, ".pi-glla", "archive")).length > 0, "archive landed before success was reported");
  } finally {
    if (previous === undefined) delete process.env.GLLA_PI_BINARY;
    else process.env.GLLA_PI_BINARY = previous;
  }
});

test("v0.34.119: /glla cancel archives the active list item and drops the waiting objective queue", async () => {
  __testOnlyResetStaleFlag();
  const cwd = tmpCwd();
  seedState(cwd, {
    goal: seedGoal({ policy: "list", objective: "glla cancel objective — done when pinned" }),
    list: [
      { id: "glla-waiting-1", objective: "hidden waiting objective", addedAt: new Date().toISOString() },
    ],
  });
  const ctx = await freshSession(cwd, "startup");
  await tick();
  await pi.command("glla", "cancel", ctx);
  const after = readState(cwd) as unknown as { goal: unknown; list?: unknown[] };
  assert.equal(after.goal, null, "glla cancel closes the objective after archiving it");
  assert.deepEqual(after.list, [], "glla cancel cancels the objective rather than leaving waiting list work behind");
  assert.equal(ledgerEvent(cwd, "list_cancelled").value.dropped, 1);
  const listCancelNotice = ctx.ui.notifies.find((notice) => notice.message.includes("List cancelled"))?.message ?? "";
  assertCompactRecap(listCancelNotice, "/glla cancel notification");
});

test("v0.34.121: /glla cancel stops an active loop before touching an unrelated waiting queue", async () => {
  __testOnlyResetStaleFlag();
  const cwd = tmpCwd();
  seedState(cwd, {
    loop: seedLoop({ active: true, target: "active loop objective" }),
    list: [{ id: "unrelated-waiting", objective: "unrelated waiting item", addedAt: new Date().toISOString() }],
  });
  const ctx = await freshSession(cwd, "reload");
  // A normal reload arbitrates legacy stacked state before the command. Reload
  // the deliberately dirty pair after binding the context so this test pins
  // the reachable cancel ordering itself.
  seedState(cwd, {
    loop: seedLoop({ active: true, target: "active loop objective" }),
    list: [{ id: "unrelated-waiting", objective: "unrelated waiting item", addedAt: new Date().toISOString() }],
  });
  __testOnlyLoadState(cwd);
  await pi.command("glla", "cancel", ctx);
  const after = readState(cwd) as unknown as { loop: { active?: boolean } | null; list?: unknown[] };
  assert.equal(after.loop?.active, false, "the active loop is the objective that gets cancelled");
  assert.equal(after.list?.length, 1, "an unrelated waiting queue is not dropped");
  assert.equal((after.list?.[0] as { id: string }).id, "unrelated-waiting");
  await pi.fire("session_shutdown", { reason: "quit" }, ctx);
});

test("v0.34.119: /glla cancel also aborts an auditing list objective and clears its waiting queue", async () => {
  __testOnlyResetStaleFlag();
  const cwd = tmpCwd();
  seedState(cwd, {
    goal: seedGoal({
      policy: "list",
      status: "auditing",
      objective: "auditing list objective — done when pinned",
      pendingCompletion: {
        completionSummary: "stored claim",
        verificationSummary: "stored evidence",
        at: new Date().toISOString(),
        phase: "running",
        attemptId: "audit-cancel-attempt",
      } as any,
    }),
    list: [{ id: "audit-waiting-1", objective: "waiting after audit", addedAt: new Date().toISOString() }],
  });
  const ctx = await freshSession(cwd, "startup");
  await tick();
  await pi.command("glla", "cancel", ctx);
  const after = readState(cwd) as unknown as { goal: { status?: string; pendingCompletion?: unknown } | null; list?: unknown[] };
  assert.equal(after.goal, null, "cancel closes the auditing objective after archiving it");
  assert.deepEqual(after.list, []);
  await pi.fire("session_shutdown", { reason: "quit" }, ctx);
});

test("v0.35.0 (v0.38.12 last-wins): /goal start replaces without dialog; plain /goal still offers update/cancel", async () => {
  __testOnlyResetStaleFlag();
  setGlobalAutoResume(true);
  const cwd = tmpCwd();
  seedState(cwd, { goal: seedGoal({ objective: "current objective — done when current proof exists" }) });
  const ctx = await freshSession(cwd, "reload");
  const original = readState(cwd).goal as { id: string; objective: string };
  // v0.38.12: /goal start is explicit consent — the conflict dialog is
  // skipped even when it would have offered Update. The spy proves no
  // dialog ran: the new objective is simply the real one now.
  const conflictTitles: string[] = [];
  ctx.ui.selectImpl = async (title, options) => {
    if (String(title).includes("already active")) conflictTitles.push(String(title));
    return options.find((option) => option === "Update current objective");
  };
  await pi.command("goal", "start updated current objective — done when updated proof exists", ctx);
  assert.equal(conflictTitles.length, 0, "/goal start asks nothing");
  assert.notEqual((readState(cwd).goal as { id: string }).id, original.id, "start replaces the identity");
  assert.match((readState(cwd).goal as { objective: string }).objective, /updated current objective/);
  assert.equal(fs.readdirSync(path.join(cwd, ".pi-glla", "archive")).length, 1, "start archives the prior objective");
  assert.match(fs.readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf8"), /start-explicit/);

  // The plain /goal verb keeps the full dialog: cancel preserves.
  ctx.ui.selectImpl = async (_title, options) => options.find((option) => option === "Cancel new objective");
  await pi.command("goal", "cancelled replacement — done when never starts", ctx);
  assert.match((readState(cwd).goal as { objective: string }).objective, /updated current objective/);
  assert.equal(fs.readdirSync(path.join(cwd, ".pi-glla", "archive")).length, 1, "cancel preserves the current objective");

  // ...and update still edits in place with no archive.
  ctx.ui.selectImpl = async (_title, options) => options.find((option) => option === "Update current objective");
  const beforeUpdate = readState(cwd).goal as { id: string };
  await pi.command("goal", "tweaked current objective — done when tweaked proof exists", ctx);
  assert.equal((readState(cwd).goal as { id: string }).id, beforeUpdate.id, "plain-goal update keeps the identity");
  assert.match((readState(cwd).goal as { objective: string }).objective, /tweaked current objective/);
  assert.equal(fs.readdirSync(path.join(cwd, ".pi-glla", "archive")).length, 1, "update does not archive the current objective");
  assert.match(fs.readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf8"), /objective_conflict_resolved/);
  await pi.fire("session_shutdown", { reason: "quit" }, ctx);
});

test("v0.35.x: same-mode list conflict updates the whole objective, never individual tasks", async () => {
  __testOnlyResetStaleFlag();
  setGlobalAutoResume(true);
  const cwd = tmpCwd();
  const queued = { id: "whole-list-incoming", objective: "incoming whole list objective", verificationContract: "the new proof exists", addedAt: new Date().toISOString() };
  seedState(cwd, {
    goal: seedGoal({
      policy: "list",
      status: "active",
      objective: "current whole list objective — done when the old proof exists",
      verificationContract: "old proof",
    }),
    list: [queued],
  });
  const ctx = await freshSession(cwd, "reload");
  const originalId = readState(cwd).goal?.id;
  ctx.ui.selectImpl = async (_title, options) => options.find((option) => option === "Update current objective");
  ctx.ui.confirmImpl = async () => true;

  await pi.command("list", "next", ctx);

  const after = readState(cwd);
  assert.equal(after.goal?.id, originalId);
  assert.equal(after.goal?.objective, queued.objective);
  assert.equal(after.goal?.verificationContract, queued.verificationContract);
  assert.equal(after.goal?.status, "active");
  assert.deepEqual(after.list, [queued], "the conflict update is whole-objective; it does not walk or consume task entries");
  const update = ledgerEvent(cwd, "objective_conflict_updated");
  assert.equal(update.value.wholeObjective, true);
  assert.equal(update.value.mode, "list");
  assert.equal(readLedger(cwd).some((entry) => entry.type === "update_task_status"), false);
  assert.ok(ctx.ui.matching("Whole list objective updated").length >= 1);
  await pi.fire("session_shutdown", { reason: "quit" }, ctx);
});

test("v0.35.x: auditing list conflict cancels the stale audit before whole-objective update", async () => {
  __testOnlyResetStaleFlag();
  const cwd = tmpCwd();
  const queued = { id: "whole-list-audit", objective: "replacement after audit conflict", addedAt: new Date().toISOString() };
  const auditGoal = seedGoal({
    policy: "list",
    status: "auditing",
    objective: "auditing list before conflict",
    pendingCompletion: { attemptId: "stale-audit-attempt", at: new Date().toISOString(), phase: "running" },
  });
  seedState(cwd, { goal: auditGoal, list: [queued] });
  const ctx = await freshSession(cwd, "reload");
  // The restore gate deliberately parks a cold auditing claim. Re-seed the
  // fixture after ownership is established so this test exercises the live
  // conflict path, including stale-audit cancellation.
  seedState(cwd, { goal: auditGoal, list: [queued] });
  __testOnlyLoadState(cwd);
  assert.equal(readState(cwd).goal?.status, "auditing");
  ctx.ui.selectImpl = async (_title, options) => options.find((option) => option === "Update current objective");
  ctx.ui.confirmImpl = async () => true;

  await pi.command("list", "next", ctx);

  const after = readState(cwd);
  assert.equal(after.goal?.status, "active");
  assert.equal(after.goal?.objective, queued.objective);
  assert.equal(after.goal?.pendingCompletion, undefined);
  assert.ok(readLedger(cwd).some((entry) => entry.type === "objective_conflict_audit_cancelled"));
  assert.ok(readLedger(cwd).some((entry) => entry.type === "objective_conflict_updated"));
  await pi.fire("session_shutdown", { reason: "quit" }, ctx);
});

test("v0.35.x: list_activate uses the same whole-objective conflict update", async () => {
  __testOnlyResetStaleFlag();
  setGlobalAutoResume(true);
  const cwd = tmpCwd();
  const queued = { id: "whole-list-tool", objective: "tool-selected whole list objective", addedAt: new Date().toISOString() };
  seedState(cwd, {
    goal: seedGoal({ policy: "list", status: "active", objective: "tool current list objective" }),
    list: [queued],
  });
  const ctx = await freshSession(cwd, "reload");
  const originalId = readState(cwd).goal?.id;
  ctx.ui.selectImpl = async (_title, options) => options.find((option) => option === "Update current objective");
  ctx.ui.confirmImpl = async () => true;

  const result = await pi.runTool("list_activate", { n: 1 }, ctx);

  assert.match(result.content[0]!.text, /Whole list objective updated/);
  assert.equal(readState(cwd).goal?.id, originalId);
  assert.equal(readState(cwd).goal?.objective, queued.objective);
  assert.deepEqual(readState(cwd).list, [queued]);
  assert.equal(readLedger(cwd).some((entry) => entry.type === "update_task_status"), false);
  await pi.fire("session_shutdown", { reason: "quit" }, ctx);
});

test("v0.35.x: failed conflict update retries the same whole-objective prompt", async () => {
  __testOnlyResetStaleFlag();
  setGlobalAutoResume(true);
  const cwd = tmpCwd();
  const queued = { id: "whole-list-retry", objective: "incoming list after retry — done when the replacement proof exists", addedAt: new Date().toISOString() };
  seedState(cwd, {
    goal: seedGoal({
      policy: "list",
      status: "active",
      objective: "current list before retry — done when the old proof exists",
    }),
    list: [queued],
  });
  const ctx = await freshSession(cwd, "reload");
  ctx.ui.selectImpl = async (_title, options) => options.find((option) => option === "Update current objective");
  let confirms = 0;
  ctx.ui.confirmImpl = async () => ++confirms > 1;
  let inputs = 0;
  const inputTitles: string[] = [];
  ctx.ui.inputImpl = async (title) => {
    inputTitles.push(title);
    inputs++;
    return inputs === 2 ? "replacement whole list objective. Done when: retry proof exists" : undefined;
  };

  await pi.command("list", "next", ctx);

  assert.equal(readState(cwd).goal?.objective, "replacement whole list objective");
  assert.equal(inputs, 2, "the bounded fallback retries the same whole-objective editor, not individual tasks");
  assert.deepEqual(new Set(inputTitles), new Set(["What should we update the list item into? (replacement objective, optional 'Done when: ...' clause)"]));
  assert.equal(readLedger(cwd).filter((entry) => entry.type === "objective_conflict_update_retry").length, 2);
  assert.equal(readLedger(cwd).some((entry) => entry.type === "update_task_status"), false);
  await pi.fire("session_shutdown", { reason: "quit" }, ctx);
});

test("v0.35.0: a cross-mode replacement confirms before replacing a live loop", async () => {
  __testOnlyResetStaleFlag();
  setGlobalAutoResume(true);
  const cwd = tmpCwd();
  seedState(cwd, { loop: seedLoop({ active: true, target: "current loop target" }) });
  const ctx = await freshSession(cwd, "reload");
  ctx.ui.selectImpl = async (_title, options) => options.find((option) => option === "Replace current objective");
  await pi.command("goal", "goal replacing loop — done when proof exists", ctx);
  assert.match((readState(cwd).goal as { objective: string }).objective, /goal replacing loop/);
  assert.equal((readState(cwd).loop as { active?: boolean } | undefined)?.active, false, "the replaced loop is no longer active");
  await pi.fire("session_shutdown", { reason: "quit" }, ctx);
});

test("v0.35.4: a refused branch-mode loop start restores the original branch", async () => {
  // startLoopFromConfig creates the scratch branch BEFORE the baseline
  // measure and the objective-conflict re-check; a refusal after the
  // checkout stranded the repo on the empty pi-glla-loop branch, and no
  // state.loop existed to remember the user's branch. The refusal must
  // checkout the original branch again (the scratch branch stays — the
  // auto-commit daemon may have landed commits on it).
  __testOnlyResetStaleFlag();
  const cwd = tmpCwd();
  fs.writeFileSync(path.join(cwd, "seed.txt"), "tracked\n");
  // session_start writes cwd/.pi-glla ledger files; the branch-mode tree
  // check refuses a dirty repo, so ignore them like the real repo does.
  fs.writeFileSync(path.join(cwd, ".gitignore"), ".pi-glla/\n");
  execSync("git init -b main -q", { cwd });
  execSync("git add seed.txt .gitignore", { cwd });
  execSync("git -c user.name=t -c user.email=t@example.test commit -qm init", { cwd });
  // MockPi's default exec fakes success for every command — loop branch
  // operations need REAL git for this test, so program the handler.
  const realExec = pi.execHandler;
  pi.execHandler = (cmd, args, opts) => {
    try {
      const out = execSync(
        `${cmd} ${args.map((a) => `'${String(a).replace(/'/g, `'\''`)}'`).join(" ")}`,
        { cwd: (opts as { cwd?: string })?.cwd ?? cwd, encoding: "utf8" },
      );
      return { code: 0, stdout: out, stderr: "" };
    } catch (err) {
      const e = err as { status?: number; stdout?: string; stderr?: string };
      return { code: e.status ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? String(err) };
    }
  };
  try {
    const ctx = await freshSession(cwd, "startup");
    await pi.command("loop", 'start refusal target branch=1 measure="cat /definitely-not-here-xyz" direction=min', ctx);
    assert.equal(readState(cwd).loop ?? null, null, "the refused start must not create a loop state");
    const branch = execSync("git branch --show-current", { cwd }).toString().trim();
    assert.equal(branch, "main", "the user is back on the original branch after the refusal");
    const leftovers = execSync("git branch --list 'pi-glla-loop/*'", { cwd }).toString().trim();
    assert.ok(leftovers.length > 0, "the empty scratch branch remains but is not checked out");
    assert.ok(
      ctx.ui.notifies.some((n) => n.message.includes("loop start refused")),
      "the refusal is loud",
    );
  } finally {
    pi.execHandler = realExec;
  }
});

test("v0.35.0: a direct /loop start also confirms before replacing a live goal", async () => {
  __testOnlyResetStaleFlag();
  setGlobalAutoResume(true);
  const cwd = tmpCwd();
  seedState(cwd, { goal: seedGoal({ objective: "goal before loop — done when proof exists" }) });
  const ctx = await freshSession(cwd, "reload");
  ctx.ui.selectImpl = async (_title, options) => options.find((option) => option === "Replace current objective");
  await pi.command("loop", "start loop replacement target", ctx);
  assert.equal(readState(cwd).goal, null, "the replaced goal is archived and closed");
  assert.equal((readState(cwd).loop as { active: boolean }).active, true, "the new loop owns the active slot");
  await pi.fire("session_shutdown", { reason: "quit" }, ctx);
});

test("v0.34.121: one confirmed /glla wipe clears recovery and dispatch artifacts too", async () => {
  __testOnlyResetStaleFlag();
  const cwd = tmpCwd();
  seedState(cwd, {
    goal: seedGoal({ objective: "wipe-once objective — done when pinned" }),
    list: [{ id: "wipe-waiting", objective: "orphan waiting item", addedAt: new Date().toISOString() }],
    loop: seedLoop({ active: false, stopReason: HELD, target: "held loop before wipe" }),
    mainModelRecovery: {
      kind: "goal",
      primary: "provider/model",
      active: "provider/model",
      attempted: ["provider/model"],
      attempts: 1,
      reason: "provider quota",
      firstFailureAt: new Date().toISOString(),
      autoRetryUntil: new Date(Date.now() + 60_000).toISOString(),
      retryAt: new Date(Date.now() + 30_000).toISOString(),
    },
  } as unknown as Parameters<typeof seedState>[1]);
  const ctx = await freshSession(cwd, "startup");
  fs.writeFileSync(path.join(cwd, ".pi-glla", "continuation-dispatch.json"), "{}\n");
  fs.writeFileSync(path.join(cwd, ".pi-glla", "continuation-dispatch.json.tmp-test"), "partial");
  let confirms = 0;
  ctx.ui.confirmImpl = async () => { confirms++; return true; };
  await pi.command("glla", "wipe", ctx);
  const after = readState(cwd);
  assert.equal(after.goal, null, "the terminal goal record is removed from the live slot");
  assert.deepEqual(after.list, []);
  assert.equal(confirms, 1, "one wipe opens one destructive confirmation");
  assert.equal(fs.readdirSync(path.join(cwd, ".pi-glla", "archive")).length, 1, "history remains archived");
  assert.equal(fs.readdirSync(path.join(cwd, ".pi-glla", "goals")).filter((name) => name.endsWith(".queue.json")).length, 0, "queue sidecars are gone");
  assert.equal(readState(cwd).mainModelRecovery, undefined, "provider recovery state is cleared");
  assert.equal(fs.existsSync(path.join(cwd, ".pi-glla", "continuation-dispatch.json")), false, "dispatch sidecar is gone");
  assert.equal(fs.existsSync(path.join(cwd, ".pi-glla", "continuation-dispatch.json.tmp-test")), false, "dispatch temp sidecar is gone");
  const wipeLedger = fs.readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf8");
  assert.match(wipeLedger, /loop_completion_summary/, "wiping a loop leaves a durable recap ledger event");
  const wipeNotice = ctx.ui.notifies.find((notice) => notice.message.includes("glla wipe done"))?.message ?? "";
  const goalRecapStart = wipeNotice.indexOf("Goal recap: ");
  assert.ok(goalRecapStart >= 0, "wipe notification includes the goal recap projection");
  const goalRecapEnd = wipeNotice.indexOf("\nLoop recap:", goalRecapStart);
  assertCompactRecap(wipeNotice.slice(goalRecapStart, goalRecapEnd >= 0 ? goalRecapEnd : undefined), "wipe goal recap");
  assert.ok(wipeNotice.includes("Loop recap: Outcome:"), "wipe notification includes the loop recap projection");
  await pi.command("glla", "wipe", ctx);
  assert.equal(confirms, 1, "a clean second invocation is an idempotent no-op, not a second destructive flow");
  await pi.fire("session_shutdown", { reason: "quit" }, ctx);
});

test("v0.35.x: /list tweak amends a paused list item without activating it or changing waiting entries", async () => {
  __testOnlyResetStaleFlag();
  const cwd = tmpCwd();
  const waiting = [
    { id: "waiting-1", objective: "waiting item one", addedAt: new Date().toISOString() },
    { id: "waiting-2", objective: "waiting item two", addedAt: new Date().toISOString() },
  ];
  seedState(cwd, {
    goal: seedGoal({
      policy: "list",
      status: "paused",
      objective: "old paused list item",
      verificationContract: "old check",
      pauseReason: "paused by user",
      pauseSuggestedAction: "/list resume to continue",
    }),
    list: waiting,
  });
  const ctx = await freshSession(cwd, "reload");
  await tick();
  let confirmTitle = "";
  let confirmMessage = "";
  ctx.ui.confirmImpl = async (title, message) => {
    confirmTitle = title;
    confirmMessage = message;
    return true;
  };

  await pi.command("list", "tweak new paused list item. Done when: new check", ctx);

  const updated = readState(cwd).goal as {
    id: string;
    status: string;
    policy: string;
    objective: string;
    verificationContract?: string;
    pauseReason?: string;
  };
  assert.equal(updated.status, "paused", "tweak does not activate the list item");
  assert.equal(updated.policy, "list", "the list provenance is preserved");
  assert.equal(updated.objective, "new paused list item");
  assert.equal(updated.verificationContract, "new check", "the replacement contract is stored");
  assert.equal(updated.pauseReason, "paused by user", "the pause state remains intact");
  assert.deepEqual(readState(cwd).list, waiting, "waiting queue entries are unchanged");
  assert.equal(confirmTitle, "Tweak list item?", "the list-specific confirmation is used");
  assert.match(confirmMessage, /CURRENT:\nold paused list item/);
  assert.match(confirmMessage, /NEW:\nnew paused list item/);
  assert.equal(ctx.ui.matching("No active goal to tweak").length, 0, "list mode does not use the goal-mode error");
  assert.ok(ctx.ui.matching("List item tweaked; it remains paused").length >= 1, "the result names the paused list item");

  const tweak = ledgerEvent(cwd, "goal_tweaked");
  assert.equal(tweak.value.goalId, updated.id);
  assert.equal(tweak.value.via, "/list tweak");
  assert.equal(tweak.value.objective, "new paused list item");
});

test("T3d: active loop + human load → HELD_ON_RESTORE (loop deactivated loudly, not silently dropped)", async () => {
  const cwd = tmpCwd();
  seedState(cwd, { loop: seedLoop() });
  const ctx = await freshSession(cwd, "startup");
  const l = readState(cwd).loop as { active: boolean; stopReason?: string };
  assert.equal(l.active, false);
  assert.equal(l.stopReason, "held: restored in a fresh session");
  assert.ok(ctx.ui.matching("loop held on restore").length >= 1, "held notify names the loop");
});

test("v0.35.x: a successor auto-resumes lifecycle-held loops intact but preserves deliberate stops", async () => {
  __testOnlyResetStaleFlag();
  __testOnlyResetOwnerSession();
  setGlobalAutoResume(false);
  const cwd = tmpCwd();
  seedState(cwd, { loop: seedLoop({
    active: true,
    iteration: 7,
    maxIterations: 123,
    plateauWindow: 9,
    stallCount: 2,
    bestValue: 42,
    lastValue: 44,
    history: [{ iteration: 6, value: 44, improved: false, at: new Date().toISOString() }],
    timeLimitHours: 4,
    tokenBudget: 12_345,
    tokensUsed: 678,
    recentPrints: ["prior-print"],
    recentTexts: ["prior-text"],
  }) });
  const first = await freshSession(cwd, "startup");
  const held = readState(cwd).loop as unknown as Record<string, unknown>;
  assert.equal(held.active, false, "human startup first parks the active loop");
  assert.equal(held.stopReason, HELD, "the lifecycle hold is explicit");
  const heldSnapshot = { ...held };
  delete heldSnapshot.active;
  delete heldSnapshot.stopReason;

  await pi.fire("session_shutdown", { reason: "reload" }, first);
  const replacement = ownerCtx(cwd);
  pi.sent.length = 0;
  await pi.fire("session_start", { reason: "reload" }, replacement);
  const resumed = readState(cwd).loop as unknown as Record<string, unknown>;
  assert.equal(resumed.active, true, "the successor resumes the lifecycle-held loop");
  assert.equal(resumed.stopReason, undefined, "the lifecycle hold marker is consumed");
  const resumedSnapshot = { ...resumed };
  delete resumedSnapshot.active;
  delete resumedSnapshot.stopReason;
  assert.deepEqual(resumedSnapshot, heldSnapshot, "metric, bounds, history, iteration, and progress survive unchanged");
  assert.ok(readLedger(cwd).some((entry) => entry.type === "loop_auto_resumed_on_restore"), "automatic lifecycle resume is ledgered");
  await pi.command("loop", "stop", replacement);

  const deliberateCwd = tmpCwd();
  const deliberateReason = "stopped by user (/loop stop)";
  seedState(deliberateCwd, { loop: seedLoop({ active: true, iteration: 11, bestValue: 9 }) });
  const deliberateFirst = await freshSession(deliberateCwd, "startup");
  const heldBeforeStop = readState(deliberateCwd).loop as { active: boolean; stopReason?: string };
  assert.equal(heldBeforeStop.stopReason, HELD, "the held loop is present before the operator stops it");
  await pi.command("loop", "stop", deliberateFirst);
  const stoppedByUser = readState(deliberateCwd).loop as { active: boolean; stopReason?: string };
  assert.equal(stoppedByUser.active, false, "the operator stop leaves the loop inactive");
  assert.equal(stoppedByUser.stopReason, deliberateReason, "the operator stop overwrites the lifecycle hold");
  await pi.fire("session_shutdown", { reason: "reload" }, deliberateFirst);
  const deliberateReplacement = ownerCtx(deliberateCwd);
  await pi.fire("session_start", { reason: "reload" }, deliberateReplacement);
  const deliberate = readState(deliberateCwd).loop as { active: boolean; stopReason?: string };
  assert.equal(deliberate.active, false, "a deliberate user stop stays stopped");
  assert.equal(deliberate.stopReason, deliberateReason, "the deliberate stop reason is preserved");
  assert.equal(readLedger(deliberateCwd).some((entry) => entry.type === "loop_auto_resumed_on_restore"), false, "deliberate stop never enters lifecycle auto-resume");
});

test("v0.29.14: live audit loop on open-count/min migrates to closed-count/max on load (discovery no longer reads as regression)", async () => {
  __testOnlyResetStaleFlag();
  const cwd = tmpCwd();
  seedState(cwd, { loop: seedLoop({
    active: false,
    stopReason: HELD,
    kind: "audit",
    direction: "min",
    bestValue: 20,
    stallCount: 4,
    measureCmd: "c=$(grep -cE '^- \\[ \\]' .pi-glla/audit-loop/findings.md 2>/dev/null); echo ${c:-0}",
  }) });
  await freshSession(cwd, "startup");
  const l = readState(cwd).loop as { direction?: string; measureCmd?: string; bestValue: number | null; stallCount: number; kind?: string };
  assert.equal(l.direction, "max", "direction flipped to max");
  assert.ok(l.measureCmd!.includes("\\[[xX]\\]"), "closed-count measure");
  assert.equal(l.bestValue, null, "pinned best nulled — next measure is the honest baseline");
  assert.equal(l.stallCount, 0, "plateau stall streak reset");
  assert.equal(l.kind, "audit");
});

test("v0.29.18: live audit loop on the audit-every-iteration target migrates to FIX-FIRST on load", async () => {
  // Field (hegemon iter 26, 2026-07-30): the audit-every-iteration target
  // made discovery (8-12 findings/iter) outpace fixes (1/iter) and allowed
  // "no new action this turn" iterations with 18 open boxes — the user
  // watched it find and present instead of fix ("the goal would be audit
  // to fix then audit then fix again no?"). Target-only swap: metric is
  // unchanged, so best/stall survive.
  __testOnlyResetStaleFlag();
  const cwd = tmpCwd();
  seedState(cwd, { loop: seedLoop({
    active: false,
    stopReason: HELD,
    kind: "audit",
    direction: "max",
    bestValue: 70,
    stallCount: 2,
    target: "Audit the project for real problems and fix them, iteration by iteration. Every iteration: (1) run a FRESH audit pass over the codebase — spawn Explore subagents for breadth — hunting real issues.",
  }) });
  await freshSession(cwd, "startup");
  const l = readState(cwd).loop as { target?: string; bestValue: number | null; stallCount: number };
  assert.ok(l.target!.includes("FIX-FIRST"), "target swapped to the fix-first template");
  assert.ok(!l.target!.includes("Every iteration: (1) run a FRESH audit pass"), "old template gone");
  assert.equal(l.bestValue, 70, "metric unchanged — best survives");
  assert.equal(l.stallCount, 2, "stall streak survives");
  const ledger = fs.readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf-8");
  assert.ok(ledger.includes("audit_loop_target_migrated"), "migration ledgered");
});

test("v0.34.16: lifecycle handoff resumes same-process replacement but quit does not bypass restore consent", async () => {
  setGlobalAutoResume(false);
  const cwd = tmpCwd();
  seedState(cwd, { goal: seedGoal() });
  const first = await freshSession(cwd, "startup");
  await pi.command("goal", "resume", first);
  await tick();
  assert.equal((readState(cwd).goal as { status: string }).status, "active", "fixture is actively supervising before replacement");

  await pi.fire("session_shutdown", { reason: "reload" }, first);
  const handoffPath = path.join(cwd, ".pi-glla", "session-handoff.json");
  assert.equal(JSON.parse(fs.readFileSync(handoffPath, "utf8")).reason, "reload", "replacement debt records its lifecycle reason");
  const replacement = ownerCtx(cwd);
  await pi.fire("session_start", { reason: "reload" }, replacement);
  await tick();
  assert.equal((readState(cwd).goal as { status: string }).status, "active", "same-process replacement consumes handoff debt");
  assert.equal(fs.existsSync(handoffPath), false, "handoff debt is single-use");
  const replacementLedger = fs.readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf8");
  assert.ok(replacementLedger.includes('"session_handoff_resumed"'), "handoff consumption is ledger-visible");

  const quitCwd = tmpCwd();
  seedState(quitCwd, { goal: seedGoal() });
  const quitSession = await freshSession(quitCwd, "startup");
  await pi.command("goal", "resume", quitSession);
  await tick();
  await pi.fire("session_shutdown", { reason: "quit" }, quitSession);
  const quitHandoff = path.join(quitCwd, ".pi-glla", "session-handoff.json");
  assert.equal(fs.existsSync(quitHandoff), false, "explicit quit leaves no continuation debt");
  const afterQuit = ownerCtx(quitCwd);
  await pi.fire("session_start", { reason: "startup" }, afterQuit);
  const quitGoal = readState(quitCwd).goal as { status: string; pauseReason?: string };
  assert.equal(quitGoal.status, "paused", "quit does not get same-pid rebind consent");
  assert.match(quitGoal.pauseReason ?? "", /held for explicit resume/);
  const quitLedger = fs.readFileSync(path.join(quitCwd, ".pi-glla", "active.jsonl"), "utf8");
  assert.ok(quitLedger.includes('"session_handoff_suppressed"'), "quit suppression is ledger-visible");

  const foreignCwd = tmpCwd();
  seedState(foreignCwd, { goal: seedGoal() });
  fs.writeFileSync(path.join(foreignCwd, ".pi-glla", "session-handoff.json"), JSON.stringify({ pid: process.pid + 1, at: new Date().toISOString(), reason: "reload" }));
  const foreignSession = await freshSession(foreignCwd, "startup");
  const foreignGoal = readState(foreignCwd).goal as { status: string };
  assert.equal(foreignGoal.status, "paused", "foreign-process debt cannot resume a cold session");
  assert.equal(fs.existsSync(path.join(foreignCwd, ".pi-glla", "session-handoff.json")), false, "foreign debt is consumed and discarded");
  assert.ok(foreignSession.ui.matching("held on restore").length >= 1, "foreign debt falls back to the normal restore gate");
});

test("stale list work survives invalidation and resumes only through a fresh file-backed session", async () => {
  __testOnlyResetStaleFlag();
  setGlobalAutoResume(true);
  const cwd = tmpCwd();
  try {
    const first = await freshSession(cwd, "startup");
    pi.sent.length = 0;
    await pi.command("list", "add durable stale-list item — done when pinned", first);
    await tick();
    assert.equal((readState(cwd).goal as { objective: string }).objective.includes("durable stale-list item"), true);
    const before = fs.readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf8");
    const sentBeforeInvalidation = pi.sent.length;

    invalidateHostSession(pi, first);
    __testOnlyHeartbeatTick();
    await pi.fire("agent_end", { messages: [{ role: "assistant", content: [{ type: "text", text: "late old callback" }], stopReason: "end_turn" }] }, first);
    await tick(250);
    const afterStale = fs.readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf8");
    assert.equal(pi.sent.length, sentBeforeInvalidation, "invalidated host does not enqueue another continuation");
    assert.ok(afterStale.length > before.length, "stale interruption is durable");
    const interrupted = readState(cwd).goal as { interruptedAt?: string; objective?: string };
    assert.ok(interrupted.interruptedAt, "saved list work records the interruption");
    assert.match(interrupted.objective ?? "", /durable stale-list item/);

    pi.sendMessageError = null;
    pi.sessionNameError = null;
    const replacement = makeMockCtx(cwd, {
      sessionManager: {
        name: "durable-list-replacement",
        getSessionFile: () => path.join(cwd, "durable-list-replacement.jsonl"),
        getSessionId: () => "durable-list-replacement-1",
      },
    });
    pi.sent.length = 0;
    await pi.fire("session_start", { reason: "reload", previousSessionFile: path.join(cwd, "old-session.jsonl") }, replacement);
    await tick();
    const rebound = readState(cwd).goal as { objective?: string; status?: string; interruptedAt?: string };
    assert.match(rebound.objective ?? "", /durable stale-list item/);
    assert.equal(rebound.status, "active", "fresh host rebind restores the saved list item");
    assert.equal(rebound.interruptedAt, undefined, "rebind clears the stale interruption marker");
    assert.equal(pi.sent.length, 1, "fresh host sends one replacement continuation");
    const ledger = readLedger(cwd);
    assert.ok(ledger.some((entry) => entry.type === "session_rebound"), "fresh rebind is ledgered");
    assert.ok(ledger.some((entry) => entry.type === "stale_flag_reset_on_rebind"), "stale latch reset is ledgered");
    await pi.fire("session_shutdown", { reason: "quit" }, replacement);
  } finally {
    pi.sendMessageError = null;
    pi.sessionNameError = null;
    __testOnlyResetOwnerSession();
  }
});

test("v0.34.49: fresh MAIN session_start resets stale state and rejects the old dispatch generation", async () => {
  __testOnlyResetStaleFlag();
  setGlobalAutoResume(false);
  const cwd = tmpCwd();
  const first = await freshSession(cwd, "startup");
  pi.sent.length = 0;
  await pi.command("goal", "start fresh-main rebind target — done when pinned", first);
  await tick();
  assert.equal(pi.sent.length, 1, "the old generation dispatched once");
  const oldPrompt = pi.sent[0]!.message.content ?? "";
  const oldDispatch = JSON.parse(fs.readFileSync(path.join(cwd, ".pi-glla", "continuation-dispatch.json"), "utf8")) as { generation: number; id: string };

  // Invalidate the old MAIN handle and let the production heartbeat park it.
  // The replacement arrives through a fresh host lifecycle event afterward.
  invalidateHostSession(pi, first);
  __testOnlyHeartbeatTick();
  pi.sendMessageError = null;
  pi.sessionNameError = null;
  pi.sent.length = 0;
  const replacement = makeMockCtx(cwd, {
    sessionManager: {
      name: "fresh-main-session-manager",
      getSessionFile: () => path.join(cwd, "fresh-main-session.jsonl"),
      getSessionId: () => "fresh-main-session-1",
    },
  });
  await pi.fire("session_start", { reason: "reload", previousSessionFile: path.join(cwd, "old-session.jsonl") }, replacement);
  await tick();

  const rebound = readState(cwd).goal as { status: string; interruptedAt?: string };
  assert.equal(rebound.status, "active", "fresh MAIN rebind keeps the goal active");
  assert.equal(rebound.interruptedAt, undefined, "fresh rebind clears the stale interrupt marker");
  const reboundLedger = readLedger(cwd);
  assert.ok(reboundLedger.some((entry) => entry.type === "stale_flag_reset_on_rebind"), "fresh session resets the stale API latch");
  assert.ok(reboundLedger.some((entry) => entry.type === "session_rebound"), "fresh session rebind is durable");
  assert.equal(pi.sent.length, 1, "rebind schedules exactly one fresh continuation");

  const newPrompt = pi.sent[0]!.message.content ?? "";
  const newDispatch = JSON.parse(fs.readFileSync(path.join(cwd, ".pi-glla", "continuation-dispatch.json"), "utf8")) as { generation: number; id: string };
  assert.ok(newDispatch.generation > oldDispatch.generation, "the replacement dispatch belongs to a newer generation");
  assert.notEqual(newDispatch.id, oldDispatch.id, "the replacement dispatch has a fresh identity");

  // A late start proof from the disposed generation cannot acknowledge the
  // replacement dispatch, even when the old callback arrives after rebind.
  await pi.fire("before_agent_start", { prompt: oldPrompt }, first);
  assert.equal(fs.existsSync(path.join(cwd, ".pi-glla", "continuation-dispatch.json")), true, "old-generation proof leaves the new sidecar pending");
  await pi.fire("before_agent_start", { prompt: newPrompt }, replacement);
  assert.equal(fs.existsSync(path.join(cwd, ".pi-glla", "continuation-dispatch.json")), false, "matching generation proof settles the replacement");
  await pi.command("goal", "pause", replacement);
  __testOnlyResetOwnerSession(); // the next fixture claims a fresh MAIN owner
});

test("v0.34.49: a handoff is one-shot and only matching predecessor identity can resume", async () => {
  __testOnlyResetStaleFlag();
  setGlobalAutoResume(false);
  const cwd = tmpCwd();
  seedState(cwd, { goal: seedGoal() });
  const first = await freshSession(cwd, "startup");
  await pi.command("goal", "resume", first);
  await tick();
  await pi.fire("session_shutdown", { reason: "reload" }, first);
  const handoffPath = path.join(cwd, ".pi-glla", "session-handoff.json");
  const handoff = JSON.parse(fs.readFileSync(handoffPath, "utf8")) as { generation: number; ownerSessionId: string };
  fs.writeFileSync(handoffPath, JSON.stringify({ ...handoff, generation: handoff.generation + 1, ownerSessionId: "wrong-predecessor" }));

  const replacement = ownerCtx(cwd);
  pi.sent.length = 0;
  await pi.fire("session_start", { reason: "reload" }, replacement);
  await tick();
  const held = readState(cwd).goal as { status: string; pauseReason?: string };
  assert.equal(held.status, "paused", "a mismatched handoff cannot bypass the restore gate");
  assert.match(held.pauseReason ?? "", /held for explicit resume/);
  assert.equal(pi.sent.length, 0, "mismatched handoff does not send a continuation");
  assert.equal(fs.existsSync(handoffPath), false, "mismatched handoff is consumed once");
  const ledger = readLedger(cwd);
  assert.ok(ledger.some((entry) => entry.type === "session_handoff_rejected"), "mismatch is ledgered");
  assert.equal(ledger.filter((entry) => entry.type === "session_handoff_resumed").length, 0, "mismatch never records a resume");
});

test("v0.34.23: host replacement with a new SessionManager is not rejected as foreign", async () => {
  __testOnlyResetStaleFlag();
  setGlobalAutoResume(true);
  const cwd = tmpCwd();
  seedState(cwd, { goal: seedGoal() });
  const first = await freshSession(cwd, "startup");
  await pi.command("goal", "resume", first);
  await tick();

  const replacement = makeMockCtx(cwd, {
    sessionManager: {
      name: "replacement-session-manager",
      getSessionFile: () => path.join(cwd, "replacement-session.jsonl"),
      getSessionId: () => "replacement-session-1",
    },
  });
  pi.sent.length = 0;
  await pi.fire("session_start", { reason: "resume", previousSessionFile: "/tmp/previous-session.json" }, replacement);
  await tick();

  assert.ok(replacement.ui.matching("resuming goal").length >= 1, "replacement session ran the restore gate");
  assert.ok(pi.sent.length >= 1, "replacement session sent the continuation");
  const ledger = fs.readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf8");
  assert.ok(ledger.includes('"session_rebind_without_shutdown"'), "replacement without shutdown is ledgered");

  // A normal subagent startup with a different manager must still be ignored.
  const foreign = makeMockCtx(cwd, { sessionManager: { name: "subagent-session-manager" } });
  pi.sent.length = 0;
  await pi.fire("session_start", { reason: "startup" }, foreign);
  await tick();
  assert.equal(pi.sent.length, 0, "subagent startup did not steal host ownership");

  // Event-shaped lifecycle reasons are not enough for an in-memory worker to
  // claim the MAIN plane; only a file-backed host replacement may rebind.
  const foreignLifecycle = makeMockCtx(cwd, {
    sessionManager: {
      name: "subagent-lifecycle-manager",
      getSessionFile: () => undefined,
      getSessionId: () => "subagent-lifecycle-1",
    },
  });
  await pi.fire("session_start", { reason: "reload", previousSessionFile: "/tmp/fake-host-session.jsonl" }, foreignLifecycle);
  await tick();
  assert.equal(pi.sent.length, 0, "subagent lifecycle-shaped start did not steal host ownership");
  assert.equal(foreignLifecycle.ui.matching("resuming goal").length, 0, "foreign lifecycle-shaped start did not run restore");
  __testOnlyResetOwnerSession(); // keep later behavioral fixtures independent
});

test("v0.34.20: registered tools use the replacement invocation context without session_shutdown", async () => {
  __testOnlyResetStaleFlag();
  const cwd = tmpCwd();
  seedState(cwd, { goal: seedGoal() });
  const first = await freshSession(cwd, "startup");
  await pi.command("goal", "resume", first);
  await tick();
  const replacement = ownerCtx(cwd);
  // Some pi replacement paths deliver session_start without a preceding
  // session_shutdown. The tool registry must not retain the first ctx.
  await pi.fire("session_start", { reason: "reload" }, replacement);
  // Reload holds the goal for explicit consent; resume it before exercising
  // the replacement invocation context so the pause tool sees a valid active
  // lifecycle rather than a late duplicate pause.
  await pi.command("goal", "resume", replacement);
  await tick();
  const result = await pi.runTool("pause_goal", { reason: "replacement context probe", kind: "blocked" }, replacement);
  assert.match(result.content[0]!.text, /Goal paused/);
  assert.ok(replacement.ui.matching("replacement context probe").length >= 1, "replacement UI received the tool result");
  assert.equal(first.ui.matching("replacement context probe").length, 0, "registration-time UI was not reused");
});

test("T3e (v0.28.21): no active goal + queued list + reload → NOT activated by default; autoresume=on → head activates", async () => {
  const cwd = tmpCwd();
  seedState(cwd, { list: [{ id: "item-1", objective: "queued head objective — done when pinned", addedAt: new Date().toISOString() }] });
  pi.sent.length = 0;
  const ctx = await freshSession(cwd, "reload");
  await tick();
  const s = readState(cwd);
  assert.equal(s.goal, null, "nothing activated by default");
  assert.ok(ctx.ui.matching("waiting").length >= 1, "waiting notify names the queue");
  assert.equal(pi.sent.length, 0, "no continuation fired");

  const cwd2 = tmpCwd();
  seedState(cwd2, { list: [{ id: "item-1", objective: "queued head objective — done when pinned", addedAt: new Date().toISOString() }] });
  setGlobalAutoResume(true);
  pi.sent.length = 0;
  const ctx2 = await freshSession(cwd2, "reload");
  await tick();
  const s2 = readState(cwd2);
  const g = s2.goal as { status: string; objective: string; policy: string } | null;
  assert.ok(g, "a goal exists after restore");
  assert.equal(g!.objective, "queued head objective — done when pinned");
  assert.equal(g!.policy, "list");
  assert.equal(g!.status, "active");
  assert.ok(ctx2.ui.matching("activated").length >= 1, "activation notify");
  assert.ok(pi.sent.length >= 1, "continuation sent for the activated head");
});

// ────────────────────────────────────────────────────────────────────
// v0.34.24 — accepted dispatch is not start proof
// ────────────────────────────────────────────────────────────────────

test("v0.34.24: continuation dispatch waits for owner start proof and clears its sidecar", async () => {
  __testOnlyResetStaleFlag();
  const cwd = tmpCwd();
  const ctx = await freshSession(cwd, "startup");
  pi.sent.length = 0;
  await pi.command("goal", "start dispatch proof target — done when pinned", ctx);
  await tick();
  assert.equal(pi.sent.length, 1, "the initial continuation was dispatched once");
  const content = pi.sent[0]!.message.content ?? "";
  const sidecar = path.join(cwd, ".pi-glla", "continuation-dispatch.json");
  assert.ok(fs.existsSync(sidecar), "accepted dispatch remains durably pending until a start proof");

  const foreign = makeMockCtx(cwd, { sessionManager: { name: "dispatch-proof-subagent" } });
  await pi.fire("before_agent_start", { prompt: content }, foreign);
  assert.ok(fs.existsSync(sidecar), "foreign-session start cannot acknowledge the main dispatch");

  await pi.fire("before_agent_start", { prompt: content }, ctx);
  assert.equal(fs.existsSync(sidecar), false, "owner before_agent_start acknowledges and clears the sidecar");
  const prepared = ledgerEvent(cwd, "continuation_dispatch_prepared").value;
  const accepted = ledgerEvent(cwd, "continuation_dispatch_accepted").value;
  const started = ledgerEvent(cwd, "continuation_start_acknowledged").value;
  assert.equal(prepared.id, accepted.id, "dispatch ID is stable across prepare and acceptance");
  assert.equal(accepted.id, started.id, "dispatch ID is stable through start proof");
  assert.equal(accepted.generation, started.generation, "generation is retained through settlement");
  assert.equal(typeof accepted.ownerSessionId, "string", "owner identity is recorded");
  assert.equal(accepted.acknowledgement, "accepted", "send acknowledgement is explicit");
  assert.equal(accepted.startProofSource, null, "acceptance does not masquerade as start proof");
  assert.equal(typeof accepted.timeoutMs, "number", "the configured timeout is recorded");
  assert.equal(started.startProofSource, "before_agent_start", "start-proof source is explicit");
  assert.equal(started.settlement, "started", "started is a distinct settlement");
  assert.equal(typeof started.settledAt, "number", "settlement time is recorded");
  await pi.command("goal", "pause", ctx);
});

test("v0.34.36: compaction releases a timed-out dispatch for one fresh resync attempt", async () => {
  __testOnlyResetStaleFlag();
  __testOnlySetContinuationStartTimeout(300);
  __testOnlySetContinuationRetryBackoff(300);
  try {
    const cwd = tmpCwd();
    const ctx = await freshSession(cwd, "startup");
    pi.sent.length = 0;
    await pi.command("goal", "compaction recovery target — done when pinned", ctx);
    await tick();
    await waitUntil(() => {
      try {
        return fs.readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf8").includes("continuation_start_unacknowledged");
      } catch {
        return false;
      }
    }, 4_000); // hardened: real-time poll under heavy CI load (2026-08-10)
    // v0.34.88: the first timeout now sends exactly ONE automatic retry (the
    // backoff window follows), then the second window declares unacknowledged.
    assert.equal(pi.sent.length, 2, "the watchdog sent exactly one automatic retry, no blind storm");
    await pi.fire("session_compact", {}, ctx);
    await waitUntil(() => pi.sent.length >= 3, 3_500);
    const ledger = fs.readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf8");
    assert.match(ledger, /compaction_refire/);
    const resyncContent = pi.sent[2]!.message.content ?? "";
    assert.match(resyncContent, /POST-COMPACTION RESYNC/);
    await pi.command("goal", "pause", ctx);
  } finally {
    __testOnlySetContinuationStartTimeout(null);
    __testOnlySetContinuationRetryBackoff(null);
  }
});

// v0.34.57 watchdog tests moved to tests/loops/goal.test.ts (the verification
// contract for the 30s continuation-start watchdog fix names that path).
// behavioral-orchestrator.test.ts remains the home for the behavioral
// orchestrator / T3-T1 stale-handle / T2 stop tests.

test("v0.34.36: a loop missing start proof stops durably and /loop resume re-arms it exactly once", async () => {
  __testOnlyResetStaleFlag();
  __testOnlySetContinuationStartTimeout(300);
  __testOnlySetContinuationRetryBackoff(300);
  try {
    const cwd = tmpCwd();
    setGlobalAutoResume(true);
    pi.sent.length = 0;
    seedState(cwd, { loop: seedLoop({ active: true }) });
    const ctx = await freshSession(cwd, "reload");
    await tick();
    assert.equal(pi.sent.length, 1, "the loop made one initial dispatch");
    const sidecar = path.join(cwd, ".pi-glla", "continuation-dispatch.json");
    const stoodDown = JSON.parse(fs.readFileSync(sidecar, "utf8")) as { phase: string; id: string };
    await waitUntil(() => {
      try {
        return fs.readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf8").includes("continuation_start_unacknowledged");
      } catch {
        return false;
      }
    }, 4_000); // hardened: real-time poll under heavy CI load (2026-08-10)
    assert.equal(stoodDown.phase, "accepted", "the initial loop dispatch was accepted before its proof timed out");
    const stopped = readState(cwd).loop as { active: boolean; stopReason?: string };
    assert.equal(stopped.active, false, "a loop cannot remain green-active after its continuation never starts");
    assert.match(stopped.stopReason ?? "", /stalled: continuation start acknowledgement timed out/);
    // v0.34.88: the watchdog re-armed exactly ONE verbatim retry, then stopped.
    assert.equal(pi.sent.length, 2, "the timeout re-arms exactly one retry, then stops");

    await pi.command("loop", "resume", ctx);
    await tick();
    assert.equal(pi.sent.length, 3, "explicit /loop resume creates exactly one fresh dispatch");
    const secondContent = pi.sent[2]!.message.content ?? "";
    const retried = JSON.parse(fs.readFileSync(sidecar, "utf8")) as { phase: string; id: string };
    assert.equal(retried.phase, "accepted");
    assert.notEqual(retried.id, stoodDown.id, "loop resume clears the stand-down and gets a new identity");
    await pi.fire("before_agent_start", { prompt: secondContent }, ctx);
    assert.equal(fs.existsSync(sidecar), false, "the resumed loop dispatch settles on owner start proof");
    await pi.command("loop", "stop", ctx);
  } finally {
    __testOnlySetContinuationStartTimeout(null);
    __testOnlySetContinuationRetryBackoff(null);
  }
});

test("v0.34.48: /list resume releases an unacknowledged dispatch exactly once", async () => {
  __testOnlyResetStaleFlag();
  __testOnlySetContinuationStartTimeout(300);
  __testOnlySetContinuationRetryBackoff(300);
  try {
    const cwd = tmpCwd();
    setGlobalAutoResume(true);
    pi.sent.length = 0;
    seedState(cwd, { goal: seedGoal({ policy: "list" }) });
    const ctx = await freshSession(cwd, "reload");
    await tick();
    assert.equal(pi.sent.length, 1, "the list item made one initial dispatch");
    const sidecar = path.join(cwd, ".pi-glla", "continuation-dispatch.json");
    const stoodDown = JSON.parse(fs.readFileSync(sidecar, "utf8")) as { phase: string; id: string };
    await waitUntil(() => {
      try {
        return fs.readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf8").includes("continuation_start_unacknowledged");
      } catch {
        return false;
      }
    }, 4_000); // hardened: real-time poll under heavy CI load (2026-08-10)
    const interrupted = readState(cwd).goal as { status: string; policy: string; interruptedAt?: string };
    assert.equal(interrupted.status, "active", "an unacknowledged list dispatch remains active but interrupted");
    assert.equal(interrupted.policy, "list");
    assert.ok(interrupted.interruptedAt, "the list item exposes its explicit-recovery marker");
    // v0.34.88: exactly one automatic retry before the stand-down.
    assert.equal(pi.sent.length, 2, "the timeout re-arms exactly one retry, then stops");

    await pi.command("list", "resume", ctx);
    await tick();
    assert.equal(pi.sent.length, 3, "explicit /list resume creates exactly one fresh dispatch");
    const secondContent = pi.sent[2]!.message.content ?? "";
    const retried = JSON.parse(fs.readFileSync(sidecar, "utf8")) as { phase: string; id: string };
    assert.equal(retried.phase, "accepted");
    assert.notEqual(retried.id, stoodDown.id, "list resume clears the stand-down and gets a new identity");
    await pi.fire("before_agent_start", { prompt: secondContent }, ctx);
    assert.equal(fs.existsSync(sidecar), false, "the resumed list dispatch settles on owner start proof");
    await pi.command("goal", "pause", ctx);
  } finally {
    __testOnlySetContinuationStartTimeout(null);
    __testOnlySetContinuationRetryBackoff(null);
  }
});

test("v0.34.24: missing start proof stands down durably and explicit resume sends one fresh attempt", async () => {
  __testOnlyResetStaleFlag();
  __testOnlySetContinuationStartTimeout(300);
  __testOnlySetContinuationRetryBackoff(300);
  try {
    const cwd = tmpCwd();
    const ctx = await freshSession(cwd, "startup");
    pi.sent.length = 0;
    await pi.command("goal", "start bounded dispatch target — done when pinned", ctx);
    await tick();
    assert.equal(pi.sent.length, 1, "the first dispatch is sent once");
    const sidecar = path.join(cwd, ".pi-glla", "continuation-dispatch.json");
    await waitUntil(() => {
      try {
        return fs.readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf8").includes("continuation_start_unacknowledged");
      } catch {
        return false;
      }
    }, 4_000); // hardened: real-time poll under heavy CI load (2026-08-10)
    const stoodDown = JSON.parse(fs.readFileSync(sidecar, "utf8")) as { phase: string; id: string };
    assert.equal(stoodDown.phase, "unacknowledged", "the failed proof is durable");
    // v0.34.88: exactly one automatic retry fired before the stand-down.
    assert.equal(pi.sent.length, 2, "the watchdog re-arms exactly one retry, then stops");
    assert.ok(ctx.ui.matching("Automatic re-sends are stopped").length >= 1, "the stand-down is loud");
    const timedOut = ledgerEvent(cwd, "continuation_start_unacknowledged").value;
    assert.equal(timedOut.id, stoodDown.id, "timeout settles the same dispatch identity");
    assert.equal(timedOut.acknowledgement, "accepted", "timeout preserves the enqueue acknowledgement");
    assert.equal(timedOut.startProofSource, null, "timeout records that no start proof arrived");
    assert.equal(typeof timedOut.timeoutMs, "number", "timeout budget is recorded");
    assert.equal(timedOut.settlement, "unacknowledged", "timeout settlement is explicit");
    assert.equal(typeof timedOut.timedOutAt, "number", "timeout time is recorded");
    assert.match(fs.readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf8"), /"continuation_start_unacknowledged"/);

    await pi.command("goal", "resume", ctx);
    await tick();
    assert.equal(pi.sent.length, 3, "explicit /goal resume creates exactly one fresh dispatch");
    const secondContent = pi.sent[2]!.message.content ?? "";
    const retried = JSON.parse(fs.readFileSync(sidecar, "utf8")) as { phase: string; id: string };
    assert.equal(retried.phase, "accepted");
    assert.notEqual(retried.id, stoodDown.id, "resume gets a new dispatch identity");

    await pi.fire("before_agent_start", { prompt: secondContent }, ctx);
    assert.equal(fs.existsSync(sidecar), false, "the resumed dispatch clears after owner start proof");
    await pi.command("goal", "pause", ctx);
  } finally {
    __testOnlySetContinuationStartTimeout(null);
    __testOnlySetContinuationRetryBackoff(null);
  }
});

test("v0.34.88: a transient no-turn-start miss self-heals with exactly ONE verbatim retry", async () => {
  __testOnlyResetStaleFlag();
  __testOnlySetContinuationStartTimeout(300);
  __testOnlySetContinuationRetryBackoff(300);
  try {
    const cwd = tmpCwd();
    const ctx = await freshSession(cwd, "startup");
    pi.sent.length = 0;
    await pi.command("goal", "no-turn-start retry target — done when pinned", ctx);
    await tick();
    // First window (T1) expires with no turn-start → the watchdog re-sends
    // the verbatim original continuation instead of declaring unacknowledged.
    await waitUntil(() => {
      try {
        return fs.readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf8").includes("continuation_retry_sent");
      } catch {
        return false;
      }
    }, 4_000); // hardened: real-time poll under heavy CI load (2026-08-10)
    assert.equal(pi.sent.length, 2, "the watchdog re-sent exactly one automatic retry");
    const ledger = fs.readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf8");
    assert.doesNotMatch(ledger, /continuation_start_unacknowledged/, "the retry window must not declare unacknowledged yet");
    const first = pi.sent[0]!.message.content ?? "";
    const retried = pi.sent[1]!.message.content ?? "";
    assert.equal(retried, first, "the retry re-sends the VERBATIM original continuation");
    // The turn starts on the retried message (self-heal) — the dispatch
    // settles on owner start proof and nothing further is sent.
    await pi.fire("before_agent_start", { prompt: retried }, ctx);
    const sidecar = path.join(cwd, ".pi-glla", "continuation-dispatch.json");
    assert.equal(fs.existsSync(sidecar), false, "the retried dispatch settles on start proof");
    await waitUntil(() => {
      try {
        return fs.readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf8").includes("continuation_start_acknowledged");
      } catch {
        return false;
      }
    }, 4_000); // hardened: real-time poll under heavy CI load (2026-08-10)
    assert.equal(pi.sent.length, 2, "settling after the retry sends nothing further");
    await pi.command("goal", "pause", ctx);
  } finally {
    __testOnlySetContinuationStartTimeout(null);
    __testOnlySetContinuationRetryBackoff(null);
  }
});

test("v0.34.88: a genuine stall fires unacknowledged after the retry backoff — exactly one retry, then re-sends stop", async () => {
  __testOnlyResetStaleFlag();
  __testOnlySetContinuationStartTimeout(300);
  __testOnlySetContinuationRetryBackoff(300);
  try {
    const cwd = tmpCwd();
    const ctx = await freshSession(cwd, "startup");
    pi.sent.length = 0;
    await pi.command("goal", "no-turn-start stall target — done when pinned", ctx);
    await tick();
    await waitUntil(() => {
      try {
        return fs.readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf8").includes("continuation_retry_sent");
      } catch {
        return false;
      }
    }, 4_000); // hardened: real-time poll under heavy CI load (2026-08-10)
    assert.equal(pi.sent.length, 2, "exactly one automatic retry before the stall is declared");
    await waitUntil(() => {
      try {
        return fs.readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf8").includes("continuation_start_unacknowledged");
      } catch {
        return false;
      }
    }, 2_000);
    assert.equal(pi.sent.length, 2, "re-sends STOP after the single retry — the explicit resume fallback owns the rest");
    const goal = readState(cwd).goal as { status: string; interruptedAt?: string };
    assert.equal(goal.status, "active", "an unacknowledged dispatch remains active but interrupted");
    assert.ok(goal.interruptedAt, "the goal exposes its explicit-recovery marker after both windows");
    assert.ok(ctx.ui.matching("Automatic re-sends are stopped").length >= 1, "the stand-down is loud");
    await pi.command("goal", "pause", ctx);
  } finally {
    __testOnlySetContinuationStartTimeout(null);
    __testOnlySetContinuationRetryBackoff(null);
  }
});

test("v0.34.88: a goal paused inside the watchdog window is never blind-retried", async () => {
  __testOnlyResetStaleFlag();
  __testOnlySetContinuationStartTimeout(300);
  __testOnlySetContinuationRetryBackoff(300);
  try {
    const cwd = tmpCwd();
    const ctx = await freshSession(cwd, "startup");
    pi.sent.length = 0;
    await pi.command("goal", "no-turn-start pause target — done when pinned", ctx);
    await tick();
    // Pause BEFORE the first window expires — the pause clears the watchdog.
    await pi.command("goal", "pause", ctx);
    await new Promise((resolve) => setTimeout(resolve, 700));
    assert.equal(pi.sent.length, 1, "a paused goal is never blind-retried");
    const ledger = fs.readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf8");
    assert.doesNotMatch(ledger, /continuation_retry_sent/, "no retry for a paused goal");
    assert.doesNotMatch(ledger, /continuation_start_unacknowledged/, "the watchdog was cleared with the pause");
  } finally {
    __testOnlySetContinuationStartTimeout(null);
    __testOnlySetContinuationRetryBackoff(null);
  }
});

// ────────────────────────────────────────────────────────────────────
// T5 — foreign-session tool guard (subagent ctx must not mutate state)
// ────────────────────────────────────────────────────────────────────

test("T5: mutating tools refuse a foreign (subagent) session ctx", async () => {
  const cwd = tmpCwd();
  await freshSession(cwd, "startup"); // owner = MAIN_SM (claimed in test 1)
  const foreign = makeMockCtx(cwd, { sessionManager: { name: "SUBAGENT-session-manager" } });
  for (const tool of ["complete_goal", "pause_goal", "record_goal_judgment", "list_add", "propose_loop_draft", "complete_task"]) {
    const res = await pi.runTool(tool, tool === "list_add" ? { items: ["x"] } : { id: "t-1" }, foreign);
    assert.match(res.content[0]!.text, /only the MAIN session owns/, `${tool} refuses foreign ctx`);
  }
});

test("T5: guard coverage pin — every mutating tool routes through foreignToolGuard", () => {
  // Per-tool block scan: a NEW or renamed mutating tool that forgets the
  // guard fails this pin (the audit's T5 regression shape). list_status is
  // read-only and explicitly exempt.
  const MUTATING = ["complete_goal", "pause_goal", "record_goal_judgment", "complete_task", "update_task_status", "propose_goal_draft", "propose_loop_draft", "propose_loop_refine", "list_add", "list_activate", "propose_task_list"];
  const blocks = GOAL_SRC.split("pi.registerTool(defineTool({").slice(1);
  const byName = new Map<string, string>();
  for (const block of blocks) {
    const m = block.match(/name: "([a-z_]+)"/);
    if (m) byName.set(m[1]!, block);
  }
  for (const tool of MUTATING) {
    const block = byName.get(tool);
    assert.ok(block, `tool ${tool} not found among registered tools`);
    assert.ok(block!.includes("foreignToolGuard(execCtx)"), `mutating tool ${tool} is MISSING the foreign-session guard`);
  }
  assert.ok(byName.has("list_status"), "list_status still registered");
  assert.ok(!byName.get("list_status")!.includes("foreignToolGuard"), "list_status is read-only — guard would be noise");
});

test("v0.36.3: live activity is scoped across lost results, host replacement, timestamps, timers, and pending dispatch", async () => {
  __testOnlyResetStaleFlag();
  __testOnlyResetToolActivity();
  clearContinuationTimer();
  setPendingContinuationDispatchRef(null);
  const cwd = tmpCwd();
  const first = await freshSession(cwd, "startup");
  const createdAt = new Date(Date.now() - 5_000).toISOString();
  const goal = seedGoal({ id: "activity-boundary-goal", createdAt, updatedAt: createdAt });
  seedState(cwd, { goal });
  __testOnlyLoadState(cwd);
  __testOnlyRememberCtx(first);

  // A real tool start is enough to produce WORKING while its result is lost.
  await pi.fire("tool_call", { toolName: "bash", toolCallId: "lost-activity", input: { command: "echo stale" } }, first);
  assert.equal(__testOnlyDisplayActivityFor(first as any).activity, "working");
  assert.equal((globalThis as any).inFlightToolCalls.size, 1);

  // The shutdown/rebind boundary drops both the unmatched start and any late
  // result. A replacement that is still busy must say BUSY, never WORKING.
  await pi.fire("session_shutdown", { reason: "reload" }, first);
  const replacement = makeMockCtx(cwd, { sessionManager: MAIN_SM, idle: false });
  await pi.fire("session_start", { reason: "reload" }, replacement);
  seedState(cwd, { goal });
  __testOnlyLoadState(cwd);
  __testOnlyRememberCtx(replacement);
  assert.equal((globalThis as any).inFlightToolCalls.size, 0, "session replacement clears lost tool starts");
  await pi.fire("tool_result", { toolName: "bash", toolCallId: "lost-activity", output: "late" }, replacement);
  assert.equal((globalThis as any).recentActions.length, 0, "an unmatched late result cannot repaint the successor");
  assert.equal(__testOnlyDisplayActivityFor(replacement as any).activity, "busy");

  // Keep the same scope but move its durable creation boundary after the
  // observed event. The timestamp fence must reject that old live record.
  await pi.fire("tool_call", { toolName: "read", toolCallId: "old-timestamp", input: { path: "old.md" } }, replacement);
  const future = new Date(Date.now() + 60_000).toISOString();
  seedState(cwd, { goal: { ...goal, createdAt: future, updatedAt: future } });
  __testOnlyLoadState(cwd);
  __testOnlyRememberCtx(replacement);
  assert.equal(__testOnlyDisplayActivityFor(replacement as any).activity, "awaiting-first-turn", "pre-goal timestamps do not produce WORKING");

  // Timer-backed queued work and a latched pending dispatch are both honest
  // QUEUED states, distinct from the evidence-backed WORKING state above.
  __testOnlyResetToolActivity();
  seedState(cwd, { goal });
  __testOnlyLoadState(cwd);
  const idleCtx = makeMockCtx(cwd, { sessionManager: MAIN_SM, idle: true });
  __testOnlyRememberCtx(idleCtx);
  releaseInitialSessionLoadBarrier();
  scheduleContinuation(idleCtx as any, true, 60_000);
  assert.equal(__testOnlyDisplayActivityFor(idleCtx as any).activity, "queued", "a live continuation timer is queued work");
  clearContinuationTimer();
  setPendingContinuationDispatchRef({ id: "pending-activity", sentAt: Date.now(), generation: 0, kind: "goal", goalId: goal.id, marker: "test", ownerSessionId: "main" } as any);
  assert.equal(__testOnlyDisplayActivityFor(idleCtx as any).activity, "queued", "a pending dispatch is queued work");
  setPendingContinuationDispatchRef(null);
  __testOnlyResetToolActivity();
  await pi.fire("session_shutdown", { reason: "quit" }, idleCtx);
});

test("v0.36.4: /glla resume behaviorally re-kicks an ACTIVE-but-idle goal", async () => {
  __testOnlyResetStaleFlag();
  __testOnlyResetTerminalFlags();
  clearContinuationTimer();
  setPendingContinuationDispatchRef(null);
  const cwd = tmpCwd();
  const ctx = await freshSession(cwd, "startup");
  const createdAt = new Date(Date.now() - 5_000).toISOString();
  const goal = seedGoal({
    id: "active-idle-resume-goal",
    objective: "behavioral active idle resume — done when pinned",
    createdAt,
    updatedAt: createdAt,
  });
  seedState(cwd, { goal });
  __testOnlyLoadState(cwd);
  __testOnlyRememberCtx(ctx);
  pi.sent.length = 0;

  await pi.command("glla", "resume", ctx);
  await tick();

  assert.ok(ctx.ui.matching("ACTIVE but idle — re-firing its continuation").length >= 1, "the command explains the active-idle recovery");
  assert.equal(pi.sent.length, 1, "the real command schedules one continuation");
  assert.match(pi.sent[0]!.message.content ?? "", /GOAL CHECKPOINT goalId=active-idle-resume-goal/);
  const ledger = fs.readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf8");
  assert.match(ledger, /"resume_rekick"/, "the re-kick is durable and observable");

  await pi.fire("session_shutdown", { reason: "quit" }, ctx);
  setPendingContinuationDispatchRef(null);
  clearContinuationTimer();
});

// ────────────────────────────────────────────────────────────────────
// T2 — stale send → goStaleTerminal (goal stays ACTIVE + interrupt marker)
// LATCHES the process-wide stale flag — everything below runs stale.
// ────────────────────────────────────────────────────────────────────

test("T2: a stale send on agent_end continuation → goal ACTIVE + interrupt marker + loud notify", async () => {
  __testOnlyResetStaleFlag();
  const cwd = tmpCwd();
  const ctx = await freshSession(cwd, "startup");
  await pi.command("goal", "start behavioral stale target — done when pinned", ctx);
  await tick();
  assert.equal((readState(cwd).goal as { status: string }).status, "active", "goal created and active");
  await acknowledgeLastContinuation(ctx);
  pi.sendMessageError = staleError();
  pi.sent.length = 0;
  await pi.fire("agent_end", { messages: [{ role: "assistant", content: [{ type: "text", text: "still working" }], stopReason: "end_turn" }] }, ctx);
  await tick();
  pi.sendMessageError = null; // cleanup BEFORE asserts — a failed assert must not poison later tests
  const g = readState(cwd).goal as { status: string; interruptedAt?: string; interruptedReason?: string };
  assert.equal(g.status, "active", "stale terminal keeps the goal ACTIVE (auto-resumes on restart)");
  assert.ok(g.interruptedAt, "interrupt marker set");
  assert.match(g.interruptedReason ?? "", /extension api stale/);
  assert.ok(ctx.ui.matching("restart pi").length >= 1, "loud restart guidance");
  const ledger = fs.readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf-8");
  assert.ok(ledger.includes('"extension_api_stale"'), "stale terminal ledgered");
  // v0.34.57: the chrome-bridge handle path also writes session_handle_invalidated
  // with a structured reason enum so the recovery path can pick the right strategy.
  // v0.34.75: the reason is CLASSIFIED at emission — this send-path death has no
  // lifecycle shutdown, so it is silent_handle_death (the "host session lost" class).
  assert.ok(ledger.includes('"session_handle_invalidated"'), "session_handle_invalidated ledgered alongside extension_api_stale");
  assert.match(ledger, /"session_handle_invalidated"[^}]*"reason":"silent_handle_death"/, "session_handle_invalidated carries the classified reason");
});

// ────────────────────────────────────────────────────────────────────
test("T2b: stale before compaction → no late rebind, refire, or misleading active UI", async () => {
  __testOnlyResetStaleFlag();
  __testOnlyResetTerminalFlags();
  __testOnlyResetOwnerSession();
  const cwd = tmpCwd();
  resetContinuationDispatchState(cwd);
  clearContinuationTimer();
  resetLengthContinue();
  const ctx = await freshSession(cwd, "startup");
  await pi.command("goal", "stale then compact — done when pinned", ctx);
  await tick();
  await acknowledgeLastContinuation(ctx);
  pi.sent.length = 0;
  pi.sendMessageError = staleError();
  const before = fs.readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf8");
  await pi.fire("agent_end", { messages: [{ role: "assistant", content: [{ type: "text", text: "boundary" }], stopReason: "end_turn" }] }, ctx);
  await tick();
  pi.sendMessageError = null;
  // Reproduce the field ordering: pi invalidates the extension first, then
  // emits/finishes compaction, but never delivers session_start.
  await pi.fire("session_compact", {}, ctx);
  await pi.fire("agent_end", { messages: [{ role: "assistant", content: [{ type: "text", text: "late old event" }], stopReason: "end_turn" }] }, ctx);
  await tick(2_200);
  const after = fs.readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf8");
  const g = readState(cwd).goal as { status: string; interruptedAt?: string };
  assert.equal(g.status, "active", "persisted goal remains recoverable");
  assert.equal(g.interruptedAt, undefined, "the healthy same-session contact clears the stale marker");
  assert.ok((after.match(/"extension_api_stale"/g) ?? []).length >= 1, "stale terminal is ledgered");
  assert.match(after, /"compaction_refire"/, "the healthy compact is allowed to re-arm the continuation");
  assert.doesNotMatch(after, /"compaction_grace_refire"/, "the late event does not double-schedule the grace refire");
  assert.ok(pi.sent.length >= 1, "healthy same-session recovery resumes the continuation");
  const status = ctx.ui.statuses["pi-glla"] ?? "";
  assert.doesNotMatch(status, /interrupted — stale handle/, "the healthy contact clears the stale status");
  assert.ok(ctx.ui.matching("Recovered from the stale-handle park").length >= 1, "same-session recovery is visible");
  assert.notEqual(after, before, "terminal marker and ledger are durably written");
});

// v0.34.25 — silent session swap (deathrun/hegemon/pulis "host session lost"
// park-forever): pi invalidates the extension and NEVER delivers session_start,
// but the replacement host session is alive and reaches glla through ordinary
// tool calls and events. A file-backed foreign ctx with a provably dead owner
// IS the replacement host session — absorb it. In-memory subagent workers keep
// failing closed.

test("v0.35.x: stale terminal keeps a recovery probe and self-heals without reload", async () => {
  __testOnlyResetStaleFlag();
  __testOnlyResetTerminalFlags();
  __testOnlyResetOwnerSession();
  setGlobalAutoResume(true);
  const cwd = tmpCwd();
  const ctx = await freshSession(cwd, "startup");
  try {
    await pi.command("goal", "same-process stale recovery — done when pinned", ctx);
    await tick();
    await acknowledgeLastContinuation(ctx);
    pi.sent.length = 0;
    const stale = staleError();
    pi.sendMessageError = stale;
    await pi.fire("agent_end", { messages: [{ role: "assistant", content: [{ type: "text", text: "boundary" }], stopReason: "end_turn" }] }, ctx);
    await tick();
    assert.ok((readState(cwd).goal as { interruptedAt?: string }).interruptedAt);

    // The API and captured context become healthy again in the same process;
    // no session_start/reload is delivered.
    pi.sendMessageError = null;
    pi.sessionNameError = null;
    (ctx as any).isIdle = () => true;
    (ctx as any).hasPendingMessages = () => false;
    __testOnlyHeartbeatTick();
    await tick();

    const recovered = readState(cwd).goal as { status?: string; interruptedAt?: string } | null;
    assert.equal(recovered?.status, "active");
    assert.equal(recovered?.interruptedAt, undefined, "same-process recovery clears the stale interrupt marker");
    const ledger = readLedger(cwd);
    assert.ok(ledger.some((entry) => entry.type === "stale_terminal_recovered_via_probe"));
    assert.ok(ledger.some((entry) => entry.type === "stale_self_healed"));
    assert.ok(ctx.ui.matching("Recovered from the stale-handle park").length >= 1);
    assert.ok(pi.sent.length >= 1, "healthy recovery resumes the supervised continuation without reload");
    pi.sent.length = 0;
    await pi.fire("session_shutdown", { reason: "quit" }, ctx);
  } finally {
    pi.sendMessageError = null;
    pi.sessionNameError = null;
    __testOnlyResetOwnerSession();
  }
});

test("v0.34.48: host-session loss without replacement session_start parks durably and rejects late callbacks", async () => {
  __testOnlyResetStaleFlag();
  const cwd = tmpCwd();
  const ctx = await freshSession(cwd, "startup");
  try {
    pi.sent.length = 0;
    await pi.command("goal", "orphaned host target — done when pinned", ctx);
    await tick();
    assert.equal(pi.sent.length, 1, "the host sent the initial continuation");
    const initialPrompt = pi.sent[0]!.message.content ?? "";
    await pi.fire("before_agent_start", { prompt: initialPrompt }, ctx);
    pi.sent.length = 0;

    // The lifecycle harness invalidates BOTH the captured host context and the
    // ExtensionAPI. Deliberately emit no successor session_start afterward.
    invalidateHostSession(pi, ctx);
    __testOnlyHeartbeatTick();
    // Clean the mock transport before assertions; the module's stale latch
    // remains set until the next explicit session_start, just like pi.
    pi.sendMessageError = null;
    pi.sessionNameError = null;

    const parked = readState(cwd).goal as { status: string; interruptedAt?: string; interruptedReason?: string };
    assert.equal(parked.status, "active", "orphan handling keeps the goal recoverable");
    assert.ok(parked.interruptedAt, "host loss writes a durable interruption marker");
    assert.match(parked.interruptedReason ?? "", /extension api stale/);
    const terminal = readLedger(cwd);
    assert.equal(terminal.filter((entry) => entry.type === "session_rebound").length, 1, "no replacement session_start was emitted");
    assert.equal(terminal.filter((entry) => entry.type === "extension_api_stale").length, 1, "orphan terminal is recorded once");
    assert.match(ctx.ui.statuses["pi-glla"] ?? "", /interrupted — stale handle/);
    assert.ok(((ctx.ui.widgets["pi-glla"] as string[] | undefined) ?? []).some((line) => line.includes("host session lost")), "the widget names host loss");

    const beforeLate = fs.readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf8");
    await pi.fire("session_compact", {}, ctx);
    await pi.fire("message_update", {}, ctx);
    await pi.fire("before_agent_start", { prompt: initialPrompt }, ctx);
    await pi.fire("agent_end", { messages: [{ role: "assistant", content: [{ type: "text", text: "late stale callback" }], stopReason: "end_turn" }] }, ctx);
    await tick(2_200);
    const afterLate = fs.readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf8");
    assert.equal(afterLate, beforeLate, "late callbacks from the invalidated host cannot mutate the ledger");
    assert.equal(pi.sent.length, 0, "late callbacks cannot enqueue a replacement continuation");
    assert.doesNotMatch(afterLate, /"compaction_refire"/, "late compaction cannot re-arm work");
    assert.doesNotMatch(afterLate, /"compaction_grace_refire"/, "late compaction cannot re-arm grace work");
  } finally {
    pi.sendMessageError = null;
    pi.sessionNameError = null;
  }
});

test("v0.35.x: host loss keeps durable auditor disapproval feedback visible", async () => {
  __testOnlyResetStaleFlag();
  const cwd = tmpCwd();
  seedState(cwd, {
    goal: seedGoal({
      pauseReason: "auditor disapproved",
      pauseSuggestedAction: "Inspect the required fixes, then /goal resume.",
      auditHistory: [{
        at: "2026-07-21T11:58:30Z",
        approved: false,
        disapproved: true,
        model: "auditor",
        report: "## Required fixes\\n- fix the pinned gap\\n<disapproved/>",
      }],
    }),
  });
  setGlobalAutoResume(true);
  const first = await freshSession(cwd, "startup");
  try {
    await tick();
    invalidateHostSession(pi, first);
    __testOnlyHeartbeatTick();

    const goal = readState(cwd).goal as { status: string; interruptedAt?: string; auditHistory?: Array<{ disapproved?: boolean }> };
    assert.equal(goal.status, "active", "host loss leaves the goal recoverable");
    assert.ok(goal.interruptedAt, "host loss writes the lifecycle marker");
    assert.equal(goal.auditHistory?.at(-1)?.disapproved, true, "the semantic disapproval survives the lifecycle patch");
    const widget = (first.ui.widgets["pi-glla"] as string[] | undefined) ?? [];
    const rendered = widget.join("\\n");
    assert.ok(rendered.includes("host session lost — waiting for fresh session_start"), rendered);
    assert.ok(rendered.includes("auditor disapproved — durable required fixes"), rendered);
    assert.ok(rendered.includes("fix the pinned gap"), rendered);
  } finally {
    pi.sendMessageError = null;
    pi.sessionNameError = null;
    __testOnlyResetOwnerSession();
  }
});

test("v0.35.x: full auditor reports and required-fixes tails survive lifecycle boundaries", async () => {
  const fullReport = [
    "Audit summary: inspected the pinned artifact.",
    "",
    "## Required fixes",
    "- fix the pinned gap",
    "- rerun the regression check",
    "<disapproved/>",
  ].join("\\n");
  const seedAuditedGoal = () => seedGoal({
    pauseReason: "auditor disapproved — inspect the required fixes",
    pauseSuggestedAction: "Inspect the required fixes, then /goal resume.",
    auditHistory: [{
      at: "2026-08-04T23:00:00.000Z",
      approved: false,
      disapproved: true,
      model: "test/auditor",
      report: fullReport,
    }],
  });
  const assertDurableReport = (cwd: string, ctx: MockCtx, label: string): void => {
    const goal = readState(cwd).goal as {
      auditHistory?: Array<{ report?: string; disapproved?: boolean }>;
    };
    const latest = goal.auditHistory?.at(-1);
    assert.equal(latest?.report, fullReport, `${label}: complete report survives`);
    assert.equal(latest?.disapproved, true, `${label}: semantic disapproval survives`);
    const widget = ((ctx.ui.widgets["pi-glla"] as string[] | undefined) ?? []).join("\\n");
    assert.match(widget, /fix the pinned gap/, `${label}: required-fixes tail remains visible`);
    assert.match(widget, /rerun the regression check/, `${label}: complete actionable tail remains visible`);
  };

  __testOnlyResetStaleFlag();
  __testOnlySetContinuationStartTimeout(300);
  __testOnlySetContinuationRetryBackoff(200);
  try {
    // An accepted continuation that never produces a turn-start proof must
    // update interruption metadata without dropping the settled report.
    const noStartCwd = tmpCwd();
    seedState(noStartCwd, { goal: seedAuditedGoal() });
    setGlobalAutoResume(true);
    pi.sent.length = 0;
    const noStartCtx = await freshSession(noStartCwd, "startup");
    await tick();
    await waitUntil(() => {
      try {
        return fs.readFileSync(path.join(noStartCwd, ".pi-glla", "active.jsonl"), "utf8").includes("continuation_start_unacknowledged");
      } catch {
        return false;
      }
    }, 4_000); // hardened: real-time poll under heavy CI load (2026-08-10)
    const noStartGoal = readState(noStartCwd).goal as { interruptedReason?: string };
    assert.match(noStartGoal.interruptedReason ?? "", /continuation start acknowledgement timed out/);
    assertDurableReport(noStartCwd, noStartCtx, "no-start");

    // A stale host lifecycle boundary must preserve the same report while
    // parking recovery behind an honest host-session-lost marker.
    __testOnlyResetStaleFlag();
    const staleCwd = tmpCwd();
    seedState(staleCwd, { goal: seedAuditedGoal() });
    setGlobalAutoResume(true);
    const staleCtx = await freshSession(staleCwd, "startup");
    await tick();
    invalidateHostSession(pi, staleCtx);
    __testOnlyHeartbeatTick();
    pi.sendMessageError = null;
    pi.sessionNameError = null;
    const staleGoal = readState(staleCwd).goal as { interruptedAt?: string };
    assert.ok(staleGoal.interruptedAt, "stale replacement writes a durable lifecycle marker");
    assertDurableReport(staleCwd, staleCtx, "stale replacement");

    // Finally exercise the real detached-worker result path and verify both
    // the state snapshot and append-only audit log retain the whole report.
    __testOnlyResetStaleFlag();
    const normalCwd = tmpCwd();
    const previousBinary = process.env.GLLA_PI_BINARY;
    const fakePi = writeFakeAuditor(normalCwd, "disapproved", 0, fullReport);
    process.env.GLLA_PI_BINARY = fakePi;
    try {
      const normalCtx = await freshSession(normalCwd, "startup");
      await pi.command("goal", "start normal settled audit target — done when pinned", normalCtx);
      await tick();
      await pi.runTool("complete_goal", { completionSummary: "Claim", verificationSummary: "Evidence" }, normalCtx);
      await waitUntil(() => {
        const goal = readState(normalCwd).goal as { status?: string; pendingCompletion?: unknown; auditHistory?: unknown[] } | null;
        return goal?.status === "active" && !goal.pendingCompletion && (goal.auditHistory?.length ?? 0) > 0;
      });
      assertDurableReport(normalCwd, normalCtx, "settled disapproval");
      const auditLog = fs.readFileSync(path.join(normalCwd, ".pi-glla", "audits.jsonl"), "utf8");
      assert.match(auditLog, /Audit summary: inspected the pinned artifact\./);
      assert.match(auditLog, /- rerun the regression check/);
      await pi.fire("session_shutdown", { reason: "quit" }, normalCtx);
    } finally {
      if (previousBinary === undefined) delete process.env.GLLA_PI_BINARY;
      else process.env.GLLA_PI_BINARY = previousBinary;
    }
  } finally {
    pi.sendMessageError = null;
    pi.sessionNameError = null;
    __testOnlySetContinuationStartTimeout(null);
    __testOnlySetContinuationRetryBackoff(null);
    __testOnlyResetOwnerSession();
  }
});

test("v0.34.25: silent swap — live file-backed successor is absorbed via a tool call and the work auto-resumes", async () => {
  __testOnlyResetStaleFlag();
  const cwd = tmpCwd();
  const ctx = await freshSession(cwd, "startup");
  await pi.command("goal", "swap survival — done when absorbed", ctx);
  await tick();
  await acknowledgeLastContinuation(ctx);
  pi.sent.length = 0;
  pi.sendMessageError = staleError();
  await pi.fire("agent_end", { messages: [{ role: "assistant", content: [{ type: "text", text: "boundary" }], stopReason: "end_turn" }] }, ctx);
  await tick();
  pi.sendMessageError = null;
  const parked = readState(cwd).goal as { interruptedAt?: string };
  assert.ok(parked.interruptedAt, "stale terminal parked the goal (the field state)");
  assert.equal(pi.sent.length, 0, "no sends from the dead handle");
  // pi silently swaps the session: no session_shutdown, no session_start —
  // the replacement session reaches the extension through an ordinary tool call.
  const successorCtx = makeMockCtx(cwd, {
    sessionManager: {
      name: "successor-session-manager",
      getSessionFile: () => path.join(cwd, "successor-session.jsonl"),
      getSessionId: () => "successor-1",
    },
  });
  const res = await pi.runTool("list_add", { items: ["post-swap follow-up"] }, successorCtx);
  assert.doesNotMatch(res.content[0]!.text, /only the MAIN session owns/, "successor tool call is absorbed, not refused");
  await tick(200);
  const g = readState(cwd).goal as { status: string; interruptedAt?: string };
  assert.equal(g.status, "active", "goal stays active through the absorption");
  assert.ok(!g.interruptedAt, "stale marker cleared on absorb");
  const ledger = fs.readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf8");
  assert.match(ledger, /"session_rebind_via_live_ctx"/, "absorption is ledgered loudly");
  assert.match(ledger, /"via":"tool-call"/);
  assert.ok(pi.sent.length >= 1, "one recovery continuation is scheduled after absorb");
  __testOnlyResetOwnerSession(); // restore the MAIN_SM claim invariant for later tests
});

test("v0.34.25: silent swap — in-memory (subagent) ctx is still refused and the park stays honest", async () => {
  __testOnlyResetStaleFlag();
  const cwd = tmpCwd();
  const ctx = await freshSession(cwd, "startup");
  await pi.command("goal", "swap refusal — done when refused", ctx);
  await tick();
  await acknowledgeLastContinuation(ctx);
  pi.sendMessageError = staleError();
  await pi.fire("agent_end", { messages: [{ role: "assistant", content: [{ type: "text", text: "boundary" }], stopReason: "end_turn" }] }, ctx);
  await tick();
  pi.sendMessageError = null;
  // pi-subagents workers are SessionManager.inMemory — no session file, both shapes:
  for (const sm of [{ name: "SUBAGENT-a", getSessionFile: () => undefined }, { name: "SUBAGENT-b" }]) {
    const res = await pi.runTool("complete_task", { id: "1" }, makeMockCtx(cwd, { sessionManager: sm }));
    assert.match(res.content[0]!.text, /only the MAIN session owns/, "ephemeral worker stays refused");
  }
  const g = readState(cwd).goal as { interruptedAt?: string };
  assert.ok(g.interruptedAt, "subagent ctx does not clear the park");
  const ledger = fs.readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf8");
  assert.doesNotMatch(ledger, /"session_rebind_via_live_ctx"/, "no absorption for ephemeral workers");
  __testOnlyResetOwnerSession(); // restore the MAIN_SM claim invariant for later tests
});

test("v0.34.25: the field ordering — stale before compaction, then the successor's compact event absorbs in place", async () => {
  __testOnlyResetStaleFlag();
  __testOnlyResetTerminalFlags();
  __testOnlyResetOwnerSession();
  const cwd = tmpCwd();
  const ctx = await freshSession(cwd, "startup");
  await pi.command("goal", "compact swap — done when absorbed", ctx);
  await tick();
  await acknowledgeLastContinuation(ctx);
  pi.sent.length = 0;
  pi.sendMessageError = staleError();
  await pi.fire("agent_end", { messages: [{ role: "assistant", content: [{ type: "text", text: "boundary" }], stopReason: "end_turn" }] }, ctx);
  await tick();
  pi.sendMessageError = null;
  assert.ok((readState(cwd).goal as { interruptedAt?: string }).interruptedAt, "parked (T2b state)");
  // pi finishes the compaction and delivers session_compact on the REPLACEMENT
  // session — the classic post-compaction contact in the field.
  const successorCtx = makeMockCtx(cwd, {
    sessionManager: {
      name: "successor-session-manager",
      getSessionFile: () => path.join(cwd, "successor-session.jsonl"),
      getSessionId: () => "successor-2",
    },
  });
  await pi.fire("session_compact", {}, successorCtx);
  await tick(200);
  const g = readState(cwd).goal as { status: string; interruptedAt?: string };
  assert.equal(g.status, "active");
  assert.ok(!g.interruptedAt, "compact from the live successor clears the park");
  const ledger = fs.readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf8");
  assert.match(ledger, /"session_rebind_via_live_ctx"/);
  assert.match(ledger, /"via":"(?:rememberCtx|session_compact)"/, "the successor contact is ledgered at its first live event");
  assert.match(ledger, /"session_compact"|"session_rebind_via_live_ctx"/, "the successor contact is treated as legitimate live host activity");
  assert.ok(pi.sent.length >= 1, "recovery continuation scheduled after the compact absorb");
  __testOnlyResetOwnerSession(); // restore the MAIN_SM claim invariant for later tests
});

test("v0.34.25: dead owner + ephemeral ctx cannot claim the plane (subagent lockout fix)", async () => {
  __testOnlyResetStaleFlag();
  const cwd = tmpCwd();
  const ctx = await freshSession(cwd, "startup");
  await pi.command("goal", "claim guard — done when pinned", ctx);
  await tick();
  // The owner quietly dies (no stale terminal yet — the heartbeat has not
  // probed). Old code rebound the plane to ANY arriving ctx — a subagent
  // worker claiming it would lock the real host out of its own plane.
  (ctx as any).isIdle = () => { throw new Error("This extension ctx is stale after session replacement or reload."); };
  await pi.command("goal", "status", makeMockCtx(cwd, { sessionManager: { name: "SUBAGENT-worker" } }));
  // The real successor must STILL be absorbable — if the subagent claimed the
  // plane, the successor would now be refused as foreign.
  const successorCtx = makeMockCtx(cwd, {
    sessionManager: {
      name: "successor-session-manager",
      getSessionFile: () => path.join(cwd, "successor-session.jsonl"),
      getSessionId: () => "successor-3",
    },
  });
  const res = await pi.runTool("list_add", { items: ["post-swap follow-up"] }, successorCtx);
  assert.doesNotMatch(res.content[0]!.text, /only the MAIN session owns/, "subagent did not claim the plane; the host successor absorbs");
  const ledger = fs.readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf8");
  assert.match(ledger, /"session_rebind_via_live_ctx"/);
  __testOnlyResetOwnerSession(); // restore the MAIN_SM claim invariant for later tests
});

// v0.34.27 — every real successor contact can rebind after a stale terminal.

test("v0.34.27: stale host recovery absorbs the first replacement contact across lifecycle and stream boundaries", async () => {
  const contacts: Array<{ via: string; event: string; payload: unknown }> = [
    { via: "message_start", event: "message_start", payload: { message: { role: "user" } } },
    { via: "tool_result", event: "tool_result", payload: { toolName: "read", output: "ok" } },
    { via: "tool_call", event: "tool_call", payload: { toolName: "read", input: {} } },
    { via: "before_agent_start", event: "before_agent_start", payload: { prompt: "[GOAL CHECKPOINT]" } },
    { via: "message_update", event: "message_update", payload: {} },
    { via: "agent_start", event: "agent_start", payload: {} },
    { via: "turn_start", event: "turn_start", payload: {} },
  ];
  for (const [index, contact] of contacts.entries()) {
    __testOnlyResetStaleFlag();
    __testOnlyResetTerminalFlags();
    __testOnlyResetOwnerSession();
    const cwd = tmpCwd();
    const ctx = await freshSession(cwd, "startup");
    await pi.command("goal", `successor contact ${index} — done when absorbed`, ctx);
    await tick();
    await acknowledgeLastContinuation(ctx);
    pi.sent.length = 0;
    pi.sendMessageError = staleError();
    await pi.fire("agent_end", { messages: [{ role: "assistant", content: [{ type: "text", text: "boundary" }], stopReason: "end_turn" }] }, ctx);
    await tick();
    pi.sendMessageError = null;
    const successorCtx = makeMockCtx(cwd, {
      sessionManager: {
        name: `successor-${contact.via}`,
        getSessionFile: () => path.join(cwd, `${contact.via}.jsonl`),
        getSessionId: () => `successor-${contact.via}`,
      },
    });
    await pi.fire(contact.event, contact.payload, successorCtx);
    await tick(200);
    const g = readState(cwd).goal as { status: string; interruptedAt?: string };
    assert.equal(g.status, "active", `${contact.via}: goal remains supervised after absorption`);
    assert.equal(g.interruptedAt, undefined, `${contact.via}: stale marker is cleared`);
    assert.ok(pi.sent.length >= 1, `${contact.via}: exactly a recovery path, not a permanent park`);
    const ledger = fs.readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf8");
    assert.match(ledger, new RegExp(`\\"via\\":\\"(?:${contact.via}|rememberCtx)\\"`), `${contact.via}: rebind is ledgered`);
  }
  __testOnlyResetOwnerSession();
});

test("v0.34.27: plain startup from a dead file-backed successor is not rejected as a subagent", async () => {
  __testOnlyResetStaleFlag();
  __testOnlyResetOwnerSession();
  setGlobalAutoResume(true);
  const cwd = tmpCwd();
  const ctx = await freshSession(cwd, "startup");
  await pi.command("goal", "startup successor — done when rebound", ctx);
  await tick();
  // Simulate pi replacing the host before it emits the successor's ordinary
  // startup event. The old manager is dead, but no stale terminal was needed
  // to make the lifecycle boundary real.
  (ctx as any).isIdle = () => { throw staleError(); };
  const subagentCtx = makeMockCtx(cwd, { sessionManager: { name: "SUBAGENT-startup" } });
  await pi.fire("session_start", { reason: "startup" }, subagentCtx);
  assert.ok((readState(cwd).goal as { status: string }).status === "active", "subagent startup cannot consume the host recovery boundary");
  const successorCtx = makeMockCtx(cwd, {
    sessionManager: {
      name: "startup-successor",
      getSessionFile: () => path.join(cwd, "startup-successor.jsonl"),
      getSessionId: () => "startup-successor-1",
    },
  });
  await pi.fire("session_start", { reason: "startup" }, successorCtx);
  await tick(200);
  const g = readState(cwd).goal as { status: string; interruptedAt?: string };
  assert.equal(g.status, "active", "the file-backed host successor rebinds in place");
  assert.equal(g.interruptedAt, undefined);
  assert.ok(pi.sent.length >= 1, "rebound session can continue the goal");
  const ledger = fs.readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf8");
  assert.match(ledger, /session_rebind_without_shutdown/);
  __testOnlyResetOwnerSession();
});

// v0.34.27 — output-token-limit exhaustion: durable explicit failure state.

test("v0.34.26: repeated output-token truncation pauses the goal durably with re-scope guidance and a fresh resume budget", async () => {
  __testOnlyResetStaleFlag();
  resetLengthContinue();
  const cwd = tmpCwd();
  const ctx = await freshSession(cwd, "startup");
  await pi.command("goal", "chunked work — done when durable", ctx);
  await tick();
  await acknowledgeLastContinuation(ctx);
  pi.sent.length = 0;
  const lengthEnd = { messages: [{ role: "assistant", content: [{ type: "text", text: "partial artifact…" }], stopReason: "length" }] };
  for (let i = 0; i < 3; i++) {
    await pi.fire("agent_end", lengthEnd, ctx);
    await tick();
    await acknowledgeLastContinuation(ctx);
  }
  assert.equal(pi.sent.length, 3, "three auto-continues fire before the cap");
  await pi.fire("agent_end", lengthEnd, ctx);
  await tick();
  const g = readState(cwd).goal as { status: string; pauseKind?: string; pauseReason?: string; pauseSuggestedAction?: string };
  assert.equal(g.status, "paused", "goal pauses durably on exhaustion — no green-active idle");
  assert.equal(g.pauseKind, "error");
  assert.match(g.pauseReason ?? "", /output-token limit — 3 responses in a row were truncated mid-artifact/);
  assert.match(g.pauseSuggestedAction ?? "", /\/goal resume/);
  assert.equal(pi.sent.length, 3, "no fourth auto-continue fires");
  const ledger = fs.readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf8");
  assert.match(ledger, /"length_continue_exhausted"/, "exhaustion is ledgered");
  // Explicit recovery gets a fresh truncation budget (the sticky gaveUp flag
  // must not make the resumed turn silently dead on the first truncation):
  await pi.command("goal", "resume", ctx);
  await tick();
  const afterResume = pi.sent.length;
  await acknowledgeLastContinuation(ctx);
  await pi.fire("agent_end", lengthEnd, ctx);
  await tick();
  assert.ok(pi.sent.length > afterResume, "a truncation after resume fires an auto-continue again");
});

test("v0.34.26: output-token-limit provider errors pause with the named wall, not generic provider-error text", async () => {
  __testOnlyResetStaleFlag();
  resetLengthContinue();
  const cwd = tmpCwd();
  const ctx = await freshSession(cwd, "startup");
  await pi.command("goal", "wall classification — done when named", ctx);
  await tick();
  const errEnd = { messages: [{ role: "assistant", content: [{ type: "text", text: "provider stopped" }], errorMessage: "Model stopped because it reached the maximum output-token limit", stopReason: "error" }] };
  for (let i = 0; i < 5; i++) {
    await pi.fire("agent_end", errEnd, ctx);
    await tick(50);
  }
  const g = readState(cwd).goal as { status: string; pauseKind?: string; pauseReason?: string; pauseResumeAt?: string; pauseSuggestedAction?: string };
  assert.equal(g.status, "paused", "deterministic wall pauses the goal");
  assert.equal(g.pauseKind, "error");
  assert.match(g.pauseReason ?? "", /output-token limit — the provider rejected \d+ overlong responses/);
  assert.doesNotMatch(g.pauseReason ?? "", /5 consecutive errors/, "generic provider-error text replaced");
  assert.ok(!g.pauseResumeAt, "no wait-timer — blind retries never help a deterministic wall");
  assert.match(g.pauseSuggestedAction ?? "", /Re-scope the work into smaller pieces/);
});

// T1 — stale paths on the two creation entry points (flag latched from T2)
// ────────────────────────────────────────────────────────────────────

test("T1a: stale Confirm in propose_goal_draft → NOT-a-rejection guidance, no goal created", async () => {
  __testOnlyResetStaleFlag();
  const cwd = tmpCwd();
  const ctx = await freshSession(cwd, "startup");
  await pi.command("goal", "", ctx); // no args → drafting mode (seed send is a no-op now: stale)
  await pi.fire("message_start", { message: { role: "user" } }, ctx); // the seed itself (skipped)
  await pi.fire("message_start", { message: { role: "user" } }, ctx); // a real reply (counted)
  ctx.ui.customImpl = async () => {
    throw staleError();
  };
  ctx.ui.confirmImpl = async () => {
    throw staleError();
  };
  const res = await pi.runTool("propose_goal_draft", { objective: "drafted objective — done when x", verificationContract: "x" }, ctx);
  assert.match(res.content[0]!.text, /NOT a rejection — do NOT refine or re-propose/);
  assert.match(res.content[0]!.text, /Wait for a fresh session_start/);
  assert.equal(readState(cwd).goal, null, "nothing was created — and nothing was REFUSED either");
});

test("T1b: stale /goal start → goal persisted to .pi-glla with honest notify", async () => {
  __testOnlyResetStaleFlag();
  __testOnlyResetTerminalFlags();
  __testOnlyResetOwnerSession();
  const cwd = tmpCwd();
  const ctx = await freshSession(cwd, "reload");
  const stale = staleError();
  pi.sessionNameError = stale; // the entry probe trips on getSessionName
  pi.sendMessageError = stale; // the created goal's continuation also sees the dead API
  await pi.command("goal", "start stale-created objective — done when pinned", ctx);
  pi.sessionNameError = null; // cleanup BEFORE asserts
  pi.sendMessageError = null;
  const g = readState(cwd).goal as { status: string; interruptedAt?: string; interruptedReason?: string } | null;
  assert.ok(g, "goal persisted despite the doomed handle");
  assert.equal(g!.status, "active");
  assert.ok(g!.interruptedAt, "a stale entry marks the newly created goal for fresh-session recovery");
  assert.equal(g!.interruptedReason, "created in a stale session");
  assert.ok(ctx.ui.matching("stale").length >= 1, "honest stale-state notify, not a 'starting now' lie");
});

test("drafting state is not left behind by a stale seed, and old confirmations cannot mutate a replacement session", async () => {
  __testOnlyResetStaleFlag();
  pi.sendMessageError = null;
  pi.sessionNameError = null;
  const listCwd = tmpCwd();
  const listCtx = await freshSession(listCwd, "startup");
  pi.sessionNameError = staleError();
  pi.sendMessageError = staleError();
  await pi.command("list", "", listCtx);
  pi.sessionNameError = null;
  pi.sendMessageError = null;
  __testOnlyResetStaleFlag();
  const added = await pi.runTool("list_add", { items: ["fresh list item — done when pinned"] }, listCtx);
  assert.match(added.content[0]!.text, /item\(s\) added|item.*active/i, "a stale seed did not leave the list-drafting mutation gate latched");
  await pi.command("list", "cancel", listCtx);

  const goalCwd = tmpCwd();
  const goalCtx = await freshSession(goalCwd, "startup");
  pi.sessionNameError = staleError();
  pi.sendMessageError = staleError();
  await pi.command("goal", "", goalCtx);
  pi.sessionNameError = null;
  pi.sendMessageError = null;
  __testOnlyResetStaleFlag();
  const staleProposal = await pi.runTool("propose_goal_draft", { objective: "old draft — done when pinned", verificationContract: "pinned" }, goalCtx);
  assert.match(staleProposal.content[0]!.text, /Not in goal drafting mode/, "a stale goal seed does not leave the interview floor active");

  const confirmCwd = tmpCwd();
  const first = await freshSession(confirmCwd, "startup");
  await pi.command("goal", "", first);
  await pi.fire("message_start", { message: { role: "user" } }, first);
  await pi.fire("message_start", { message: { role: "user" } }, first);
  let resolveConfirm!: (choice: string) => void;
  first.ui.customImpl = () => new Promise<string>((resolve) => { resolveConfirm = resolve; });
  const pending = pi.runTool("propose_goal_draft", { objective: "late draft — done when pinned", verificationContract: "pinned" }, first);
  await tick(20);
  const replacement = makeMockCtx(confirmCwd, {
    sessionManager: {
      name: "draft-replacement",
      getSessionFile: () => path.join(confirmCwd, "draft-replacement.jsonl"),
      getSessionId: () => "draft-replacement-1",
    },
  });
  await pi.fire("session_start", { reason: "reload", previousSessionFile: path.join(confirmCwd, "old.jsonl") }, replacement);
  resolveConfirm("Yes");
  const late = await pending;
  assert.match(late.content[0]!.text, /session replacement|NOT a rejection/i, "a late old-session confirmation is not presented as a user rejection");
  assert.equal(readState(confirmCwd).goal, null, "late confirmation cannot create a goal in the replacement session");
  first.ui.selectImpl = undefined;
  __testOnlyResetOwnerSession();
});

// ── v0.28.12: auto-accept escape hatch in draft dialogs ────────────────
// The polis incident: a 14-item batch Confirm gave no hint that /glla
// autoaccept=on existed. Every draft-class dialog is now a 3-choice
// select; the ALWAYS choice persists project autoAcceptDrafts and accepts.

test("auto-accept escape hatch: ALWAYS choice persists project autoAcceptDrafts and accepts the draft", async () => {
  __testOnlyResetStaleFlag();
  const cwd = tmpCwd();
  const ctx = await freshSession(cwd, "startup");
  await pi.command("goal", "", ctx); // drafting mode
  await pi.fire("message_start", { message: { role: "user" } }, ctx);
  await pi.fire("message_start", { message: { role: "user" } }, ctx); // floor satisfied
  let selectTitle = "";
  ctx.ui.customImpl = async () => {
    return "Yes — and always auto-accept drafts (sets autoAcceptDrafts for this project)";
  };
  const res = await pi.runTool("propose_goal_draft", { objective: "hatch objective — done when pinned", verificationContract: "pinned" }, ctx);
  ctx.ui.customImpl = undefined; // cleanup BEFORE asserts
  const lastDialog = __testOnlyLastConfirmDialog();
  assert.ok(lastDialog, "the custom path captured the rendered dialog");
  selectTitle = lastDialog!.title;
  assert.match(res.content[0]!.text, /Goal activated|activated|Begin work/i, "draft accepted, not rejected");
  assert.match(selectTitle, /Confirm goal/, "the dialog rendered as the goal confirm");
  const g = readState(cwd).goal as { status: string } | null;
  assert.ok(g && g.status === "active", "goal created by the ALWAYS choice");
  const onDisk = JSON.parse(fs.readFileSync(path.join(cwd, ".pi-glla", "settings.json"), "utf-8")) as { autoAcceptDrafts?: boolean };
  assert.equal(onDisk.autoAcceptDrafts, true, "persisted to PROJECT settings (survives restart, project-scoped)");
  assert.ok(ctx.ui.matching("auto-accept ON").length >= 1, "loud notify names the undo path");
});

test("escape hatch: a later draft skips the dialog entirely once autoAcceptDrafts landed", async () => {
  __testOnlyResetStaleFlag();
  const cwd = tmpCwd();
  fs.mkdirSync(path.join(cwd, ".pi-glla"), { recursive: true });
  fs.writeFileSync(path.join(cwd, ".pi-glla", "settings.json"), JSON.stringify({ autoAcceptDrafts: true }));
  const ctx = await freshSession(cwd, "startup");
  await pi.command("goal", "", ctx);
  await pi.fire("message_start", { message: { role: "user" } }, ctx);
  let selectCalled = false;
  ctx.ui.selectImpl = async () => { selectCalled = true; return "No"; };
  const res = await pi.runTool("propose_goal_draft", { objective: "second objective — done when pinned", verificationContract: "pinned" }, ctx);
  ctx.ui.selectImpl = undefined;
  assert.equal(selectCalled, false, "no dialog once the setting is on");
  assert.match(res.content[0]!.text, /activated|Begin work/i);
  assert.ok(ctx.ui.matching("auto-accepted").length >= 1, "the auto-accept notify says why");
});

test("source pin: all five draft-class dialogs route through confirmDraft with the 3-choice ALWAYS option", () => {
  const sites = ["Confirm list batch", "Confirm list item", "Confirm goal", "Confirm loop", "Confirm loop spec refinement", "Confirm task list"];
  for (const s of sites) assert.ok(GOAL_SRC.includes(s), `dialog exists: ${s}`);
  const callsites = GOAL_SRC.split("confirmDraft(").length - 1;
  assert.ok(callsites >= 6, `helper + 5 call sites (got ${callsites})`);
  assert.match(GOAL_SRC, /Yes — and always auto-accept drafts \(sets autoAcceptDrafts for this project\)/);
  assert.match(GOAL_SRC, /saveSettings\("project", ctx\.cwd, \{ autoAcceptDrafts: true \}\)/);
  assert.match(GOAL_SRC, /if \(isStaleApiError\(err\)\) return "stale";/, "stale fallback preserved inside the helper");
});

// ────────────────────────────────────────────────────────────────────
// 429-exemption: provider-error turns must NOT feed the stall watchdog
// (endless-td 2026-07-28: 4 MiniMax-M3 429s paused a healthy goal)
// ────────────────────────────────────────────────────────────────────

test("quota error turns enter durable main-model recovery instead of a resend storm", async () => {
  __testOnlyResetStaleFlag();
  const cwd = tmpCwd();
  const ctx = await freshSession(cwd, "startup");
  await pi.command("goal", "start behavioral 429 target — done when pinned", ctx);
  await tick();
  assert.equal((readState(cwd).goal as { status: string }).status, "active", "goal created and active");
  const rawProviderWall = '429 {"error":{"message":"Token Plan rate limit reached: upgrade your Token Plan"},"request_id":"main-abc123"}';
  const errTurn = { messages: [{ role: "assistant", content: [], stopReason: "error", errorMessage: rawProviderWall }] };
  for (let i = 0; i < 3; i++) {
    await pi.fire("agent_end", errTurn, ctx);
    await tick();
  }
  const snapshot = readState(cwd) as { goal: { status: string; pauseReason?: string; providerErrorDiagnostic?: string }; mainModelRecovery?: { retryAt?: string } };
  assert.equal(snapshot.goal.status, "paused", "a quota wall pauses into a durable wait, not blind re-sends");
  assert.match(snapshot.goal.pauseReason ?? "", /main model recovery/);
  assert.doesNotMatch(snapshot.goal.pauseReason ?? "", /429|Token Plan|main-abc123/, "main recovery pause copy is sanitized");
  assert.match(snapshot.goal.providerErrorDiagnostic ?? "", /Token Plan/);
  assert.ok(snapshot.mainModelRecovery?.retryAt, "recovery probe time persisted");
  const userSurface = ctx.ui.matching("Main model recovery").map((notice) => notice.message).join("\\n");
  assert.doesNotMatch(userSurface, /429|Token Plan|main-abc123/, "main recovery notifications stay sanitized");
  const ledger = fs.readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf-8");
  assert.ok(ledger.includes('"main_model_recovery_wait"'), "recovery wait ledgered");
  assert.match(ledger, /Token Plan/, "raw provider diagnostics remain in durable state/ledger");
});

test("main-model recovery external notices are deduplicated per provider episode", async () => {
  __testOnlyResetStaleFlag();
  const cwd = tmpCwd();
  const ctx = await freshSession(cwd, "startup");
  await pi.command("goal", "external notice dedup target — done when pinned", ctx);
  await tick();
  const raw = '429 {"error":{"message":"Token Plan rate limit reached"},"requestId":"req-aaa"}';
  const errTurn = { messages: [{ role: "assistant", content: [], stopReason: "error", errorMessage: raw }] };
  await pi.fire("agent_end", errTurn, ctx);
  await tick();
  const calls: string[] = [];
  pi.execHandler = async (_cmd, args) => {
    if (args[1] === "-c") calls.push(args[2] ?? "");
    return { code: 0, stdout: "/usr/bin/notify-send\n", stderr: "" };
  };
  fs.writeFileSync(path.join(cwd, ".pi-glla", "settings.json"), JSON.stringify({ notifyCmd: "notify-send $1" }));
  const before = calls.length;
  await pi.fire("agent_end", { ...errTurn, messages: [{ ...errTurn.messages[0], errorMessage: raw.replace("req-aaa", "req-bbb") }] }, ctx);
  await tick();
  const state = readState(cwd) as { mainModelRecovery?: { recoveryNoticeKeys?: string[] } };
  assert.equal(state.mainModelRecovery?.recoveryNoticeKeys?.filter((key) => key.endsWith(":external-wait")).length, 1);
  assert.equal(calls.length - before, 0, "the second recovery wait does not invoke the external notifier");
  assert.ok(ctx.ui.notifies.some((notice) => notice.message.includes("Main model recovery")), "the in-session warning remains visible");
  pi.execHandler = null;
});

test("request-rate prose uses the generic fallback chain", async () => {
  __testOnlyResetStaleFlag();
  const cwd = tmpCwd();
  setGlobalSettings({ mainModelFallbacks: ["provider/backup"], aggressiveMode: false });
  const ctx = await freshSession(cwd, "startup");
  (ctx as any).modelRegistry = { find: (provider: string, id: string) => ({ provider, id }), hasConfiguredAuth: () => true };
  await pi.command("goal", "request-rate stays current — done when pinned", ctx);
  await tick();
  const before = readLedger(cwd).filter((entry) => entry.type === "main_model_failover").length;
  await pi.fire("agent_end", { messages: [{ role: "assistant", content: [], stopReason: "error", errorMessage: "request rate exceeded" }] }, ctx);
  await tick();
  assert.equal(readLedger(cwd).filter((entry) => entry.type === "main_model_failover").length, before + 1);
  assert.equal(readState(cwd).mainModelRecovery?.quotaSignal, undefined);
});

test("explicit 429-shaped errors use the generic fallback chain", async () => {
  __testOnlyResetStaleFlag();
  const cwd = tmpCwd();
  setGlobalSettings({ mainModelFallbacks: ["provider/backup"], aggressiveMode: false });
  const ctx = await freshSession(cwd, "startup");
  (ctx as any).modelRegistry = { find: (provider: string, id: string) => ({ provider, id }), hasConfiguredAuth: () => true };
  await pi.command("goal", "429 keeps current model — done when pinned", ctx);
  await tick();
  const before = readLedger(cwd).filter((entry) => entry.type === "main_model_failover").length;
  await pi.fire("agent_end", { messages: [{ role: "assistant", content: [], stopReason: "error", statusCode: 429, errorMessage: "too many requests" }] }, ctx);
  await tick();
  assert.equal(readLedger(cwd).filter((entry) => entry.type === "main_model_failover").length, before + 1);
  assert.equal(readState(cwd).mainModelRecovery?.quotaSignal, undefined);
});

test("a successful core retry clears generic provider recovery and resumes the parked goal", async () => {
  __testOnlyResetStaleFlag();
  const cwd = tmpCwd();
  const ctx = await freshSession(cwd, "startup");
  await pi.command("goal", "start recovery resume target — done when pinned", ctx);
  await tick();
  const errTurn = { messages: [{ role: "assistant", content: [], stopReason: "error", statusCode: 429, errorMessage: "limit exceeded" }] };
  await pi.fire("agent_end", errTurn, ctx); await tick();
  const parked = readState(cwd) as {
    goal: { status: string; pauseKind?: string; objective?: string; pauseReason?: string; pauseSuggestedAction?: string };
    mainModelRecovery?: { kind?: string; quotaSignal?: string; retryAt?: string };
  };
  const objective = parked.goal.objective;
  assert.equal(parked.goal.status, "paused");
  assert.equal(parked.goal.pauseKind, "wait");
  assert.equal(parked.mainModelRecovery?.kind, "goal", "recovery owner remains the goal");
  assert.equal(parked.mainModelRecovery?.quotaSignal, undefined, "provider wording is not persisted as a policy signal");
  assert.ok(parked.mainModelRecovery?.retryAt, "bounded provider retry is persisted");
  const retryMs = Date.parse(parked.mainModelRecovery!.retryAt!) - Date.now();
  assert.ok(retryMs > 0 && retryMs <= 5_500, `first provider retry is bounded: ${retryMs}ms`);
  assert.match(parked.goal.pauseReason ?? "", /main model recovery/);
  assert.doesNotMatch(`${parked.goal.pauseReason} ${parked.goal.pauseSuggestedAction}`, /quota exhausted|quota wall|Token Plan|429|rate_limit_error/i, "rate-limit display copy does not claim quota exhaustion or leak the provider payload");
  const hourly = readLedger(cwd).find((entry) => entry.type === "hourly_probe_scheduled");
  assert.ok(hourly, "the hourly reset probe is durably scheduled");
  const fireAt = new Date(String(hourly!.value.fireAt));
  assert.equal(fireAt.getMinutes(), 0, "the hourly retry uses the hourly slot");
  assert.equal(fireAt.getSeconds(), 30, "the reset probe waits for the provider's post-hour skew window");
  assert.equal(ctx.ui.matching("429").length, 0, "notifications never show the raw 429");
  assert.equal(ctx.ui.matching("Token Plan").length, 0, "notifications never claim Token Plan exhaustion");
  assert.ok(parked.mainModelRecovery, "the test starts from a durable recovery wait");

  // Rebind the real orchestrator to the same file-backed workspace before
  // resuming. A provider wall must survive reload without losing the
  // objective or turning into an account/quota claim.
  const reloaded = await freshSession(cwd, "startup");
  await tick();
  const restored = readState(cwd) as { goal: { status: string; objective?: string; pauseReason?: string }; mainModelRecovery?: { quotaSignal?: string; retryAt?: string } };
  assert.equal(restored.goal.status, "paused", "reload keeps the rate-limit recovery parked");
  assert.equal(restored.goal.objective, objective, "reload preserves the saved objective");
  assert.equal(restored.mainModelRecovery?.quotaSignal, undefined, "reload preserves generic recovery without a quota signal");
  assert.doesNotMatch(`${restored.goal.pauseReason} ${reloaded.ui.notifies.map((notice) => notice.message).join("\\n")}`, /429|quota exhausted|Token Plan|rate_limit_error/i);

  const success = { messages: [{ role: "assistant", content: [{ type: "text", text: "recovered" }], stopReason: "end_turn" }] };
  await pi.fire("agent_end", success, reloaded);
  await tick(350);
  const recovered = readState(cwd) as { goal: { status: string; pauseReason?: string; objective?: string }; mainModelRecovery?: unknown };
  assert.equal(recovered.goal.status, "active", "a successful provider retry must not leave the goal parked");
  assert.equal(recovered.goal.pauseReason, undefined);
  assert.equal(recovered.goal.objective, objective, "the saved objective remains resumable across the rate-limit recovery");
  assert.equal(recovered.mainModelRecovery, undefined);
  assert.match(fs.readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf-8"), /"main_model_recovered".*"resumed":"goal"/);
});

test("v0.35.x: a successful main-model recovery gives a parked audit its one automatic retry", async () => {
  __testOnlyResetStaleFlag();
  const cwd = tmpCwd();
  const fakePi = writeFakeAuditor(cwd, "disapproved", 350);
  const previous = process.env.GLLA_PI_BINARY;
  process.env.GLLA_PI_BINARY = fakePi;
  seedState(cwd, {
    goal: seedGoal({
      status: "paused",
      pauseKind: "blocked",
      pauseReason: "completion audit blocked — no verdict: auditor infrastructure",
      pendingCompletion: {
        completionSummary: "The parked claim waits for a healthy recovery.",
        verificationSummary: "The detached auditor must receive one fresh attempt.",
        at: new Date().toISOString(),
        phase: "recovery-pending",
        attemptId: "parked-before-main-recovery",
      },
    }),
    mainModelRecovery: {
      primary: "mock/provider-model",
      active: "mock/provider-model",
      attempted: ["mock/provider-model"],
      attempts: 1,
      reason: "provider recovery",
      firstFailureAt: new Date().toISOString(),
      autoRetryUntil: new Date(Date.now() + 60_000).toISOString(),
      kind: "goal",
    },
  } as unknown as Parameters<typeof seedState>[1]);
  try {
    const ctx = await freshSession(cwd, "startup");
    assert.equal((readState(cwd).goal as { status?: string }).status, "paused", "cold startup keeps the parked claim held");
    mainModelRecoverySucceeded(ctx as unknown as Parameters<typeof mainModelRecoverySucceeded>[0]);
    await waitUntil(() => readLedger(cwd).some((entry) => entry.type === "audit_recovery_started"));
    const started = readState(cwd).goal as {
      status?: string;
      pendingCompletion?: { phase?: string; automaticRecoveryAttempted?: boolean; automaticRecoveryGeneration?: number };
    } | null;
    assert.equal(started?.status, "auditing");
    assert.equal(started?.pendingCompletion?.phase, "running");
    assert.equal(started?.pendingCompletion?.automaticRecoveryAttempted, true);
    assert.equal(typeof started?.pendingCompletion?.automaticRecoveryGeneration, "number");
    await waitUntil(() => {
      const settled = readState(cwd).goal as { status?: string; pendingCompletion?: unknown } | null;
      return settled?.status === "active" && !settled.pendingCompletion;
    });
    await pi.fire("session_shutdown", { reason: "quit" }, ctx);
  } finally {
    pi.sendMessageError = null;
    pi.sessionNameError = null;
    __testOnlyResetOwnerSession();
    if (previous === undefined) delete process.env.GLLA_PI_BINARY;
    else process.env.GLLA_PI_BINARY = previous;
  }
});

test("a user-aborted agent_end does not falsely clear main-model recovery", async () => {
  __testOnlyResetStaleFlag();
  const cwd = tmpCwd();
  const ctx = await freshSession(cwd, "startup");
  await pi.command("goal", "abort recovery target — done when pinned", ctx);
  await tick();
  await pi.fire("agent_end", { messages: [{ role: "assistant", content: [], stopReason: "error", errorMessage: "429 rate limit" }] }, ctx);
  await tick();
  const before = readState(cwd) as { mainModelRecovery?: unknown; goal?: { status?: string } };
  assert.ok(before.mainModelRecovery, "the provider failure created durable recovery");
  await pi.fire("agent_end", { messages: [{ role: "assistant", content: [], stopReason: "aborted" }] }, ctx);
  await tick();
  const after = readState(cwd) as { mainModelRecovery?: unknown; goal?: { status?: string } };
  assert.ok(after.mainModelRecovery, "Escape/user abort does not discard the retry plan");
  assert.equal(after.goal?.status, "paused");
});

test("recoverable error turns enter generic recovery before stall accounting", async () => {
  __testOnlyResetStaleFlag();
  const cwd = tmpCwd();
  const ctx = await freshSession(cwd, "startup");
  await pi.command("goal", "start behavioral mixed target — done when pinned", ctx);
  await tick();
  const errTurn = { messages: [{ role: "assistant", content: [], stopReason: "error", errorMessage: "500 upstream" }] };
  await pi.fire("agent_end", errTurn, ctx); await tick();
  const snapshot = readState(cwd) as { goal: { status: string; pauseKind?: string; pauseReason?: string }; mainModelRecovery?: unknown };
  assert.equal(snapshot.goal.status, "paused", "recoverable errors are parked by the generic recovery envelope");
  assert.equal(snapshot.goal.pauseKind, "wait");
  assert.match(snapshot.goal.pauseReason ?? "", /main model recovery/);
  assert.ok(snapshot.mainModelRecovery, "the retry plan is durable before stall accounting");
});

test("explicit prompt-policy rejection pauses the owning goal without retrying", async () => {
  __testOnlyResetStaleFlag();
  __testOnlyResetTerminalFlags();
  const cwd = tmpCwd();
  const ctx = await freshSession(cwd, "startup");
  let aborts = 0;
  ctx.abort = () => { aborts++; };
  await pi.command("goal", "start prompt-policy target — done when pinned", ctx);
  await tick();
  const sentBefore = pi.sent.length;

  try {
    await pi.fire("agent_end", {
      messages: [{ role: "assistant", content: [], stopReason: "error", errorMessage: "HTTP 500 — Codex error event: invalid prompt" }],
    }, ctx);
    await tick();
    await pi.fire("agent_settled", {}, ctx);
    await tick(250);

    const snapshot = readState(cwd) as {
      goal?: { status?: string; pauseKind?: string; pauseResumeAt?: string; pauseReason?: string; pauseSuggestedAction?: string; providerErrorDiagnostic?: string };
      mainModelRecovery?: unknown;
    };
    assert.equal(snapshot.mainModelRecovery, undefined);
    assert.equal(snapshot.goal?.status, "paused");
    assert.equal(snapshot.goal?.pauseKind, "error");
    assert.equal(snapshot.goal?.pauseResumeAt, undefined);
    assert.match(snapshot.goal?.pauseReason ?? "", /policy violation/);
    assert.doesNotMatch(snapshot.goal?.pauseReason ?? "", /Codex|invalid prompt/i);
    assert.match(snapshot.goal?.providerErrorDiagnostic ?? "", /Codex error event: invalid prompt/);
    assert.match(snapshot.goal?.pauseSuggestedAction ?? "", /change the objective or prompt/i);
    const ledger = fs.readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf8");
    assert.match(ledger, /main_model_prompt_policy_terminal/);
    assert.doesNotMatch(ledger, /main_model_recovery_wait/);
    assert.equal(isProviderRetryPending(), false);
    assert.equal(pendingContinuationDispatchRef(), null);
    assert.equal(continuationTimerPending(), false);
    assert.equal(continuationDispatchStoodDownRef(), true);
    assert.equal(aborts, 1);
    assert.equal(pi.sent.length, sentBefore);

    __testOnlyLoadState(cwd);
    const reloaded = readState(cwd).goal as { status?: string; pauseKind?: string; pauseResumeAt?: string; pauseReason?: string };
    assert.equal(reloaded.status, "paused");
    assert.equal(reloaded.pauseKind, "error");
    assert.equal(reloaded.pauseResumeAt, undefined);
    assert.doesNotMatch(reloaded.pauseReason ?? "", /Codex|invalid prompt/i);
  } finally {
    resetContinuationDispatchState(cwd);
    __testOnlyResetTerminalFlags();
  }
});

// ────────────────────────────────────────────────────────────────────
// v0.28.14 — lifecycle consolidation: carryover resolution + /loop cancel
// + one-active-thing tool guards
// ────────────────────────────────────────────────────────────────────

const HELD = "held: restored in a fresh session";
const seedListItem = (objective: string) => ({ id: `item-${Math.random().toString(36).slice(2, 8)}`, objective, addedAt: new Date().toISOString() });

test("carryover pause (default): new goal over stale paused goal+list+held loop → ONE summary, goal archived, list+loop kept", async () => {
  __testOnlyResetStaleFlag();
  const cwd = tmpCwd();
  seedState(cwd, {
    goal: seedGoal({ status: "paused", objective: "stale paused goal from yesterday" }),
    list: [seedListItem("stale list item one"), seedListItem("stale list item two")],
    loop: seedLoop({ active: false, stopReason: HELD, target: "stale held loop" }),
  });
  const ctx = await freshSession(cwd, "startup");
  await pi.command("goal", "start brand new goal — done when pinned", ctx);
  await tick();
  const s = readState(cwd);
  const g = s.goal as { status: string; objective: string };
  assert.equal(g.status, "active", "new goal active");
  assert.match(g.objective, /brand new goal/);
  assert.equal((s.list as unknown[]).length, 2, "pause policy KEEPS the waiting list");
  assert.equal((s.loop as { stopReason?: string })?.stopReason, HELD, "pause policy KEEPS the held loop");
  const ledger = fs.readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf-8");
  assert.ok(ledger.includes('"carryover_resolved"'), "resolution ledgered");
  assert.ok(ledger.includes("replaced by new goal (carryover)"), "stale paused goal archived honestly, not orphaned");
  const notes = ctx.ui.matching("Carryover from before this session");
  assert.equal(notes.length, 1, "exactly ONE summary notify");
  assert.match(notes[0]!.message, /2 waiting list item/);
  assert.match(notes[0]!.message, /held loop/);
});

test("carryover=clear: new goal drops the queue, dismisses the held loop, archives the paused goal", async () => {
  __testOnlyResetStaleFlag();
  const cwd = tmpCwd();
  fs.mkdirSync(path.join(cwd, ".pi-glla"), { recursive: true });
  fs.writeFileSync(path.join(cwd, ".pi-glla", "settings.json"), JSON.stringify({ carryover: "clear" }));
  const staleItem = seedListItem("stale list item");
  seedState(cwd, {
    goal: seedGoal({ status: "paused", objective: "stale paused goal" }),
    list: [staleItem],
    loop: seedLoop({ active: false, stopReason: HELD, target: "stale held loop" }),
  });
  assert.equal(writeQueueItemFile(cwd, staleItem).wrote, true, "the queued item has a durable sidecar");
  const ctx = await freshSession(cwd, "startup");
  await pi.command("goal", "start fresh work — done when pinned", ctx);
  await tick();
  const s = readState(cwd);
  assert.equal((s.list as unknown[]).length, 0, "queue dropped");
  assert.equal((s.loop as { stopReason?: string })?.stopReason, "cleared: carryover", "held loop dismissed");
  assert.equal((s.goal as { status: string }).status, "active", "new goal active");
  assert.equal(queueItemSidecarCount(cwd), 0, "carryover clear removes the durable sidecar too");
  assert.ok(ctx.ui.matching("Carryover cleared").length >= 1, "clear summary shown");
  assert.ok(ctx.ui.notifies.some((notice) => notice.message.includes("Loop recap: Outcome:")), "carryover clear includes the dismissed loop recap");
});

test("v0.35.4: a recovered sidecar is hydrated before list mutations", async () => {
  __testOnlyResetStaleFlag();
  const cwd = tmpCwd();
  const recovered = seedListItem("recovered queue item");
  seedState(cwd, { list: [] });
  assert.equal(writeQueueItemFile(cwd, recovered).wrote, true);
  const ctx = await freshSession(cwd, "startup");
  await pi.command("list", "remove 1", ctx);
  await tick();
  assert.equal((readState(cwd).list as unknown[]).length, 0, "remove acted on hydrated state");
  assert.equal(queueItemSidecarCount(cwd), 0, "mutation removed the recovered sidecar");
});

test("/loop cancel: first-class alias stops the loop (stopReason recorded)", async () => {
  __testOnlyResetStaleFlag();
  const cwd = tmpCwd();
  seedState(cwd, { loop: seedLoop({ active: true }) });
  setGlobalAutoResume(true); // v0.28.21: reload holds by default; this test needs the loop ACTIVE
  const ctx = await freshSession(cwd, "reload");
  await pi.command("loop", "cancel", ctx);
  await tick();
  const loop = readState(cwd).loop as { active: boolean; stopReason?: string };
  assert.equal(loop.active, false, "loop stopped");
  assert.equal(loop.stopReason, "stopped by user (/loop cancel)", "cancel verb recorded");
  assert.ok(ctx.ui.matching("Loop stopped").length >= 1, "stop summary shown");
  const recap = ctx.ui.notifies.find((notice) => notice.message.includes("Recap: Outcome:"));
  assert.ok(recap, "loop cancel notification includes the compact six-label recap");
});

test("/loop finish persists and notifies the complete six-label recap", async () => {
  __testOnlyResetStaleFlag();
  const cwd = tmpCwd();
  seedState(cwd, { loop: seedLoop({ active: true, iteration: 4, bestValue: 3, lastValue: 3 }) });
  setGlobalAutoResume(true);
  const ctx = await freshSession(cwd, "reload");
  await pi.command("loop", "finish audit pass", ctx);
  await tick();
  const loop = readState(cwd).loop as { active: boolean; stopReason?: string; completionSummary?: string };
  assert.equal(loop.active, false);
  assert.equal(loop.stopReason, "completed: audit pass");
  for (const label of ["Outcome:", "Changed:", "Evidence:", "Tests:", "Unresolved:", "Next:"]) assert.match(loop.completionSummary ?? "", new RegExp(label));
  const recap = ctx.ui.notifies.find((notice) => notice.message.includes("Recap: Outcome:"));
  assert.ok(recap, "finish notification includes the compact six-label recap");
  assert.match(fs.readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf8"), /loop_completion_summary/);
});

test("one-active-thing tool guards: list_activate + propose_loop_draft + propose_goal_draft refuse over the wrong active kind", async () => {
  __testOnlyResetStaleFlag();
  // Active loop blocks list_activate and propose_goal_draft.
  const cwd = tmpCwd();
  seedState(cwd, { loop: seedLoop({ active: true }), list: [seedListItem("queued thing")] });
  setGlobalAutoResume(true); // v0.28.21: keep the loop ACTIVE through the reload
  const ctx = await freshSession(cwd, "reload");
  ctx.ui.selectImpl = async (_title, options) => options.find((option) => option === "Cancel new objective") ?? "Yes";
  const r1 = await pi.runTool("list_activate", { n: 1 }, ctx);
  assert.match(r1.content[0]!.text, /cancelled|preserved/i, "list_activate asks before replacing the live loop");
  await pi.command("goal", "", ctx); // enter drafting
  await pi.fire("message_start", { message: { role: "user" } }, ctx);
  await pi.fire("message_start", { message: { role: "user" } }, ctx);
  ctx.ui.customImpl = async () => "Yes";
  ctx.ui.selectImpl = async (_title, options) => options.includes("Yes") ? "Yes" : "Cancel new objective";
  const r2 = await pi.runTool("propose_goal_draft", { objective: "goal over loop — done when pinned" }, ctx);
  assert.match(r2.content[0]!.text, /cancelled|preserved|not started/i, "propose_goal_draft asks before replacing the live loop");
  ctx.ui.customImpl = undefined;
  assert.equal((readState(cwd).loop as { active: boolean }).active, true, "loop untouched");

  // Active goal blocks propose_loop_draft (before the measure even test-runs).
  const cwd2 = tmpCwd();
  seedState(cwd2, { goal: seedGoal() });
  setGlobalAutoResume(true); // v0.28.21: keep the goal ACTIVE through the reload
  const ctx2 = await freshSession(cwd2, "reload");
  await pi.command("loop", "", ctx2); // enter loop drafting (slash-bar gate)
  await pi.fire("message_start", { message: { role: "user" } }, ctx2);
  await pi.fire("message_start", { message: { role: "user" } }, ctx2);
  ctx2.ui.customImpl = async () => "Yes";
  ctx2.ui.selectImpl = async (_title, options) => options.includes("Yes") ? "Yes" : "Cancel new objective";
  const r3 = await pi.runTool("propose_loop_draft", { target: "loop over goal", measureCmd: "none" }, ctx2);
  assert.match(r3.content[0]!.text, /could not start|cancelled|preserved|not started/i, "propose_loop_draft does not silently replace the live goal");
  assert.ok(ctx2.ui.matching("New loop cancelled").length >= 1, "the conflict dialog's cancellation is visible");
  ctx2.ui.customImpl = undefined;
});

test("one-active-thing: /goal resume guard remains; the load-time combo is auto-arbitrated (v0.29.6)", async () => {
  __testOnlyResetStaleFlag();
  // The 0.28.21 behavioral setup (paused goal + live loop after a reload)
  // is unreachable now: v0.29.6 arbitration resolves the stack AT LOAD.
  // The in-session guard stays (pause a goal → start a loop → /goal resume):
  const CONFLICT_SRC = fs.readFileSync("extensions/goal-objective-conflict.ts", "utf8");
  assert.match(CONFLICT_SRC, /Update current objective/);
  assert.match(CONFLICT_SRC, /Replace current objective/);
  const cwd = tmpCwd();
  seedState(cwd, {
    loop: seedLoop({ active: true, startedAt: "2026-07-30T00:00:00.000Z" }),
    goal: seedGoal({ status: "paused", objective: "paused goal — done when pinned", updatedAt: "2026-07-29T00:00:00.000Z" }),
  });
  setGlobalAutoResume(true); // keep the surviving loop ACTIVE through the reload
  const ctx = await freshSession(cwd, "reload");
  await tick();
  const s = readState(cwd);
  assert.equal(s.goal, null, "older goal was archived and closed at load");
  assert.equal((s.loop as { active: boolean }).active, true, "the surviving loop resumed");
  assert.ok(ctx.ui.matching("Stacked state auto-arbitrated").length >= 1, "arbitration notify");
});

test("v0.29.6: stacked state at load is AUTO-ARBITRATED — most recent activity keeps the slot, loser archived (supersedes the 0.28.21 picker)", async () => {
  __testOnlyResetStaleFlag();
  // (a) loop more recent → goal archived; the surviving loop is then held
  // by the restore gate (default hold-everything).
  const cwd = tmpCwd();
  seedState(cwd, {
    loop: seedLoop({ active: true, startedAt: "2026-07-30T00:00:00.000Z" }),
    goal: seedGoal({ updatedAt: "2026-07-29T00:00:00.000Z" }),
  });
  pi.sent.length = 0;
  const ctx = await freshSession(cwd, "startup");
  await tick();
  const s = readState(cwd);
  assert.equal(s.goal, null, "the older goal was archived and closed");
  assert.equal((s.loop as { active: boolean }).active, false, "the surviving loop is then held by the restore gate");
  assert.ok(ctx.ui.matching("Stacked state auto-arbitrated").length >= 1, "arbitration notify");
  assert.equal(pi.sent.length, 0, "nothing fired");

  // (b) goal more recent → loop stopped with an honest reason; the goal survives (held).
  const cwd2 = tmpCwd();
  seedState(cwd2, {
    loop: seedLoop({ active: true, startedAt: "2026-07-28T00:00:00.000Z", iteration: 7 }),
    goal: seedGoal({ updatedAt: "2026-07-30T00:00:00.000Z" }),
  });
  pi.sent.length = 0;
  const ctx2 = await freshSession(cwd2, "startup");
  await tick();
  const s2 = readState(cwd2);
  assert.equal((s2.loop as { active: boolean; stopReason?: string }).active, false, "loop stopped");
  assert.match((s2.loop as { stopReason?: string }).stopReason ?? "", /auto-arbitrated/, "honest stop reason");
  assert.ok(s2.goal && (s2.goal as { status: string }).status !== "aborted", "the newer goal survives");
  assert.ok(ctx2.ui.matching("Stacked state auto-arbitrated").length >= 1, "arbitration notify");
  assert.ok(ctx2.ui.notifies.some((notice) => notice.message.includes("Loop recap: Outcome:")), "arbitration notification includes the loop recap");
});

test("carryover via /list next (pause): summary fires BEFORE the stale item activates; paused goal archived, held loop kept", async () => {
  __testOnlyResetStaleFlag();
  const cwd = tmpCwd();
  seedState(cwd, {
    goal: seedGoal({ status: "paused", objective: "stale paused goal" }),
    list: [seedListItem("carryover head item"), seedListItem("second item")],
    loop: seedLoop({ active: false, stopReason: HELD, target: "stale held loop" }),
  });
  const ctx = await freshSession(cwd, "startup");
  await pi.command("list", "next", ctx);
  await tick();
  const s = readState(cwd);
  assert.equal((s.goal as { status: string; objective: string }).status, "active", "head item activated");
  assert.match((s.goal as { objective: string }).objective, /carryover head item/);
  assert.equal((s.list as unknown[]).length, 1, "one item consumed");
  assert.equal((s.loop as { stopReason?: string })?.stopReason, HELD, "held loop kept under pause");
  assert.equal(ctx.ui.matching("Carryover from before this session").length, 1, "ONE summary on the list path too");
  assert.ok(ctx.ui.notifies.some((notice) => notice.message.includes("Archived goal recap: Outcome:")), "carryover replacement notification includes the archived goal recap");
  const ledger = fs.readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf-8");
  assert.ok(ledger.includes("replaced by new list (carryover)"), "paused goal archived on the list path");
});

test("carryover via /list next (clear): the stale queue is dropped BEFORE activation — nothing activates", async () => {
  __testOnlyResetStaleFlag();
  const cwd = tmpCwd();
  fs.mkdirSync(path.join(cwd, ".pi-glla"), { recursive: true });
  fs.writeFileSync(path.join(cwd, ".pi-glla", "settings.json"), JSON.stringify({ carryover: "clear" }));
  seedState(cwd, {
    goal: seedGoal({ status: "paused", objective: "stale paused goal" }),
    list: [seedListItem("stale item one"), seedListItem("stale item two")],
    loop: seedLoop({ active: false, stopReason: HELD, target: "stale held loop" }),
  });
  const ctx = await freshSession(cwd, "startup");
  await pi.command("list", "next", ctx);
  await tick();
  const s = readState(cwd);
  assert.ok(!s.goal || (s.goal as { status: string }).status !== "active", "NO stale item activated after clear");
  assert.equal((s.list as unknown[]).length, 0, "queue dropped before activation");
  assert.equal((s.loop as { stopReason?: string })?.stopReason, "cleared: carryover", "held loop dismissed");
  assert.ok(ctx.ui.matching("Carryover cleared").length >= 1, "clear summary shown");
  assert.ok(ctx.ui.matching("List is empty").length >= 1, "nothing-to-activate notice");
});

test("carryover=resume: legacy silent stacking — no summary, queue + held loop untouched", async () => {
  __testOnlyResetStaleFlag();
  const cwd = tmpCwd();
  fs.mkdirSync(path.join(cwd, ".pi-glla"), { recursive: true });
  fs.writeFileSync(path.join(cwd, ".pi-glla", "settings.json"), JSON.stringify({ carryover: "resume" }));
  seedState(cwd, {
    goal: seedGoal({ status: "paused", objective: "stale paused goal" }),
    list: [seedListItem("stale item one"), seedListItem("stale item two")],
    loop: seedLoop({ active: false, stopReason: HELD, target: "stale held loop" }),
  });
  const ctx = await freshSession(cwd, "startup");
  await pi.command("goal", "start fresh work — done when pinned", ctx);
  await tick();
  const s = readState(cwd);
  assert.equal((s.goal as { status: string }).status, "active", "new goal active");
  assert.equal((s.list as unknown[]).length, 2, "queue untouched (legacy stacking)");
  assert.equal((s.loop as { stopReason?: string })?.stopReason, HELD, "held loop untouched");
  assert.equal(ctx.ui.matching("Carryover").length, 0, "NO summary under resume (legacy silent)");
});


test("/list audit: queues a collect-only audit item with the restart-safe marker", async () => {
  __testOnlyResetStaleFlag();
  const cwd = tmpCwd();
  const ctx = await freshSession(cwd, "startup");
  await pi.command("list", "audit the renderer", ctx);
  await tick();
  const s = readState(cwd);
  const active = s.goal as { objective: string; policy: string } | null;
  const queued = s.list as Array<{ objective: string }>;
  const text = (active?.objective ?? "") + "|" + queued.map((i) => i.objective).join("|");
  assert.ok(text.includes("[LIST-AUDIT-COLLECT]"), `collect marker in the item: ${text.slice(0, 160)}`);
  assert.ok(text.includes("Scope: the renderer"), "focus threaded through");
  assert.ok(
    ctx.ui.matching("CHANGES NO CODE").length >= 1,
    "the route notify states the collect-only contract",
  );
});

// ---- v0.28.23: decision picker popup (/goal decide) ----

function seedDecisionGoal(): Record<string, unknown> {
  return seedGoal({
    status: "paused",
    pauseKind: "decision",
    pauseReason: "auditor disapproved completion — pick a path",
    pauseOptions: ["Fix the disapproval gap, then continue (/goal resume)", "Tweak the objective — /goal tweak <new text>", "Cancel the goal (/goal cancel)"],
    pauseRecommended: 1,
    pauseSuggestedAction: "Pick one, then /goal resume.",
  });
}

test("/goal decide: content pick → decision sent to the agent + goal resumes", async () => {
  __testOnlyResetStaleFlag();
  const cwd = tmpCwd();
  seedState(cwd, { goal: seedDecisionGoal() });
  const ctx = await freshSession(cwd, "reload");
  await tick();
  assert.equal((readState(cwd).goal as { status: string }).status, "paused", "decision pause survives reload");
  // Swap in content-only options (the seeded defaults are command options).
  const g0 = readState(cwd).goal as unknown as Record<string, unknown>;
  g0.pauseOptions = ["Surgical Done when: clause", "Deliver the missing polish (~2-3 hours)", "Reword the objective to accept SUPERSEDED"];
  g0.pauseRecommended = 3;
  // v0.30.0: rewrite the last STATE entry in place — session_start now
  // also ledgers session_rebound, so the last line is no longer
  // guaranteed to be a state entry (and truncating the ledger drops
  // history readState still needs).
  const lines = fs.readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf-8").trim().split("\n");
  const stateIdx = lines.map((l) => (JSON.parse(l) as { type?: string }).type).lastIndexOf("state");
  assert.ok(stateIdx >= 0, "a state entry exists to rewrite");
  const entry = JSON.parse(lines[stateIdx]!);
  entry.value.goal = g0;
  lines[stateIdx] = JSON.stringify(entry);
  fs.writeFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), lines.join("\n") + "\n");
  // Re-load so the module state picks up the content options.
  const ctx2 = await freshSession(cwd, "reload");
  await tick();
  const ui = (ctx2 as { ui: { selectImpl?: (t: string, o: string[]) => Promise<string | undefined> } }).ui;
  let shownTitle = "";
  ui.selectImpl = (title, options) => {
    shownTitle = title;
    return Promise.resolve(options[0]); // a content option
  };
  await pi.command("goal", "decide", ctx2);
  await tick();
  assert.match(shownTitle, /Decision needed — seeded test objective/);
  assert.match(shownTitle, /auditor disapproved completion/);
  const msgs = pi.userMessages.map((m) => m.message);
  assert.ok(msgs.some((m) => /Decision for the paused goal .*Surgical Done when: clause/.test(m)), `decision message: ${msgs.join(" | ")}`);
  const g = readState(cwd).goal as { status: string; pauseKind?: string; pauseOptions?: string[] };
  assert.equal(g.status, "active", "pick resumes the goal");
  assert.equal(g.pauseKind, undefined, "pause fields cleared on resume");
});

test("/goal decide: Escape (undefined) → goal stays paused, nothing sent", async () => {
  __testOnlyResetStaleFlag();
  const cwd = tmpCwd();
  seedState(cwd, { goal: seedDecisionGoal() });
  const ctx = await freshSession(cwd, "reload");
  await tick();
  const before = pi.userMessages.length;
  await pi.command("goal", "decide", ctx); // mock select returns undefined by default = Escape
  await tick();
  assert.equal((readState(cwd).goal as { status: string }).status, "paused");
  assert.equal(pi.userMessages.length, before, "no decision message on Escape");
});

test("/goal decide: command option (/goal cancel) runs the command, not a message", async () => {
  __testOnlyResetStaleFlag();
  const cwd = tmpCwd();
  seedState(cwd, { goal: seedDecisionGoal() });
  const ctx = await freshSession(cwd, "reload");
  await tick();
  const ui = (ctx as { ui: { selectImpl?: (t: string, o: string[]) => Promise<string | undefined> } }).ui;
  ui.selectImpl = (_t, options) => Promise.resolve(options[2]); // "Cancel the goal (/goal cancel)"
  const before = pi.userMessages.length;
  await pi.command("goal", "decide", ctx);
  await tick();
  const g = readState(cwd).goal as { status: string } | null;
  assert.ok(!g || g.status === "aborted", `goal aborted via command pick, got ${g?.status}`);
  assert.equal(pi.userMessages.length, before, "command picks don't message the agent");
});

test("/goal decide: no pending decision → notify, no picker", async () => {
  __testOnlyResetStaleFlag();
  const cwd = tmpCwd();
  seedState(cwd, { goal: seedGoal() }); // active, no pause
  const ctx = await freshSession(cwd, "reload");
  await tick();
  await pi.command("goal", "decide", ctx);
  const ui = ctx.ui as unknown as { matching(sub: string): Array<{ message: string }> };
  assert.ok(ui.matching("No pending decision").length > 0, "explains why no picker opened");
});

// ---- v0.28.24: goal ids are internal plumbing — user-facing surfaces never show them ----

test("/goal status + /goal pause: no goal id in user-facing text (v0.28.24)", async () => {
  __testOnlyResetStaleFlag();
  const cwd = tmpCwd();
  seedState(cwd, { goal: seedGoal() });
  const ctx = await freshSession(cwd, "reload");
  await tick();
  const g = readState(cwd).goal as { id: string; objective: string };
  const ui = ctx.ui as unknown as { matching(sub: string): Array<{ message: string }> };

  await pi.command("goal", "status", ctx);
  const statusMsgs = ui.matching("seeded test objective");
  assert.ok(statusMsgs.length > 0, "status shows the objective");
  assert.ok(!statusMsgs.some((m) => m.message.includes(g.id)), `status must not show the id ${g.id}`);
  assert.ok(!statusMsgs.some((m) => m.message.startsWith("[20")), "no [id] tag prefix");

  await pi.command("goal", "pause", ctx);
  const pauseMsgs = ui.matching("paused");
  assert.ok(pauseMsgs.length > 0, "pause notifies");
  assert.ok(!pauseMsgs.some((m) => m.message.includes(g.id)), "pause notify names the objective, not the id");
  assert.ok(pauseMsgs.some((m) => /paused/.test(m.message) && /seeded test objective/.test(m.message)), "pause notify carries the short objective");
});

test("goal-start notify has no (id: …) suffix (v0.28.24 source pin)", () => {
  const src = readGoalRuntimeSource();
  assert.ok(!src.includes("(id: ${goal.id})"), "started/saved notifies dropped the id suffix");
  assert.ok(!src.includes("List item ${state.goal.id} paused"), "list-pause notify names the item");
});

// ────────────────────────────────────────────────────────────────────
// v0.34.20: behavioral lifecycle coverage for delayed work. The source pins
// catch wiring drift; these tests hold an actual async operation across a
// replacement and prove the old generation cannot mutate the new session.

 test("v0.34.21 lifecycle: completion audit from a replaced generation leaves the stored claim intact", async () => {
  __testOnlyResetStaleFlag();
  const cwd = tmpCwd();
  const first = await freshSession(cwd, "startup");
  await pi.command("goal", "start lifecycle completion target — done when pinned", first);
  await tick();
  const originalModel = (first as unknown as { model: unknown }).model;
  try {
    // No model makes the isolated auditor return immediately without a
    // provider call; the replacement is delivered at its await boundary.
    (first as unknown as { model: unknown }).model = undefined;
    const audit = pi.runTool("complete_goal", {
      completionSummary: "The lifecycle regression is covered.",
      verificationSummary: "The replacement session must retain this claim.",
    }, first);
    await Promise.resolve();
    const claimed = readState(cwd).goal as { status: string; pendingCompletion?: { completionSummary?: string; phase?: string; attemptId?: string } };
    assert.equal(claimed.status, "auditing", "the claim is persisted before the auditor starts");
    assert.ok(claimed.pendingCompletion?.completionSummary?.startsWith("The lifecycle regression is covered."), "the claim is persisted before the auditor starts (may carry NOTE for missing labels)");
    assert.equal(claimed.pendingCompletion?.phase, "running", "the durable claim records an active audit attempt");
    assert.ok(claimed.pendingCompletion?.attemptId, "the attempt has a durable id");

    const replacement = ownerCtx(cwd);
    await pi.fire("session_start", { reason: "reload" }, replacement);
    const result = await audit;
    assert.match(result.content[0]!.text, /detached auditor queued|verdict will be applied asynchronously/i, "complete_goal returns without waiting on the old generation");

    const after = readState(cwd).goal as { status: string; pendingCompletion?: { completionSummary?: string; phase?: string } };
    assert.ok(["auditing", "paused"].includes(after.status), "the replacement keeps the audit lifecycle recoverable");
    assert.ok(after.pendingCompletion?.completionSummary?.startsWith("The lifecycle regression is covered."), "the durable claim survived (may carry NOTE for missing labels)");
    assert.ok(["running", "recovery-pending"].includes(after.pendingCompletion?.phase ?? ""), "the fresh lifecycle uses an explicit phase");
    const ledger = fs.readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf8");
    assert.match(ledger, /"audit_recovery_pending"/, "replacement marks the old attempt as recovery-pending");
    assert.match(ledger, /"audit_recovery_started"/, "replacement starts a fresh stored-claim attempt immediately");
    assert.doesNotMatch(ledger, /"goal_archived"/, "the stale audit did not archive the goal");
    assert.equal(first.ui.matching("Goal complete").length, 0, "the old UI did not receive a completion notice");
    assert.equal(first.ui.matching("auditor approved").length, 0, "the old generation did not apply a detached result");
    await pi.fire("session_shutdown", { reason: "quit" }, replacement);
  } finally {
    (first as unknown as { model: unknown }).model = originalModel;
  }
});

test("v0.34.119: impossible completion counts reach the durable auditor claim before the worker starts", async () => {
  __testOnlyResetStaleFlag();
  const cwd = tmpCwd();
  const previous = process.env.GLLA_PI_BINARY;
  process.env.GLLA_PI_BINARY = writeFakeAuditor(cwd, "approved", 250);
  try {
    const ctx = await freshSession(cwd, "startup");
    await pi.command("goal", "impossible-count claim target — done when pinned", ctx);
    await tick();
    await pi.runTool("complete_goal", {
      completionSummary: "bun test → 29/28 pass, 0 fail — all work is complete.",
      verificationSummary: "The fake auditor checks the claim.",
    }, ctx);
    const claimed = readState(cwd).goal as { status: string; pendingCompletion?: { completionSummary?: string } };
    assert.equal(claimed.status, "auditing");
    assert.match(claimed.pendingCompletion?.completionSummary ?? "", /Counts appear inconsistent: 29 passed vs 28 total/);
    await waitUntil(() => (readState(cwd).goal as { status?: string } | null) === null);
    const archived = fs.readdirSync(path.join(cwd, ".pi-glla", "archive"));
    assert.ok(archived.length > 0, "approval closes the live slot but preserves the archive");
    await pi.fire("session_shutdown", { reason: "quit" }, ctx);
  } finally {
    if (previous === undefined) delete process.env.GLLA_PI_BINARY;
    else process.env.GLLA_PI_BINARY = previous;
  }
});

test("v0.34.22: complete_goal returns while a detached auditor finishes and archives approval", async () => {
  __testOnlyResetStaleFlag();
  const cwd = tmpCwd();
  const fakePi = writeFakeAuditor(cwd, "approved", 350);
  const previous = process.env.GLLA_PI_BINARY;
  process.env.GLLA_PI_BINARY = fakePi;
  try {
    const ctx = await freshSession(cwd, "startup");
    await pi.command("goal", "start detached approval target — done when pinned", ctx);
    await tick();
    const started = Date.now();
    const result = await pi.runTool("complete_goal", {
      completionSummary: [
        "Outcome: The detached completion path is covered.",
        "Changed: tests/behavioral-orchestrator.test.ts.",
        "Evidence: The fake auditor inspected the pinned artifact.",
        "Tests: The detached approval test passed.",
        "Unresolved: none.",
        "Next: none.",
      ].join("\n"),
      verificationSummary: "The fake auditor will inspect the pinned artifact.",
    }, ctx);
    const elapsed = Date.now() - started;
    assert.match(result.content[0]!.text, /detached auditor queued/i);
    assert.ok(elapsed < 300, `complete_goal waited ${elapsed}ms for the worker`);
    const claimed = readState(cwd).goal as { status: string; pendingCompletion?: { phase?: string } };
    assert.equal(claimed.status, "auditing", "claim is durable before the detached result");
    assert.equal(claimed.pendingCompletion?.phase, "running");
    const queuedWidget = (ctx.ui.widgets["pi-glla"] as string[] | undefined) ?? [];
    assert.ok(queuedWidget.some((line) => line.includes("auditor: queued")), "the queued auditor phase is visible before worker progress");
    // A host render can run after the tool callback and restore the previous
    // widget. The persistence-side deferred repaint must win after the
    // current event yields, even if the worker has already moved past its
    // initial queued phase.
    ctx.ui.setWidget("pi-glla", ["stale pre-turn widget"]);
    await tick(100);
    const repaintedWidget = (ctx.ui.widgets["pi-glla"] as string[] | undefined) ?? [];
    assert.ok(repaintedWidget.some((line) => line.includes("· auditing ·")), "the post-tool repaint restores the durable auditing state");
    assert.ok(repaintedWidget.some((line) => line.includes("detached worker")), "the post-tool repaint restores the detached-auditor surface");
    await waitUntil(() => (readState(cwd).goal as { status?: string } | null) === null);
    assert.ok(fs.readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf8").includes('"goal_archived"'), "approval archived and closed the goal");
    // v0.34.91: the detached-settle chat notify carries the recap (what
    // happened), not "auditor approved" boilerplate.
    assert.equal(ctx.ui.matching("✓ done — The detached completion path is covered").length, 1, "exactly one final notification voices the briefing");
    await pi.fire("session_shutdown", { reason: "quit" }, ctx);
  } finally {
    if (previous === undefined) delete process.env.GLLA_PI_BINARY;
    else process.env.GLLA_PI_BINARY = previous;
  }
});

// ---- v0.34.91: the end-of-goal voice carries the recap (what happened) ----

test("v0.35.x: provider-wall diagnostics stay durable while completion surfaces remain sanitized and deduplicated", { timeout: 15_000 }, async () => {
  __testOnlyResetStaleFlag();
  const cwd = tmpCwd();
  const raw = '429 {"error":{"message":"Token Plan rate limit reached: upgrade your Token Plan"},"request_id":"abc123"}';
  const previous = process.env.GLLA_PI_BINARY;
  process.env.GLLA_PI_BINARY = writeFakeAuditorError(cwd, raw);
  try {
    const ctx = await freshSession(cwd, "startup");
    await pi.command("goal", "provider wall completion target — done when pinned", ctx);
    await tick();
    const result = await pi.runTool("complete_goal", {
      completionSummary: "The provider-wall completion path is covered.",
      verificationSummary: "The detached auditor returns a synthetic provider wall.",
    }, ctx);
    assert.doesNotMatch(result.content.map((part) => part.text).join("\\n"), /429|Token Plan|abc123/, "the immediate completion-tool result never dumps the provider payload");
    await waitUntil(() => readLedger(cwd).some((entry) => entry.type === "auditor_fallback_exhausted"), 30_000);
    const parked = readState(cwd).goal as { status?: string; pauseKind?: string; pauseResumeAt?: string; pauseReason?: string; providerErrorDiagnostic?: string; pendingCompletion?: { phase?: string; providerErrorDiagnostic?: string; recoveryNoticeKeys?: string[]; auditorFallbackExhausted?: boolean; recoveryRetryAt?: string } };
    assert.equal(parked.status, "paused");
    assert.equal(parked.pauseKind, "error");
    assert.equal(parked.pendingCompletion?.phase, "recovery-pending");
    assert.equal(parked.pendingCompletion?.auditorFallbackExhausted, true, "the bounded candidate chain parks after its authorized retry");
    assert.equal(parked.pendingCompletion?.recoveryRetryAt, undefined, "an exhausted chain has no automatic timer");
    assert.equal(parked.pauseResumeAt, undefined, "an exhausted chain has no pause deadline");
    assert.doesNotMatch(`${parked.pauseReason ?? ""} ${ctx.ui.notifies.map((notice) => notice.message).join("\\n")}`, /429|Token Plan|abc123/, "recovery notifications and pause copy are sanitized");
    assert.match(parked.providerErrorDiagnostic ?? "", /Token Plan/);
    assert.match(parked.pendingCompletion?.providerErrorDiagnostic ?? "", /429/);
    const ledger = fs.readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf8");
    assert.match(ledger, /Token Plan/);
    assert.match(ledger, /429/);
    await pi.fire("session_shutdown", { reason: "quit" }, ctx);
  } finally {
    if (previous === undefined) delete process.env.GLLA_PI_BINARY;
    else process.env.GLLA_PI_BINARY = previous;
  }
});

test("v0.35.x: /glla audits full sanitizes active and global reports", async () => {
  __testOnlyResetStaleFlag();
  const cwd = tmpCwd();
  const raw403 = '403 {"error":{"message":"upstream denied this request"},"request_id":"auth-sensitive-id"}';
  const raw429 = '429 {"error":{"message":"Token Plan rate limit reached"},"request_id":"quota-sensitive-id"}';
  const report403 = [
    "## Audit report",
    "Safe finding remains visible.",
    raw403,
    "The implementation is otherwise correct.",
  ].join("\n");
  seedState(cwd, {
    goal: seedGoal({
      status: "paused",
      auditHistory: [{
        at: new Date().toISOString(),
        approved: false,
        disapproved: false,
        model: "provider/model",
        report: report403,
      }],
    }),
  });
  const ctx = await freshSession(cwd, "startup");
  await pi.command("glla", "audits full", ctx);
  const activeFull = ctx.ui.notifies.at(-1)?.message ?? "";
  assert.match(activeFull, /Safe finding remains visible/);
  assert.doesNotMatch(activeFull, /403|upstream denied|auth-sensitive-id/);
  assert.match(activeFull, /provider diagnostic redacted/);

  appendAuditLog(cwd, {
    at: new Date().toISOString(),
    goalId: "global-403-429",
    objective: "global provider recovery",
    verdict: "error",
    model: "provider/model",
    thinkingLevel: "high",
    report: `Safe global finding\n${raw429}`,
    error: raw429,
  });
  seedState(cwd, { goal: seedGoal({ status: "paused" }) });
  __testOnlyLoadState(cwd);
  await pi.command("glla", "audits full all", ctx);
  const globalFull = ctx.ui.notifies.at(-1)?.message ?? "";
  assert.match(globalFull, /Safe global finding/);
  assert.doesNotMatch(globalFull, /429|Token Plan|quota-sensitive-id/);
  assert.match(globalFull, /provider diagnostic redacted/);
  await pi.fire("session_shutdown", { reason: "quit" }, ctx);
});

test("v0.35.x: bare 403 main recovery sanitizes live surfaces while retaining diagnostics", async () => {
  __testOnlyResetStaleFlag();
  const cwd = tmpCwd();
  const ctx = await freshSession(cwd, "startup");
  await pi.command("goal", "bare provider recovery target — done when pinned", ctx);
  await tick();
  const raw = '403 {"error":{"message":"upstream denied this request"},"request_id":"auth-sensitive-id"}';
  await pi.fire("agent_end", {
    messages: [{ role: "assistant", content: [], stopReason: "error", errorMessage: raw }],
  }, ctx);
  await tick();

  const parked = readState(cwd) as {
    goal: { status: string; pauseReason?: string; pauseSuggestedAction?: string; providerErrorDiagnostic?: string };
    mainModelRecovery?: { retryAt?: string; providerErrorDiagnostic?: string };
  };
  assert.equal(parked.goal.status, "paused", "the auth-shaped provider failure enters durable recovery");
  assert.ok(parked.mainModelRecovery?.retryAt, "recovery retry is durable");
  const liveCopy = [
    parked.goal.pauseReason,
    parked.goal.pauseSuggestedAction,
    parked.mainModelRecovery?.providerErrorDiagnostic && "diagnostic",
    ...ctx.ui.notifies.map((notice) => notice.message),
    ...Object.values(ctx.ui.widgets).map((lines) => JSON.stringify(lines)),
  ].filter(Boolean).join("\\n");
  assert.doesNotMatch(liveCopy, /403|upstream denied|auth-sensitive-id/, "live notifications/cards never expose the raw 403 payload");
  assert.match(parked.goal.providerErrorDiagnostic ?? "", /403|auth-sensitive-id/, "goal diagnostics remain durable");
  assert.match(parked.mainModelRecovery?.providerErrorDiagnostic ?? "", /403|auth-sensitive-id/, "recovery diagnostics remain durable");

  await pi.command("glla", "status", ctx);
  assert.doesNotMatch(ctx.ui.notifies.at(-1)?.message ?? "", /403|upstream denied|auth-sensitive-id/, "status remains sanitized");
  await pi.fire("session_shutdown", { reason: "quit" }, ctx);
});

test("v0.35.x: bare 403 completion diagnostics stay durable while completion surfaces remain sanitized", { timeout: 30_000 }, async () => {
  __testOnlyResetStaleFlag();
  const cwd = tmpCwd();
  const raw = '403 {"error":{"message":"upstream denied this request"},"request_id":"auth-sensitive-id"}';
  const previous = process.env.GLLA_PI_BINARY;
  process.env.GLLA_PI_BINARY = writeFakeAuditorError(cwd, raw);
  try {
    const ctx = await freshSession(cwd, "startup");
    await pi.command("goal", "bare provider completion target — done when pinned", ctx);
    await tick();
    const result = await pi.runTool("complete_goal", {
      completionSummary: "The completion path is covered.",
      verificationSummary: "The detached auditor returns a synthetic HTTP error.",
    }, ctx);
    assert.doesNotMatch(result.content.map((part) => part.text).join("\\n"), /403|upstream denied|auth-sensitive-id/, "completion-tool output is sanitized");
    await waitUntil(() => readLedger(cwd).some((entry) => entry.type === "auditor_fallback_exhausted"), 30_000);
    const parked = readState(cwd).goal as { status?: string; pauseKind?: string; pauseResumeAt?: string; pauseReason?: string; pauseSuggestedAction?: string; providerErrorDiagnostic?: string; pendingCompletion?: { phase?: string; providerErrorDiagnostic?: string; auditorFallbackExhausted?: boolean; recoveryRetryAt?: string } };
    assert.equal(parked.status, "paused");
    assert.equal(parked.pauseKind, "error");
    assert.equal(parked.pendingCompletion?.phase, "recovery-pending");
    assert.equal(parked.pendingCompletion?.auditorFallbackExhausted, true);
    assert.equal(parked.pendingCompletion?.recoveryRetryAt, undefined, "exhaustion does not re-arm generic recovery");
    assert.equal(parked.pauseResumeAt, undefined);
    const liveCopy = [parked.pauseReason, parked.pauseSuggestedAction, ...ctx.ui.notifies.map((notice) => notice.message)].filter(Boolean).join("\\n");
    assert.doesNotMatch(liveCopy, /403|upstream denied|auth-sensitive-id/, "completion recovery copy is sanitized");
    assert.match(parked.providerErrorDiagnostic ?? "", /403|auth-sensitive-id/, "completion goal diagnostic remains durable");
    assert.match(parked.pendingCompletion?.providerErrorDiagnostic ?? "", /403|auth-sensitive-id/, "pending claim diagnostic remains durable");
    await pi.fire("session_shutdown", { reason: "quit" }, ctx);
  } finally {
    if (previous === undefined) delete process.env.GLLA_PI_BINARY;
    else process.env.GLLA_PI_BINARY = previous;
  }
});

test("v0.34.119: auditor-approved list completion archives the item and activates exactly the next queue item", async () => {
  __testOnlyResetStaleFlag();
  const cwd = tmpCwd();
  const previous = process.env.GLLA_PI_BINARY;
  process.env.GLLA_PI_BINARY = writeFakeAuditor(cwd, "approved", 0);
  try {
    const ctx = await freshSession(cwd, "startup");
    const added = await pi.runTool("list_add", {
      items: ["first queued objective — done when first proof exists", "second queued objective — done when second proof exists"],
    }, ctx);
    assert.match(added.content[0]!.text, /item|active/i);
    const before = readState(cwd).goal as { id: string; objective: string; status: string };
    assert.match(before.objective, /first queued objective/);
    const firstId = before.id;

    await pi.runTool("complete_goal", {
      completionSummary: "First queued objective is complete with the required proof.",
      verificationSummary: "The fake auditor verifies the first proof.",
    }, ctx);
    await waitUntil(() => {
      const current = readState(cwd).goal as { objective?: string; status?: string } | null;
      return current?.status === "active" && current.objective?.includes("second queued objective") === true;
    });

    const after = readState(cwd) as unknown as { goal: { objective: string; status: string }; list?: unknown[] };
    assert.match(after.goal.objective, /second queued objective/);
    assert.equal(after.goal.status, "active", "the next item is genuinely active, not merely left queued");
    assert.equal(after.list?.length ?? 0, 0, "the queue is empty after activating its final item");
    assert.ok(fs.existsSync(path.join(cwd, ".pi-glla", "archive", `${firstId}.md`)), "the first item has a durable archive");
    const ledger = fs.readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf8");
    assert.match(ledger, /"goal_archived"/);
    assert.match(ledger, /"status":"complete"/);
    await pi.fire("session_shutdown", { reason: "quit" }, ctx);
  } finally {
    if (previous === undefined) delete process.env.GLLA_PI_BINARY;
    else process.env.GLLA_PI_BINARY = previous;
  }
});

test("v0.36.2: approved standalone completion automatically activates a pre-queued list head", { timeout: 30_000 }, async () => {
  __testOnlyResetStaleFlag();
  const cwd = tmpCwd();
  const previous = process.env.GLLA_PI_BINARY;
  process.env.GLLA_PI_BINARY = writeFakeAuditor(cwd, "approved", 0);
  try {
    const ctx = await freshSession(cwd, "startup");
    await pi.command("goal", "standalone completion before list — done when pinned", ctx);
    await tick();
    await pi.runTool("list_add", {
      items: [
        "first post-standalone item — done when pinned",
        "second post-standalone item — done when pinned",
      ],
    }, ctx);
    const standalone = readState(cwd).goal as { id: string; policy: string; status: string };
    assert.equal(standalone.policy, "goal");
    assert.equal(standalone.status, "active");

    await pi.runTool("complete_goal", {
      completionSummary: "The standalone objective is complete with the required proof.",
      verificationSummary: "The fake auditor verifies the standalone proof.",
    }, ctx);
    await waitUntil(() => {
      const current = readState(cwd).goal as { objective?: string; status?: string } | null;
      return current?.status === "active" && current.objective?.includes("first post-standalone item") === true;
    });

    const after = readState(cwd);
    assert.equal(after.goal?.policy, "list");
    assert.equal(after.list?.length, 1);
    assert.ok(fs.existsSync(path.join(cwd, ".pi-glla", "archive", `${standalone.id}.md`)));
    assert.ok(readLedger(cwd).some((entry) => entry.type === "goal_completion_list_handoff"));
    clearContinuationTimer();
    await pi.fire("session_shutdown", { reason: "quit" }, ctx);
  } finally {
    if (previous === undefined) delete process.env.GLLA_PI_BINARY;
    else process.env.GLLA_PI_BINARY = previous;
  }
});

test("v0.34.91: detached approval notify carries the agent's completion recap, not process boilerplate", async () => {
  __testOnlyResetStaleFlag();
  const cwd = tmpCwd();
  const previous = process.env.GLLA_PI_BINARY;
  process.env.GLLA_PI_BINARY = writeFakeAuditor(cwd, "approved", 0);
  try {
    const ctx = await freshSession(cwd, "startup");
    await pi.command("goal", "start recap-notify target — done when pinned", ctx);
    await tick();
    const longValidRecap = [
      "Outcome: Pinned the R-key/HUD retire parity in 5 tests across 5 layers.",
      "Changed: extensions/goal-loop-display.ts and tests/behavioral-orchestrator.test.ts.",
      "Evidence: ledger close at findings.md:727; " + "durable-proof-marker ".repeat(20),
      "Tests: 5338/5338 tests / 24166 expect() / 598 files pass. tsc clean.",
      "Unresolved: none.",
      "Next: none.",
    ].join("\n");
    await pi.runTool("complete_goal", {
      completionSummary: longValidRecap,
      verificationSummary: "5338/5338 tests / 24166 expect() / 598 files pass. tsc clean.",
    }, ctx);
    await waitUntil(() => (readState(cwd).goal as { status?: string } | null) === null);
    const recapNotifs = ctx.ui.matching("Pinned the R-key/HUD retire parity");
    assert.ok(recapNotifs.length > 0, "the settle notify carries the recap (what happened), not 'auditor approved' alone");
    assert.ok(recapNotifs.some((n: { message: string }) => n.message.includes("Changed:") && n.message.includes("\n")), "the recap arrives as one-label-per-line, not the single-line mash");
    assert.equal(ctx.ui.matching("✓ done").length, 1, "the recap line is the single decisive end-of-goal voice");
    assert.match(recapNotifs[0]!.message, /^✓ done — Pinned the R-key\/HUD retire parity/, "the briefing leads with the outcome in the header");
    // v0.38.20: the chat notify is outcome + at most two details + approval
    // + record pointer (five 120-char label lines scan as soup, not a
    // summary — field 2026-09-04). Substance lives in the transcript
    // notice + archive; the chat stays glanceable but never boilerplate.
    for (const label of ["Changed:", "Evidence:"]) {
      assert.ok(recapNotifs[0]!.message.split("\n").some((line: string) => line.startsWith(label)), `approved briefing keeps informing label ${label}`);
    }
    assert.ok(recapNotifs[0]!.message.split("\n").length <= 5, "chat notify stays glanceable: outcome + ≤2 details + approval + record");
    assert.match(recapNotifs[0]!.message, /— record: \.pi-glla\/archive\/.*\.md/, "chat notify points at the archived record");
    for (const label of ["Unresolved:", "Next:"]) {
      assert.ok(!recapNotifs[0]!.message.split("\n").some((line: string) => line.startsWith(label)), `filler ${label} none is dropped from the briefing`);
    }
    assert.doesNotMatch(recapNotifs[0]!.message, / · /, "approved briefing is lines, not the single-line mash");
    assert.match(recapNotifs[0]!.message, /…/, "long approved recap values are bounded");
    assert.doesNotMatch(recapNotifs[0]!.message, new RegExp(`(${"durable-proof-marker "}){20}`), "approved notification does not flatten the full long recap");
    assert.doesNotMatch(recapNotifs.join("\n"), /^Goal complete — auditor /, "the old process-only line is gone");
    await pi.fire("session_shutdown", { reason: "quit" }, ctx);
  } finally {
    if (previous === undefined) delete process.env.GLLA_PI_BINARY;
    else process.env.GLLA_PI_BINARY = previous;
  }
});

test("v0.34.87: complete_goal on a paused item names the pause + resume verb, not a flat 'No active goal'", async () => {
  __testOnlyResetStaleFlag();
  const cwd = tmpCwd();
  const previous = process.env.GLLA_PI_BINARY;
  process.env.GLLA_PI_BINARY = writeFakeAuditor(cwd, "approved", 0);
  try {
    const ctx = await freshSession(cwd, "startup");
    await pi.command("goal", "start parked-completion target — done when pinned", ctx);
    await tick();
    const paused = await pi.runTool("pause_goal", { reason: "completion audit blocked — no verdict: host successor silent", kind: "blocked" }, ctx);
    assert.match(paused.content[0]!.text, /Goal paused/);
    // Surface separation: the widget shows a paused card, so complete_goal
    // must name the paused state + the resume verb instead of the old flat
    // "No active goal." that read as if the card were nothing at all.
    const result = await pi.runTool("complete_goal", { completionSummary: "Claim", verificationSummary: "Evidence" }, ctx);
    assert.match(result.content[0]!.text, /No active goal — the goal is paused; \/goal resume reactivates it/);
    assert.doesNotMatch(result.content[0]!.text, /^No active goal\.$/);
    // The pause survives — complete_goal did not touch the parked goal.
    const state = readState(cwd).goal as { status: string };
    assert.equal(state.status, "paused");
    await pi.fire("session_shutdown", { reason: "quit" }, ctx);
  } finally {
    if (previous === undefined) delete process.env.GLLA_PI_BINARY;
    else process.env.GLLA_PI_BINARY = previous;
  }
});

test("v0.34.22: detached disapproval resumes the goal with a durable report", async () => {
  __testOnlyResetStaleFlag();
  const cwd = tmpCwd();
  const rawReport = [
    "## Required fixes",
    "- provider returned 429 Token Plan request_id=secret-request",
    "403",
    "{",
    '  "account": "secret-account",',
    '  "message": "Token Plan rate limit reached"',
    "}",
    "<disapproved/>",
  ].join("\n");
  const fakePi = writeFakeAuditor(cwd, "disapproved", 0, rawReport);
  const previous = process.env.GLLA_PI_BINARY;
  process.env.GLLA_PI_BINARY = fakePi;
  try {
    const ctx = await freshSession(cwd, "startup");
    await pi.command("goal", "start detached disapproval target — done when pinned", ctx);
    await tick();
    const completionResult = await pi.runTool("complete_goal", { completionSummary: "Claim", verificationSummary: "Evidence" }, ctx);
    assert.doesNotMatch(completionResult.content.map((part) => part.text).join("\n"), /403|429|Token Plan|secret-request|secret-account/);
    await waitUntil(() => {
      const goal = readState(cwd).goal as { status?: string; pendingCompletion?: unknown; auditHistory?: unknown[] } | null;
      return goal?.status === "active" && !goal.pendingCompletion && (goal.auditHistory?.length ?? 0) > 0;
    });
    const goal = readState(cwd).goal as { status: string; auditHistory?: Array<{ disapproved?: boolean; report?: string }> };
    assert.equal(goal.status, "active");
    assert.equal(goal.auditHistory?.at(-1)?.disapproved, true);
    assert.match(goal.auditHistory?.at(-1)?.report ?? "", /secret-account|Token Plan/);
    const userFacing = [
      ...ctx.ui.notifies.map((notice) => notice.message),
      ...(((ctx.ui.widgets["pi-glla"] as string[] | undefined) ?? [])),
    ].join("\n");
    assert.doesNotMatch(userFacing, /403|429|Token Plan|secret-request|secret-account|rate limit/);
    assert.match(userFacing, /provider diagnostic redacted/);
    assert.ok(
      ctx.ui.matching("Report excerpt").some((n) => n.message.includes("provider diagnostic redacted")),
      "the sanitized disapproval report is notified directly, not only returned to a continuation turn",
    );
    await pi.fire("session_shutdown", { reason: "quit" }, ctx);
  } finally {
    if (previous === undefined) delete process.env.GLLA_PI_BINARY;
    else process.env.GLLA_PI_BINARY = previous;
  }
});

test("v0.35.x: a detached approval blocked by the regression shield is not relabeled", async () => {
  __testOnlyResetStaleFlag();
  const cwd = tmpCwd();
  const fakePi = writeFakeAuditor(cwd, "approved", 0, "<evidence>\\npinned\\n</evidence>\\n<approved/>");
  const previous = process.env.GLLA_PI_BINARY;
  process.env.GLLA_PI_BINARY = fakePi;
  try {
    const ctx = await freshSession(cwd, "startup");
    await pi.command("goal", "start shielded completion target — done when:\n- pinned\n- tests", ctx);
    await tick();
    await pi.runTool("complete_goal", { completionSummary: "Claim", verificationSummary: "Evidence" }, ctx);
    await waitUntil(() => {
      const goal = readState(cwd).goal as { status?: string; pendingCompletion?: unknown; auditHistory?: unknown[] } | null;
      return goal?.status === "active" && !goal.pendingCompletion && (goal.auditHistory?.length ?? 0) > 0;
    });
    const goal = readState(cwd).goal as {
      status: string;
      auditHistory?: Array<{ approved?: boolean; disapproved?: boolean; regressionShieldPassed?: boolean; regressionShieldMissing?: string[] }>;
    };
    const latest = goal.auditHistory?.at(-1);
    assert.equal(goal.status, "active", "shield-blocked completion remains open for another evidence-backed audit");
    assert.equal(latest?.approved, true);
    assert.equal(latest?.disapproved, false);
    assert.equal(latest?.regressionShieldPassed, false);
    assert.deepEqual(latest?.regressionShieldMissing, ["tests"]);
    const auditLog = fs.readFileSync(path.join(cwd, ".pi-glla", "audits.jsonl"), "utf8");
    assert.match(auditLog, /"verdict":"shield_blocked"/);
    assert.doesNotMatch(auditLog, /"verdict":"disapproved"/);
    assert.ok(ctx.ui.matching("Regression shield blocked completion").length >= 1);
    await pi.fire("session_shutdown", { reason: "quit" }, ctx);
  } finally {
    if (previous === undefined) delete process.env.GLLA_PI_BINARY;
    else process.env.GLLA_PI_BINARY = previous;
  }
});

test("v0.34.22: an old detached result cannot archive after session replacement", async () => {
  __testOnlyResetStaleFlag();
  const cwd = tmpCwd();
  const fakePi = writeFakeAuditor(cwd, "approved", 450);
  const previous = process.env.GLLA_PI_BINARY;
  process.env.GLLA_PI_BINARY = fakePi;
  try {
    const first = await freshSession(cwd, "startup");
    await pi.command("goal", "detached stale result target — done when pinned", first);
    await tick();
    await pi.runTool("complete_goal", { completionSummary: "old claim", verificationSummary: "old evidence" }, first);
    const before = readState(cwd).goal as { status: string; pendingCompletion?: { attemptId?: string } };
    assert.equal(before.status, "auditing");
    const oldAttempt = before.pendingCompletion?.attemptId;
    assert.ok(oldAttempt);

    await pi.fire("session_shutdown", { reason: "quit" }, first);
    const replacement = await freshSession(cwd, "startup");
    await new Promise((resolve) => setTimeout(resolve, 900));
    const after = readState(cwd).goal as { status: string; pendingCompletion?: { attemptId?: string; phase?: string } } | null;
    assert.ok(after, "replacement retained the goal instead of archiving it");
    assert.equal(after?.pendingCompletion?.attemptId, oldAttempt, "cold replacement kept the stored claim for explicit resume");
    assert.equal(after?.pendingCompletion?.phase, "recovery-pending");
    assert.notEqual(after?.status, "complete");
    const ledger = fs.readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf8");
    assert.doesNotMatch(ledger, /"goal_archived"/, "the old worker result cannot archive after replacement");
    await pi.fire("session_shutdown", { reason: "quit" }, replacement);
  } finally {
    if (previous === undefined) delete process.env.GLLA_PI_BINARY;
    else process.env.GLLA_PI_BINARY = previous;
  }
});

test("v0.34.21 lifecycle: cold startup holds a recovered claim until explicit resume", async () => {
  __testOnlyResetStaleFlag();
  const cwd = tmpCwd();
  seedState(cwd, {
    goal: seedGoal({
      status: "auditing",
      pendingCompletion: {
        completionSummary: "saved claim",
        verificationSummary: "saved evidence",
        at: new Date().toISOString(),
        phase: "running",
        attemptId: "old-attempt",
      },
    }),
  });
  const ctx = await freshSession(cwd, "startup");
  await tick();
  const goal = readState(cwd).goal as { status: string; pauseKind?: string; pauseReason?: string; pendingCompletion?: { phase?: string } };
  assert.equal(goal.status, "paused", "cold startup releases the MAIN instead of waiting in auditing");
  assert.equal(goal.pauseKind, "blocked", "the no-verdict hold is infrastructure-blocked");
  assert.match(goal.pauseReason ?? "", /completion audit blocked — no verdict/);
  assert.equal(goal.pendingCompletion?.phase, "recovery-pending", "old running attempt is made explicit");
  const ledger = fs.readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf8");
  assert.doesNotMatch(ledger, /"audit_recovery_started"/, "no recovery starts without lifecycle/explicit consent");
  assert.ok(ctx.ui.matching("Completion audit blocked — no verdict").length >= 1, "the hold is explained");
  assert.ok((ctx.ui.widgets["pi-glla"] as string[]).some((line) => line.includes("auditor: parked — no verdict")), "the widget names the parked auditor (v0.34.87 surface separation)");
});

test("v0.35.x: validated session handoff auto-retries a parked completion audit", async () => {
  __testOnlyResetStaleFlag();
  const cwd = tmpCwd();
  const fakePi = writeFakeAuditor(cwd, "disapproved", 350);
  const previous = process.env.GLLA_PI_BINARY;
  process.env.GLLA_PI_BINARY = fakePi;
  try {
    const first = await freshSession(cwd, "startup");
    await pi.command("goal", "session handoff audit target — done when pinned", first);
    await tick();
    const audit = pi.runTool("complete_goal", {
      completionSummary: "The parked claim should recover on a valid handoff.",
      verificationSummary: "A fresh session must retry the stored claim without manual resume.",
    }, first);
    await waitUntil(() => (readState(cwd).goal as { status?: string } | null)?.status === "auditing");
    const before = readState(cwd).goal as { pendingCompletion?: { attemptId?: string } };
    const oldAttempt = before.pendingCompletion?.attemptId;
    assert.ok(oldAttempt);

    // A non-quit lifecycle boundary writes a matching handoff sidecar. The
    // successor session is therefore allowed to recover the parked claim;
    // this is different from merely contacting the successor with a tool.
    await pi.fire("session_shutdown", { reason: "reload" }, first);
    const replacement = await freshSession(cwd, "reload");
    await waitUntil(() => readLedger(cwd).some((entry) => entry.type === "audit_recovery_started"));

    const afterStart = readState(cwd).goal as { status?: string; pendingCompletion?: { attemptId?: string; phase?: string } } | null;
    assert.equal(afterStart?.status, "auditing", "the fresh host continues the detached audit, not the main goal");
    assert.notEqual(afterStart?.pendingCompletion?.attemptId, oldAttempt, "recovery dispatch owns a fresh attempt");
    assert.equal(readLedger(cwd).filter((entry) => entry.type === "audit_recovery_started").length, 1, "one recovery dispatch is ledgered");
    assert.ok(replacement.ui.matching("Fresh session recovered the interrupted completion audit").length >= 1);

    await waitUntil(() => {
      const settled = readState(cwd).goal as { status?: string; pendingCompletion?: unknown; auditHistory?: unknown[] } | null;
      return settled?.status === "active" && !settled.pendingCompletion && (settled.auditHistory?.length ?? 0) >= 1;
    });
    await pi.fire("session_shutdown", { reason: "quit" }, replacement);
    await audit;
  } finally {
    pi.sendMessageError = null;
    pi.sessionNameError = null;
    __testOnlyResetOwnerSession();
    if (previous === undefined) delete process.env.GLLA_PI_BINARY;
    else process.env.GLLA_PI_BINARY = previous;
  }
});

test("v0.35.x: explicit Auto-resume retries a parked claim on cold startup", async () => {
  __testOnlyResetStaleFlag();
  setGlobalAutoResume(true);
  const cwd = tmpCwd();
  const fakePi = writeFakeAuditor(cwd, "disapproved", 350);
  const previous = process.env.GLLA_PI_BINARY;
  process.env.GLLA_PI_BINARY = fakePi;
  const oldAttempt = "parked-before-autoresume";
  seedState(cwd, {
    goal: seedGoal({
      status: "paused",
      pauseKind: "blocked",
      pauseReason: "completion audit blocked — no verdict",
      pendingCompletion: {
        completionSummary: "Auto-resume must recover this parked claim.",
        verificationSummary: "The stored claim is retried from a fresh startup.",
        at: new Date().toISOString(),
        phase: "recovery-pending",
        attemptId: oldAttempt,
      },
    }),
  });
  try {
    const ctx = await freshSession(cwd, "startup");
    await waitUntil(() => readLedger(cwd).some((entry) => entry.type === "audit_recovery_started"));
    const started = readState(cwd).goal as { status?: string; pendingCompletion?: { attemptId?: string } } | null;
    assert.equal(started?.status, "auditing");
    assert.notEqual(started?.pendingCompletion?.attemptId, oldAttempt);
    assert.ok(ctx.ui.matching("Fresh session recovered the interrupted completion audit").length >= 1);
    await waitUntil(() => {
      const settled = readState(cwd).goal as { status?: string; pendingCompletion?: unknown; auditHistory?: unknown[] } | null;
      return settled?.status === "active" && !settled.pendingCompletion && (settled.auditHistory?.length ?? 0) >= 1;
    });
    await pi.fire("session_shutdown", { reason: "quit" }, ctx);
  } finally {
    pi.sendMessageError = null;
    pi.sessionNameError = null;
    __testOnlyResetOwnerSession();
    if (previous === undefined) delete process.env.GLLA_PI_BINARY;
    else process.env.GLLA_PI_BINARY = previous;
  }
});

test("v0.35.x: manual /list resume retries a parked list completion claim directly", async () => {
  __testOnlyResetStaleFlag();
  const cwd = tmpCwd();
  const fakePi = writeFakeAuditor(cwd, "disapproved", 350);
  const previous = process.env.GLLA_PI_BINARY;
  process.env.GLLA_PI_BINARY = fakePi;
  const oldAttempt = "parked-list-manual-resume";
  seedState(cwd, {
    goal: seedGoal({
      policy: "list",
      status: "paused",
      pauseKind: "blocked",
      pauseReason: "completion audit blocked — no verdict: detached auditor timeout",
      pauseSuggestedAction: "/list resume retries the stored claim",
      pendingCompletion: {
        completionSummary: "The parked list claim remains authoritative.",
        verificationSummary: "Manual list resume must retry the stored claim without an agent turn.",
        at: new Date().toISOString(),
        phase: "recovery-pending",
        attemptId: oldAttempt,
      },
    }),
  });
  try {
    const ctx = await freshSession(cwd, "startup");
    await tick();
    const held = readState(cwd).goal as { status?: string; policy?: string; pendingCompletion?: { phase?: string } } | null;
    assert.equal(held?.status, "paused", "cold startup keeps the parked list claim held");
    assert.equal(held?.policy, "list");
    assert.equal(held?.pendingCompletion?.phase, "recovery-pending");
    assert.equal(readLedger(cwd).filter((entry) => entry.type === "audit_recovery_started").length, 0, "cold startup does not spend the automatic retry");

    await pi.command("list", "resume", ctx);
    await waitUntil(() => {
      const resumed = readState(cwd).goal as { status?: string; pendingCompletion?: { phase?: string; attemptId?: string } } | null;
      return resumed?.status === "auditing" && resumed.pendingCompletion?.phase === "running";
    });
    const started = readState(cwd).goal as { pendingCompletion?: { attemptId?: string } };
    assert.notEqual(started.pendingCompletion?.attemptId, oldAttempt, "manual /list resume starts a fresh detached attempt");
    const ledger = readLedger(cwd);
    assert.equal(ledger.filter((entry) => entry.type === "audit_recovery_started").length, 0, "manual resume is not mislabeled as automatic recovery");
    assert.equal(ledger.filter((entry) => entry.type === "audit_started").length, 1, "manual /list resume starts exactly one stored-claim audit");
    assert.equal(ledger.filter((entry) => entry.type === "goal_continuation_sent").length, 0, "manual stored-claim recovery does not invent an agent turn");

    await waitUntil(() => {
      const settled = readState(cwd).goal as { status?: string; pendingCompletion?: unknown; auditHistory?: unknown[] } | null;
      return settled?.status === "active" && !settled.pendingCompletion && (settled.auditHistory?.length ?? 0) >= 1;
    });
    const settled = readState(cwd).goal as { policy?: string; auditHistory?: Array<{ disapproved?: boolean }> } | null;
    assert.equal(settled?.policy, "list");
    assert.equal(settled?.auditHistory?.at(-1)?.disapproved, true, "the fresh manual audit produces a durable semantic verdict");
    await pi.fire("session_shutdown", { reason: "quit" }, ctx);
  } finally {
    pi.sendMessageError = null;
    pi.sessionNameError = null;
    __testOnlyResetOwnerSession();
    if (previous === undefined) delete process.env.GLLA_PI_BINARY;
    else process.env.GLLA_PI_BINARY = previous;
  }
});

test("v0.35.x: one automatic parked-audit retry is durable across repeated lifecycle events", async () => {
  __testOnlyResetStaleFlag();
  setGlobalAutoResume(true);
  const cwd = tmpCwd();
  const fakePi = writeFakeAuditor(cwd, "disapproved", 900);
  const previous = process.env.GLLA_PI_BINARY;
  process.env.GLLA_PI_BINARY = fakePi;
  const oldAttempt = "parked-before-one-shot-recovery";
  seedState(cwd, {
    goal: seedGoal({
      status: "paused",
      pauseKind: "blocked",
      pauseReason: "completion audit blocked — no verdict: auditor wall timeout",
      pendingCompletion: {
        completionSummary: "The durable one-shot recovery claim.",
        verificationSummary: "The manual path must remain available.",
        at: new Date().toISOString(),
        phase: "recovery-pending",
        attemptId: oldAttempt,
      },
    }),
  });
  try {
    const first = await freshSession(cwd, "startup");
    await waitUntil(() => readLedger(cwd).some((entry) => entry.type === "audit_recovery_started"));
    const started = readState(cwd).goal as {
      status?: string;
      pendingCompletion?: { phase?: string; attemptId?: string; automaticRecoveryAttempted?: boolean; automaticRecoveryGeneration?: number };
    } | null;
    assert.equal(started?.status, "auditing");
    assert.equal(started?.pendingCompletion?.phase, "running");
    assert.notEqual(started?.pendingCompletion?.attemptId, oldAttempt);
    assert.equal(started?.pendingCompletion?.automaticRecoveryAttempted, true, "the durable marker is consumed with the fresh attempt");
    assert.equal(typeof started?.pendingCompletion?.automaticRecoveryGeneration, "number", "the consumed marker records the dispatch generation");

    // A second healthy lifecycle event must not launch another automatic
    // worker, even though it sees the claim in the old running phase.
    const second = ownerCtx(cwd);
    await pi.fire("session_start", { reason: "reload" }, second);
    await tick(50);
    const afterReload = readState(cwd).goal as {
      status?: string;
      pendingCompletion?: { phase?: string; automaticRecoveryAttempted?: boolean };
    } | null;
    const ledgerAfterReload = readLedger(cwd);
    assert.equal(ledgerAfterReload.filter((entry) => entry.type === "audit_recovery_started").length, 1, "repeated lifecycle recovery launches no second automatic audit");
    assert.equal(ledgerAfterReload.filter((entry) => entry.type === "audit_recovery_auto_retry_claimed").length, 1, "the durable claim is claimed once");
    assert.equal(afterReload?.status, "paused", "the invalidated automatic attempt is parked safely");
    assert.equal(afterReload?.pendingCompletion?.phase, "recovery-pending");
    assert.equal(afterReload?.pendingCompletion?.automaticRecoveryAttempted, true);

    // Explicit manual resume remains a separate consent path after the
    // automatic one-shot has been consumed.
    await pi.command("goal", "resume", second);
    await waitUntil(() => {
      const resumed = readState(cwd).goal as { status?: string; pendingCompletion?: { phase?: string; attemptId?: string } } | null;
      return resumed?.status === "auditing" && resumed.pendingCompletion?.phase === "running";
    });
    const manualLedger = readLedger(cwd);
    assert.equal(manualLedger.filter((entry) => entry.type === "audit_recovery_started").length, 1, "manual resume does not masquerade as automatic recovery");
    assert.equal(manualLedger.filter((entry) => entry.type === "audit_started").length >= 2, true, "manual resume starts a fresh stored-claim audit");
    await pi.fire("session_shutdown", { reason: "quit" }, second);
  } finally {
    pi.sendMessageError = null;
    pi.sessionNameError = null;
    __testOnlyResetOwnerSession();
    if (previous === undefined) delete process.env.GLLA_PI_BINARY;
    else process.env.GLLA_PI_BINARY = previous;
  }
});

test("v0.35.x: stale host replacement session_start auto-recovers the parked audit", async () => {
  __testOnlyResetStaleFlag();
  const cwd = tmpCwd();
  const fakePi = writeFakeAuditor(cwd, "disapproved", 350);
  const previous = process.env.GLLA_PI_BINARY;
  process.env.GLLA_PI_BINARY = fakePi;
  try {
    const first = await freshSession(cwd, "startup");
    await pi.command("goal", "stale replacement audit target — done when pinned", first);
    await tick();
    const audit = pi.runTool("complete_goal", {
      completionSummary: "A dropped host must not require manual auditor resume.",
      verificationSummary: "The replacement session retries the durable claim.",
    }, first);
    await waitUntil(() => (readState(cwd).goal as { status?: string } | null)?.status === "auditing");

    invalidateHostSession(pi, first);
    __testOnlyHeartbeatTick();
    const released = readState(cwd).goal as { status?: string; pendingCompletion?: { attemptId?: string; phase?: string } };
    assert.equal(released.status, "paused");
    assert.equal(released.pendingCompletion?.phase, "recovery-pending");
    const oldAttempt = released.pendingCompletion?.attemptId;
    assert.ok(oldAttempt);

    // No session_shutdown is delivered: this is the actual silent host-loss
    // shape. A file-backed successor session_start supplies the rebind proof.
    pi.sendMessageError = null;
    pi.sessionNameError = null;
    const successor = makeMockCtx(cwd, {
      sessionManager: {
        name: "stale-replacement-session-manager",
        getSessionFile: () => path.join(cwd, "stale-replacement-session.jsonl"),
        getSessionId: () => "stale-replacement-1",
      },
    });
    await pi.fire("session_start", { reason: "startup" }, successor);
    await waitUntil(() => readLedger(cwd).some((entry) => entry.type === "audit_recovery_started"));
    const restarted = readState(cwd).goal as { status?: string; pendingCompletion?: { attemptId?: string } } | null;
    assert.equal(restarted?.status, "auditing");
    assert.notEqual(restarted?.pendingCompletion?.attemptId, oldAttempt);
    assert.ok(successor.ui.matching("Fresh session recovered the interrupted completion audit").length >= 1);

    await waitUntil(() => {
      const settled = readState(cwd).goal as { status?: string; pendingCompletion?: unknown; auditHistory?: unknown[] } | null;
      return settled?.status === "active" && !settled.pendingCompletion && (settled.auditHistory?.length ?? 0) >= 1;
    });
    await pi.fire("session_shutdown", { reason: "quit" }, successor);
    await audit;
  } finally {
    pi.sendMessageError = null;
    pi.sessionNameError = null;
    __testOnlyResetOwnerSession();
    if (previous === undefined) delete process.env.GLLA_PI_BINARY;
    else process.env.GLLA_PI_BINARY = previous;
  }
});

test("v0.35.x: healthy same-session heartbeat recovers a parked completion audit without manual resume", { timeout: 15_000 }, async () => {
  __testOnlyResetStaleFlag();
  __testOnlyResetOwnerSession();
  __testOnlySetSessionReplacementUntil(0);
  const cwd = tmpCwd();
  const fakePi = writeFakeAuditor(cwd, "disapproved", 350);
  const previous = process.env.GLLA_PI_BINARY;
  process.env.GLLA_PI_BINARY = fakePi;
  try {
    const first = await freshSession(cwd, "startup");
    await pi.command("goal", "same-session stale completion target — done when pinned", first);
    await tick();
    const audit = pi.runTool("complete_goal", {
      completionSummary: "A stale heartbeat must not leave the completion claim idle.",
      verificationSummary: "A healthy same-session heartbeat retries the stored claim once.",
    }, first);
    await waitUntil(() => (readState(cwd).goal as { status?: string } | null)?.status === "auditing");

    invalidateHostSession(pi, first);
    __testOnlyHeartbeatTick();
    const parked = readState(cwd).goal as { status?: string; pendingCompletion?: { phase?: string } } | null;
    assert.equal(parked?.status, "paused", "the stale boundary parks the claim durably");
    assert.equal(parked?.pendingCompletion?.phase, "recovery-pending");

    // Restore the same mock host without delivering session_start. Before the
    // heartbeat gate fix, the parked status returned before probing this
    // healthy handle, so the objective stayed idle forever.
    pi.sendMessageError = null;
    pi.sessionNameError = null;
    first.isIdle = () => true;
    first.hasPendingMessages = () => false;
    await waitUntil(() => {
      __testOnlyHeartbeatTick();
      return readLedger(cwd).some((entry) => entry.type === "audit_recovery_started");
    }, 4_000);

    const retrying = readState(cwd).goal as { status?: string; pendingCompletion?: { phase?: string; automaticRecoveryAttempted?: boolean } } | null;
    assert.equal(retrying?.status, "auditing", "healthy heartbeat starts the bounded recovery audit");
    assert.equal(retrying?.pendingCompletion?.phase, "running");
    assert.equal(retrying?.pendingCompletion?.automaticRecoveryAttempted, true);
    assert.equal(readLedger(cwd).filter((entry) => entry.type === "audit_recovery_auto_retry_claimed").length, 1);

    await waitUntil(() => {
      const settled = readState(cwd).goal as { status?: string; pendingCompletion?: unknown; auditHistory?: unknown[] } | null;
      return settled?.status === "active" && !settled.pendingCompletion && (settled.auditHistory?.length ?? 0) >= 1;
    });
    await pi.fire("session_shutdown", { reason: "quit" }, first);
    await audit;
  } finally {
    pi.sendMessageError = null;
    pi.sessionNameError = null;
    __testOnlySetSessionReplacementUntil(null);
    __testOnlyResetOwnerSession();
    if (previous === undefined) delete process.env.GLLA_PI_BINARY;
    else process.env.GLLA_PI_BINARY = previous;
  }
});

test("v0.36.0: exhausted no-verdict auditor chain parks without an automatic recovery timer", { timeout: 60_000 }, async () => {
  __testOnlyResetStaleFlag();
  __testOnlySetAuditorRecoveryRetryDelay(120);
  const cwd = tmpCwd();
  const previous = process.env.GLLA_PI_BINARY;
  process.env.GLLA_PI_BINARY = writeFakeAuditorError(cwd, "Auditor stalled — no progress");
  let ctx: MockCtx | undefined;
  try {
    // Detached process startup can exceed a few seconds on the busy release
    // rig; wait for the durable event rather than making a one-shot 12s
    // launch assumption.
    ctx = await freshSession(cwd, "startup");
    await pi.command("goal", "recover a no-verdict auditor failure — done when pinned", ctx);
    await tick();
    await pi.runTool("complete_goal", { completionSummary: "Stored claim", verificationSummary: "Stored evidence" }, ctx);
    await waitUntil(() => readLedger(cwd).some((entry) => entry.type === "auditor_fallback_exhausted"), 30_000);

    const parked = readState(cwd).goal as { status?: string; pauseKind?: string; pauseResumeAt?: string; pendingCompletion?: { phase?: string; recoveryRetryAt?: string; automaticRecoveryAttempted?: boolean; auditorFallbackExhausted?: boolean; auditorFailureClass?: string } } | null;
    assert.equal(parked?.status, "paused");
    assert.equal(parked?.pendingCompletion?.phase, "recovery-pending");
    assert.equal(parked?.pauseKind, "error", "an exhausted no-verdict chain requires explicit resume");
    assert.equal(parked?.pauseResumeAt, undefined);
    assert.equal(parked?.pendingCompletion?.recoveryRetryAt, undefined);
    assert.equal(parked?.pendingCompletion?.automaticRecoveryAttempted, undefined);
    assert.equal(parked?.pendingCompletion?.auditorFallbackExhausted, true);
    assert.ok(parked?.pendingCompletion?.auditorFailureClass, "the concrete infrastructure class remains durable");

    const ledger = readLedger(cwd);
    assert.equal(ledger.filter((entry) => entry.type === "audit_recovery_auto_retry_claimed").length, 0, "exhaustion does not arm a generic automatic recovery");
    assert.equal(ledger.filter((entry) => entry.type === "audit_recovery_retry_scheduled").length, 0, "the exhausted chain has no automatic retry timer");
  } finally {
    // Clean up even when an assertion/timeout fails; otherwise a detached
    // fake auditor can poison the next recovery test in this shared process.
    if (ctx) await pi.fire("session_shutdown", { reason: "quit" }, ctx).catch(() => {});
    pi.sendMessageError = null;
    pi.sessionNameError = null;
    __testOnlySetAuditorRecoveryRetryDelay(null);
    __testOnlyResetOwnerSession();
    if (previous === undefined) delete process.env.GLLA_PI_BINARY;
    else process.env.GLLA_PI_BINARY = previous;
  }
});

test("v0.36.0: aggressive mode parks an exhausted no-verdict auditor chain", { timeout: 60_000 }, async () => {
  // v0.35.15: budget raised 30s→60s — this real-timer test observed 23s on
  // a busy machine (the auditor's own release:check ran concurrently with
  // an active session) and blew the per-test ceiling, fast-failing the
  // whole release check. The budget adds no wall time; it only stops load
  // spikes from killing the gate.
  // v0.35.19/v0.35.61: raised the test budget again with wait budgets
  // 25s→45s→90s / 8s→20s→30s — at machine load ~50 (16 cores) each
  // fake-auditor subprocess spawn cycle can take many seconds, and TWO retry
  // cycles legitimately exceed the old budget. Budgets only; semantics
  // untouched.
  __testOnlyResetStaleFlag();
  __testOnlySetAuditorRecoveryRetryDelay(120);
  const cwd = tmpCwd();
  fs.mkdirSync(path.join(cwd, ".pi-glla"), { recursive: true });
  fs.writeFileSync(path.join(cwd, ".pi-glla", "settings.json"), JSON.stringify({ aggressiveMode: true }));
  const previous = process.env.GLLA_PI_BINARY;
  process.env.GLLA_PI_BINARY = writeFakeAuditorError(cwd, "Auditor stalled — no progress");
  let ctx: MockCtx | undefined;
  try {
    ctx = await freshSession(cwd, "startup");
    await pi.command("goal", "aggressive no-verdict recovery — done when the stored claim is audited", ctx);
    await tick();
    await pi.runTool("complete_goal", { completionSummary: "Stored claim", verificationSummary: "Stored evidence" }, ctx);

    await waitUntil(() => readLedger(cwd).some((entry) => entry.type === "auditor_fallback_exhausted"), 30_000);

    const persisted = readState(cwd).goal as {
      status?: string;
      pauseKind?: string;
      pauseResumeAt?: string;
      pendingCompletion?: {
        phase?: string;
        auditorFallbackExhausted?: boolean;
        auditorFailureClass?: string;
        recoveryRetryAt?: string;
        automaticRecoveryAttempts?: number;
        automaticRecoveryUntil?: string;
      };
    } | null;
    assert.equal(persisted?.status, "paused");
    assert.equal(persisted?.pauseKind, "error");
    assert.equal(persisted?.pauseResumeAt, undefined);
    assert.equal(persisted?.pendingCompletion?.phase, "recovery-pending");
    assert.equal(persisted?.pendingCompletion?.auditorFallbackExhausted, true);
    assert.equal(persisted?.pendingCompletion?.recoveryRetryAt, undefined);
    assert.ok(persisted?.pendingCompletion?.auditorFailureClass, "aggressive mode preserves the concrete failure class");
    assert.equal(persisted?.pendingCompletion?.automaticRecoveryAttempts, undefined, "candidate fallback is not a second generic recovery horizon");
    assert.equal(persisted?.pendingCompletion?.automaticRecoveryUntil, undefined);
    assert.equal(readLedger(cwd).filter((entry) => entry.type === "audit_recovery_retry_scheduled").length, 0, "aggressive mode does not retry an exhausted candidate chain");
  } finally {
    if (ctx) await pi.fire("session_shutdown", { reason: "quit" }, ctx).catch(() => {});
    pi.sendMessageError = null;
    pi.sessionNameError = null;
    __testOnlySetAuditorRecoveryRetryDelay(null);
    __testOnlyResetOwnerSession();
    if (previous === undefined) delete process.env.GLLA_PI_BINARY;
    else process.env.GLLA_PI_BINARY = previous;
  }
});

test("v0.35.x: stale host loss releases an in-flight completion audit without a verdict", { timeout: 30_000 }, async () => {
  __testOnlyResetStaleFlag();
  const cwd = tmpCwd();
  const fakePi = writeFakeAuditorError(cwd, "Auditor stalled — no progress", 100);
  const previous = process.env.GLLA_PI_BINARY;
  process.env.GLLA_PI_BINARY = fakePi;
  try {
    const first = await freshSession(cwd, "startup");
    await pi.command("goal", "start no-verdict host-loss target — done when pinned", first);
    await tick();
    const audit = pi.runTool("complete_goal", {
      completionSummary: "The claim must survive a dead auditor host.",
      verificationSummary: "No semantic verdict is allowed when the host disappears.",
    }, first);
    await waitUntil(() => (readState(cwd).goal as { status?: string } | null)?.status === "auditing");

    invalidateHostSession(pi, first);
    __testOnlyHeartbeatTick();
    // The replacement is a fresh host transport; clear the mock's injected
    // stale errors before exercising its explicit recovery command.
    pi.sendMessageError = null;
    pi.sessionNameError = null;

    const released = readState(cwd).goal as {
      status: string;
      pauseKind?: string;
      pauseReason?: string;
      pendingCompletion?: { phase?: string; attemptId?: string; completionSummary?: string };
    };
    assert.equal(released.status, "paused", "host loss releases MAIN instead of leaving it auditing");
    assert.equal(released.pauseKind, "blocked");
    assert.match(released.pauseReason ?? "", /completion audit blocked — no verdict/);
    assert.equal(released.pendingCompletion?.phase, "recovery-pending");
    assert.ok(released.pendingCompletion?.completionSummary?.startsWith("The claim must survive a dead auditor host."));
    const ledger = fs.readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf8");
    assert.match(ledger, /"audit_recovery_pending"/);
    assert.match(ledger, /"mainReleased":true/);

    // A live file-backed successor may reclaim MAIN ownership. It is a
    // validated recovery signal, so it spends the single durable automatic
    // retry instead of leaving the no-verdict claim parked forever.
    const successor = makeMockCtx(cwd, {
      sessionManager: {
        name: "audit-successor-session-manager",
        getSessionFile: () => path.join(cwd, "audit-successor-session.jsonl"),
        getSessionId: () => "audit-successor-1",
      },
    });
    const res = await pi.runTool("list_add", { items: ["after no-verdict recovery"] }, successor);
    assert.doesNotMatch(res.content[0]!.text, /only the MAIN session owns/);
    await waitUntil(() => readLedger(cwd).some((entry) => entry.type === "audit_recovery_started"), 30_000);
    const afterSuccessor = readState(cwd).goal as { status: string; pendingCompletion?: { phase?: string; automaticRecoveryAttempted?: boolean } };
    assert.equal(afterSuccessor.status, "auditing", "successor starts the bounded no-verdict recovery audit");
    assert.equal(afterSuccessor.pendingCompletion?.phase, "running");
    assert.equal(afterSuccessor.pendingCompletion?.automaticRecoveryAttempted, true);
    const afterLedger = fs.readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf8");
    assert.equal((afterLedger.match(/"audit_recovery_started"/g) ?? []).length, 1, "successor launches one recovery retry");
    assert.equal((afterLedger.match(/"audit_recovery_auto_retry_claimed"/g) ?? []).length, 1, "successor claims the durable retry once");

    // v0.35.17: 30s deadline — the chain spans a real detached worker
    // process plus the recovery retry; under heavy machine load (observed
    // load avg 12-16) the old 8s bound expired before the worker started.
    await waitUntil(() => {
      const settled = readState(cwd).goal as { status?: string; pendingCompletion?: { phase?: string; automaticRecoveryAttempted?: boolean } } | null;
      return settled?.status === "paused"
        && settled.pendingCompletion?.phase === "recovery-pending"
        && settled.pendingCompletion?.automaticRecoveryAttempted === true;
    }, 30_000);
    const exhausted = readLedger(cwd);
    assert.equal(exhausted.filter((entry) => entry.type === "audit_recovery_auto_retry_claimed").length, 1, "the failed automatic retry is not repeated");
    assert.equal(exhausted.filter((entry) => entry.type === "audit_recovery_retry_scheduled").length, 0, "the failed one-shot retry does not re-arm itself");
    await pi.fire("session_shutdown", { reason: "quit" }, successor);
    await audit;
    __testOnlyResetOwnerSession();
  } finally {
    pi.sendMessageError = null;
    pi.sessionNameError = null;
    __testOnlyResetOwnerSession();
    if (previous === undefined) delete process.env.GLLA_PI_BINARY;
    else process.env.GLLA_PI_BINARY = previous;
  }
});

test("v0.34.29: audit fan-out honors autoAcceptDrafts without opening confirmation", async () => {
  __testOnlyResetStaleFlag();
  const cwd = tmpCwd();
  fs.mkdirSync(path.join(cwd, ".pi-glla"), { recursive: true });
  fs.writeFileSync(path.join(cwd, ".pi-glla", "settings.json"), JSON.stringify({ autoAcceptDrafts: true }));
  seedState(cwd, { goal: seedGoal({ status: "paused" }) });
  const ctx = await freshSession(cwd, "startup");
  const findingsDir = path.join(cwd, ".pi-glla", "audit-loop");
  fs.mkdirSync(findingsDir, { recursive: true });
  fs.writeFileSync(path.join(findingsDir, "findings.md"), "- [ ] HIGH: auto-accepted finding (goal.ts:1)\\n");

  let confirmCalled = false;
  ctx.ui.confirmImpl = async () => {
    confirmCalled = true;
    return false;
  };
  await __testOnlyRunFanOutListAuditFindings(cwd);

  assert.equal(confirmCalled, false, "autoAcceptDrafts skips the fan-out confirmation");
  assert.equal((readState(cwd).list ?? []).length, 1, "the finding is queued despite no dialog");
  const ledger = fs.readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf8");
  assert.match(ledger, /\"list_audit_fanout\"/);
  assert.match(ledger, /\"autoAccepted\":true/);
  assert.ok(ctx.ui.matching("Auto-accepted by autoAcceptDrafts").length >= 1, "the bypass is visible");
  await pi.fire("session_shutdown", { reason: "quit" }, ctx);
});

test("v0.34.129: fan-out dedupe does not drop a finding whose prefix appears inside another queue item", async () => {
  __testOnlyResetStaleFlag();
  const cwd = tmpCwd();
  const finding = "HIGH: distinct finding with a shared leading phrase that must still be queued (orchestrator.ts:793)";
  const collidingPrefix = finding.slice(0, 60);
  fs.mkdirSync(path.join(cwd, ".pi-glla"), { recursive: true });
  fs.writeFileSync(path.join(cwd, ".pi-glla", "settings.json"), JSON.stringify({ autoAcceptDrafts: true }));
  seedState(cwd, {
    goal: seedGoal({ status: "paused" }),
    list: [{ id: "unrelated-queued-item", objective: `unrelated queued context: ${collidingPrefix}`, addedAt: new Date().toISOString() }],
  });
  const ctx = await freshSession(cwd, "startup");
  const findingsDir = path.join(cwd, ".pi-glla", "audit-loop");
  fs.mkdirSync(findingsDir, { recursive: true });
  fs.writeFileSync(path.join(findingsDir, "findings.md"), `- [ ] FIX: ${finding}\n`);

  await __testOnlyRunFanOutListAuditFindings(cwd);

  const after = readState(cwd);
  assert.equal(after.list?.length, 2, "the distinct finding is queued beside the unrelated item");
  assert.ok(after.list?.some((item) => item.objective.startsWith(`Fix audit finding: ${finding}`)), "the canonical finding item landed");
  const event = ledgerEvent(cwd, "list_audit_fanout");
  assert.equal(event.value.alreadyQueued, 0, "substring collision is not counted as already queued");
  assert.equal(event.value.deferredByCap, 0, "no item was deferred by the cap");
  await pi.fire("session_shutdown", { reason: "quit" }, ctx);
});

test("v0.34.129: fan-out reports cap-deferred findings separately from true queue dedupes", async () => {
  __testOnlyResetStaleFlag();
  const cwd = tmpCwd();
  fs.mkdirSync(path.join(cwd, ".pi-glla"), { recursive: true });
  fs.writeFileSync(path.join(cwd, ".pi-glla", "settings.json"), JSON.stringify({ autoAcceptDrafts: true }));
  seedState(cwd, { goal: seedGoal({ status: "paused" }) });
  const ctx = await freshSession(cwd, "startup");
  const findingsDir = path.join(cwd, ".pi-glla", "audit-loop");
  fs.mkdirSync(findingsDir, { recursive: true });
  const findings = Array.from({ length: 51 }, (_, i) => `- [ ] FIX: LOW: cap-only finding ${String(i + 1).padStart(2, "0")} (cap.ts:${i + 1})`).join("\n") + "\n";
  fs.writeFileSync(path.join(findingsDir, "findings.md"), findings);

  await __testOnlyRunFanOutListAuditFindings(cwd);

  assert.equal(readState(cwd).list?.length, 50, "one fan-out enqueues at most 50 findings");
  const event = ledgerEvent(cwd, "list_audit_fanout");
  assert.equal(event.value.alreadyQueued, 0, "none were already queued");
  assert.equal(event.value.deferredByCap, 1, "the 51st finding is counted as cap-deferred");
  assert.ok(ctx.ui.matching("1 more held by the 50-item cap").length >= 1, "the cap deferral is visible to the user");
  await pi.fire("session_shutdown", { reason: "quit" }, ctx);
});

test("v0.34.20 lifecycle: fan-out confirmation from the old generation cannot queue into its replacement", async () => {
  __testOnlyResetStaleFlag();
  const cwd = tmpCwd();
  const first = await freshSession(cwd, "startup");
  const findingsDir = path.join(cwd, ".pi-glla", "audit-loop");
  fs.mkdirSync(findingsDir, { recursive: true });
  fs.writeFileSync(path.join(findingsDir, "findings.md"), "- [ ] HIGH: lifecycle finding (goal.ts:1)\n");

  let confirmEntered = false;
  let releaseConfirm!: (value: boolean) => void;
  const confirmation = new Promise<boolean>((resolve) => { releaseConfirm = resolve; });
  first.ui.confirmImpl = async () => {
    confirmEntered = true;
    return confirmation;
  };
  const fanout = __testOnlyRunFanOutListAuditFindings(cwd);
  for (let i = 0; i < 50 && !confirmEntered; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(confirmEntered, true, "fan-out reached the confirmation boundary");

  const replacement = ownerCtx(cwd);
  await pi.fire("session_start", { reason: "reload" }, replacement);
  releaseConfirm(true);
  await fanout;

  const after = readState(cwd);
  assert.equal(after.list?.length ?? 0, 0, "old confirmation did not enqueue into the replacement session");
  const ledger = fs.readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf8");
  assert.doesNotMatch(ledger, /"list_audit_fanout"/, "no stale fan-out mutation was ledgered");
  assert.equal(replacement.ui.matching("Queued ").length, 0, "replacement UI did not claim the old consent landed");
  await pi.fire("session_shutdown", { reason: "quit" }, replacement);
});

test("v0.34.20 lifecycle: loop measurement abandons the old generation after replacement", async () => {
  __testOnlyResetStaleFlag();
  const cwd = tmpCwd();
  seedState(cwd, { loop: seedLoop({ active: true, measureCmd: "echo 7" }) });
  setGlobalAutoResume(true); // keep the seeded loop active through reload
  let measureStarted = false;
  let releaseMeasure!: () => void;
  const measureGate = new Promise<void>((resolve) => { releaseMeasure = resolve; });
  let calls = 0;
  pi.execHandler = async () => {
    calls++;
    measureStarted = true;
    await measureGate;
    return { code: 0, stdout: "7", stderr: "" };
  };
  try {
    const first = await freshSession(cwd, "reload");
    const oldTick = pi.fire("agent_end", { messages: [{ role: "assistant", content: [{ type: "text", text: "measured" }], stopReason: "end_turn" }] }, first);
    for (let i = 0; i < 50 && !measureStarted; i++) await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(measureStarted, true, "loop tick reached the asynchronous measure");

    const replacement = ownerCtx(cwd);
    await pi.fire("session_start", { reason: "reload" }, replacement);
    // Prevent the replacement's restore scheduling from starting another turn;
    // the assertion is about the already-running old tick.
    await pi.fire("session_shutdown", { reason: "quit" }, replacement);
    releaseMeasure();
    await oldTick;

    const loop = readState(cwd).loop as { iteration: number; lastValue?: number | null };
    assert.equal(loop.iteration, 1, "the old tick did not advance the persisted loop");
    assert.equal(loop.lastValue, null, "the old measure did not update loop state");
    const ledger = fs.readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf8");
    assert.equal((ledger.match(/"loop_measured"/g) ?? []).length, 0, "the old tick did not persist a measurement");
    assert.equal(calls, 1, "replacement cleanup prevented a second old-generation measure");
  } finally {
    releaseMeasure();
    pi.execHandler = null;
  }
});

test("v0.34.25: a resolved auditor model failure advances to the session fallback without a verdict", async () => {
  const calls: string[] = [];
  const result = await runDetachedCompletionWithFallback(
    [
      { model: "provider/primary", via: "setting" },
      { model: "provider/session", via: "session-fallback" },
    ],
    async (candidate) => {
      calls.push(candidate.model as string);
      if (candidate.via === "setting") {
        return {
          approved: false,
          disapproved: false,
          output: "",
          model: candidate.model as string,
          thinkingLevel: "high",
          error: "pi exited without an agent_settled RPC event",
        };
      }
      return {
        approved: true,
        disapproved: false,
        output: "<evidence>fallback read</evidence>\\n<approved/>",
        model: candidate.model as string,
        thinkingLevel: "high",
      };
    },
    { sleep: async () => {}, shouldRetry: () => true },
  );
  assert.deepEqual(calls, ["provider/primary", "provider/primary", "provider/session"], "the primary is retried once, then the session fallback is detached");
  assert.equal(result.result.approved, true);
  assert.equal(result.fallbackUsed, true);
  assert.equal(result.via, "session-fallback");
});

test("v0.35.x: zero-stream zombie auto-aborts and parks a list item without a retry storm", async () => {
  __testOnlyResetStaleFlag();
  __testOnlyResetOwnerSession();
  __testOnlySetZombieRunWindows(0, 0);
  __testOnlySetZombieRetryMaxAttempts(1);
  const cwd = tmpCwd();
  const ctx = await freshSession(cwd, "reload");
  ctx.isIdle = () => false;
  let aborts = 0;
  ctx.abort = () => { aborts++; };
  try {
    const added = await pi.runTool("list_add", {
      items: ["zero-stream zombie item — done when the bounded abort is proven"],
    }, ctx);
    assert.match(added.content[0]?.text ?? "", /active/i);
    const active = readState(cwd).goal as { id: string; policy: string; status: string } | null;
    assert.equal(active?.policy, "list");
    assert.equal(active?.status, "active");

    // The timer-created continuation is intentionally left without a turn;
    // the heartbeat sees a genuinely busy host with no stream proof. Clear
    // any prior test's compaction grace because this watchdog is intentionally
    // testing the post-grace production path.
    (globalThis as any).compactionGraceUntil = 0;
    (globalThis as any).postCompletionSettleUntil = 0;
    __testOnlyHeartbeatTick();
    const parked = readState(cwd).goal as {
      status?: string;
      pauseKind?: string;
      pauseReason?: string;
      pauseSuggestedAction?: string;
    } | null;

    assert.equal(aborts, 1, "the confirmed zero-stream turn is aborted once");
    assert.equal(parked?.status, "paused", "the list item is no longer falsely ACTIVE");
    assert.equal(parked?.pauseKind, "error");
    assert.match(parked?.pauseReason ?? "", /zero-stream abort/);
    assert.match(parked?.pauseSuggestedAction ?? "", /\/list resume/);
    assert.match(parked?.pauseSuggestedAction ?? "", /\/list cancel/);
    const afterAbort = readLedger(cwd);
    assert.equal(afterAbort.filter((entry) => entry.type === "zombie_run_aborted").length, 1);
    // Pin this legacy-focused test to one retry; the dedicated retry test
    // covers the production default of repeated bounded recovery.
    assert.equal(afterAbort.filter((entry) => entry.type === "zombie_auto_retry_scheduled").length, 1);

    const sendsBefore = pi.sent.length;
    await tick(200);
    assert.equal(pi.sent.length, sendsBefore, "cleanup does not blind-retry the wedged item (the retry waits out its delay)");
    assert.equal(readLedger(cwd).filter((entry) => entry.type === "zombie_run_aborted").length, 1, "heartbeat ticks do not repeat the abort");

    // Explicit list resume is the only re-entry path and may dispatch one
    // fresh attempt after the user has restored an idle host.
    ctx.isIdle = () => true;
    await pi.command("list", "resume", ctx);
    await tick(100);
    assert.equal((readState(cwd).goal as { status?: string } | null)?.status, "active");
    assert.equal(pi.sent.length, sendsBefore + 1, "resume creates exactly one fresh dispatch");
  } finally {
    __testOnlyResetZombieRunWatchdog();
    __testOnlySetZombieRetryMaxAttempts(null);
    __testOnlyResetZombieAutoRetry();
    await pi.fire("session_shutdown", { reason: "quit" }, ctx);
  }
});

test("v0.35.x: zero-stream loop termination preserves and notifies its recap", async () => {
  __testOnlyResetStaleFlag();
  __testOnlyResetOwnerSession();
  __testOnlySetZombieRunWindows(0, 0);
  __testOnlySetZombieRetryMaxAttempts(1);
  setGlobalAutoResume(true);
  const cwd = tmpCwd();
  seedState(cwd, { loop: seedLoop({ active: true, iteration: 6, bestValue: 4, lastValue: 4 }) });
  const ctx = await freshSession(cwd, "reload");
  ctx.isIdle = () => false;
  let aborts = 0;
  ctx.abort = () => { aborts++; };
  try {
    (globalThis as any).compactionGraceUntil = 0;
    (globalThis as any).postCompletionSettleUntil = 0;
    __testOnlyHeartbeatTick();
    const loop = readState(cwd).loop as { active: boolean; stopReason?: string; completionSummary?: string };
    assert.equal(aborts, 1, "the loop zero-stream turn is aborted once");
    assert.equal(loop.active, false);
    assert.match(loop.stopReason ?? "", /zero-stream abort/);
    for (const label of ["Outcome:", "Changed:", "Evidence:", "Tests:", "Unresolved:", "Next:"]) assert.match(loop.completionSummary ?? "", new RegExp(label));
    const recap = ctx.ui.notifies.find((notice) => notice.message.includes("Recap: Outcome:"));
    assert.ok(recap, "zero-stream loop notification includes the compact six-label recap");
  } finally {
    __testOnlyResetZombieRunWatchdog();
    __testOnlySetZombieRetryMaxAttempts(null);
    __testOnlyResetZombieAutoRetry();
    await pi.fire("session_shutdown", { reason: "quit" }, ctx);
  }
});

test("v0.35.4: zombie watchdog stands down while a subagent wait is in flight", async () => {
  __testOnlyResetStaleFlag();
  __testOnlyResetOwnerSession();
  __testOnlyClearSubagentHangProbes();
  __testOnlySetZombieRunWindows(0, 0);
  const cwd = tmpCwd();
  const ctx = await freshSession(cwd, "reload");
  ctx.isIdle = () => false;
  let aborts = 0;
  ctx.abort = () => { aborts++; };
  try {
    const added = await pi.runTool("list_add", {
      items: ["zombie carve-out item — done when the subagent-wait stand-down is proven"],
    }, ctx);
    assert.match(added.content[0]?.text ?? "", /active/i);
    (globalThis as any).compactionGraceUntil = 0;
    (globalThis as any).postCompletionSettleUntil = 0;

    // A live subagent-hang probe = the parent is BUSY-waiting on a child;
    // stream silence is expected and the bounded abort must NOT fire.
    upsertSubagentHangProbe("probe-carveout-1", "Explore", "carve-out probe");
    __testOnlyHeartbeatTick();
    assert.equal(aborts, 0, "a live subagent wait stands down the zombie abort");
    assert.equal((readState(cwd).goal as { status?: string } | null)?.status, "active");
    assert.equal(readLedger(cwd).filter((entry) => entry.type === "zombie_run_stood_down_subagent_wait").length, 1);
    assert.equal(readLedger(cwd).filter((entry) => entry.type === "zombie_run_aborted").length, 0);

    // The wait ends (subagent completed) → the next tick aborts as before.
    endSubagentHangProbe("probe-carveout-1");
    __testOnlyHeartbeatTick();
    assert.equal(aborts, 1, "abort proceeds once the wait is gone");
    assert.equal((readState(cwd).goal as { status?: string } | null)?.status, "paused");
  } finally {
    __testOnlyClearSubagentHangProbes();
    __testOnlyResetZombieRunWatchdog();
    await pi.fire("session_shutdown", { reason: "quit" }, ctx);
  }
});

test("v0.35.64: a stale subagent probe no longer shields unrelated parent cleanup", async () => {
  __testOnlyResetStaleFlag();
  __testOnlyResetOwnerSession();
  __testOnlyClearSubagentHangProbes();
  __testOnlySetZombieRunWindows(0, 0);
  const cwd = tmpCwd();
  const ctx = await freshSession(cwd, "reload");
  ctx.isIdle = () => false;
  let aborts = 0;
  ctx.abort = () => { aborts++; };
  const managerKey = Symbol.for("pi-subagents:manager");
  const previousManager = (globalThis as any)[managerKey];
  (globalThis as any)[managerKey] = { getRecord: () => undefined };
  try {
    const added = await pi.runTool("list_add", {
      items: ["stale child must not shield parent cleanup — done when the watchdog remains independent"],
    }, ctx);
    assert.match(added.content[0]?.text ?? "", /active/i);
    (globalThis as any).compactionGraceUntil = 0;
    (globalThis as any).postCompletionSettleUntil = 0;
    upsertSubagentHangProbe("stale-shield-child", "Explore", "stale child");
    const probe = __testOnlySubagentHangProbes().find((candidate) => candidate.recordId === "stale-shield-child")!;
    probe.lastProgressAt = Date.now() - 21 * 60_000;

    __testOnlyHeartbeatTick();
    assert.equal(aborts, 1, "the stale child does not suppress the unrelated parent zombie abort");
    assert.equal(readLedger(cwd).filter((entry) => entry.type === "zombie_run_aborted").length, 1);
  } finally {
    if (previousManager === undefined) delete (globalThis as any)[managerKey];
    else (globalThis as any)[managerKey] = previousManager;
    __testOnlyClearSubagentHangProbes();
    __testOnlyResetZombieRunWatchdog();
    await pi.fire("session_shutdown", { reason: "quit" }, ctx);
  }
});

test("v0.35.4: context-starved warning is one-shot per refusal episode", async () => {
  __testOnlyResetStaleFlag();
  __testOnlyResetOwnerSession();
  const cwd = tmpCwd();
  // Seed the goal directly and opt into global autoResume so session_start
  // runs the real restore gate into an ACTIVE goal. That path arms the
  // first continuation dispatch; clear the dispatch plane (timer + start
  // watchdog + dispatch record) so the heartbeat's refire gate passes —
  // exactly the production shape after the starved yield path refused to
  // schedule a continuation.
  seedState(cwd, { goal: seedGoal({ objective: "starved one-shot item — done when the refusal warning is proven one-shot" }) });
  setGlobalAutoResume(true);
  const ctx = await freshSession(cwd, "reload");
  resetContinuationDispatchState(cwd);
  clearContinuationTimer();
  (globalThis as any).compactionGraceUntil = 0;
  (globalThis as any).postCompletionSettleUntil = 0;
  try {
    const yieldOnce = () => (globalThis as any).noteContextStarvedYield();
    // Backdate the quiet window so the refire gate (>= 60s) passes.
    (globalThis as any).lastActivityAt = Date.now() - 120_000;
    yieldOnce();
    yieldOnce();
    __testOnlyHeartbeatTick();
    assert.equal(readLedger(cwd).filter((entry) => entry.type === "continuation_refused_context_starved").length, 1);
    __testOnlyHeartbeatTick();
    __testOnlyHeartbeatTick();
    assert.equal(readLedger(cwd).filter((entry) => entry.type === "continuation_refused_context_starved").length, 1, "no re-fire while the same refusal episode holds");

    // Compaction lands → the refusal clears → no warning while cleared.
    (globalThis as any).onCompactionLanded();
    __testOnlyHeartbeatTick();
    assert.equal(readLedger(cwd).filter((entry) => entry.type === "continuation_refused_context_starved").length, 1, "cleared episode does not re-fire");
    // That tick's refire path re-armed a continuation timer; clear the
    // dispatch plane again so the second episode reaches the starved branch.
    resetContinuationDispatchState(cwd);
    clearContinuationTimer();

    // A NEW refusal episode gets its own single warning (latch re-armed).
    (globalThis as any).lastActivityAt = Date.now() - 120_000;
    yieldOnce();
    yieldOnce();
    __testOnlyHeartbeatTick();
    assert.equal(readLedger(cwd).filter((entry) => entry.type === "continuation_refused_context_starved").length, 2, "the next episode re-arms the one-shot");
  } finally {
    await pi.fire("session_shutdown", { reason: "quit" }, ctx);
  }
});
