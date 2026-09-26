// Field 2026-09-23: Pi emits session_compact_failed when compaction cannot
// finish. GLLA settles only its current-attempt marker, leaves willRetry to
// Pi, rotates only explicit terminal prompt overflow, and durably parks other
// terminal failures with /new + resume. Leaving the marker armed makes the UI
// claim WORKING/BUSY for up to 30 minutes.

import { test, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import activate, {
  __testOnlyPostCompactDebt,
  __testOnlyResetOwnerSession,
  __testOnlyResetPostCompactDebt,
  __testOnlyResetStaleFlag,
  __testOnlySetCompactionInFlight,
} from "../extensions/loops/goal.js";
import { readState } from "../extensions/goal-loop-core.js";
import { MockPi, makeMockCtx, seedGoal, seedLoop, seedState, tick, tmpCwd } from "./harness/mock-pi.ts";

const GLOBAL = process.env.GLLA_GLOBAL_SETTINGS_PATH!;
const original = fs.readFileSync(GLOBAL, "utf8");
let session: { pi: MockPi; ctx: any } | null = null;

function ledger(cwd: string): Array<{ type: string; value?: Record<string, unknown> }> {
  return fs.readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf8")
    .split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

async function boot(cwd: string, settings: Record<string, unknown>, model = "provider/small") {
  fs.writeFileSync(GLOBAL, JSON.stringify({ autoResume: true, aggressiveMode: false, ...settings }));
  __testOnlyResetOwnerSession();
  __testOnlyResetStaleFlag();
  const pi = new MockPi();
  activate(pi.api);
  const sessionId = `compact-fail-${Date.now()}-${Math.random()}`;
  const ctx = makeMockCtx(cwd, { sessionManager: { name: sessionId, getSessionId: () => sessionId } });
  (ctx as any).model = { provider: model.split("/")[0], id: model.split("/")[1] };
  (ctx as any).modelRegistry = {
    find: (provider: string, id: string) => ({ provider, id }),
    hasConfiguredAuth: () => true,
  };
  (ctx as any).getContextUsage = () => ({ tokens: 202_000, contextWindow: 200_000, percent: 101 });
  await pi.fire("session_start", { reason: "reload" }, ctx);
  await tick(80);
  session = { pi, ctx };
  return { pi, ctx };
}

afterEach(async () => {
  if (session) {
    const current = session;
    session = null;
    __testOnlySetCompactionInFlight(null);
    __testOnlyResetPostCompactDebt();
    await current.pi.fire("session_shutdown", { reason: "test-end" }, current.ctx).catch(() => {});
  }
  fs.writeFileSync(GLOBAL, original);
});

test("host-owned failed compaction retries without model rotation, park, or competing continuation", async () => {
  const cwd = tmpCwd();
  seedState(cwd, { goal: seedGoal({ status: "active", objective: "let Pi retry the failed compaction" }) });
  const { pi, ctx } = await boot(cwd, { mainModelFallbacks: ["provider/large"] });
  const sendsBeforeFailure = pi.sent.length;

  await pi.fire("session_before_compact", {}, ctx);
  await pi.fire("session_compact_failed", {
    reason: "overflow",
    errorMessage: "generation hit the token cap and the summary is incomplete",
    aborted: false,
    willRetry: true,
    fromExtension: false,
  }, ctx);
  await tick(80);

  assert.equal(pi.modelSelections.length, 0, "Pi remains the retry owner");
  assert.equal(readState(cwd).goal?.status, "active", "host retry does not park supervised work");
  assert.equal(pi.sent.length, sendsBeforeFailure, "GLLA does not dispatch a competing recovery probe");
  const failure = ledger(cwd).find((entry) => entry.type === "session_compact_failed");
  assert.equal(failure?.value?.failureKind, "retry-owned");
  assert.equal(failure?.value?.willRetry, true);
});

test("terminal prompt overflow rotates once and arms durable post-compact resume debt", async () => {
  const cwd = tmpCwd();
  seedState(cwd, { goal: seedGoal({ status: "active", objective: "survive failed compaction" }) });
  const { pi, ctx } = await boot(cwd, { mainModelFallbacks: ["provider/large"] });

  await pi.fire("session_before_compact", {}, ctx);
  await pi.fire("session_compact_failed", {
    reason: "overflow",
    errorMessage: "Context overflow recovery failed: maximum context length is 200000 tokens",
    aborted: false,
    willRetry: false,
    fromExtension: false,
  }, ctx);
  await tick(80);

  assert.ok(pi.modelSelections.length > 0, "configured larger-context fallback is selected");
  assert.ok(ledger(cwd).some((e) => e.type === "session_compact_failed" && e.value?.failureKind === "context-overflow"));
  assert.equal(ledger(cwd).filter((e) => e.type === "compaction_inflight_start").length, 1);
  assert.equal(ledger(cwd).filter((e) => e.type === "compaction_refire").length, 0, "no session_compact resume path was faked");
  const ctxAfter = (ctx as any);
  assert.equal(ctxAfter.isIdle(), true, "host returns idle after the failed compaction");
  assert.equal(readState(cwd).goal?.status, "active", "successful fallback keeps work moving");
  // The fast-path probe must be a non-empty post-compact resync, not a bare or
  // empty continuation. Its ledger payloadChars is bounded by the normal
  // continuation assembler and proves GLLA retained durable resume debt.
  const probe = ledger(cwd).find((e) => e.type === "goal_continuation_sent");
  assert.ok(probe, "fallback queues the bounded recovery probe");
  assert.equal(typeof probe?.value?.payloadChars, "number");
  assert.ok(Number(probe?.value?.payloadChars) > 0);
  assert.deepEqual(__testOnlyPostCompactDebt(), { resumeOwed: true, resyncPending: true }, "the fast probe cannot strand a switched model without heartbeat debt");
  const persisted = readState(cwd) as { postCompactRecovery?: { sessionId?: string; resumeOwed?: boolean; resyncPending?: boolean } };
  assert.match(String(persisted.postCompactRecovery?.sessionId), /^compact-fail-/, "fallback debt is session-fenced");
  assert.equal(persisted.postCompactRecovery?.resumeOwed, true);
  assert.equal(persisted.postCompactRecovery?.resyncPending, true, "the debt survives a crash before the fast probe starts");
});

test("same-session startup restores fallback debt, while a new session discards it", async () => {
  const cwd = tmpCwd();
  seedState(cwd, {
    goal: seedGoal({ status: "active", objective: "restore post-compaction debt" }),
    postCompactRecovery: { sessionId: "same-session", at: Date.now(), resumeOwed: true, resyncPending: true },
  });
  fs.writeFileSync(GLOBAL, JSON.stringify({ autoResume: true, aggressiveMode: false, mainModelFallbacks: [] }));
  __testOnlyResetOwnerSession();
  __testOnlyResetStaleFlag();
  __testOnlyResetPostCompactDebt();
  const pi = new MockPi();
  activate(pi.api);
  const ctx = makeMockCtx(cwd, {
    sessionManager: {
      name: "compact-fail-same",
      getSessionId: () => "same-session",
      getSessionFile: () => path.join(cwd, "historical.jsonl"),
    },
  });
  (ctx as any).model = { provider: "provider", id: "small" };
  (ctx as any).modelRegistry = { find: () => undefined, hasConfiguredAuth: () => true };

  await pi.fire("session_start", { reason: "reload" }, ctx);
  await tick(80);
  assert.deepEqual(__testOnlyPostCompactDebt(), { resumeOwed: true, resyncPending: true });
  assert.ok(ledger(cwd).some((e) => e.type === "post_compact_recovery_restored"));

  __testOnlyResetPostCompactDebt();
  (ctx as any).sessionManager = {
    name: "compact-fail-new",
    getSessionId: () => "new-session",
    getSessionFile: () => path.join(cwd, "replacement.jsonl"),
  };
  await pi.fire("session_start", { reason: "new" }, ctx);
  await tick(80);
  assert.deepEqual(__testOnlyPostCompactDebt(), { resumeOwed: false, resyncPending: false });
  assert.equal((readState(cwd) as { postCompactRecovery?: unknown }).postCompactRecovery, undefined);
  assert.ok(ledger(cwd).some((e) => e.type === "post_compact_recovery_discarded"));
  session = { pi, ctx };
});

test("terminal output-cap failure parks instead of misclassifying it as context overflow", async () => {
  const cwd = tmpCwd();
  seedState(cwd, { goal: seedGoal({ status: "active", objective: "park an incomplete summary" }) });
  const { pi, ctx } = await boot(cwd, { mainModelFallbacks: ["provider/large"] });

  await pi.fire("session_before_compact", {}, ctx);
  await pi.fire("session_compact_failed", {
    reason: "threshold",
    errorMessage: "Auto-compaction failed: generation hit the token cap and the summary is incomplete",
    aborted: false,
    willRetry: false,
  }, ctx);

  const goal = readState(cwd).goal as { status?: string; pauseReason?: string };
  assert.equal(pi.modelSelections.length, 0, "an output-capped summary is not evidence of an undersized context window");
  assert.equal(goal.status, "paused");
  assert.match(goal.pauseReason ?? "", /summarization output limit/i);
  assert.ok(ledger(cwd).some((e) => e.type === "session_compact_failed" && e.value?.failureKind === "summarization-length"));
  assert.equal((readState(cwd) as { postCompactRecovery?: unknown }).postCompactRecovery, undefined, "parking a failed summary does not leave automatic recovery debt");
});

test("failed compaction without a usable fallback parks an active goal durably", async () => {
  const cwd = tmpCwd();
  seedState(cwd, { goal: seedGoal({ status: "active", objective: "park after failed compaction" }) });
  const { pi, ctx } = await boot(cwd, { mainModelFallbacks: [] });
  const sendsBeforeFailure = pi.sent.length;

  await pi.fire("session_before_compact", {}, ctx);
  await pi.fire("session_compact_failed", {
    reason: "overflow",
    errorMessage: "Context overflow recovery failed: summary incomplete",
    aborted: false,
    willRetry: false,
  }, ctx);

  const goal = readState(cwd).goal as { status?: string; pauseKind?: string; pauseReason?: string; pauseSuggestedAction?: string };
  assert.equal(goal.status, "paused");
  assert.equal(goal.pauseKind, "blocked");
  assert.match(goal.pauseReason ?? "", /summarization output limit/i);
  assert.match(goal.pauseSuggestedAction ?? "", /\/new[\s\S]*\/goal resume/);
  assert.equal(
    pi.sent.slice(sendsBeforeFailure).filter((s) => String(s.message.content ?? "").includes("[GOAL CHECKPOINT")).length,
    0,
    "no impossible hot-context retry",
  );
});

test("failed compaction parks a branch loop instead of leaving it active", async () => {
  const cwd = tmpCwd();
  seedState(cwd, { loop: seedLoop({ active: true, iteration: 4, target: "loop survives compaction failure" }) });
  const { pi, ctx } = await boot(cwd, { mainModelFallbacks: [] });

  await pi.fire("session_before_compact", {}, ctx);
  await pi.fire("session_compact_failed", {
    reason: "threshold",
    errorMessage: "Auto-compaction failed: generation hit the token cap",
    aborted: false,
    willRetry: false,
  }, ctx);

  const loop = readState(cwd).loop as { active?: boolean; stopReason?: string; iteration?: number };
  assert.equal(loop.active, false);
  assert.match(loop.stopReason ?? "", /summarization output limit/i);
  assert.equal(loop.iteration, 4, "history is preserved for /loop resume");
  assert.ok(ledger(cwd).some((e) => e.type === "loop_stopped" && e.value?.cause === "compaction_failed"));
});

test("a failed debt-discharge append keeps RAM debt instead of diverging from disk", async () => {
  const cwd = tmpCwd();
  seedState(cwd, {
    goal: seedGoal({ status: "active", objective: "debt discharge under disk failure" }),
    postCompactRecovery: { sessionId: "debt-kept", at: Date.now(), resumeOwed: true, resyncPending: true },
  });
  fs.writeFileSync(GLOBAL, JSON.stringify({ autoResume: true, aggressiveMode: false }));
  __testOnlyResetOwnerSession();
  __testOnlyResetStaleFlag();
  __testOnlyResetPostCompactDebt();
  const pi = new MockPi();
  activate(pi.api);
  const ctx = makeMockCtx(cwd, {
    sessionManager: {
      name: "debt-kept-sm",
      getSessionId: () => "debt-kept",
      getSessionFile: () => path.join(cwd, "debt.jsonl"),
    },
  });
  await pi.fire("session_start", { reason: "reload" }, ctx);
  await tick(80);
  assert.deepEqual(__testOnlyPostCompactDebt(), { resumeOwed: true, resyncPending: true }, "same-session restore arms the debt flags");
  // Break persistence: the state append now fails (an existing file appends
  // fine under a read-only dir, so the file itself goes read-only).
  const ledgerFile = path.join(cwd, ".pi-glla", "active.jsonl");
  fs.chmodSync(ledgerFile, 0o444);
  try {
    await pi.fire("agent_start", {}, ctx);
    assert.deepEqual(
      __testOnlyPostCompactDebt(),
      { resumeOwed: true, resyncPending: true },
      "RAM keeps the debt the disk still holds",
    );
  } finally {
    fs.chmodSync(ledgerFile, 0o644);
  }
  assert.equal(
    (readState(cwd) as { postCompactRecovery?: { resumeOwed?: boolean } }).postCompactRecovery?.resumeOwed,
    true,
    "the disk debt was never discharged",
  );
  session = { pi, ctx };
});
