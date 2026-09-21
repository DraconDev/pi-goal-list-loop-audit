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
import { isDeterministicProviderError } from "../extensions/main-model-recovery.js";
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
    assert.equal(
      setMainModelRecoveryPause(r.ctx, pastHorizonEpisode("503 Service Unavailable"), 30 * 60_000),
      false, "non-quota failures keep their horizon park",
    );
    assert.equal(state.mainModelRecovery?.manualResumeRequired, true);
  } finally {
    r.restore();
  }
});

function freshEpisode(reason: string) {
  return {
    primary: "provider/primary",
    active: "provider/primary",
    attempted: ["provider/primary"],
    attempts: 2,
    reason,
    providerErrorDiagnostic: reason,
    firstFailureAt: new Date().toISOString(),
    kind: "goal" as const,
  };
}

test("deterministic classifier: 400 markers hold, everything else passes through", () => {
  assert.equal(
    isDeterministicProviderError('400: {"message":"***.BadRequestError: OpenAIException - {\\"object\\":\\"error\\",\\"message\\":\\"Image count 12 exceeds limit 4 per request.\\",\\"type\\":\\"BadRequestError\\",\\"param\\":null,\\"code\\":400}"}'),
    true,
    "field case: image-count 400",
  );
  assert.equal(isDeterministicProviderError("invalid_request_error: reasoning encrypted_content was not issued"), true);
  assert.equal(isDeterministicProviderError('{"type":"upstream_error","code":"400"}'), true);
  assert.equal(isDeterministicProviderError("429 Too Many Requests"), false);
  assert.equal(isDeterministicProviderError("503 Service Unavailable"), false);
  assert.equal(isDeterministicProviderError("used 400 of 200k tokens"), false, "bare 400s (token counts) never match");
  assert.equal(isDeterministicProviderError(""), false);
  assert.equal(isDeterministicProviderError(undefined), false);
});

test("deterministic 400 holds even aggressive and fresh — identical retries cannot succeed", () => {
  const r = rig();
  try {
    fs.writeFileSync(globalSettingsPath(), JSON.stringify({ aggressiveMode: true }));
    const scheduled = setMainModelRecoveryPause(
      r.ctx,
      freshEpisode('BadRequestError: Image count 12 exceeds limit 4 per request. "code":"400"'),
      15 * 60_000,
    );
    assert.equal(scheduled, false, "no timer for a deterministic refusal, even aggressive");
    assert.equal(state.mainModelRecovery?.manualResumeRequired, true, "held for manual resume with fix directions");
    assert.equal(state.mainModelRecovery?.retryAt, undefined, "no probe scheduled");
  } finally {
    r.restore();
  }
});

test("deterministic hold names the fix directions", () => {
  const src = fs.readFileSync("extensions/goal-recovery.ts", "utf-8");
  assert.match(src, /deterministic client error/, "hold names the refusal class");
  assert.match(src, /Switch model or trim the request, then resume/, "hold tells the user how to unstick it");
});

test("transient wall still schedules under aggressive (control)", () => {
  const r = rig();
  try {
    fs.writeFileSync(globalSettingsPath(), JSON.stringify({ aggressiveMode: true }));
    const scheduled = setMainModelRecoveryPause(r.ctx, freshEpisode("429 Too Many Requests — retry later"), 15 * 60_000);
    assert.equal(scheduled, true, "transient 429 keeps its probe");
    assert.equal(state.mainModelRecovery?.manualResumeRequired, undefined);
  } finally {
    r.restore();
  }
});
