import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { cancelHourlyProbe, createGoalRecovery, fireHourlyProbe, scheduleHourlyProbe } from "../extensions/goal-recovery.js";
import { replaceState, state } from "../extensions/goal-state.js";

const settingsPath = process.env.GLLA_GLOBAL_SETTINGS_PATH;
assert.ok(settingsPath, "the parent test supplies an isolated global-settings path");

function setHourlyProbeSetting(enabled) {
  fs.writeFileSync(settingsPath, JSON.stringify({ hourlyRetryProbe: enabled }));
}

function parkedRecovery() {
  return {
    primary: "openai/backup",
    active: "anthropic/mock-model",
    attempted: ["anthropic/mock-model"],
    attempts: 1,
    // This fixture exercises rejected model selection, not the earlier
    // same-model retry phase. That phase has its own integration coverage.
    sameModelRetries: 10,
    reason: "main model quota: synthetic hourly probe failure",
    kind: "goal",
    firstFailureAt: new Date().toISOString(),
    autoRetryUntil: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
    retryAt: new Date(Date.now() + 60_000).toISOString(),
  };
}

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "glla-hourly-runtime-"));
const ctx = {
  cwd,
  model: { provider: "anthropic", id: "mock-model" },
  modelRegistry: { find: () => ({ provider: "openai", id: "backup" }) },
  ui: { notify: () => {} },
};

let providerCalls = 0;
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
      providerCalls += 1;
      throw new Error("synthetic hourly probe failure");
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
  // A cycle-reset probe resumes the supervised turn on the currently
  // selected model; count that turn as the provider call in this isolated
  // runtime instead of pretending setModel() itself sends a request.
  scheduleContinuation: () => { providerCalls += 1; },
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

setHourlyProbeSetting(true);
replaceState({ goal: { status: "paused", pauseReason: "main model recovery" }, mainModelRecovery: parkedRecovery() });
scheduleHourlyProbe(ctx);
assert.equal(scheduled.length, 1, "parked recovery arms one hourly timer");
const firstHourly = scheduled[0];
run(firstHourly);
await settle();
assert.equal(providerCalls, 1, "the first scheduled slot executes a provider probe");
assert.match(ledger(), /"main_model_probe_failed"/, "the injected provider failure reaches cleanup");
assert.notEqual(flags.hourlyProbeTimer, null, "cleanup leaves a new hourly timer");
const pending = scheduled.filter((timer) => !timer.fired);
assert.equal(pending.length, 2, "normal retry and later hourly slot are both pending");
const secondHourly = pending.find((timer) => timer.native === flags.hourlyProbeTimer);
const normalRetry = pending.find((timer) => timer !== secondHourly);
assert.ok(secondHourly, "cleanup leaves a distinct hourly timer among the pending schedules");
assert.ok(normalRetry, "the normal recovery retry remains separately scheduled");
assert.notEqual(secondHourly.native, firstHourly.native, "cleanup did not retain the consumed timer");
assert.notEqual(secondHourly.native, normalRetry.native, "the hourly and normal retry handles are distinct");
assert.equal(flags.hourlyProbeTimer, secondHourly.native, "the re-armed timer is the hourly handle");

run(secondHourly);
await settle();
assert.equal(providerCalls, 2, "the later scheduled slot executes a second provider probe");
assert.equal((ledger().match(/"hourly_probe_fired"/g) ?? []).length, 2, "both hourly slots fired");

cancelHourlyProbe();
setHourlyProbeSetting(false);
replaceState({ goal: { status: "paused", pauseReason: "main model recovery" }, mainModelRecovery: parkedRecovery() });
const beforeOptOut = scheduled.length;
scheduleHourlyProbe(ctx);
assert.equal(scheduled.length, beforeOptOut, "opt-out prevents a new hourly timer");

setHourlyProbeSetting(true);
scheduleHourlyProbe(ctx);
const staleTimer = scheduled[scheduled.length - 1];
assert.equal(staleTimer.fired, false, "opt-in arms a timer again");
const beforeStale = scheduled.length;
flags.sessionGeneration += 1;
run(staleTimer);
await settle();
assert.equal(providerCalls, 2, "a stale generation never reaches the provider");
assert.equal(scheduled.length, beforeStale, "a stale timer does not re-arm itself");
assert.equal((ledger().match(/"hourly_probe_fired"/g) ?? []).length, 2, "stale execution emits no probe event");

// The normal retry timer and the hourly slot can become ready together. The
// recovery wrapper must serialize the provider call instead of launching two
// overlapping probes against the same saved wall.
cancelHourlyProbe();
replaceState({ goal: { status: "paused", pauseReason: "main model recovery" }, mainModelRecovery: parkedRecovery() });
const beforeOverlap = providerCalls;
await Promise.all([fireHourlyProbe(ctx), fireHourlyProbe(ctx)]);
assert.equal(providerCalls - beforeOverlap, 1, "overlapping hourly/normal probes share one in-flight provider call");
assert.match(ledger(), /"main_model_probe_skipped_in_flight"/, "the overlap fence is observable");

cancelHourlyProbe();
for (const timer of scheduled) clearTimeout(timer.native);
console.log("hourly-runtime-ok");
