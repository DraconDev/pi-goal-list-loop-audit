// pi-goal-list-loop-audit — v0.34.85
// tests/subagent-hang-detection.test.ts
//
// note.md Screenshots 161019/161032: subagents frozen at 10697s (3h) with
// zero stream activity — repeated "BUSY with zero stream activity" warnings
// at 22/31/41 min. The auditor's detached worker has a heartbeat-without-
// progress watchdog (auditor-process.ts, 10m); subagent sessions have none.
// v0.34.85 extends the no-progress watchdog to subagent sessions with a
// SHORTER default (5m vs the auditor's 10m): a subagent whose pi-subagents
// record is still "running" but shows no NEW progress (tool uses or output
// tokens) for 5m is surfaced (ui.notify + notifyExternal) and ledgered
// `subagent_hang_detected` so the main session can decide to abort.
//
// Progress evidence joins the record via the cross-package registry
// Symbol.for("pi-subagents:manager") → getRecord(id) (live toolUses /
// lifetimeUsage.output / status); compacted/steered events refresh the
// streak as secondary evidence; completed/failed end the watch.

import { test, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";

import activate, {
  __testOnlyResetOwnerSession,
  __testOnlyResetStaleFlag,
} from "../extensions/loops/goal.js";
import {
  classifyHungSubagents,
  __testOnlyClearSubagentHangProbes,
  __testOnlyHeartbeatTick,
  __testOnlySubagentHangProbes,
} from "../extensions/goal-heartbeat.js";
import {
  MockPi, makeMockCtx, tmpCwd, tick,
  type MockCtx,
} from "./harness/mock-pi.js";
import { readState } from "../extensions/goal-loop-core.js";
import { readGoalRuntimeSource } from "./harness/goal-source.js";

const GLOBAL_SETTINGS_PATH = process.env.GLLA_GLOBAL_SETTINGS_PATH!;
function setGlobalAutoResume(v: boolean): void {
  fs.writeFileSync(GLOBAL_SETTINGS_PATH, JSON.stringify(v ? { autoResume: true, aggressiveMode: false } : { aggressiveMode: false }));
}
function ownerCtx(cwd: string): MockCtx {
  return makeMockCtx(cwd, { sessionManager: { name: "main-session-manager" } });
}
async function freshSession(cwd: string, reason: string): Promise<MockCtx> {
  __testOnlyResetOwnerSession();
  const ctx = ownerCtx(cwd);
  await pi.fire("session_start", { reason }, ctx);
  return ctx;
}
function readLedger(cwd: string): Array<{ type: string; value?: any }> {
  const raw = fs.readFileSync(`${cwd}/.pi-glla/active.jsonl`, "utf-8");
  return raw.split("\n").filter(Boolean).map((l) => JSON.parse(l));
}
function ledgerHangs(cwd: string): Array<{ type: string; value?: any }> {
  return readLedger(cwd).filter((l) => l.type === "subagent_hang_detected");
}
/** Live bound session WITHOUT autoResume: a continuation dispatch would set
 * pendingContinuationDispatch and heartbeatTick returns before the subagent
 * hang scan. The watchdog is goal-independent — no goal needed. */
async function spawnFixture(): Promise<{ cwd: string; ctx: MockCtx }> {
  setGlobalAutoResume(false);
  const cwd = tmpCwd();
  const ctx = await freshSession(cwd, "startup");
  await tick();
  return { cwd, ctx };
}

const pi = new MockPi();
activate(pi.api);

/** A fake running subagent record, mirroring pi-subagents' AgentRecord poll shape. */
function runningRecord(overrides: { toolUses?: number; output?: number; status?: string } = {}): any {
  return {
    toolUses: overrides.toolUses ?? 0,
    lifetimeUsage: { output: overrides.output ?? 0 },
    status: overrides.status ?? "running",
  };
}
const MANAGER_KEY = Symbol.for("pi-subagents:manager");
function installManager(getRecord: (id: string) => any | undefined): void {
  (globalThis as any)[MANAGER_KEY] = { getRecord };
}
function uninstallManager(): void {
  delete (globalThis as any)[MANAGER_KEY];
}

afterEach(() => {
  __testOnlyResetOwnerSession();
  __testOnlyClearSubagentHangProbes();
  uninstallManager();
});

// ---------------------------------------------------------------- pure unit

test("classify: a running subagent with no new progress for 5m is hung", () => {
  const probes = [
    { recordId: "r1", lastProgressAt: Date.now() - 5 * 60_000 - 1, lastToolUses: 1, lastOutputTokens: 10 },
  ];
  const hung = classifyHungSubagents(probes, () => runningRecord({ toolUses: 1, output: 10 }));
  assert.equal(hung.length, 1, "the wedged subagent is flagged");
  assert.equal(hung[0]!.recordId, "r1");
  assert.ok(hung[0]!.silentMs >= 5 * 60_000);
});

test("classify: sub-5m silence is not hung (5m floor, shorter than the auditor's 10m)", () => {
  const probes = [
    { recordId: "r1", lastProgressAt: Date.now() - 4 * 60_000, lastToolUses: 1, lastOutputTokens: 10 },
  ];
  const hung = classifyHungSubagents(probes, () => runningRecord({ toolUses: 1, output: 10 }));
  assert.equal(hung.length, 0, "4m of silence is inside the 5m window");
});

test("classify: a NEW tool use refreshes the streak (working, not wedged)", () => {
  const probes = [
    { recordId: "r1", lastProgressAt: Date.now() - 30 * 60_000, lastToolUses: 1, lastOutputTokens: 10 },
  ];
  const hung = classifyHungSubagents(probes, () => runningRecord({ toolUses: 2, output: 10 }));
  assert.equal(hung.length, 0, "a tool use is progress — no hang");
  assert.equal(probes[0]!.lastToolUses, 2, "the counters advanced");
  assert.ok(probes[0]!.lastProgressAt > Date.now() - 60_000, "the streak reset to now");
});

test("classify: NEW output tokens refresh the streak (long think, still alive)", () => {
  const probes = [
    { recordId: "r1", lastProgressAt: Date.now() - 20 * 60_000, lastToolUses: 5, lastOutputTokens: 100 },
  ];
  const hung = classifyHungSubagents(probes, () => runningRecord({ toolUses: 5, output: 400 }));
  assert.equal(hung.length, 0, "output tokens are progress — no hang");
  assert.equal(probes[0]!.lastOutputTokens, 400);
});

test("classify: ended / non-running records are not hung (watch stops)", () => {
  const ended = [{ recordId: "r1", lastProgressAt: Date.now() - 60 * 60_000, lastToolUses: 1, lastOutputTokens: 1, endedAt: Date.now() }];
  assert.equal(classifyHungSubagents(ended, () => runningRecord()).length, 0, "ended probe is skipped");
  const completed = [{ recordId: "r2", lastProgressAt: Date.now() - 60 * 60_000, lastToolUses: 1, lastOutputTokens: 1 }];
  assert.equal(classifyHungSubagents(completed, () => runningRecord({ status: "completed" })).length, 0, "completed record is skipped");
});

test("v0.34.102: a vanished/unreachable record falls back to event-only evidence (field: pully 118m wedge)", () => {
  // Field case (pully W161 rehearsal agent aac4ab1e, 2026-08-08): the
  // manager record was unreachable for the whole 118-minute wedge, so the
  // OLD `if (!rec) continue` skipped the probe every poll and
  // `subagent_hang_detected` NEVER fired. Event-only classification uses
  // the probe's own lastProgressAt (spawn seed + compacted/steered refresh)
  // against the LONGER SUBAGENT_HANG_EVENT_ONLY_MS window.
  const stale = [{ recordId: "gone-1", lastProgressAt: Date.now() - 21 * 60_000, lastToolUses: 0, lastOutputTokens: 0 }];
  const hung = classifyHungSubagents(stale, () => undefined);
  assert.equal(hung.length, 1, "a stale event-only probe IS hung (no manager record to contradict it)");
  assert.ok(hung[0]!.silentMs >= 20 * 60_000);

  const fresh = [{ recordId: "gone-2", lastProgressAt: Date.now() - 60_000, lastToolUses: 0, lastOutputTokens: 0 }];
  assert.equal(classifyHungSubagents(fresh, () => undefined).length, 0, "a young event-only probe is not hung");

  const ended = [{ recordId: "gone-3", lastProgressAt: Date.now() - 21 * 60_000, lastToolUses: 0, lastOutputTokens: 0, endedAt: Date.now() }];
  assert.equal(classifyHungSubagents(ended, () => undefined).length, 0, "an ended probe is skipped even with no record");
});

// ------------------------------------------------------------- integration

test("hang detection surfaces ui.notify + ledger `subagent_hang_detected` via the heartbeat scan", async () => {
  const { cwd, ctx } = await spawnFixture();
  installManager(() => runningRecord({ toolUses: 0, output: 0 })); // frozen record
  pi.emitBus("subagents:started", { id: "sub-wedged-1", type: "Explore", description: "survey auth flow" });
  await tick();
  assert.equal(__testOnlySubagentHangProbes().length, 1, "spawn seeded the probe");

  // Backdate the probe so the 5m streak is already elapsed.
  const probe = __testOnlySubagentHangProbes()[0]!;
  probe.lastProgressAt = Date.now() - 6 * 60_000;

  __testOnlyHeartbeatTick();
  await tick();

  const hangs = ledgerHangs(cwd);
  assert.equal(hangs.length, 1, "exactly one hang ledgered");
  assert.equal(hangs[0]!.value.recordId, "sub-wedged-1");
  assert.equal(hangs[0]!.value.agentType, "Explore");
  assert.equal(hangs[0]!.value.summary, "survey auth flow");
  assert.ok(hangs[0]!.value.silentMs >= 5 * 60_000);
  const warned = ctx.ui.notifies.filter((n) => n.message.includes("no progress"));
  assert.equal(warned.length, 1, "the user was warned");
  assert.ok(warned[0]!.message.includes("Explore"), "the warning names the subagent");
});

test("hang warning is throttled — one alert per 5m streak window, not per tick", async () => {
  const { cwd } = await spawnFixture();
  installManager(() => runningRecord({ toolUses: 0, output: 0 }));
  pi.emitBus("subagents:started", { id: "sub-throttle-1", type: "general-purpose", description: "build the widget" });
  await tick();
  const probe = __testOnlySubagentHangProbes()[0]!;
  probe.lastProgressAt = Date.now() - 6 * 60_000;

  __testOnlyHeartbeatTick();
  await tick();
  __testOnlyHeartbeatTick(); // second tick within the throttle window
  await tick();

  assert.equal(ledgerHangs(cwd).length, 1, "the second tick does not re-alert inside the throttle");
});

test("v0.34.102: event-only hang surfaces `subagent_hang_detected` with evidence=event-only when no manager record exists", async () => {
  const { cwd, ctx } = await spawnFixture();
  // NO installManager() — the pi-subagents manager registry is absent, which
  // is the field shape (pully: getRecord returned undefined for the whole
  // 118m wedge). The watchdog must still classify via the probe's own event
  // trail against the longer SUBAGENT_HANG_EVENT_ONLY_MS window.
  pi.emitBus("subagents:started", { id: "sub-orphan-1", type: "general-purpose", description: "rehearse W161 contract" });
  await tick();
  assert.equal(__testOnlySubagentHangProbes().length, 1, "spawn seeded the probe");

  // Backdate past the 20m event-only window (the 5m record path never
  // applies — no record to poll).
  const probe = __testOnlySubagentHangProbes()[0]!;
  probe.lastProgressAt = Date.now() - 21 * 60_000;

  __testOnlyHeartbeatTick();
  await tick();

  const hangs = ledgerHangs(cwd);
  assert.equal(hangs.length, 1, "the orphaned subagent is surfaced despite no manager record");
  assert.equal(hangs[0]!.value.recordId, "sub-orphan-1");
  assert.equal(hangs[0]!.value.evidence, "event-only", "the ledger names the evidence class");
  assert.ok(hangs[0]!.value.silentMs >= 20 * 60_000);
  const warned = ctx.ui.notifies.filter((n) => n.message.includes("manager record is unreachable"));
  assert.equal(warned.length, 1, "the warning names the event-only shape");
});

test("completed/failed events end the watch — no hang alert after completion", async () => {
  const { cwd } = await spawnFixture();
  installManager(() => runningRecord({ toolUses: 0, output: 0 }));
  pi.emitBus("subagents:started", { id: "sub-done-1", type: "Plan", description: "design the rollout" });
  await tick();
  pi.emitBus("subagents:completed", { id: "sub-done-1", type: "Plan", description: "design the rollout", status: "completed" });
  await tick();
  const probe = __testOnlySubagentHangProbes()[0]!;
  assert.ok(probe.endedAt !== undefined, "the watch ended on completion");
  probe.lastProgressAt = Date.now() - 6 * 60_000;

  __testOnlyHeartbeatTick();
  await tick();
  assert.equal(ledgerHangs(cwd).length, 0, "no hang alert for a completed subagent");
});

test("compacted/steered events refresh the streak (secondary progress evidence)", async () => {
  const { cwd } = await spawnFixture();
  installManager(() => runningRecord({ toolUses: 0, output: 0 }));
  pi.emitBus("subagents:started", { id: "sub-alive-1", type: "Explore", description: "long research pass" });
  await tick();
  const probe = __testOnlySubagentHangProbes()[0]!;
  probe.lastProgressAt = Date.now() - 6 * 60_000;
  pi.emitBus("subagents:compacted", { id: "sub-alive-1", reason: "context full" });
  await tick();

  __testOnlyHeartbeatTick();
  await tick();
  assert.equal(ledgerHangs(cwd).length, 0, "a compaction is fresh evidence — no hang");
  assert.ok(probe.lastProgressAt > Date.now() - 60_000, "the streak reset on the compacted event");
});

test("malformed hang inputs are dropped, not crashy", async () => {
  await spawnFixture();
  installManager(() => runningRecord());
  pi.emitBus("subagents:started", { type: "Explore" });         // no id
  pi.emitBus("subagents:compacted", "not-an-object");           // garbage payload
  pi.emitBus("subagents:steered", { message: "no id" });        // no id
  pi.emitBus("subagents:completed", { id: 42 });                // non-string id
  pi.emitBus("subagents:failed", { id: "" });                   // empty id
  await tick();
  assert.equal(__testOnlySubagentHangProbes().length, 0, "nothing registered for malformed events");
});

test("source pins: constants, watchdog wiring, and ledger key", () => {
  const hb = fs.readFileSync("extensions/goal-heartbeat.ts", "utf-8"); // decomposition step 4 (v0.34.112)
  assert.match(hb, /const SUBAGENT_HANG_NO_PROGRESS_MS = 5 \* 60_000;/);
  assert.match(hb, /const SUBAGENT_HANG_EVENT_ONLY_MS = 20 \* 60_000;/);
  assert.match(hb, /Symbol\.for\("pi-subagents:manager"\)/);
  assert.match(hb, /subagent_hang_detected/);
  assert.match(hb, /evidence: stillTracked \? "record-frozen" : "event-only"/);
  const src = readGoalRuntimeSource();
  assert.match(src, /subagents:compacted/);
  assert.match(src, /subagents:steered/);
  assert.match(src, /subagents:completed/);
  assert.match(src, /subagents:failed/);
  assert.match(src, /upsertSubagentHangProbe\(sessionId/);
});

// v0.34.105 (field: 2026-08-08 16:18 — quota wall froze subagent
// 74305f7e while the MAIN model was also in recovery). Before this fix,
// heartbeatTick returned early at `if (mainModelRecoveryActive()) return;`
// and the subagent hang scan NEVER ran during a main-model quota wall —
// the 12m+ wedge produced zero `subagent_hang_detected` ledger entries.
// The scan is detection + notify only (never an auto-kill), so it must
// run even while the main model is quota-parked: a shared-provider wall
// freezes subagents and the main model at the same time.
test("v0.34.105: hang scan runs during main-model recovery (quota wall blinds the watchdog before the fix)", async () => {
  __testOnlyResetStaleFlag();
  const cwd = tmpCwd();
  const ctx = await freshSession(cwd, "startup");
  await pi.command("goal", "start recovery-blindspot target — done when pinned", ctx);
  await tick();
  assert.equal((readState(cwd).goal as { status: string }).status, "active", "goal created and active");

  // Park the MAIN model into durable recovery (3× 429) — the exact field
  // shape: main model quota-walled, subagent frozen by the same wall.
  const errTurn = { messages: [{ role: "assistant", content: [], stopReason: "error", errorMessage: "429: rate_limit_error" }] };
  for (let i = 0; i < 3; i++) {
    await pi.fire("agent_end", errTurn, ctx);
    await tick();
  }
  const parked = readState(cwd) as { goal: { status: string; pauseKind?: string }; mainModelRecovery?: unknown };
  assert.equal(parked.goal.status, "paused", "the quota wall parks the goal");
  assert.ok(parked.mainModelRecovery, "the main model is in recovery — the exact gate that used to blind the scan");

  // Now a subagent freezes (frozen record, no new progress for 6m):
  installManager(() => runningRecord({ toolUses: 0, output: 0 }));
  pi.emitBus("subagents:started", { id: "sub-quota-1", type: "general-purpose", description: "audit the project" });
  await tick();
  const probe = __testOnlySubagentHangProbes()[0]!;
  probe.lastProgressAt = Date.now() - 6 * 60_000;

  __testOnlyHeartbeatTick();
  await tick();

  const hangs = ledgerHangs(cwd);
  assert.equal(hangs.length, 1, "the frozen subagent is surfaced even while the main model is quota-parked");
  assert.equal(hangs[0]!.value.recordId, "sub-quota-1");
  assert.equal(hangs[0]!.value.evidence, "record-frozen", "record still pollable → record-frozen evidence");
  const warned = ctx.ui.notifies.filter((n) => n.message.includes("no progress"));
  assert.equal(warned.length, 1, "the user was warned during the recovery window");
});

test("v0.34.105 source pin: subagent scan precedes the main-model-recovery early return in heartbeatTick", () => {
  const hb = fs.readFileSync("extensions/goal-heartbeat.ts", "utf-8"); // decomposition step 4 (v0.34.112)
  const tickBody = hb.slice(hb.indexOf("function heartbeatTick"), hb.indexOf("function startHeartbeat"));
  const scanAt = tickBody.indexOf("subagentHangProbes.size > 0");
  // v0.35.28 (issue #16): the gate became a block that first runs the
  // due-wait backstop, then returns under active main-model recovery.
  const recoveryGateAt = tickBody.indexOf("if (mainModelRecoveryActive()) {");
  assert.ok(scanAt > -1, "the subagent scan lives in heartbeatTick");
  assert.ok(recoveryGateAt > -1, "the recovery early-return lives in heartbeatTick");
  assert.ok(scanAt < recoveryGateAt, "the scan runs BEFORE the recovery gate — a quota wall can no longer blind it");
});
