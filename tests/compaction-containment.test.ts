// pi-goal-list-loop-audit — compaction containment (field 083546)
//
// A long auto-compaction is legitimate busy time: no stream, no events,
// host silent for 6m45s+. The wedge-silence machinery must not read that
// silence as a stuck send queue (send-rearm storm → synthetic
// main-model-recovery park) and must not dispatch new continuations into
// the compacting host. One bounded probe after the settle owns the resume.
//
// Lifecycle shape (no source-regex, all behavior):
//   session_before_compact arms in-flight → storm clocks backdated →
//   accountSendRearm must suppress escalation (ledger, no park) →
//   session_compact settles → exactly one post-settle probe send →
//   storm clocks backdated again → escalation proceeds (gate is scoped).

import { test, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import { isCompactionInFlightSince, COMPACTION_IN_FLIGHT_MAX_MS } from "../extensions/main-model-recovery.js";
import {
  accountSendRearm,
  setContinuationRearmStreak,
  setContinuationRearmSince,
  resetContinuationDispatchState,
  scheduleContinuation,
} from "../extensions/goal-continuation.js";
import { clearMainModelRecoveryTimer } from "../extensions/goal-recovery.js";
import activate, {
  __testOnlyLoadState,
  __testOnlyResetOwnerSession,
  __testOnlyResetStaleFlag,
  __testOnlySetCompactionInFlight,
  __testOnlySetLastActivityAt,
} from "../extensions/loops/goal.js";
import { readState } from "../extensions/goal-loop-core.js";
import { MockPi, makeMockCtx, tmpCwd, tick, type MockCtx } from "./harness/mock-pi.js";

const pi = new MockPi();
activate(pi.api);

const MAIN_SM = { name: "main-session-manager" };

function readLedger(cwd: string): Array<{ type: string; value: Record<string, unknown> }> {
  const file = path.join(cwd, ".pi-glla", "active.jsonl");
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf-8").trim().split("\n").filter(Boolean)
    .map((l) => JSON.parse(l));
}
function ledgerTypes(cwd: string): string[] {
  return readLedger(cwd).map((e) => e.type);
}
function countLedger(cwd: string, type: string): number {
  return readLedger(cwd).filter((e) => e.type === type).length;
}

async function freshSession(cwd: string): Promise<MockCtx> {
  const ctx = makeMockCtx(cwd, { sessionManager: MAIN_SM });
  await pi.fire("session_start", { reason: "reload" }, ctx);
  return ctx;
}

async function activeGoalSession(): Promise<{ cwd: string; ctx: MockCtx }> {
  const cwd = tmpCwd();
  const ctx = await freshSession(cwd);
  await pi.runTool("list_add", { items: ["compaction wedge item — done when silence is not a failure"] }, ctx);
  assert.equal((readState(cwd).goal as { status?: string } | null)?.status, "active");
  // Drain the creation dispatch (its send + pending record) so send deltas
  // below measure only the compaction lifecycle, not goal-creation fallout.
  await tick(300);
  resetContinuationDispatchState(cwd);
  return { cwd, ctx };
}

/** Backdate the wedge-silence clocks to the 083546 field shape: 16m of
 * failed re-arms, zero session activity for 6m. */
function backdateStormClocks(): void {
  setContinuationRearmStreak(35);
  setContinuationRearmSince(Date.now() - 16 * 60_000);
  __testOnlySetLastActivityAt(Date.now() - 6 * 60_000);
}

let currentCtx: MockCtx | null = null;

beforeEach(() => {
  __testOnlyResetStaleFlag();
  __testOnlyResetOwnerSession();
  __testOnlySetCompactionInFlight(null);
  __testOnlySetLastActivityAt(Date.now());
  setContinuationRearmStreak(0);
  setContinuationRearmSince(0);
  resetContinuationDispatchState(tmpCwd());
});

afterEach(async () => {
  clearMainModelRecoveryTimer();
  __testOnlySetCompactionInFlight(null);
  setContinuationRearmStreak(0);
  setContinuationRearmSince(0);
  if (currentCtx) {
    resetContinuationDispatchState(currentCtx.cwd);
    await pi.fire("session_shutdown", { reason: "quit" }, currentCtx).catch(() => {});
    currentCtx = null;
  }
});

test("pure: in-flight marker is armed-signal plus timeout, never silence", () => {
  const now = Date.now();
  assert.equal(isCompactionInFlightSince(null, now), false);
  assert.equal(isCompactionInFlightSince(undefined, now), false);
  assert.equal(isCompactionInFlightSince(0, now), false);
  assert.equal(isCompactionInFlightSince(now - 60_000, now), true);
  assert.equal(isCompactionInFlightSince(now - COMPACTION_IN_FLIGHT_MAX_MS - 1, now), false);
  assert.equal(isCompactionInFlightSince(now + 60_000, now), true); // clock skew tolerates future arm
});

test("compaction in flight suppresses send-storm escalation (no park, no recovery)", async () => {
  const { cwd, ctx } = await activeGoalSession();
  currentCtx = ctx;
  await pi.fire("session_before_compact", {}, ctx); // arms the marker
  backdateStormClocks();
  accountSendRearm(ctx as never, "continuation");
  await tick();

  const types = ledgerTypes(cwd);
  assert.ok(!types.includes("send_rearm_escalated"), "must not escalate mid-compact");
  assert.ok(types.includes("send_rearm_escalated_suppressed"), "suppression must be ledgered");
  const suppression = readLedger(cwd).find((e) => e.type === "send_rearm_escalated_suppressed");
  assert.equal(suppression?.value.reason, "compaction-in-flight");
  assert.equal((readState(cwd).goal as { status?: string } | null)?.status, "active", "goal stays active mid-compact");
  assert.equal((readState(cwd) as { mainModelRecovery?: unknown }).mainModelRecovery ?? null, null, "no recovery planted mid-compact");
});

test("post-compact settle owns exactly one bounded probe (no duplicates)", async () => {
  const { cwd, ctx } = await activeGoalSession();
  currentCtx = ctx;
  await pi.fire("session_before_compact", {}, ctx);
  backdateStormClocks();
  accountSendRearm(ctx as never, "continuation");
  await tick();
  assert.equal((readState(cwd).goal as { status?: string } | null)?.status, "active");

  const sentBefore = pi.sent.length;
  await pi.fire("session_compact", {}, ctx);
  await tick(2500); // the 2s post-compact settle

  assert.equal(countLedger(cwd, "compaction_refire"), 1, "exactly one post-settle probe");
  assert.equal(countLedger(cwd, "compaction_grace_refire"), 0, "grace refire stays future");
  assert.equal(pi.sent.length - sentBefore, 1, "exactly one continuation send after settle");
  assert.ok(!ledgerTypes(cwd).includes("send_rearm_escalated"), "settle probe is not a storm");
});

test("escalation proceeds after settle — the gate is compaction-scoped, not a blanket disable", async () => {
  const { cwd, ctx } = await activeGoalSession();
  currentCtx = ctx;
  await pi.fire("session_before_compact", {}, ctx);
  await pi.fire("session_compact", {}, ctx);
  await tick(2500); // settle owns its probe; marker cleared

  backdateStormClocks(); // the wedge OUTLIVES the compaction this time
  accountSendRearm(ctx as never, "continuation");
  await tick();

  assert.ok(ledgerTypes(cwd).includes("send_rearm_escalated"), "a real post-compact wedge still escalates");
  clearMainModelRecoveryTimer(); // disarm the parked 5s probe; the ledger pin above is the assertion
});

test("scheduleContinuation defers while in flight and the settle still sends once", async () => {
  const { cwd, ctx } = await activeGoalSession();
  currentCtx = ctx;
  await pi.fire("session_before_compact", {}, ctx);

  const sentBefore = pi.sent.length;
  scheduleContinuation(ctx as never);
  await tick(300);
  assert.equal(pi.sent.length - sentBefore, 0, "no dispatch into a compacting host");
  assert.ok(ledgerTypes(cwd).includes("continuation_dispatch_deferred_compaction"), "deferral is ledgered");

  await pi.fire("session_compact", {}, ctx);
  await tick(2500);
  assert.equal(pi.sent.length - sentBefore, 1, "settle sends once — deferred dispatch is not doubled");
});
