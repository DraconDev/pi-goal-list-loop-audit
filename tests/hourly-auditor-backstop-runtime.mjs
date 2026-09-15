import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { cancelHourlyProbe, createGoalRecovery, fireHourlyProbe, scheduleHourlyProbe } from "../extensions/goal-recovery.js";
import { replaceState } from "../extensions/goal-state.js";

const settingsPath = process.env.GLLA_GLOBAL_SETTINGS_PATH;
assert.ok(settingsPath, "the parent test supplies an isolated global-settings path");

function setHourlyProbeSetting(enabled) {
  fs.writeFileSync(settingsPath, JSON.stringify({ hourlyRetryProbe: enabled }));
}

function parkedAuditorClaim(over = {}) {
  return {
    status: "paused",
    pauseKind: "wait",
    pauseReason: "auditor retry: 503 upstream unavailable",
    pauseResumeAt: new Date(Date.now() - 60_000).toISOString(),
    pendingCompletion: {
      phase: "retry-waiting",
      claim: "done",
      goalId: "g-1",
      attemptId: "a-1",
      at: new Date().toISOString(),
      retryAttempts: 3,
      retryFirstAt: new Date().toISOString(),
    },
    ...over,
  };
}

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "glla-hourly-auditor-"));
fs.mkdirSync(path.join(cwd, ".pi-glla"), { recursive: true });
const ctx = {
  cwd,
  model: { provider: "anthropic", id: "mock-model" },
  modelRegistry: { find: () => ({ provider: "openai", id: "backup" }) },
  ui: { notify: () => {} },
};

const scheduled = [];
const flags = {
  completionAuditRecoveryArmed: false,
  mainModelRecoveryTimer: null,
  mainModelSwitchInFlight: false,
  mainModelAbortForRecovery: false,
  lastMainModelFailure: null,
  hourlyProbeTimer: null,
  hourlyProbeFireAt: null,
  sessionGeneration: 1,
  extensionApi: {
    setModel: async () => {
      throw new Error("the auditor backstop never switches models");
    },
  },
  extensionApiStale: false,
  continuationDispatchStoodDown: false,
  lastLongLivedFailureAt: 0,
  lastMainModelRecoveryResumeAt: 0,
};

const deps = {
  activeGoalSurfaceCommand: (command) => `/${command}`,
  clearDetachedAuditRuntime: () => {},
  updateGoal: () => {},
  clearContinuationTimer: () => {},
  freshCtxForGeneration: (generation) => generation === flags.sessionGeneration ? ctx : null,
  isSupervising: () => true,
  notifyExternal: () => {},
  persistState: () => {},
  recoverySurfaceCommand: (_kind, command) => `/${command}`,
  scheduleContinuation: () => {},
  scheduleSessionTimeout: (callback, delayMs) => {
    const timer = {
      delayMs,
      callback,
      native: setTimeout(() => {}, 60 * 60_000),
      fired: false,
    };
    scheduled.push(timer);
    return timer.native;
  },
};

createGoalRecovery(flags, deps);

function run(timer) {
  assert.equal(timer.fired, false, "a runtime timer fires once");
  timer.fired = true;
  timer.callback();
}

async function settle() {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function ledger() {
  return fs.readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf8");
}

// The auditor retry call is a runtime-global seam (same one the production
// ladder uses). Stub it and count invocations with their origin.
const retryCalls = [];
globalThis.retryStoredCompletionAudit = async (origin) => {
  retryCalls.push(origin ?? "unknown");
};

setHourlyProbeSetting(true);

// 1. An auditor-only park (no main-model recovery at all) arms the ticker.
replaceState({ goal: parkedAuditorClaim(), mainModelRecovery: undefined });
scheduleHourlyProbe(ctx);
assert.equal(scheduled.length, 1, "a parked auditor claim arms one hourly timer");
const auditorSlot = scheduled[0];

// 2. The :00:30 slot fires the parked auditor retry and re-arms the ticker.
run(auditorSlot);
await settle();
assert.deepEqual(retryCalls, ["provider-retry"], "the backstop retries the stored claim past its ladder deadline");
assert.match(ledger(), /"hourly_probe_auditor_backstop"/, "the backstop probe is observable in the ledger");
const rearmed = scheduled.filter((timer) => !timer.fired);
assert.equal(rearmed.length, 1, "the backstop re-arms its hourly slot");
assert.notEqual(rearmed[0].native, auditorSlot.native, "the re-armed slot is a fresh handle");

// 3. A claim whose ladder deadline has NOT passed stays with the ladder timer.
replaceState({ goal: parkedAuditorClaim({ pauseResumeAt: new Date(Date.now() + 3_600_000).toISOString() }), mainModelRecovery: undefined });
await fireHourlyProbe(ctx);
await settle();
assert.equal(retryCalls.length, 1, "a not-yet-due claim does not fire early");

// 4. Any other claim phase never reaches the auditor retry.
replaceState({
  goal: parkedAuditorClaim({
    pauseReason: "completion audit timed out — no verifier verdict was produced",
    pendingCompletion: { phase: "recovery-pending", claim: "done" },
  }),
  mainModelRecovery: undefined,
});
await fireHourlyProbe(ctx);
await settle();
assert.equal(retryCalls.length, 1, "a non-retry-waiting claim is ignored");

// 5. A retry-waiting claim under a different pause copy is not ours.
replaceState({ goal: parkedAuditorClaim({ pauseReason: "something else entirely" }), mainModelRecovery: undefined });
await fireHourlyProbe(ctx);
await settle();
assert.equal(retryCalls.length, 1, "a foreign pause reason is ignored");

// 6. Opt-out blocks new timers even for a parked auditor claim.
cancelHourlyProbe();
setHourlyProbeSetting(false);
replaceState({ goal: parkedAuditorClaim(), mainModelRecovery: undefined });
const beforeOptOut = scheduled.length;
scheduleHourlyProbe(ctx);
assert.equal(scheduled.length, beforeOptOut, "opt-out prevents a new hourly timer");

delete globalThis.retryStoredCompletionAudit;
cancelHourlyProbe();
for (const timer of scheduled) clearTimeout(timer.native);
console.log("auditor-backstop-runtime-ok");
