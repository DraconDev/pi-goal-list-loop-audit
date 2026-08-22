// pi-goal-list-loop-audit — v0.35.25
// tests/zombie-resume.test.ts
//
// GitHub issue #14: the zombie watchdog's zero-stream abort parks a loop with
//   stopReason = "stopped: automatic zero-stream abort — no provider activity
//   was observed after Nm (iteration X preserved; /loop resume to retry)"
// and its user-facing message PROMISES "/loop resume to retry". But the
// /loop resume handler's RESUMABLE_STOP predicate never matched that prefix,
// so the explicit resume answered "No held loop to resume" and the preserved
// iteration count, best value, and history were unreachable — the operator
// had to re-draft from scratch.
//
// These tests drive the REAL cmdLoop("resume") handler end-to-end:
//   T1 — an aborted-stopReason loop resumes with iteration/best/history
//        intact and re-dispatches exactly one fresh turn (also proving the
//        v0.35.23 load hold is released by the explicit resume).
//   T2 — control: a non-resumable stop reason ("stopped: bounds —") is still
//        refused, so the new prefix does not open the gate to everything.

import { test, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import activate from "../extensions/loops/goal.js";
import { readState } from "../extensions/goal-loop-core.js";
import { MockPi, makeMockCtx, tmpCwd, seedState, seedLoop, tick, type MockCtx } from "./harness/mock-pi.js";

const GLOBAL_SETTINGS_PATH = process.env.GLLA_GLOBAL_SETTINGS_PATH!;

const pi = new MockPi();
activate(pi.api);

const MAIN_SM = { name: "main-session-manager-zombie-resume" };

function ownerCtx(cwd: string): MockCtx {
  return makeMockCtx(cwd, { sessionManager: MAIN_SM });
}

async function freshSession(cwd: string): Promise<MockCtx> {
  const ctx = ownerCtx(cwd);
  await pi.fire("session_start", { reason: "reload" }, ctx);
  return ctx;
}

const ZOMBIE_REASON =
  "stopped: automatic zero-stream abort — no provider activity was observed after 30m (iteration 210 preserved; /loop resume to retry)";

function zombieLoop(): Record<string, unknown> {
  return seedLoop({
    active: false,
    stopReason: ZOMBIE_REASON,
    iteration: 210,
    bestValue: 42,
    lastValue: 42,
    maxIterations: 0,
    measureCmd: "",
    history: [
      { value: 44, improved: true },
      { value: 43, improved: true },
      { value: 42, improved: true },
    ],
  });
}

test("v0.35.25 #14: /loop resume honors the zero-stream abort park and preserves iteration/history", async () => {
  const cwd = tmpCwd();
  seedState(cwd, { loop: zombieLoop() });
  pi.sent.length = 0;
  const ctx = await freshSession(cwd);

  // Boot must NOT auto-start the parked loop (v0.35.23 load-hold semantics).
  assert.equal(pi.sent.length, 0, "boot does not dispatch for a parked loop");
  assert.equal((readState(cwd).loop as { active: boolean }).active, false);

  // The exact promise the abort message makes:
  await pi.command("loop", "resume", ctx);
  await tick();

  const resumed = readState(cwd).loop as {
    active: boolean;
    stopReason?: string;
    iteration: number;
    bestValue: number | null;
    history: Array<{ value?: number }>;
  };
  assert.equal(resumed.active, true, "the promised resume actually resumes");
  assert.equal(resumed.stopReason, undefined, "the park is cleared");
  assert.equal(resumed.iteration, 210, "iteration survives the resume");
  assert.equal(resumed.bestValue, 42, "best value survives the resume");
  assert.equal(resumed.history.length, 3, "history survives the resume");
  assert.ok(pi.sent.length >= 1, "the resumed loop re-dispatches");

  // The ledger records the release of any load hold via the explicit resume.
  const ledger = fs.readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf8");
  assert.ok(ledger.includes("load_hold_released"), "explicit resume releases the boot hold");

  await pi.command("loop", "stop", ctx);
});

test("v0.35.25 #14: control — a non-resumable stop reason is still refused", async () => {
  const cwd = tmpCwd();
  seedState(cwd, {
    loop: seedLoop({
      active: false,
      stopReason: "stopped: bounds — token budget exhausted",
      iteration: 7,
    }),
  });
  pi.sent.length = 0;
  const ctx = await freshSession(cwd);

  await pi.command("loop", "resume", ctx);
  await tick();

  const refused = readState(cwd).loop as { active: boolean; stopReason?: string };
  assert.equal(refused.active, false, "bounds stops stay stopped");
  assert.match(refused.stopReason ?? "", /bounds/);
  assert.equal(pi.sent.length, 0, "no dispatch for a non-resumable park");
});

const GLOBAL_BACKUP = GLOBAL_SETTINGS_PATH + ".zombie-resume-backup";
try { fs.copyFileSync(GLOBAL_SETTINGS_PATH, GLOBAL_BACKUP); } catch { /* absent */ }
afterEach(() => {
  try { fs.copyFileSync(GLOBAL_BACKUP, GLOBAL_SETTINGS_PATH); } catch { fs.rmSync(GLOBAL_SETTINGS_PATH, { force: true }); }
  fs.rmSync(GLOBAL_BACKUP, { force: true });
});
