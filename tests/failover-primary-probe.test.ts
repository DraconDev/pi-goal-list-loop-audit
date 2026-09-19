// pi-goal-list-loop-audit — work-through-failover with reset-timed primary probe.
//
// Antigravity port (survey 2026-09-19): while the primary sleeps through a
// quota wall, fallback-chain work proceeds and the primary is probed in the
// background with auto-failback. GLLA already walks the chain and probes —
// but the probe fires on the generic cadence (default 15m), hammering a
// KNOWN-walled primary. Pins:
//   1. A quota-hinted failure on the primary stamps primaryResetAt on the
//      recovery episode when failing over.
//   2. A hintless primary failure stamps no reset (generic cadence stands).
//   3. While a fallback serves, the background primary probe fires AT the
//      reset, not on the generic 15m cadence.
//   4. Without a reset, the probe keeps the generic cadence.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { classifyMainModelFailure } from "../extensions/main-model-recovery.js";
import {
  clearMainModelRecoveryTimer,
  createGoalRecovery,
  mainModelRecoverySucceeded,
  tryMainModelFallback,
} from "../extensions/goal-recovery.js";
import { replaceState, state } from "../extensions/goal-state.js";
import { globalSettingsPath } from "../extensions/goal-settings.js";

const HOUR_MS = 60 * 60_000;

function rig() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "glla-failover-probe-"));
  const settingsFile = globalSettingsPath();
  const original = fs.existsSync(settingsFile) ? fs.readFileSync(settingsFile, "utf8") : undefined;
  const calls: string[] = [];
  const ctx: any = {
    cwd,
    model: { provider: "provider", id: "primary" },
    modelRegistry: {
      find: (provider: string, id: string) => ({ provider, id }),
      hasConfiguredAuth: () => true,
    },
    ui: { notify: () => {} },
    abort: () => {},
  };
  const flags: any = {
    completionAuditRecoveryArmed: false,
    mainModelRecoveryTimer: null,
    mainModelSwitchInFlight: false,
    mainModelAbortForRecovery: false,
    lastMainModelFailure: null,
    hourlyProbeTimer: null,
    hourlyProbeFireAt: null,
    sessionGeneration: 1,
    extensionApi: { setModel: async (model: any) => { calls.push(`${model.provider}/${model.id}`); return true; } },
    extensionApiStale: false,
    continuationDispatchStoodDown: false,
    lastMainModelRecoveryResumeAt: 0,
  };
  replaceState({ goal: null } as any);
  createGoalRecovery(flags, {
    activeGoalSurfaceCommand: (command: string) => `/${command}`,
    clearDetachedAuditRuntime: () => {},
    updateGoal: () => {},
    clearContinuationTimer: () => {},
    freshCtxForGeneration: (generation: number) => generation === flags.sessionGeneration ? ctx : null,
    isSupervising: () => true,
    notifyExternal: () => {},
    persistState: () => {},
    recoverySurfaceCommand: (_kind: "goal" | "loop", command: string) => `/${command}`,
    scheduleContinuation: () => {},
    scheduleSessionTimeout: () => setTimeout(() => {}, 60_000),
  });
  fs.writeFileSync(settingsFile, JSON.stringify({
    mainModelFallbacks: ["provider/first", "provider/second"],
  }));
  return {
    cwd, ctx, calls,
    restore() {
      try { clearMainModelRecoveryTimer(); } catch { /* best-effort */ }
      if (original === undefined) { try { fs.unlinkSync(settingsFile); } catch { /* best-effort */ } }
      else fs.writeFileSync(settingsFile, original);
      replaceState({ goal: null } as any);
    },
  };
}

test("failover stamps the primary reset while fallback-chain work proceeds", async () => {
  const r = rig();
  try {
    const before = Date.now();
    assert.equal(await tryMainModelFallback(r.ctx, classifyMainModelFailure("429 Too Many Requests; retry in 2 hours")), true);
    assert.equal(r.calls.at(-1), "provider/first", "work fails over to the chain");
    const resetAt = state.mainModelRecovery?.primaryResetAt;
    assert.ok(resetAt, "the quota-walled primary carries its reset forward");
    const ms = Date.parse(resetAt!) - before;
    assert.ok(ms > 2 * HOUR_MS - 120_000 && ms <= 2 * HOUR_MS + 60_000, `reset lands ~2h out (got ${(ms / 60000).toFixed(1)}m)`);
  } finally {
    r.restore();
  }
});

test("hintless primary failure stamps no reset", async () => {
  const r = rig();
  try {
    assert.equal(await tryMainModelFallback(r.ctx, classifyMainModelFailure("429 Too Many Requests")), true);
    assert.equal(state.mainModelRecovery?.primaryResetAt, undefined, "no hint: generic probe cadence stands");
  } finally {
    r.restore();
  }
});

test("background primary probe fires at reset, not on the generic cadence", () => {
  const r = rig();
  try {
    const resetAt = new Date(Date.now() + 4 * HOUR_MS).toISOString();
    state.mainModelRecovery = {
      primary: "provider/primary",
      active: "provider/first",
      attempted: ["provider/primary", "provider/first"],
      attempts: 1,
      reason: "main model recovery — provider error",
      kind: "goal",
      primaryResetAt: resetAt,
    };
    r.ctx.model = { provider: "provider", id: "first" };
    mainModelRecoverySucceeded(r.ctx);
    assert.equal(state.mainModelRecovery?.primaryProbeAt, resetAt, "the probe waits for the reset");
  } finally {
    r.restore();
  }
});

test("no reset keeps the generic probe cadence", () => {
  const r = rig();
  try {
    const before = Date.now();
    state.mainModelRecovery = {
      primary: "provider/primary",
      active: "provider/first",
      attempted: ["provider/primary", "provider/first"],
      attempts: 1,
      reason: "main model recovery — provider error",
      kind: "goal",
    };
    r.ctx.model = { provider: "provider", id: "first" };
    mainModelRecoverySucceeded(r.ctx);
    const probeAt = state.mainModelRecovery?.primaryProbeAt;
    assert.ok(probeAt, "a probe is still scheduled");
    const ms = Date.parse(probeAt!) - before;
    assert.ok(ms > 10 * 60_000 && ms <= 16 * 60_000, `generic ~15m cadence (got ${(ms / 60000).toFixed(1)}m)`);
  } finally {
    r.restore();
  }
});
