import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import activate, { __testOnlyLoadState, __testOnlyResetOwnerSession, __testOnlyResetStaleFlag } from "../extensions/loops/goal.js";
import { __testOnlyResetCompactor, __testOnlySetSpawnWorker } from "../extensions/goal-compactor.js";
import { sendContinuation } from "../extensions/goal-continuation.js";
import { scheduleLoopTick, clearLoopTimer } from "../extensions/goal-loop.js";
import { MockPi, makeMockCtx, seedGoal, seedState, tmpCwd, tick } from "./harness/mock-pi.js";

afterEach(() => { __testOnlyResetCompactor(); __testOnlyResetOwnerSession(); __testOnlyResetStaleFlag(); });

for (const fail of [false, true]) {
  test(`idle loop dispatch checks the threshold without agent_settled (failure=${fail})`, async () => {
    const cwd = tmpCwd(), pi = new MockPi(); activate(pi.api);
    const ctx = makeMockCtx(cwd, { sessionManager: { name: `compact-loop-${fail}` } });
    let tokens = 50_000, compacts = 0, idle = true;
    ctx.isIdle = () => idle;
    ctx.getContextUsage = () => ({ tokens, contextWindow: 1_000_000, percent: tokens / 10_000 });
    ctx.compact = options => {
      compacts++;
      if (fail) options?.onError?.(new Error("summarizer unavailable"));
      else idle = false;
    };
    __testOnlySetSpawnWorker(async () => ({ ok: true, brief: "Continue this loop." }));
    await pi.fire("session_start", { reason: "startup" }, ctx);
    try {
      await pi.command("loop", "start develop the intended project", ctx);
      clearLoopTimer(); pi.sent.length = 0;
      tokens = 315_000;
      scheduleLoopTick(ctx as unknown as ExtensionContext);
      await tick(150);
      assert.equal(compacts, 1, "a loop turn must check compaction before dispatch");
      assert.equal(pi.sent.filter(s => (s.options as { triggerTurn?: boolean })?.triggerTurn === true).length, fail ? 1 : 0,
        "success yields to compaction; failure resumes ordinary work without repeated attempts");
    } finally { clearLoopTimer(); await pi.fire("session_shutdown", { reason: "test-end" }, ctx); }
  });
}

for (const guard of ["paused", "auditing", "frozen", "aborted"] as const) {
  test(`settled and idle-send compaction preserve ${guard}`, async () => {
    const cwd = tmpCwd(), pi = new MockPi(); activate(pi.api);
    __testOnlyResetOwnerSession(); __testOnlyResetStaleFlag();
    const ctx = makeMockCtx(cwd, { sessionManager: { name: `compact-guard-${guard}` } });
    await pi.fire("session_start", { reason: "startup" }, ctx);
    const g = seedGoal({ status: guard === "paused" || guard === "auditing" ? guard : "active", autoContinue: true });
    seedState(cwd, { goal: g, ...(guard === "frozen" ? { supervisorPausedAt: Date.now() } : {}) });
    __testOnlyLoadState(cwd);
    let compacts = 0;
    ctx.getContextUsage = () => ({ tokens: 315_000, contextWindow: 1_000_000, percent: 31.5 });
    ctx.compact = () => { compacts++; };
    const runtime = globalThis as typeof globalThis & { abortedStandDown: boolean };
    runtime.abortedStandDown = guard === "aborted";
    try {
      await pi.fire("agent_settled", {}, ctx);
      sendContinuation(String(g.id));
      assert.equal(compacts, 0, "compaction cannot bypass the work owner's hold");
    } finally {
      runtime.abortedStandDown = false;
      await pi.fire("session_shutdown", { reason: "test-end" }, ctx);
    }
  });
}

test("idle list advancement checks compaction before dispatching the next task", async () => {
  const cwd = tmpCwd(), pi = new MockPi(); activate(pi.api);
  __testOnlyResetOwnerSession(); __testOnlyResetStaleFlag();
  const ctx = makeMockCtx(cwd, { sessionManager: { name: "compact-next-list-item" } });
  await pi.fire("session_start", { reason: "startup" }, ctx);
  const g = seedGoal({ status: "active", autoContinue: true, policy: "list", objective: "next queued work — done when pinned" });
  seedState(cwd, { goal: g }); __testOnlyLoadState(cwd); pi.sent.length = 0;
  let compacts = 0;
  ctx.getContextUsage = () => ({ tokens: 315_000, contextWindow: 1_000_000, percent: 31.5 });
  ctx.compact = () => { compacts++; };
  __testOnlySetSpawnWorker(async () => ({ ok: true, brief: "Objective: x. Next task: y." }));
  try {
    sendContinuation(String(g.id));
    assert.equal(compacts, 1, "a queue advance has no new agent_end/agent_settled event to trigger compaction");
    assert.equal(pi.sent.filter(s => (s.options as { triggerTurn?: boolean })?.triggerTurn === true).length, 0);
  } finally { await tick(100); await pi.fire("session_shutdown", { reason: "test-end" }, ctx); }
});

test("busy agent_end defers the 200k trigger to agent_settled, then work resumes after compaction", async () => {
  const cwd = tmpCwd(), pi = new MockPi(); activate(pi.api);
  __testOnlyResetOwnerSession(); __testOnlyResetStaleFlag();
  const ctx = makeMockCtx(cwd, { sessionManager: { name: "compact-settled-owner" } });
  let idle = true, tokens = 315_000, compacts = 0;
  ctx.isIdle = () => idle;
  ctx.getContextUsage = () => ({ tokens, contextWindow: 1_000_000, percent: tokens / 10_000 });
  ctx.compact = () => { compacts++; idle = false; };
  __testOnlySetSpawnWorker(async () => ({ ok: true, brief: "Objective: x. Next task: y." }));
  await pi.fire("session_start", { reason: "startup" }, ctx);
  const g = seedGoal({ status: "active", autoContinue: true, objective: "settled compaction test — done when pinned" });
  seedState(cwd, { goal: g }); __testOnlyLoadState(cwd); pi.sent.length = 0;
  try {
    idle = false; // Pi's run remains active while emitting agent_end.
    await pi.fire("tool_call", { toolName: "read", input: { path: "artifact.txt" } }, ctx);
    await pi.fire("agent_end", { messages: [{ role: "assistant", content: [{ type: "text", text: "checkpoint" }], stopReason: "end_turn" }] }, ctx);
    assert.equal(compacts, 0, "never compact a running host");
    idle = true;
    await pi.fire("agent_settled", {}, ctx);
    assert.equal(compacts, 1, "the settled host actually runs the 200k trigger");
    await tick(100);
    assert.equal(pi.sent.filter(s => (s.options as { triggerTurn?: boolean })?.triggerTurn === true).length, 0, `the pending executor continuation yields to compaction: ${JSON.stringify(pi.sent)}`);
    await pi.fire("agent_settled", {}, ctx);
    assert.equal(compacts, 1, "no second compact while the first owns the host");
    tokens = 50_000; idle = true;
    await pi.fire("session_compact", {}, ctx);
    sendContinuation(String(g.id)); await tick(50);
    assert.equal(pi.sent.filter(s => (s.options as { triggerTurn?: boolean })?.triggerTurn === true).length, 1, "ordinary post-compact dispatch resumes the same work");
  } finally {
    await tick(100); // let the optional handoff writer finish
    await pi.fire("session_shutdown", { reason: "test-end" }, ctx);
  }
});


test("completed compaction is named accurately and remains inspectable through public status", async () => {
  const cwd = tmpCwd(), pi = new MockPi(); activate(pi.api);
  const ctx = makeMockCtx(cwd, { sessionManager: { name: "compact-visible-complete" } });
  await pi.fire("session_start", { reason: "startup" }, ctx);
  try {
    await pi.fire("session_compact", {}, ctx);
    assert.ok(ctx.ui.notifies.some(n => n.message.includes("transcript compacted")));
    await pi.command("glla", "status", ctx);
    const status = ctx.ui.notifies.at(-1)!.message;
    assert.match(status, /compaction: target 200000 tokens.*last completed 20\d\d-/);
    assert.doesNotMatch(status, /last completed not recorded/);
  } finally { await pi.fire("session_shutdown", { reason: "test-end" }, ctx); }
});
