import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import activate, { __testOnlyResetOwnerSession, __testOnlyResetStaleFlag } from "../extensions/loops/goal.js";
import { HELD_ON_RESTORE } from "../extensions/goal-loop-forever.js";
import { readState } from "../extensions/goal-loop-core.js";
import { MockPi, makeMockCtx, seedGoal, seedLoop, seedState, tick, tmpCwd } from "./harness/mock-pi.js";

// Field 2026-10-02: a respec draft loop completed its draft, the session
// reloaded, the loop HELD (autoResume off) — and the load warning named
// every resume verb except /loop resume. The user ran /loop respec again,
// which silently replaced the held loop with a fresh reconcile loop and
// lost its history. Two fixes: the warning names /loop resume when a loop
// is held, and a fresh start over a lifecycle-held loop asks first.

const GLOBAL_SETTINGS_PATH = process.env.GLLA_GLOBAL_SETTINGS_PATH!;
function events(cwd: string) {
  return fs.readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));
}
async function boot(pi: MockPi, cwd: string) {
  fs.writeFileSync(GLOBAL_SETTINGS_PATH, JSON.stringify({ aggressiveMode: false }));
  __testOnlyResetOwnerSession(); __testOnlyResetStaleFlag();
  const ctx = makeMockCtx(cwd, { sessionManager: { name: `loop-held-start-${Math.random()}` } });
  await pi.fire("session_start", { reason: "startup" }, ctx); await tick(120); return ctx;
}
afterEach(() => {
  fs.writeFileSync(GLOBAL_SETTINGS_PATH, JSON.stringify({ aggressiveMode: false }));
  __testOnlyResetOwnerSession();
  __testOnlyResetStaleFlag();
});

test("held loop: the load-hold warning names /loop resume", async () => {
  const cwd = tmpCwd(), pi = new MockPi(); activate(pi.api);
  seedState(cwd, { loop: seedLoop({ active: true, target: "held respec draft" }) });
  const ctx = await boot(pi, cwd);
  try {
    assert.equal(readState(cwd).loop?.active, false, "human startup holds the active loop");
    const holds = ctx.ui.matching("Loaded without starting");
    assert.equal(holds.length, 1);
    assert.ok(holds[0]!.message.includes("/loop resume"), "the warning names the loop resume verb");
  } finally { await pi.fire("session_shutdown", { reason: "test-end" }, ctx); }
});

test("held loop: the load-hold warning is byte-identical when no loop is held", async () => {
  const cwd = tmpCwd(), pi = new MockPi(); activate(pi.api);
  seedState(cwd, { goal: seedGoal({ status: "paused", pauseKind: "blocked", pauseReason: "wait" }) });
  const ctx = await boot(pi, cwd);
  try {
    const holds = ctx.ui.matching("Loaded without starting");
    assert.equal(holds.length, 1);
    assert.ok(!holds[0]!.message.includes("/loop resume"), "no loop held, no loop hint");
    assert.match(holds[0]!.message, /\/goal resume, \/list resume, or \/list next starts work/, "legacy wording preserved");
  } finally { await pi.fire("session_shutdown", { reason: "test-end" }, ctx); }
});

test("fresh start over a held loop offers resume and preserves the loop", async () => {
  const cwd = tmpCwd(), pi = new MockPi(); activate(pi.api);
  seedState(cwd, { loop: seedLoop({ active: false, stopReason: HELD_ON_RESTORE, target: "held respec draft", iteration: 7, respecPhase: "draft", specFile: "SPEC.md" }) });
  const ctx = await boot(pi, cwd);
  ctx.ui.selectImpl = async (_title, options) => options.find((o) => o.startsWith("Resume"));
  try {
    await pi.command("loop", "start fresh target", ctx);
    const loop = readState(cwd).loop as Record<string, unknown>;
    assert.equal(loop.active, true, "the held loop resumed");
    assert.equal(loop.iteration, 7, "history preserved, not restarted");
    assert.equal(loop.target, "held respec draft", "no fresh loop replaced it");
    assert.equal(loop.respecPhase, "draft", "respec phase preserved");
    assert.ok(ctx.ui.matching("Loop resumed").length >= 1);
    assert.equal(events(cwd).filter(e => e.type === "loop_started").length, 0, "no fresh start was recorded");
  } finally { await pi.fire("session_shutdown", { reason: "test-end" }, ctx); }
});

test("fresh start over a held loop: dismiss keeps the held loop untouched", async () => {
  const cwd = tmpCwd(), pi = new MockPi(); activate(pi.api);
  seedState(cwd, { loop: seedLoop({ active: false, stopReason: HELD_ON_RESTORE, target: "held respec draft", iteration: 7 }) });
  const ctx = await boot(pi, cwd);
  ctx.ui.selectImpl = async () => undefined;
  try {
    await pi.command("loop", "start fresh target", ctx);
    const loop = readState(cwd).loop as Record<string, unknown>;
    assert.equal(loop.active, false, "still held");
    assert.equal(loop.iteration, 7);
    assert.ok(ctx.ui.matching("held loop is unchanged").length >= 1);
    assert.equal(events(cwd).filter(e => e.type === "loop_started").length, 0);
  } finally { await pi.fire("session_shutdown", { reason: "test-end" }, ctx); }
});

test("fresh start over a held loop: headless refuses instead of discarding", async () => {
  const cwd = tmpCwd(), pi = new MockPi(); activate(pi.api);
  seedState(cwd, { loop: seedLoop({ active: false, stopReason: HELD_ON_RESTORE, target: "held respec draft" }) });
  const ctx = await boot(pi, cwd);
  (ctx as { hasUI: boolean }).hasUI = false;
  try {
    await pi.command("loop", "start fresh target", ctx);
    assert.equal(readState(cwd).loop?.active, false, "still held");
    assert.equal(events(cwd).filter(e => e.type === "loop_fresh_start_refused_held").length, 1);
    assert.equal(events(cwd).filter(e => e.type === "loop_started").length, 0);
  } finally { await pi.fire("session_shutdown", { reason: "test-end" }, ctx); }
});

test("fresh start over an explicitly stopped loop keeps today's silent behavior", async () => {
  const cwd = tmpCwd(), pi = new MockPi(); activate(pi.api);
  seedState(cwd, { loop: seedLoop({ active: false, stopReason: "stopped by user — done for now", target: "old loop" }) });
  const ctx = await boot(pi, cwd);
  let selects = 0;
  ctx.ui.selectImpl = async () => { selects++; return undefined; };
  try {
    await pi.command("loop", "start fresh target", ctx);
    const loop = readState(cwd).loop as Record<string, unknown>;
    assert.equal(loop.active, true, "fresh start proceeds");
    assert.equal(loop.target, "fresh target");
    assert.equal(selects, 0, "no held-loop dialog for an explicit stop");
  } finally { await pi.fire("session_shutdown", { reason: "test-end" }, ctx); }
});
