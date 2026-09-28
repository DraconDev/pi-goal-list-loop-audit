// v0.38.105: a measure whose exec result carries NO numeric exit code must
// fail closed. It used to default to 0 — success — so partial stdout from a
// measure killed by MEASURE_TIMEOUT_MS was parsed as a real reading, could
// set bestValue, and permanently suppressed the plateau stop.

import { test, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import activate, {
  __testOnlyResetOwnerSession,
  __testOnlyResetStaleFlag,
} from "../extensions/loops/goal.js";
import { readState } from "../extensions/goal-loop-core.js";
import { MockPi, makeMockCtx, seedLoop, seedState, tmpCwd } from "./harness/mock-pi.js";

const GLOBAL_SETTINGS_PATH = process.env.GLLA_GLOBAL_SETTINGS_PATH!;
const pi = new MockPi();
activate(pi.api);

afterEach(() => {
  pi.execHandler = null;
  fs.writeFileSync(GLOBAL_SETTINGS_PATH, JSON.stringify({ aggressiveMode: false }));
});

async function tickWithMeasureResult(
  result: { code?: number; stdout?: string; stderr?: string },
  loopPatch: Record<string, unknown> = {},
) {
  const cwd = tmpCwd();
  fs.writeFileSync(GLOBAL_SETTINGS_PATH, JSON.stringify({ autoResume: true, aggressiveMode: false }));
  __testOnlyResetOwnerSession();
  __testOnlyResetStaleFlag();
  seedState(cwd, {
    loop: seedLoop({
      target: "reduce the todo count",
      measureCmd: "echo 42",
      direction: "min",
      bestValue: 10,
      lastValue: 10,
      iteration: 1,
      ...loopPatch,
    }),
  });
  const measureCalls: string[][] = [];
  // The cast is the point: a measure killed by MEASURE_TIMEOUT_MS yields an
  // envelope with NO numeric code at all, which the harness's return type
  // cannot express.
  pi.execHandler = ((cmd: string, args: string[]) => {
    measureCalls.push([cmd, ...args]);
    if (cmd === "bash") return result as { code: number; stdout: string; stderr: string };
    return { code: 0, stdout: "", stderr: "" };
  }) as typeof pi.execHandler;
  const ctx = makeMockCtx(cwd, { sessionManager: { name: `measure-fail-closed-${Date.now()}-${Math.random()}` } });
  await pi.fire("session_start", { reason: "reload" }, ctx);
  try {
    await pi.fire("agent_end", {
      messages: [{ role: "assistant", content: [{ type: "text", text: "HYPOTHESIS: fewer todos" }], stopReason: "end_turn" }],
    }, ctx);
  } finally {
    await pi.fire("session_shutdown", { reason: "test-end" }, ctx);
  }
  const loop = readState(cwd).loop as {
    lastValue: number | null;
    bestValue?: number;
    consecutiveNullMeasures?: number;
    history: { value: number | null }[];
  };
  return { loop, measureCalls };
}

test("a measure result with no exit code is a NULL measure, not a reading", async () => {
  // v0.38.105: the envelope carries stdout but NO numeric code at all — the
  // shape a killed measure produces. runMeasure must treat it as a failure.
  const { loop, measureCalls } = await tickWithMeasureResult({ stdout: "42\n" });
  assert.ok(measureCalls.some(([cmd]) => cmd === "bash"), "the measure actually ran");
  assert.equal(loop.lastValue, null, "an exit-code-less measure is recorded as null, never as 42");
  assert.equal(loop.bestValue, 10, "the best value is not moved by an unverified reading");
  assert.equal(loop.consecutiveNullMeasures, 1, "it counts as a broken measure, toward the loud stop");
  assert.equal(loop.history.at(-1)?.value, null);
});

test("an empty result envelope is also a NULL measure", async () => {
  const { loop } = await tickWithMeasureResult({});
  assert.equal(loop.lastValue, null);
  assert.equal(loop.consecutiveNullMeasures, 1);
});

test("a genuinely successful measure still records its number", async () => {
  const { loop } = await tickWithMeasureResult({ code: 0, stdout: "5\n" });
  assert.equal(loop.lastValue, 5, "the fail-closed default does not swallow real readings");
  assert.equal(loop.bestValue, 5, "min direction moves best to the improved value");
  assert.equal(loop.consecutiveNullMeasures, 0);
});

test("a nonzero exit code with a parseable number is still rejected", async () => {
  const { loop } = await tickWithMeasureResult({ code: 1, stdout: "7\n" });
  assert.equal(loop.lastValue, null, "a failing measure is null even when its stdout has a number");
  assert.equal(loop.bestValue, 10);
});
