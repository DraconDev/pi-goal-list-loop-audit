// pi-goal-list-loop-audit — v0.35.23
// tests/load-without-autostart.test.ts
//
// note.md Next #2: loading a session with persisted goal/list/loop state
// must RESTORE and DISPLAY everything truthfully but hold ALL automatic
// dispatch until the user decides (/goal resume, /list resume, /list next,
// /loop resume|start) — with explicit `autoResume: true` in global settings
// restoring today's load-time automation.
//
// Root cause this pins: resolveEffectiveAggressiveSettings coerced unset
// autoResume→true (aggressiveMode defaults on), so stock installs auto-
// resumed on every load despite the documented v0.28.21 tri-state whose
// undefined default is HOLD. The fix reads the RAW setting for load consent
// and engages a dedicated load hold (loadHoldAt) through the same freeze
// gates as /glla pause.
//
// One plane per seed: stacked live goal+loop states are deliberately
// arbitrated at load (v0.29.6), so tests never seed both active.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import activate, { __testOnlyResetOwnerSession } from "../extensions/loops/goal.js";
import { readState } from "../extensions/goal-loop-core.js";
import { seedGoal, seedLoop, seedState, tmpCwd, tick, MockPi, makeMockCtx } from "./harness/mock-pi.js";

const GLOBAL_SETTINGS_PATH = process.env.GLLA_GLOBAL_SETTINGS_PATH!;

function ledger(cwd: string): Array<{ type: string; value?: Record<string, unknown> }> {
  try {
    return fs.readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf8")
      .split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

async function coldBoot(pi: MockPi, cwd: string) {
  __testOnlyResetOwnerSession();
  const ctx = makeMockCtx(cwd, { sessionManager: { name: `no-autostart-${Date.now()}-${Math.random()}` } });
  await pi.fire("session_start", { reason: "startup" }, ctx);
  await tick(120);
  await tick(120);
  return ctx;
}

function newPi(): MockPi {
  const pi = new MockPi();
  activate(pi.api);
  return pi;
}

test("v0.35.23: DEFAULT cold load restores + displays a pending goal but sends NOTHING and arms NO automation", async () => {
  fs.writeFileSync(GLOBAL_SETTINGS_PATH, JSON.stringify({})); // stock install: no autoResume anywhere
  const cwd = tmpCwd();
  seedState(cwd, {
    goal: seedGoal({ policy: "goal", status: "active", objective: "persisted active goal — done when pinned" }),
    list: [{ id: "waiting-1", objective: "waiting queued item", addedAt: new Date().toISOString() }],
  });
  const pi = newPi();
  await coldBoot(pi, cwd);

  // ZERO sends on the restored-but-held load.
  assert.equal(pi.sent.length, 0, "no agent sends fire from a held session_start");
  assert.equal(pi.userMessages.length, 0, "no user-message injections fire either");

  // State is restored TRUTHFULLY — visible, intact, but held.
  const after = readState(cwd);
  assert.equal(after.goal?.status, "paused", "the persisted goal is held for explicit resume");
  assert.match(String(after.goal?.pauseReason ?? ""), /restored|held/i);
  assert.equal(after.list?.length, 1, "the waiting queue stays fully visible");

  // The load hold is engaged durably through the supervisor-freeze gate.
  assert.equal(typeof after.loadHoldAt, "number", "loadHoldAt marks the engaged hold");
  assert.ok(ledger(cwd).some((e) => e.type === "load_hold_engaged"));

  // And it STAYS inert: more event-loop turns arm no late timers/sends.
  await tick(200);
  await tick(200);
  assert.equal(pi.sent.length, 0, "no continuation timer fires after the hold");
});

test("v0.35.23: DEFAULT cold load HELDS a persisted live loop instead of resuming its ticks", async () => {
  fs.writeFileSync(GLOBAL_SETTINGS_PATH, JSON.stringify({}));
  const cwd = tmpCwd();
  seedState(cwd, {
    loop: seedLoop({ active: true, target: "persisted metric loop" }),
    list: [{ id: "waiting-1", objective: "waiting queued item", addedAt: new Date().toISOString() }],
  });
  const pi = newPi();
  await coldBoot(pi, cwd);

  const after = readState(cwd);
  assert.equal(after.loop?.active, false, "the persisted loop is HELD, not running");
  assert.match(String(after.loop?.stopReason ?? ""), /held/i, "the loop carries a truthful held marker");
  assert.equal(typeof after.loadHoldAt, "number", "the hold engages for loop-only pending state too");
  await tick(200);
  assert.equal(pi.sent.length, 0, "no loop turn dispatches while held");
});

test("v0.35.23: explicit autoResume:true restores load-time automation (opt-in = today's behavior)", async () => {
  fs.writeFileSync(GLOBAL_SETTINGS_PATH, JSON.stringify({ autoResume: true }));
  const cwd = tmpCwd();
  seedState(cwd, {
    goal: seedGoal({ policy: "goal", status: "active", objective: "persisted active goal — done when pinned" }),
    list: [{ id: "waiting-1", objective: "waiting queued item", addedAt: new Date().toISOString() }],
  });
  const pi = newPi();
  await coldBoot(pi, cwd);

  const after = readState(cwd);
  assert.equal(after.loadHoldAt, undefined, "no load hold when the user opted in");
  assert.equal(after.goal?.status, "active", "the goal resumes under explicit consent");
  await tick(150);
  assert.ok(pi.sent.length >= 1 || pi.userMessages.length >= 1, "automation actually dispatches after an opted-in load");
});

test("v0.35.23: /goal resume releases the load hold and re-arms automation", async () => {
  fs.writeFileSync(GLOBAL_SETTINGS_PATH, JSON.stringify({}));
  const cwd = tmpCwd();
  seedState(cwd, {
    goal: seedGoal({ policy: "goal", status: "active", objective: "persisted active goal — done when pinned" }),
  });
  const pi = newPi();
  const ctx = await coldBoot(pi, cwd);
  assert.equal(typeof readState(cwd).loadHoldAt, "number", "precondition: held");

  await pi.command("goal", "resume", ctx);
  await tick(150);

  const after = readState(cwd);
  assert.equal(after.loadHoldAt, undefined, "the hold is released by the explicit resume");
  assert.equal(after.goal?.status, "active", "the goal goes active");
  assert.ok(ledger(cwd).some((e) => e.type === "load_hold_released" && e.value?.via === "goal-resume"));
  await tick(150);
  assert.ok(pi.sent.length >= 1 || pi.userMessages.length >= 1, "a continuation actually fires after the release");
});

test("v0.38.96: /glla resume releases the load hold BEFORE the manual-recovery probe (field 2026-09-23)", async () => {
  // Field: dracon-utilities — a goal parked on a deterministic-400 manual
  // hold was cold-loaded (load hold engaged), then /glla resume consumed the
  // manual hold but the recovery probe died silently on the supervisorPaused
  // gate (which includes loadHoldAt): no probe event, no timer, goal still
  // parked. /goal resume and agent-resume release the hold at entry;
  // /glla resume must too — it carries the same consent semantics.
  fs.writeFileSync(GLOBAL_SETTINGS_PATH, JSON.stringify({}));
  const cwd = tmpCwd();
  seedState(cwd, {
    goal: seedGoal({
      status: "paused",
      pauseKind: "blocked",
      pauseReason: "main model recovery — automatic probes stopped (deterministic client error)",
      pauseSuggestedAction: "/goal resume to start a fresh recovery window",
    }),
    mainModelRecovery: {
      primary: "anthropic/mock-model",
      active: "anthropic/mock-model",
      attempted: ["anthropic/mock-model"],
      attempts: 5,
      reason: "main model transient — provider 400",
      kind: "goal",
      firstFailureAt: new Date().toISOString(),
      manualResumeRequired: true,
    },
  } as unknown as Parameters<typeof seedState>[1]);
  const pi = newPi();
  const ctx = await coldBoot(pi, cwd);
  assert.equal(typeof readState(cwd).loadHoldAt, "number", "precondition: cold load holds the parked recovery");

  await pi.command("glla", "resume", ctx);
  await tick(150);

  const after = readState(cwd);
  assert.equal(after.loadHoldAt, undefined, "/glla resume releases the load hold like /goal resume");
  assert.ok(ledger(cwd).some((e) => e.type === "load_hold_released" && e.value?.via === "glla-resume"));
  assert.ok(
    ledger(cwd).some((e) => e.type === "main_model_probe" || e.type === "main_model_fallback_cycle_reset"),
    "the recovery probe is dispatched, not dropped on the freeze gate",
  );
  assert.equal(after.goal?.status, "active", "the recovery-owned pause un-parks");
  await tick(1200);
  assert.ok(pi.sent.length >= 1 || pi.userMessages.length >= 1, "a supervised probe turn actually fires after the release");
});

test("v0.38.96: /loop resume releases the load hold BEFORE the manual-recovery probe", async () => {
  // Same wedge, loop kind: /loop resume fired manuallyResumeMainModelRecovery
  // without releasing the cold-load hold, so the probe bailed silently and
  // the held loop never re-armed.
  fs.writeFileSync(GLOBAL_SETTINGS_PATH, JSON.stringify({}));
  const cwd = tmpCwd();
  seedState(cwd, {
    loop: seedLoop({
      active: false,
      stopReason: "main model recovery — automatic probes stopped (deterministic client error)",
    }),
    mainModelRecovery: {
      primary: "anthropic/mock-model",
      active: "anthropic/mock-model",
      attempted: ["anthropic/mock-model"],
      attempts: 5,
      reason: "main model transient — provider 400",
      kind: "loop",
      firstFailureAt: new Date().toISOString(),
      manualResumeRequired: true,
    },
  } as unknown as Parameters<typeof seedState>[1]);
  const pi = newPi();
  const ctx = await coldBoot(pi, cwd);
  assert.equal(typeof readState(cwd).loadHoldAt, "number", "precondition: cold load holds the parked loop recovery");

  await pi.command("loop", "resume", ctx);
  await tick(150);

  const after = readState(cwd);
  assert.equal(after.loadHoldAt, undefined, "/loop resume releases the load hold before probing");
  assert.ok(ledger(cwd).some((e) => e.type === "load_hold_released" && e.value?.via === "loop-resume"));
  assert.ok(
    ledger(cwd).some((e) => e.type === "main_model_probe" || e.type === "main_model_fallback_cycle_reset"),
    "the recovery probe is dispatched, not dropped on the freeze gate",
  );
  assert.equal(after.loop?.active, true, "the recovery-held loop re-arms");
});

test("v0.35.23: /list next also releases the hold and starts the queued head", async () => {
  fs.writeFileSync(GLOBAL_SETTINGS_PATH, JSON.stringify({}));
  const cwd = tmpCwd();
  seedState(cwd, {
    list: [{ id: "head-1", objective: "queued head — done when pinned", addedAt: new Date().toISOString() }],
  });
  const pi = newPi();
  const ctx = await coldBoot(pi, cwd);
  assert.equal(typeof readState(cwd).loadHoldAt, "number", "precondition: held with a waiting queue");
  assert.equal(pi.sent.length, 0);

  await pi.command("list", "next", ctx);
  await tick(150);

  const after = readState(cwd);
  assert.equal(after.loadHoldAt, undefined, "an explicit activation releases the hold");
  assert.ok(after.goal, "the queued head started");
  assert.equal(after.goal?.policy, "list");
  assert.ok(ledger(cwd).some((e) => e.type === "load_hold_released"));
  assert.match(JSON.stringify(ledger(cwd)), /goal_created/);
});
