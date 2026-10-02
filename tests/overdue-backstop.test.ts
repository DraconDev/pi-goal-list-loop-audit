import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import activate, { __testOnlyResetOwnerSession, __testOnlyResetStaleFlag, __testOnlyLoadState } from "../extensions/loops/goal.js";
import { __testOnlyHeartbeatTick, __testOnlyResetOverdueWaitBackstop } from "../extensions/goal-heartbeat.js";
import { __testOnlyResetAuditorSurface } from "../extensions/loops/goal-auditor-surface.js";
import { readState, type Goal } from "../extensions/goal-loop-core.js";
import { MockPi, makeMockCtx, seedGoal, seedState, tick, tmpCwd } from "./harness/mock-pi.js";

function events(cwd: string) {
  return fs.readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));
}
async function boot(pi: MockPi, cwd: string) {
  __testOnlyResetOwnerSession(); __testOnlyResetStaleFlag();
  const ctx = makeMockCtx(cwd, { sessionManager: { name: `overdue-backstop-${Math.random()}` } });
  await pi.fire("session_start", { reason: "startup" }, ctx); await tick(120); return ctx;
}
function waitGoal(pauseReason: string): Goal {
  return seedGoal({
    status: "paused",
    pauseKind: "wait",
    pauseResumeAt: new Date(Date.now() - 120_000).toISOString(),
    pauseReason,
    pauseSuggestedAction: "test wait",
  }) as unknown as Goal;
}
afterEach(() => { __testOnlyResetAuditorSurfaceSafe(); __testOnlyResetOwnerSession(); __testOnlyResetStaleFlag(); __testOnlyResetOverdueWaitBackstop(); });
// The auditor surface reset lives behind its own module; keep this file's
// teardown dependency-free when that module is untouched.
function __testOnlyResetAuditorSurfaceSafe(): void {}

test("S9: overdue agent wait resumes exactly once — park-clear lands, then latch + ledger", async () => {
  const cwd = tmpCwd(), pi = new MockPi(); activate(pi.api); const ctx = await boot(pi, cwd);
  __testOnlyResetOverdueWaitBackstop();
  seedState(cwd, { goal: waitGoal("agent wait — test cooldown") });
  __testOnlyLoadState(cwd);
  try {
    __testOnlyHeartbeatTick(); await tick(120);
    const restored = readState(cwd).goal;
    assert.equal(restored?.status, "active");
    assert.equal(restored?.pauseResumeAt, undefined);
    assert.equal(restored?.autoResumedEvent, "overdue wait resumed (agent wait — test cooldown)");
    assert.equal(events(cwd).filter(e => e.type === "wait_pause_overdue_resume").length, 1);
    __testOnlyHeartbeatTick(); await tick(120);
    assert.equal(events(cwd).filter(e => e.type === "wait_pause_overdue_resume").length, 1, "latched: the same wait never resumes twice");
  } finally { await pi.fire("session_shutdown", { reason: "test-end" }, ctx); }
});

test("S8: probe-route no-op releases the overdue latch so the next tick retries", async () => {
  const cwd = tmpCwd(), pi = new MockPi(); activate(pi.api); const ctx = await boot(pi, cwd);
  __testOnlyResetOverdueWaitBackstop();
  // A recovery-reasoned wait with NO state.mainModelRecovery: the probe
  // no-ops without re-parking, so the same wait is still parked at settle.
  seedState(cwd, { goal: waitGoal("main model recovery — retrying in 2m (test)") });
  __testOnlyLoadState(cwd);
  try {
    __testOnlyHeartbeatTick(); await tick(120);
    assert.equal(events(cwd).filter(e => e.type === "wait_pause_overdue_resume").length, 1);
    assert.equal(readState(cwd).goal?.status, "paused", "the no-op probe leaves the wait parked");
    __testOnlyHeartbeatTick(); await tick(120);
    assert.equal(events(cwd).filter(e => e.type === "wait_pause_overdue_resume").length, 2, "latch released at settle: the next tick retries the still-parked wait");
  } finally { await pi.fire("session_shutdown", { reason: "test-end" }, ctx); }
});
