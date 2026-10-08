import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Goal } from "../extensions/goal-loop-core.js";
import { readState } from "../extensions/goal-loop-core.js";
import { state, replaceState, persistStateLine } from "../extensions/goal-state.js";
import { admitBackgroundWait, bindBackgroundWaitRuntime, observeBackgroundStart, observeBackgroundTerminal,
  reconcileBackgroundWait, backgroundWaitPromptContext, __testOnlyResetBackgroundWaitRuntime } from "../extensions/background-wait-runtime.js";
import { makeMockCtx, tmpCwd } from "./harness/mock-pi.js";

const now = "2026-10-08T17:00:00.000Z";
function goal(over: Partial<Goal> = {}): Goal {
  return { id: "goal-1", objective: "Implement retained scope", status: "active", policy: "goal", autoContinue: true,
    usage: { tokensUsed: 0, tokensLimit: 0 }, createdAt: now, updatedAt: now,
    taskList: { version: 1, tasks: [{ id: "1", title: "Checkpoint", status: "complete", subtasks: [] }] }, ...over };
}
function fixture(policy: "goal" | "list" = "goal") {
  const cwd = tmpCwd();
  const mock = makeMockCtx(cwd, { sessionManager: { getSessionId: () => "session-1", getSessionFile: () => undefined } });
  const ctx = mock as unknown as ExtensionContext;
  let sends = 0, assessments = 0, writable = true, idle = true;
  mock.isIdle = () => idle;
  replaceState({ goal: goal({ policy }), list: [] });
  bindBackgroundWaitRuntime({ valid: () => true,
    persist: () => writable && persistStateLine(cwd, state),
    updateGoal: patch => {
      if (!state.goal || !writable) return false;
      state.goal = { ...state.goal, ...patch };
      return persistStateLine(cwd, state);
    }, clearTimers: () => {}, refresh: () => {}, schedule: () => { sends++; }, assessment: () => { assessments++; } });
  const asyncDir = path.join(cwd, "worker"); fs.mkdirSync(asyncDir);
  const file = path.join(asyncDir, "status.json");
  const publish = (status: string, id = "worker-1") => fs.writeFileSync(file, JSON.stringify({ runId: id, state: status, lastActivityAt: Date.now() }));
  publish("running");
  const start = () => observeBackgroundStart({ runId: "worker-1", asyncDir }, ctx);
  return { cwd, ctx, mock, start, publish, asyncDir, sends: () => sends, assessments: () => assessments,
    writable: (value: boolean) => { writable = value; }, idle: (value: boolean) => { idle = value; } };
}
afterEach(() => { __testOnlyResetBackgroundWaitRuntime(); replaceState({ goal: null }); });

for (const policy of ["goal", "list"] as const) {
  test(`${policy}: owned wait persists without pausing; exact completion wakes once`, () => {
    const f = fixture(policy); f.start();
    assert.equal(admitBackgroundWait(f.ctx, ["worker-1"], "checkpoint").ok, true);
    const loaded = readState(f.cwd).goal!;
    assert.equal(loaded.status, "active"); assert.equal(loaded.backgroundWait?.dependencies[0]?.runId, "worker-1");
    observeBackgroundTerminal({ runId: "other" }, f.ctx, "completed");
    assert.ok(state.goal?.backgroundWait); assert.equal(f.sends(), 0);
    f.publish("complete"); observeBackgroundTerminal({ runId: "worker-1" }, f.ctx, "completed");
    assert.equal(f.sends(), 1); assert.equal(f.assessments(), 1);
    assert.equal(readState(f.cwd).goal?.backgroundWait, undefined);
    assert.equal(state.goal?.lastBackgroundWait?.dependencies[0]?.outcome, "completed");
    assert.equal(state.goal?.taskList?.tasks[0]?.status, "complete");
    assert.match(backgroundWaitPromptContext()!, /Dependencies settled/);
    assert.match(backgroundWaitPromptContext()!, /worker-1/);
    observeBackgroundTerminal({ runId: "worker-1" }, f.ctx, "completed");
    reconcileBackgroundWait(f.ctx); assert.equal(f.sends(), 1);
  });
}

for (const freeze of ["supervisor", "load", "goal"] as const) {
  test(`${freeze} pause freezes wake but retains dependency evidence for resume`, () => {
    const f = fixture(); f.start(); admitBackgroundWait(f.ctx, ["worker-1"], "checkpoint");
    if (freeze === "supervisor") state.supervisorPausedAt = 1;
    else if (freeze === "load") state.loadHoldAt = 1;
    else state.goal = { ...state.goal!, status: "paused", pauseKind: "blocked" };
    f.publish("complete"); observeBackgroundTerminal({ runId: "worker-1" }, f.ctx, "completed");
    assert.equal(f.sends(), 0); assert.ok(state.goal?.backgroundWait);
    delete state.supervisorPausedAt; delete state.loadHoldAt;
    state.goal = { ...state.goal!, status: "active", pauseKind: undefined };
    reconcileBackgroundWait(f.ctx); assert.equal(f.sends(), 1);
  });
}

for (const status of ["complete", "failed", "missing", "mismatched"] as const) {
  test(`reload reconciles ${status} artifact without losing work`, () => {
    const f = fixture(); f.start(); admitBackgroundWait(f.ctx, ["worker-1"], "checkpoint");
    if (status === "missing") fs.rmSync(path.join(f.asyncDir, "status.json"));
    else f.publish(status === "mismatched" ? "complete" : status, status === "mismatched" ? "wrong-worker" : "worker-1");
    const saved = readState(f.cwd);
    replaceState(saved);
    // Rebinding clears live observations, like /reload. Artifact identity is
    // retained in the journal; no registry scan or guessed worker is needed.
    let sends = 0;
    bindBackgroundWaitRuntime({ valid: () => true, persist: () => persistStateLine(f.cwd, state), updateGoal: patch => {
      state.goal = { ...state.goal!, ...patch }; return persistStateLine(f.cwd, state);
    }, clearTimers: () => {}, refresh: () => {}, schedule: () => { sends++; }, assessment: () => {} });
    reconcileBackgroundWait(f.ctx);
    assert.equal(sends, 1); assert.equal(state.goal?.objective, "Implement retained scope");
    assert.equal(state.goal?.taskList?.tasks[0]?.status, "complete");
    assert.equal(state.goal?.lastBackgroundWait?.dependencies[0]?.outcome,
      status === "complete" ? "completed" : status === "failed" ? "failed" : "missing");
  });
}

test("legacy standby reconciles through assessment, not invented worker ownership", () => {
  const f = fixture(); state.goal = goal({ status: "paused", pauseKind: "standby", pauseReason: "Old design wait" });
  reconcileBackgroundWait(f.ctx);
  assert.equal(state.goal?.status, "active"); assert.equal(f.sends(), 1);
  assert.equal(state.goal?.lastBackgroundWait?.legacy, true);
  assert.deepEqual(state.goal?.lastBackgroundWait?.dependencies, []);
});

test("storage failure retains the wait and refuses premature dispatch", () => {
  const f = fixture(); f.start(); admitBackgroundWait(f.ctx, ["worker-1"], "checkpoint");
  f.writable(false); f.publish("complete"); reconcileBackgroundWait(f.ctx);
  assert.ok(state.goal?.backgroundWait); assert.equal(f.sends(), 0);
  f.writable(true); reconcileBackgroundWait(f.ctx); assert.equal(f.sends(), 1);
});

test("replacement, cancellation and pending audit cannot be woken by an old dependency", () => {
  const f = fixture(); f.start(); admitBackgroundWait(f.ctx, ["worker-1"], "checkpoint");
  const old = state.goal!;
  state.goal = goal({ id: "new-goal" }); observeBackgroundTerminal({ runId: "worker-1" }, f.ctx, "completed");
  assert.equal(f.sends(), 0); assert.equal(state.goal.id, "new-goal");
  state.goal = { ...old, status: "aborted" }; reconcileBackgroundWait(f.ctx); assert.equal(f.sends(), 0);
  state.goal = { ...old, pendingCompletion: { at: now, completionSummary: "Saved audit" } };
  f.publish("complete"); reconcileBackgroundWait(f.ctx); assert.equal(f.sends(), 0);
  assert.equal(state.goal.pendingCompletion?.completionSummary, "Saved audit");
});

test("admission rejects guessed ids; foreign sessions cannot settle an owned wait", () => {
  const f = fixture();
  assert.equal(admitBackgroundWait(f.ctx, ["guessed-worker"], "prose is not ownership").ok, false);
  f.start(); admitBackgroundWait(f.ctx, ["worker-1"], "checkpoint");
  observeBackgroundTerminal({ runId: "worker-1", sessionId: "unrelated-session" }, f.ctx, "completed");
  assert.equal(state.goal?.backgroundWait?.dependencies[0]?.outcome, "pending");
  assert.equal(f.sends(), 0);
});

test("multiple dependencies require all results; completion before admission is retained", () => {
  const f = fixture(); f.start();
  observeBackgroundStart({ runId: "worker-2" }, f.ctx);
  observeBackgroundTerminal({ runId: "worker-1" }, f.ctx, "completed");
  admitBackgroundWait(f.ctx, ["worker-1", "worker-2"], "two checkpoints");
  reconcileBackgroundWait(f.ctx); assert.equal(f.sends(), 0);
  observeBackgroundTerminal({ runId: "worker-2" }, f.ctx, "stopped");
  assert.equal(f.sends(), 1);
  assert.deepEqual(state.goal?.lastBackgroundWait?.dependencies.map(dep => dep.outcome), ["completed", "stopped"]);
});

for (const publishedDeadline of [true, false]) {
  test(`running artifact cannot retain waiting indefinitely (${publishedDeadline ? "deadline" : "no deadline"})`, () => {
    const f = fixture(); f.start(); admitBackgroundWait(f.ctx, ["worker-1"], "checkpoint");
    state.goal = { ...state.goal!, backgroundWait: { ...state.goal!.backgroundWait!, createdAt: new Date(Date.now() - 31 * 60_000).toISOString() } };
    fs.writeFileSync(path.join(f.asyncDir, "status.json"), JSON.stringify({ runId: "worker-1", state: "running", pid: process.pid,
      lastActivityAt: Date.now(), ...(publishedDeadline ? { deadlineAt: Date.now() - 1 } : {}) }));
    reconcileBackgroundWait(f.ctx);
    assert.equal(f.sends(), 1); assert.equal(state.goal?.lastBackgroundWait?.dependencies[0]?.outcome, "missing");
  });
}

test("busy parent consumes settlement without an extra main-thread send", () => {
  const f = fixture(); f.start(); admitBackgroundWait(f.ctx, ["worker-1"], "checkpoint");
  f.idle(false); f.publish("complete"); observeBackgroundTerminal({ runId: "worker-1" }, f.ctx, "completed");
  assert.equal(f.sends(), 0); assert.equal(f.assessments(), 1); assert.equal(state.goal?.backgroundWait, undefined);
});
