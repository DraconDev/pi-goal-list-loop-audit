// pi-goal-list-loop-audit — result-time telemetry must read both event shapes.
// The call-time path recorder handles toolName and name; the result-time
// fileWrites counters only read toolName, so name-shaped results left
// fileWrites at 0 while telemetry.files filled — a contradictory record
// that also under-tiered the detached audit.

import { test, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";

import activate, {
  __testOnlyResetOwnerSession,
  __testOnlyResetStaleFlag,
} from "../extensions/loops/goal.js";
import { readState } from "../extensions/goal-loop-core.js";
import { state } from "../extensions/goal-state.js";
import { MockPi, makeMockCtx, seedGoal, seedLoop, seedState, tmpCwd, type MockCtx } from "./harness/mock-pi.js";

const GLOBAL_SETTINGS_PATH = process.env.GLLA_GLOBAL_SETTINGS_PATH!;
const pi = new MockPi();
activate(pi.api);

async function boot(cwd: string): Promise<MockCtx> {
  fs.writeFileSync(GLOBAL_SETTINGS_PATH, JSON.stringify({ autoResume: true, aggressiveMode: false }));
  __testOnlyResetOwnerSession();
  __testOnlyResetStaleFlag();
  const ctx = makeMockCtx(cwd, {
    sessionManager: { name: `telemetry-shapes-${Date.now()}-${Math.random()}` },
  });
  await pi.fire("session_start", { reason: "reload" }, ctx);
  return ctx;
}

afterEach(() => {
  pi.execHandler = null;
  fs.writeFileSync(GLOBAL_SETTINGS_PATH, JSON.stringify({ aggressiveMode: false }));
});

test("name-shaped write results count fileWrites on goal telemetry", async () => {
  const cwd = tmpCwd();
  seedState(cwd, {
    goal: seedGoal({ objective: "telemetry shapes", telemetry: { turns: 1, fileWrites: 0, bashCalls: 0 } }),
  });
  const ctx = await boot(cwd);
  try {
    await pi.fire("tool_result", { name: "edit", toolCallId: "w1", output: "ok" }, ctx);
    assert.equal(
      (state.goal as { telemetry: { fileWrites: number } }).telemetry.fileWrites,
      1,
      "a name-shaped edit result counts exactly like a toolName-shaped one",
    );
    await pi.fire("tool_result", { toolName: "edit", toolCallId: "w2", output: "ok" }, ctx);
    assert.equal(
      (state.goal as { telemetry: { fileWrites: number } }).telemetry.fileWrites,
      2,
      "the toolName shape still counts after the fix",
    );
    await pi.fire("tool_result", { name: "read", toolCallId: "r1", output: "ok" }, ctx);
    assert.equal(
      (state.goal as { telemetry: { fileWrites: number } }).telemetry.fileWrites,
      2,
      "a non-write tool never counts regardless of shape",
    );
  } finally {
    await pi.fire("session_shutdown", { reason: "test-end" }, ctx);
  }
});

test("name-shaped write results count fileWrites on loop iterMetrics", async () => {
  const cwd = tmpCwd();
  seedState(cwd, {
    loop: seedLoop({ measureCmd: "echo 1", direction: "max", bestValue: 1, lastValue: 1, iteration: 1 }),
  });
  const ctx = await boot(cwd);
  try {
    await pi.fire("tool_result", { name: "write", toolCallId: "w1", output: "ok" }, ctx);
    assert.equal(
      (state.loop as { iterMetrics?: { fileWrites: number } }).iterMetrics?.fileWrites,
      1,
      "a name-shaped write result feeds the stuck-gate progress signal",
    );
  } finally {
    await pi.fire("session_shutdown", { reason: "test-end" }, ctx);
  }
});
