import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import activate, { __testOnlyLoadState, __testOnlyResetOwnerSession, __testOnlyResetStaleFlag } from "../extensions/loops/goal.js";
import { __testOnlyResetCompactor, __testOnlySetSpawnWorker } from "../extensions/goal-compactor.js";
import { sendContinuation } from "../extensions/goal-continuation.js";
import { MockPi, makeMockCtx, seedGoal, seedState, tmpCwd, tick } from "./harness/mock-pi.js";

afterEach(() => { __testOnlyResetCompactor(); __testOnlyResetOwnerSession(); __testOnlyResetStaleFlag(); });

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
    await pi.fire("agent_end", { messages: [{ role: "assistant", content: [{ type: "text", text: "checkpoint" }], stopReason: "end_turn" }] }, ctx);
    assert.equal(compacts, 0, "never compact a running host");
    idle = true;
    await pi.fire("agent_settled", {}, ctx);
    assert.equal(compacts, 1, "the settled host actually runs the 200k trigger");
    await tick(100);
    assert.equal(pi.sent.filter(s => s.options?.triggerTurn === true).length, 0, "the pending executor continuation yields to compaction");
    await pi.fire("agent_settled", {}, ctx);
    assert.equal(compacts, 1, "no second compact while the first owns the host");
    tokens = 50_000; idle = true;
    await pi.fire("session_compact", {}, ctx);
    sendContinuation(String(g.id)); await tick(50);
    assert.equal(pi.sent.filter(s => s.options?.triggerTurn === true).length, 1, "ordinary post-compact dispatch resumes the same work");
  } finally {
    await tick(100); // let the optional handoff writer finish
    await pi.fire("session_shutdown", { reason: "test-end" }, ctx);
  }
});
