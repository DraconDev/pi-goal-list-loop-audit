import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import activate, { __testOnlyResetProcessState } from "../extensions/loops/goal.js";
import { __testOnlyLoadState } from "../extensions/loops/goal-ui.js";
import { state } from "../extensions/goal-state.js";
import { __testOnlyHeartbeatTickRaw } from "../extensions/goal-heartbeat.js";
import { readState } from "../extensions/goal-loop-core.js";
import { createRespecBuilder } from "../extensions/respec-builder.js";
import { MockPi, makeMockCtx, seedGoal, seedLoop, seedState, tmpCwd, tick } from "./harness/mock-pi.js";

afterEach(() => { __testOnlyResetProcessState(); });

for (const outcome of ["complete", "failed", "missing"] as const) {
  test(`host reload reconciles ${outcome} after consent without task loss`, async () => {
    __testOnlyResetProcessState();
    const cwd = tmpCwd(); seedState(cwd, {});
    const manager = { getSessionId: () => "restored-parent", getSessionFile: () => undefined, getSessionName: () => "parent", getBranch: () => [] };
    const ctx = makeMockCtx(cwd, { sessionManager: manager });
    ctx.isIdle = () => false;
    const first = new MockPi(); activate(first.api);
    await first.fire("session_start", { reason: "startup" }, ctx);
    seedState(cwd, { goal: seedGoal({ objective: "Implement retained scope. Done when: tests pass.",
      taskList: { version: 1, tasks: [{ id: "1", title: "Implementation", status: "in_progress", subtasks: [] }] } }) });
    __testOnlyLoadState(cwd);
    const asyncDir = path.join(cwd, "restored-dependency"); fs.mkdirSync(asyncDir);
    const file = path.join(asyncDir, "status.json");
    fs.writeFileSync(file, JSON.stringify({ runId: "reload-worker", state: "running", lastActivityAt: Date.now() }));
    first.emitBus("subagent:async-started", { runId: "reload-worker", asyncDir, sessionId: "restored-parent" });
    await first.runTool("wait_for_background", { reason: "checkpoint", runIds: ["reload-worker"] }, ctx);
    const savedId = state.goal!.id;
    if (outcome === "missing") fs.rmSync(file);
    else fs.writeFileSync(file, JSON.stringify({ runId: "reload-worker", state: outcome }));
    __testOnlyResetProcessState();
    const restored = new MockPi(); activate(restored.api);
    await restored.fire("session_start", { reason: "startup" }, ctx);
    assert.equal(state.goal?.id, savedId);
    // A cold load without consent must not grant automatic continuation.
    assert.ok(state.goal?.backgroundWait);
    await restored.command("goal", "resume", ctx);
    __testOnlyHeartbeatTickRaw();
    assert.equal(state.goal?.backgroundWait, undefined);
    assert.equal(state.goal?.lastBackgroundWait?.dependencies[0]?.outcome, outcome === "complete" ? "completed" : outcome);
    assert.equal(state.goal?.taskList?.tasks[0]?.status, "in_progress");
    assert.equal(restored.sent.filter(message => message.message.customType === "glla-background-settled").length, 1);
    __testOnlyHeartbeatTickRaw();
    assert.equal(restored.sent.filter(message => message.message.customType === "glla-background-settled").length, 1);
  });
}

for (const surface of ["goal", "list", "metric", "project"] as const) {
  test(`${surface}: host wait tool yields without abort, event settles, and wait-turn skips accounting`, async () => {
    __testOnlyResetProcessState();
    const cwd = tmpCwd(); seedState(cwd, {});
    const pi = new MockPi(); activate(pi.api);
    let busy = false;
    const manager = { getSessionId: () => "parent-session", getSessionFile: () => undefined, getSessionName: () => "parent", getBranch: () => [] };
    const ctx = makeMockCtx(cwd, { sessionManager: manager });
    ctx.isIdle = () => !busy;
    let aborts = 0; ctx.abort = async () => { aborts++; };
    await pi.fire("session_start", { reason: "startup" }, ctx);
    await tick(20);
    const builder = { ...createRespecBuilder("Retained project"), phase: "building" as const,
      requirements: [{ id: "capability", text: "Keep scope", acceptance: "Observable result", status: "open" as const }] };
    seedState(cwd, surface === "goal" || surface === "list"
      ? { goal: seedGoal({ policy: surface, objective: "Implement retained scope. Done when: regression tests pass." }) }
      : { loop: seedLoop({ ...(surface === "project" ? { builder } : {}), iteration: 2, stallCount: 0 }) });
    __testOnlyLoadState(cwd);
    const asyncDir = path.join(cwd, "dependency"); fs.mkdirSync(asyncDir);
    fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({ runId: "owned-worker", state: "running", lastActivityAt: Date.now() }));
    pi.emitBus("subagent:async-started", { runId: "owned-worker", asyncDir, sessionId: "parent-session" });
    const result = await pi.runTool("wait_for_background", { reason: "Independent checkpoint", runIds: ["owned-worker"] }, ctx) as unknown as { terminate?: boolean; isError?: boolean };
    assert.equal(result.isError, false); assert.equal(result.terminate, true);
    assert.equal(aborts, 0, "waiting must not abort the parent and induce model failure recovery");
    assert.equal(state.goal?.status ?? state.loop?.active, surface === "goal" || surface === "list" ? "active" : true);
    const loaded = readState(cwd);
    assert.ok(loaded.goal?.backgroundWait ?? loaded.loop?.backgroundWait, "the wait is durable");
    busy = true;
    await pi.fire("agent_end", { messages: [] }, ctx);
    if (state.loop) {
      assert.equal(state.loop.iteration, 2, "yield is not a measured loop iteration");
      assert.equal(state.loop.stallCount, 0, "yield is not plateau or stall evidence");
      if (surface === "project") assert.equal(state.loop.builder?.requirements[0]?.status, "open");
    }
    pi.emitBus("subagent:async-complete", { runId: "other-worker" });
    assert.ok(state.goal?.backgroundWait ?? state.loop?.backgroundWait);
    fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({ runId: "owned-worker", state: "complete" }));
    pi.emitBus("subagent:async-complete", { runId: "owned-worker", sessionId: "parent-session" });
    assert.equal(state.goal?.backgroundWait ?? state.loop?.backgroundWait, undefined);
    assert.ok(state.goal?.lastBackgroundWait ?? state.loop?.lastBackgroundWait);
    const notices = pi.sent.filter(message => message.message.customType === "glla-background-settled").length;
    assert.equal(notices, 1);
    pi.emitBus("subagent:async-complete", { runId: "owned-worker" });
    assert.equal(pi.sent.filter(message => message.message.customType === "glla-background-settled").length, 1);
    assert.equal(aborts, 0);
  });
}
