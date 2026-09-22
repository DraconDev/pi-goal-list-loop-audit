// v0.38.5 (delta-only): steady-state sends marker-only, deltas send full.
import { test, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";

import {
  buildContinuationContent,
  buildMarkerContent,
  continuationPrompt,
  needsFullContinuation,
  resetContinuationInitialSend,
  sendContinuation,
} from "../extensions/goal-continuation.js";
import type { Goal } from "../extensions/goal-loop-core.js";
import activate, { __testOnlyResetOwnerSession } from "../extensions/loops/goal.js";
import { MockPi, makeMockCtx, seedState, tick, tmpCwd } from "./harness/mock-pi.js";

afterEach(() => {
  __testOnlyResetOwnerSession();
  resetContinuationInitialSend();
});

function cleanGoal(overrides: Partial<Goal> = {}): Goal {
  return {
    id: "20260903000000-delta01",
    objective: "Implement delta-only continuation",
    verificationContract: "Done when marker-only steady-state ships",
    status: "active",
    policy: "goal",
    autoContinue: true,
    createdAt: "2026-09-03T00:00:00.000Z",
    updatedAt: "2026-09-03T00:00:00.000Z",
    taskList: { tasks: [{ id: "t1", title: "Do the thing", status: "pending" }] },
    auditHistory: [],
    ...overrides,
  } as Goal;
}

test("marker is tiny and carries the dispatch marker", () => {
  const m = buildMarkerContent("20260903000000-delta01");
  assert.equal(m, "[GOAL CHECKPOINT goalId=20260903000000-delta01]");
  assert.ok(m.length < 100, `marker must stay tiny, got ${m.length}`);
});

test("clean goal needs no full — repair/recovery/audit/designer do", () => {
  assert.equal(needsFullContinuation(cleanGoal()), false);
  assert.equal(needsFullContinuation(cleanGoal({ repairTarget: { id: "x", objective: "orig", reasons: ["r"], source: "test" } as any })), true);
  assert.equal(needsFullContinuation(cleanGoal({ autoResumedAt: "2026-09-03T00:00:00.000Z" })), true);
  assert.equal(needsFullContinuation(cleanGoal({ pendingTasks: ["fix this"] })), true);
  assert.equal(
    needsFullContinuation(cleanGoal({ auditHistory: [{ at: "2026-09-03T00:00:00.000Z", approved: false, report: "bad" } as any] })),
    true,
  );
  assert.equal(
    needsFullContinuation(
      cleanGoal({
        revision: 2,
        auditHistory: [{ at: "2026-09-03T00:00:00.000Z", approved: true, revision: 1 } as any],
      }),
    ),
    true,
    "stale approval mismatch forces full",
  );
  assert.equal(needsFullContinuation(cleanGoal({ agentRole: "designer" as any })), true);
  const full = continuationPrompt(cleanGoal());
  assert.ok(full.length > 15000, `full prompt must stay material, got ${full.length}`);
});

test("builder: steady-state marker, resync+marker, dirty full", () => {
  const goal = cleanGoal();
  const steady = buildContinuationContent(goal, { firstSend: false });
  assert.equal(steady.kind, "marker");
  assert.equal(steady.content, buildMarkerContent(goal.id));

  const first = buildContinuationContent(goal, { firstSend: true });
  assert.equal(first.kind, "full");
  assert.ok(first.content.length > 15000, `first send must teach discipline once, got ${first.content.length}`);

  const resyncBlock = "[POST-COMPACTION RESYNC] trust disk\n\n";
  const resyncOnly = buildContinuationContent(goal, { resync: resyncBlock, firstSend: false });
  assert.equal(resyncOnly.kind, "resync");
  assert.equal(resyncOnly.content, resyncBlock + buildMarkerContent(goal.id));
  assert.ok(resyncOnly.content.includes(goal.id), "resync+marker keeps the dispatch marker for start-proof");
  assert.ok(resyncOnly.content.length < 1000, `resync must stay tiny, got ${resyncOnly.content.length}`);

  const dirty = cleanGoal({ auditHistory: [{ at: "2026-09-03T00:00:00.000Z", approved: false, report: "needs work" } as any] });
  const dirtySend = buildContinuationContent(dirty, { firstSend: false });
  assert.equal(dirtySend.kind, "full");
  assert.ok(dirtySend.content.length > 15000);
});

test("v0.38.94: consecutive sends go full once, then marker (field: 909 full sends)", async () => {
  const cwd = tmpCwd();
  const id = `20260922000000-delta${Date.now() % 100000}`;
  seedState(cwd, { goal: cleanGoal({ id }), list: [] });
  const pi = new MockPi();
  activate(pi.api);
  __testOnlyResetOwnerSession();
  const ctx = makeMockCtx(cwd, { sessionManager: { name: `delta-${id}` } });
  await pi.fire("session_start", { reason: "startup" }, ctx);
  await tick(80);

  await sendContinuation(id);
  await tick(80);
  assert.equal(pi.sent.length, 1, "first send dispatches");
  const first = pi.sent[0]?.message.content ?? "";
  assert.ok(first.length > 15000, `first send teaches the full brief, got ${first.length} chars`);

  await pi.fire("before_agent_start", { prompt: first }, ctx);
  await tick(80);
  await sendContinuation(id);
  await tick(80);
  assert.equal(pi.sent.length, 2, "second send dispatches");
  const second = pi.sent[1]?.message.content ?? "";
  assert.equal(second, buildMarkerContent(id), "second send is the tiny marker, not another full brief");
});

test("v0.38.94: rebind reset re-arms the one full brief (fresh context)", async () => {
  const cwd = tmpCwd();
  const id = `20260922000001-delta${Date.now() % 100000}`;
  seedState(cwd, { goal: cleanGoal({ id }), list: [] });
  const pi = new MockPi();
  activate(pi.api);
  __testOnlyResetOwnerSession();
  const ctx = makeMockCtx(cwd, { sessionManager: { name: `delta-${id}` } });
  await pi.fire("session_start", { reason: "startup" }, ctx);
  await tick(80);

  await sendContinuation(id);
  await tick(80);
  await pi.fire("before_agent_start", { prompt: pi.sent[0]?.message.content ?? "" }, ctx);
  await tick(80);
  await sendContinuation(id);
  await tick(80);
  assert.equal(pi.sent.length, 2);
  assert.equal(pi.sent[1]?.message.content, buildMarkerContent(id));

  // Fresh host, same restored goal: the brief must teach again.
  resetContinuationInitialSend();
  await pi.fire("before_agent_start", { prompt: pi.sent[1]?.message.content ?? "" }, ctx);
  await tick(80);
  await sendContinuation(id);
  await tick(80);
  assert.equal(pi.sent.length, 3, "post-rebind send dispatches");
  assert.ok(
    (pi.sent[2]?.message.content ?? "").length > 15000,
    "post-rebind first send is full again",
  );
});

test("sendContinuation wires the delta-only branch with kind ledger", () => {
  const src = fs.readFileSync(new URL("../extensions/goal-continuation.ts", import.meta.url), "utf-8");
  const send = src.slice(src.indexOf("export function sendContinuation"));
  assert.match(send, /buildContinuationContent/, "send path uses the pure builder");
  assert.match(send, /kind, payloadChars/, "ledger distinguishes marker vs full");
});
