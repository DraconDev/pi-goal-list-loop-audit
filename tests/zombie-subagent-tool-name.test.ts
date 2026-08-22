// pi-goal-list-loop-audit — v0.35.26
// tests/zombie-subagent-tool-name.test.ts
//
// GitHub issue #13: the zombie watchdog's subagent-wait carve-out (v0.35.4)
// only matched the legacy built-in names (Agent / get_subagent_result /
// steer_subagent). The pi-subagents extension registers its FOREGROUND
// dispatch tool as "subagent" and a blocking wait as "subagent_wait", so a
// parent legitimately BUSY-waiting on a healthy foreground child was
// stream-silent by design yet got zombie_run_suspected at 20m and
// loop_stopped + zombie_run_aborted at 30m — killing productive work
// (field 2026-08-21: 816 catalog records written up to the abort second).
//
// These tests drive the REAL heartbeat tick with the real in-flight tool-call
// map populated via the real tool_call event:
//   T1 — an in-flight "subagent" call stands down the bounded abort; when
//        the call completes the next tick aborts as before.
//   T2 — same guarantee for the blocking "subagent_wait" tool.
//   T3 — source pin: both consumption sites share isSubagentWaitCall, so the
//        name set cannot drift between them again.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import activate, { __testOnlyResetOwnerSession, __testOnlyResetStaleFlag } from "../extensions/loops/goal.js";
import { __testOnlyResetZombieAutoRetry } from "../extensions/loops/goal-activation.js";
import { __testOnlyHeartbeatTick, __testOnlySetZombieRunWindows, __testOnlyResetZombieRunWatchdog } from "../extensions/goal-heartbeat.js";
import { readState } from "../extensions/goal-loop-core.js";
import { MockPi, tmpCwd, tick, type MockCtx } from "./harness/mock-pi.js";

const pi = new MockPi();
activate(pi.api);

async function freshSession(cwd: string): Promise<MockCtx> {
  const ctx = makeZombieCtx(cwd);
  await pi.fire("session_start", { reason: "reload" }, ctx);
  return ctx;
}

function makeZombieCtx(cwd: string): MockCtx {
  const { makeMockCtx } = require("./harness/mock-pi.js") as typeof import("./harness/mock-pi.js");
  return makeMockCtx(cwd, { sessionManager: { name: "main-session-manager-zombie-subtool" } });
}

function readLedger(cwd: string): Array<{ type: string }> {
  return fs.readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf8")
    .trim().split("\n").filter(Boolean)
    .map((line) => JSON.parse(line) as { type: string });
}

async function armZombieGoal(toolName: string): Promise<{ cwd: string; ctx: MockCtx; aborts: { n: number } }> {
  const cwd = tmpCwd();
  const ctx = await freshSession(cwd);
  ctx.isIdle = () => false;
  const aborts = { n: 0 };
  ctx.abort = () => { aborts.n++; };
  await pi.runTool("list_add", { items: [`zombie ${toolName} carve-out item`] }, ctx);
  assert.equal((readState(cwd).goal as { status?: string } | null)?.status, "active");
  // Clear prior graces so the watchdog sees genuine post-grace silence.
  (globalThis as any).compactionGraceUntil = 0;
  (globalThis as any).postCompletionSettleUntil = 0;
  // A foreground subagent dispatch: real tool_call event, then 30 minutes of
  // stream silence while the child works (zero-window watchdog = due now).
  pi.fire("tool_call", { toolName, toolCallId: `call-${toolName}` }, ctx);
  return { cwd, ctx, aborts };
}

test("v0.35.26 #13: an in-flight 'subagent' call stands down the zombie abort until it settles", async () => {
  __testOnlyResetStaleFlag();
  __testOnlyResetOwnerSession();
  __testOnlySetZombieRunWindows(0, 0);
  const { cwd, ctx, aborts } = await armZombieGoal("subagent");
  try {
    __testOnlyHeartbeatTick();
    assert.equal(aborts.n, 0, "a healthy foreground 'subagent' child is NOT aborted");
    assert.equal(readLedger(cwd).filter((e) => e.type === "zombie_run_stood_down_subagent_wait").length, 1);
    assert.equal(readLedger(cwd).filter((e) => e.type === "zombie_run_aborted").length, 0);
    assert.equal((readState(cwd).goal as { status?: string } | null)?.status, "active");

    // The child settles → the tool_result clears the in-flight entry → the
    // genuinely silent run is aborted exactly as before (no blanket amnesty).
    pi.fire("tool_result", { toolCallId: "call-subagent" }, ctx);
    __testOnlyHeartbeatTick();
    assert.equal(aborts.n, 1, "abort proceeds once the subagent call is done");
    assert.equal(readLedger(cwd).filter((e) => e.type === "zombie_run_aborted").length, 1);
    assert.equal((readState(cwd).goal as { status?: string } | null)?.status, "paused");
  } finally {
    __testOnlyResetZombieRunWatchdog();
    __testOnlyResetZombieAutoRetry();
    await pi.fire("session_shutdown", { reason: "quit" }, ctx);
  }
});

test("v0.35.26 #13: the blocking 'subagent_wait' tool gets the same stand-down", async () => {
  __testOnlyResetStaleFlag();
  __testOnlyResetOwnerSession();
  __testOnlySetZombieRunWindows(0, 0);
  const { cwd, ctx, aborts } = await armZombieGoal("subagent_wait");
  try {
    __testOnlyHeartbeatTick();
    assert.equal(aborts.n, 0, "'subagent_wait' blocks the zombie abort");
    assert.equal(readLedger(cwd).filter((e) => e.type === "zombie_run_stood_down_subagent_wait").length, 1);
  } finally {
    __testOnlyResetZombieRunWatchdog();
    __testOnlyResetZombieAutoRetry();
    await pi.fire("session_shutdown", { reason: "quit" }, ctx);
  }
});

test("v0.35.26 #13: both watchdog sites consume the shared isSubagentWaitCall name set", () => {
  const src = fs.readFileSync("extensions/goal-heartbeat.ts", "utf8");
  const uses = src.split("isSubagentWaitCall").length - 1;
  // definition + two consumers minimum; no site hand-rolls its own name list
  assert.ok(uses >= 3, `isSubagentWaitCall shared across sites (found ${uses} references)`);
  assert.ok(!src.includes('t.name === "get_subagent_result" || t.name === "Agent"'), "no duplicated legacy name chain remains");
});
