// pi-goal-list-loop-audit — v0.2.0
// tests/hegemon-queue-unblock-evidence.test.ts
//
// Evidence for repair goal 20260814124631-4wstd3 (hegemon list-queue repair).
// Reproduces the REAL blocked cascade: a 43-item list whose head holds 12
// empty-objective items (20260811120417-*) trips faulty_objective_list_activation_blocked;
// the same queue with those 12 removed (31 items, head = main-menu-deeper-polish)
// activates cleanly with no blocked event. This is the harness-level proof of
// the auditor's required fix #3 ("verify the unblock") at activation granularity.

import { test, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import activate, { __testOnlyResetOwnerSession } from "../extensions/loops/goal.js";
import { readState } from "../extensions/goal-loop-core.js";
import { MockPi, makeMockCtx, seedState, tick, tmpCwd } from "./harness/mock-pi.js";

// v0.34.139: the blocked-activation contract assumes the DEFAULT restore
// gate (no autoResume). Pin it explicitly: the shared worker-process
// settings file is reset per file by harness/setup.ts, but a poison write
// would otherwise turn session_start into an auto-activation that makes
// the repair item a live goal before /list next runs.
const GLOBAL_SETTINGS_PATH = process.env.GLLA_GLOBAL_SETTINGS_PATH;
function pinNoAutoResume(): void {
  if (GLOBAL_SETTINGS_PATH) fs.writeFileSync(GLOBAL_SETTINGS_PATH, JSON.stringify({ aggressiveMode: false }));
}

const EMPTY_IDS = [
  "20260811120417-t12dn0",
  "20260811120417-0y3e1s",
  "20260811120417-1zduyg",
  "20260811120417-5ib013",
  "20260811120417-5m88cw",
  "20260811120417-5ygj7d",
  "20260811120417-88l2xy",
  "20260811120417-doefpl",
  "20260811120417-k3len7",
  "20260811120417-t18ljq",
  "20260811120417-t9pz2o",
  "20260811120417-uemv69",
];

const REAL_HEAD = {
  id: "20260811120442-b5waz6",
  objective:
    "main-menu-deeper-polish: resolve the 4 vision-flagged items on / (LORD VARK caption framing, v1.0.0-PREP version chip styling, tagline container panel, music-toggle frame). MmX vision re-rate targets ≥9/10. Single focused change — menu page only.",
  addedAt: "2026-08-11T12:04:42.000Z",
};

function realItem(i: number) {
  return {
    id: `20260811120442-real-${String(i).padStart(3, "0")}`,
    objective: `real backlog item ${i}: polish the page to premium standard`,
    addedAt: "2026-08-11T12:04:42.000Z",
  };
}

function ledger(cwd: string): string {
  return fs.readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf8");
}

async function boot(pi: MockPi, cwd: string): Promise<ReturnType<typeof makeMockCtx>> {
  __testOnlyResetOwnerSession();
  const ctx = makeMockCtx(cwd, { sessionManager: { name: `unblock-${Date.now()}-${Math.random()}` } });
  await pi.fire("session_start", { reason: "startup" }, ctx);
  await tick(80);
  return ctx;
}

test("REAL SHAPE: 12 empty head items block list activation exactly as in the hegemon ledger", async () => {
  // v0.38.105 (field 2026-09-29, dracon-system "list doesnt auto progress"):
  // the safe repair still queues ahead of the blocked head, but it now
  // AUTO-ACTIVATES on the same command instead of idling the queue until a
  // second manual /list next. The blocked event and the repair binding are
  // unchanged; only the idle wait is gone.
  pinNoAutoResume();
  const cwd = tmpCwd();
  const empties = EMPTY_IDS.map((id) => ({ id, objective: "", addedAt: "2026-08-11T12:04:17.974Z" }));
  const rest = [REAL_HEAD, ...Array.from({ length: 30 }, (_, i) => realItem(i))];
  seedState(cwd, { goal: null, list: [...empties, ...rest] });
  const pi = new MockPi();
  activate(pi.api);
  const ctx = await boot(pi, cwd);
  await pi.command("list", "next", ctx);
  await tick(100);
  const s = readState(cwd);
  assert.equal(s.goal?.objective, "Repair the blocked list item from saved intent", "the safe repair auto-activates");
  assert.equal(s.goal?.status, "active");
  assert.equal(s.goal?.policy, "list");
  assert.equal(s.list?.length, 43, "repair taken out; the original 43 still queued behind it");
  assert.match(ledger(cwd), /"faulty_objective_list_activation_blocked"/);
  assert.match(ledger(cwd), /"faulty_objective_repair_auto_activate"/);
  // repaired target binding carries onto the activated repair goal
  assert.equal((s.goal as unknown as Record<string, { id: string }>)?.repairTarget?.id, "20260811120417-t12dn0");
  fs.rmSync(cwd, { recursive: true, force: true });
});

test("REAL SHAPE: the clean 31-item queue (empties removed) activates main-menu without any blocked event", async () => {
  pinNoAutoResume();
  const cwd = tmpCwd();
  const rest = [REAL_HEAD, ...Array.from({ length: 30 }, (_, i) => realItem(i))];
  seedState(cwd, { goal: null, list: rest });
  const pi = new MockPi();
  activate(pi.api);
  const ctx = await boot(pi, cwd);
  await pi.command("list", "next", ctx);
  await tick(100);
  const s = readState(cwd);
  assert.equal(s.goal?.objective, REAL_HEAD.objective, "main-menu-deeper-polish is the activated goal");
  assert.equal(s.goal?.status, "active");
  assert.equal(s.goal?.policy, "list");
  assert.equal(s.list?.length, 30, "the taken item is gone from the queue");
  assert.doesNotMatch(ledger(cwd), /"faulty_objective_list_activation_blocked"/);
  assert.match(ledger(cwd), /List item #1 activated|"goal_created"/);
  fs.rmSync(cwd, { recursive: true, force: true });
});

afterEach(() => {});
