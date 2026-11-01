// pi-goal-list-loop-audit — v0.34.51
// tests/contract-text-semantics.test.ts
//
// Pins the contract-text semantics for tweak flows (goal + list):
//   supplied "Done when: ..." clause  → REPLACE the stored contract
//   omitted clause                    → PRESERVE the stored contract
//   bare "Done when:" marker          → CLEAR the stored contract
// (v0.34.51: a reword must not silently destroy the verification gate;
// clearing is an explicit act. The parser also exposes the explicit-clear
// signal to every caller via extractVerificationContract.)

import { test, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";

import { extractVerificationContract, readState } from "../extensions/goal-loop-core.js";
import activate, { __testOnlyResetOwnerSession } from "../extensions/loops/goal.js";
import { MockPi, makeMockCtx, tmpCwd, seedState, seedGoal, tick, type MockCtx } from "./harness/mock-pi.js";

const GLOBAL_SETTINGS_PATH = process.env.GLLA_GLOBAL_SETTINGS_PATH!;
function setGlobalAutoResume(v: boolean): void {
  fs.writeFileSync(GLOBAL_SETTINGS_PATH, JSON.stringify(v ? { autoResume: true, aggressiveMode: false } : { aggressiveMode: false }));
}

const pi = new MockPi();
activate(pi.api);
const MAIN_SM = { name: "main-session-manager" };

function ownerCtx(cwd: string): MockCtx {
  return makeMockCtx(cwd, { sessionManager: MAIN_SM });
}
async function freshSession(cwd: string, reason: string): Promise<MockCtx> {
  __testOnlyResetOwnerSession(); // behavioral-orchestrator's owner claim precedes this file (shared process)
  const ctx = ownerCtx(cwd);
  await pi.fire("session_start", { reason }, ctx);
  return ctx;
}
afterEach(() => {
  setGlobalAutoResume(false);
  pi.execHandler = null;
  __testOnlyResetOwnerSession(); // release the shared owner claim so later/parallel files are unaffected
});

// ---------------------------------------------------------------------------
// level 1: parser (extractVerificationContract)
// ---------------------------------------------------------------------------

test("parser: supplied clause yields replacement data", () => {
  const r = extractVerificationContract("Do x. Done when: grep -q ok x.txt");
  assert.equal(r.objective, "Do x");
  assert.equal(r.verificationContract, "grep -q ok x.txt");
  assert.equal(r.explicitClear, false);
});

test("parser: omitted clause yields no contract and no clear signal", () => {
  const r = extractVerificationContract("Do x.");
  assert.equal(r.objective, "Do x.");
  assert.equal(r.verificationContract, "");
  assert.equal(r.explicitClear, false);
});

test("parser: bare line-marker is an explicit clear", () => {
  const r = extractVerificationContract("Do x.\nDone when:");
  assert.equal(r.objective, "Do x.");
  assert.equal(r.verificationContract, "");
  assert.equal(r.explicitClear, true);
});

test("parser: bare inline marker is an explicit clear and is stripped from the objective", () => {
  const r = extractVerificationContract("Do x. Done when:");
  assert.equal(r.objective, "Do x");
  assert.equal(r.verificationContract, "");
  assert.equal(r.explicitClear, true);
});

test("parser: bare marker followed by content still captures the contract block", () => {
  const r = extractVerificationContract("Do x.\nDone when:\nrun tests");
  assert.equal(r.objective, "Do x.");
  assert.equal(r.verificationContract, "run tests");
  // clear flag is set (a bare marker line appeared) but content wins at call sites
  assert.equal(r.explicitClear, true);
});

// ---------------------------------------------------------------------------
// level 2: goal flow (/goal tweak, active goal)
// ---------------------------------------------------------------------------

async function goalTweakFixture(contract: string | undefined) {
  // default settings HOLD an active goal on session_start (reload → paused),
  // which would trip the "No active goal to tweak" guard — opt in to
  // auto-resume so the seeded goal stays active like a real running goal.
  setGlobalAutoResume(true);
  const cwd = tmpCwd();
  seedState(cwd, {
    goal: seedGoal({
      policy: "goal",
      status: "active",
      objective: "old goal objective",
      verificationContract: contract,
    }),
  });
  const ctx = await freshSession(cwd, "reload");
  await tick();
  let confirmMessage = "";
  ctx.ui.confirmImpl = async (_title, message) => {
    confirmMessage = message;
    return true;
  };
  return { cwd, ctx, confirmMessage: () => confirmMessage };
}

function storedContract(cwd: string): string | undefined {
  return (readState(cwd).goal as { verificationContract?: string }).verificationContract;
}

test("goal tweak: supplied clause replaces the stored contract", async () => {
  const { cwd, ctx, confirmMessage } = await goalTweakFixture("old check");
  await pi.command("goal", "tweak new goal objective. Done when: new check", ctx);
  assert.equal(storedContract(cwd), "new check", "replacement contract is stored");
  // note.md item 2: the default card states the consequence; the exact contract
  // text lives in the expandable rationale (asserted in
  // amendment-confirm-compact.test.ts by driving the expand).
  assert.match(confirmMessage(), /Replaces the goal objective and its verification contract/);
  assert.ok(!confirmMessage().includes("new check"),
    "the contract body is NOT in the default card — that was the wall");
});

test("goal tweak: omitted clause preserves the stored contract", async () => {
  const { cwd, ctx, confirmMessage } = await goalTweakFixture("old check");
  await pi.command("goal", "tweak new goal objective", ctx);
  assert.equal(storedContract(cwd), "old check", "omitted clause keeps the old contract");
  assert.match(confirmMessage(), /its verification contract is kept/);
});

test("goal tweak: bare 'Done when:' clears the stored contract", async () => {
  const { cwd, ctx, confirmMessage } = await goalTweakFixture("old check");
  await pi.command("goal", "tweak new goal objective. Done when:", ctx);
  assert.equal(storedContract(cwd), "", "bare marker clears the contract");
  assert.match(confirmMessage(), /CLEARS its verification contract/);
});

// ---------------------------------------------------------------------------
// level 3: list flow (/list tweak, paused list item)
// ---------------------------------------------------------------------------

async function listTweakFixture(contract: string | undefined) {
  const cwd = tmpCwd();
  seedState(cwd, {
    goal: seedGoal({
      policy: "list",
      status: "paused",
      objective: "old list objective",
      verificationContract: contract,
      pauseReason: "paused by user",
      pauseSuggestedAction: "/list resume to continue",
    }),
  });
  const ctx = await freshSession(cwd, "reload");
  await tick();
  let confirmMessage = "";
  ctx.ui.confirmImpl = async (_title, message) => {
    confirmMessage = message;
    return true;
  };
  return { cwd, ctx, confirmMessage: () => confirmMessage };
}

test("list tweak: supplied clause replaces the stored contract", async () => {
  const { cwd, ctx, confirmMessage } = await listTweakFixture("old check");
  await pi.command("list", "tweak new list objective. Done when: new check", ctx);
  const updated = readState(cwd).goal as { status: string; policy: string; objective: string };
  assert.equal(storedContract(cwd), "new check", "replacement contract is stored");
  assert.equal(updated.status, "paused", "tweak does not activate the list item");
  assert.equal(updated.policy, "list", "list provenance is preserved");
  assert.match(confirmMessage(), /Replaces the list item objective and its verification contract/);
});

test("list tweak: omitted clause preserves the stored contract", async () => {
  const { cwd, ctx, confirmMessage } = await listTweakFixture("old check");
  await pi.command("list", "tweak new list objective", ctx);
  assert.equal(storedContract(cwd), "old check", "omitted clause keeps the old contract");
  assert.equal((readState(cwd).goal as { status: string }).status, "paused");
  assert.match(confirmMessage(), /its verification contract is kept/);
});

test("list tweak: bare 'Done when:' clears the stored contract", async () => {
  const { cwd, ctx, confirmMessage } = await listTweakFixture("old check");
  await pi.command("list", "tweak new list objective. Done when:", ctx);
  assert.equal(storedContract(cwd), "", "bare marker clears the contract");
  assert.equal((readState(cwd).goal as { status: string }).status, "paused");
  assert.match(confirmMessage(), /CLEARS its verification contract/);
});
