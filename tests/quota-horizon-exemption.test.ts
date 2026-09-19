// pi-goal-list-loop-audit — quota-wait exempt from the 24h park horizon.
//
// Antigravity port (survey 2026-09-19): agy busy-retries a quota wall until
// reset (2546 RESOURCE_EXHAUSTED hits in one log, never parking), while GLLA
// parks quota waits at the 24h automatic-recovery horizon even though the
// wall is transient. Pins (conservative mode — aggressive already drops the
// horizon):
//   1. A quota-class episode (rate-limit/plan-quota) past its horizon does
//      NOT hold for manual resume: the wait is re-armed, attempts keep
//      climbing, the run survives the wall.
//   2. Billing still parks at the horizon (account wall, not a transient).
//   3. Non-quota failures still park at the horizon.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  clearMainModelRecoveryTimer,
  createGoalRecovery,
  setMainModelRecoveryPause,
} from "../extensions/goal-recovery.js";
import { replaceState, state } from "../extensions/goal-state.js";
import { globalSettingsPath } from "../extensions/goal-settings.js";

const HOUR_MS = 60 * 60_000;

function rig() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "glla-quota-horizon-"));
  const settingsFile = globalSettingsPath();
  const original = fs.existsSync(settingsFile) ? fs.readFileSync(settingsFile, "utf8") : undefined;
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
    extensionApi: { setModel: async () => true },
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
  fs.writeFileSync(settingsFile, JSON.stringify({ aggressiveMode: false }));
  return {
    ctx,
    restore() {
      try { clearMainModelRecoveryTimer(); } catch { /* best-effort */ }
      if (original === undefined) { try { fs.unlinkSync(settingsFile); } catch { /* best-effort */ } }
      else fs.writeFileSync(settingsFile, original);
      replaceState({ goal: null } as any);
    },
  };
}

function pastHorizonEpisode(reason: string) {
  const firstFailureAt = new Date(Date.now() - 25 * HOUR_MS).toISOString();
  return {
    primary: "provider/primary",
    active: "provider/primary",
    attempted: ["provider/primary"],
    attempts: 40,
    reason,
    providerErrorDiagnostic: reason,
    firstFailureAt,
    autoRetryUntil: new Date(Date.now() - 1 * HOUR_MS).toISOString(),
    kind: "goal" as const,
  };
}

test("quota wait survives the horizon instead of parking", () => {
  const r = rig();
  try {
    const scheduled = setMainModelRecoveryPause(
      r.ctx,
      pastHorizonEpisode("429 Too Many Requests — Individual quota reached; retry in 2 hours"),
      2 * HOUR_MS,
    );
    assert.equal(scheduled, true, "quota wait re-arms past the horizon");
    assert.ok(state.mainModelRecovery?.retryAt, "a fresh probe is scheduled");
    assert.equal(state.mainModelRecovery?.manualResumeRequired, undefined, "no manual hold for a transient wall");
  } finally {
    r.restore();
  }
});

test("billing and non-quota failures still park at the horizon", () => {
  const r = rig();
  try {
    assert.equal(
      setMainModelRecoveryPause(r.ctx, pastHorizonEpisode("insufficient credits — buy credits"), 30 * 60_000),
      false, "billing parks: an account wall is not a transient",
    );
    assert.equal(state.mainModelRecovery?.manualResumeRequired, true);
    state.mainModelRecovery = undefined;
    assert.equal(
      setMainModelRecoveryPause(r.ctx, pastHorizonEpisode("503 Service Unavailable"), 30 * 60_000),
      false, "non-quota failures keep their horizon park",
    );
    assert.equal(state.mainModelRecovery?.manualResumeRequired, true);
  } finally {
    r.restore();
  }
});
