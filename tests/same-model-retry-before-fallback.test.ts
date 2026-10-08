// pi-goal-list-loop-audit — v0.38.105
// tests/same-model-retry-before-fallback.test.ts
//
// The same-model retry budget (operator direction 2026-10-08): the CURRENT
// main model gets a bounded number of retries before the configured fallback
// chain is touched. Most provider failures are transient, so rotating on the
// first 429 spends a different provider's quota to solve a five-second
// problem. 0 restores the legacy immediate rotation. The phase is
// reason-agnostic: the existing envelope cadence (reset-hinted walls sleep to
// reset, transient/unknown/empty hammer at 5s, persistent walls ladder per
// mainModelRetryMinutes) applies inside it unchanged.
//
// Coverage:
//   1. normalizeMainModelSameModelRetries / sameModelRetriesRemain math
//   2. Source-pinned: the orchestrator gates tryMainModelFallback on the
//      budget, and the probe path re-arms a supervised turn on the current
//      model instead of walking the chain while the budget remains.
//   3. Integration: a fresh recovery (sameModelRetries=0) with budget=10
//      emits main_model_probe with mode:"same-model-retry" and does NOT
//      call setModel on a fallback.
//   4. Integration: a recovery that has already exhausted the budget walks
//      the chain (existing contract preserved).
//   5. Integration: tryMainModelFallback success resets sameModelRetries=0
//      so the backup earns its own budget from zero.
//   6. Integration: parkMainModelAfterFailure increments the counter across
//      same-model calls and resets it when the active model changes.
//   7. Sanitize: sanitizeMainModelRecovery accepts sameModelRetries and
//      bounds it to MAX_MAIN_MODEL_SAME_MODEL_RETRIES.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  classifyMainModelFailure,
  DEFAULT_MAIN_MODEL_SAME_MODEL_RETRIES,
  MAX_MAIN_MODEL_SAME_MODEL_RETRIES,
  normalizeMainModelSameModelRetries,
  sameModelRetriesRemain,
} from "../extensions/main-model-recovery.js";
import {
  createGoalRecovery,
  parkMainModelAfterFailure,
  probeMainModelRecovery,
  tryMainModelFallback,
} from "../extensions/goal-recovery.js";
import {
  formatMainModelRecoveryStatus,
  sanitizeMainModelRecovery,
} from "../extensions/goal-loop-core.js";
import { replaceState, state } from "../extensions/goal-state.js";
import { globalSettingsPath } from "../extensions/goal-settings.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const ORCH_SRC = readFileSync(path.join(here, "..", "extensions", "loops", "goal-orchestrator.ts"), "utf8");
const RECOVERY_SRC = readFileSync(path.join(here, "..", "extensions", "goal-recovery.ts"), "utf8");

test("normalizeMainModelSameModelRetries clamps to the documented range", () => {
  assert.equal(normalizeMainModelSameModelRetries(undefined), DEFAULT_MAIN_MODEL_SAME_MODEL_RETRIES);
  // null is a number-shaped absence: treat it as 0 (legacy rotation). An
  // explicit `null` is the operator opting out of the new phase.
  assert.equal(normalizeMainModelSameModelRetries(null), 0);
  assert.equal(normalizeMainModelSameModelRetries(0), 0, "0 explicitly opts in to the legacy immediate rotation");
  assert.equal(normalizeMainModelSameModelRetries(1), 1);
  assert.equal(normalizeMainModelSameModelRetries(-5), 0, "negative values normalize to 0 (legacy rotation), not a permanent stall");
  assert.equal(normalizeMainModelSameModelRetries(MAX_MAIN_MODEL_SAME_MODEL_RETRIES), MAX_MAIN_MODEL_SAME_MODEL_RETRIES);
  assert.equal(normalizeMainModelSameModelRetries(MAX_MAIN_MODEL_SAME_MODEL_RETRIES + 7), MAX_MAIN_MODEL_SAME_MODEL_RETRIES, "hand-edited values above the cap clamp to the cap");
  assert.equal(normalizeMainModelSameModelRetries("7"), 7, "string numbers parse the same as JSON numbers");
  assert.equal(normalizeMainModelSameModelRetries("banana"), DEFAULT_MAIN_MODEL_SAME_MODEL_RETRIES, "junk values use the safe default rather than disabling the phase");
  assert.equal(normalizeMainModelSameModelRetries(NaN), DEFAULT_MAIN_MODEL_SAME_MODEL_RETRIES);
  assert.equal(normalizeMainModelSameModelRetries(Infinity), DEFAULT_MAIN_MODEL_SAME_MODEL_RETRIES);
  assert.equal(normalizeMainModelSameModelRetries(3.7), 3, "fractional values are truncated toward integer semantics");
  // The default intentionally aligns with TRANSIENT_EAGER_ATTEMPTS — enough
  // retries to prove a 429 is not a blip before rotating.
  assert.equal(DEFAULT_MAIN_MODEL_SAME_MODEL_RETRIES, 10);
});

test("sameModelRetriesRemain: 0 budget = legacy rotation; positive budget = N retries", () => {
  assert.equal(sameModelRetriesRemain(undefined, 0), false);
  assert.equal(sameModelRetriesRemain(5, 0), false, "0 budget means rotate immediately regardless of spent");
  assert.equal(sameModelRetriesRemain(0, 10), true, "fresh episode: budget fully remains");
  assert.equal(sameModelRetriesRemain(9, 10), true, "9 spent out of 10 — one more before rotation");
  assert.equal(sameModelRetriesRemain(10, 10), false, "10 spent = budget exhausted = rotate next");
  assert.equal(sameModelRetriesRemain(11, 10), false, "overspend is a terminal condition; no rewind");
  assert.equal(sameModelRetriesRemain(NaN, 10), true, "missing counter is treated as 0 — full budget remains");
  assert.equal(sameModelRetriesRemain(-3, 10), true);
});

test("source: orchestrator gates the immediate rotation on the same-model budget", () => {
  // The gate is the only difference between today's "first 429 rotates" and
  // the operator-asked-for "10 retries on the current model first". Pin the
  // wiring so a future refactor cannot silently restore immediate rotation.
  const block = ORCH_SRC.slice(ORCH_SRC.indexOf("if (failure.kind !== \"non-recoverable\")"));
  assert.match(block, /sameModelBudget/, "the generic recoverable branch must consult the budget");
  assert.match(block, /sameModelRetriesRemain/, "the gate must call sameModelRetriesRemain");
  assert.match(block, /rotationsAllowed\s*\?\s*await\s+tryMainModelFallback/, "tryMainModelFallback runs only when rotationsAllowed");
  assert.doesNotMatch(
    ORCH_SRC.match(/if \(failure\.kind !== "non-recoverable"\)[\s\S]*?tryMainModelFallback\(ctx, failure\)/)?.[0] ?? "",
    /return true;\s*\/\/ pi's core retry now uses the selected backup/,
    "the legacy unconditional rotation is gone",
  );
});

test("source: probe path emits a same-model-retry branch before the selector walk", () => {
  // The probe path is what fires when the parked recovery timer ticks.
  // Without this branch, a fresh recovery (sameModelRetries=0) would walk
  // the configured fallback chain on the very first probe, even though the
  // agent_end gate would have parked on the current model. The branch keeps
  // the agent_end and probe paths consistent.
  const probe = RECOVERY_SRC.slice(RECOVERY_SRC.indexOf("async function probeMainModelRecoveryImpl"));
  assert.match(probe, /sameModelRetriesRemain/, "probe impl must consult the same-model budget");
  assert.match(probe, /mode:\s*"same-model-retry"/, "the same-model branch must emit a mode that distinguishes it from cycle-reset and resume-backup");
  assert.match(probe, /Main model recovery: retrying.*same-model retry/i, "operator-visible notify must name the phase and the budget");
});

test("integration: fresh recovery retries the current model instead of rotating", async () => {
  const cwd = fs.mkdtempSync(path.join("/tmp", "glla-same-model-park-"));
  const settingsFile = globalSettingsPath();
  const original = fs.existsSync(settingsFile) ? fs.readFileSync(settingsFile, "utf8") : undefined;
  const calls: string[] = [];
  const notifies: string[] = [];
  const ctx: any = {
    cwd,
    model: { provider: "provider", id: "primary" },
    modelRegistry: {
      find: (provider: string, id: string) => ({ provider, id, reasoning: true }),
      hasConfiguredAuth: () => true,
    },
    ui: { notify: (m: string) => notifies.push(m) },
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
    extensionApi: { setModel: async (model: any) => { calls.push(`${model.provider}/${model.id}`); return true; }, getThinkingLevel: () => "high", setThinkingLevel: () => {} },
    extensionApiStale: false,
    continuationDispatchStoodDown: false,
    lastMainModelRecoveryResumeAt: 0,
  };
  try {
    fs.writeFileSync(settingsFile, JSON.stringify({
      mainModelFallbacks: ["provider/first", "provider/second"],
      mainModelSameModelRetries: 10,
    }));
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
    // Fresh episode: no recovery yet, retries=0, budget=10. A scheduled
    // probe on the parked timer must re-arm on the current model and
    // emit a same-model-retry probe event, not call setModel on a backup.
    state.mainModelRecovery = {
      primary: "provider/primary",
      active: "provider/primary",
      attempted: ["provider/primary"],
      attempts: 1,
      retryAt: new Date(Date.now() - 1).toISOString(), // timer past, so the probe runs
      reason: "main model recovery — provider error",
      kind: "goal",
    };
    await probeMainModelRecovery(ctx);
    assert.equal(calls.length, 0, "a fresh same-model retry must not call setModel on a backup");
    assert.equal(state.mainModelRecovery?.active, "provider/primary", "the current model keeps the episode");
    assert.equal(state.mainModelRecovery?.sameModelRetries, 1, "the same-model counter increments");
    assert.equal(state.mainModelRecovery?.attempted, ["provider/primary"], "attempted resets to [current] so the chain is fresh after exhaustion");
    assert.ok(
      notifies.some((m) => /same-model retry 1\/10/.test(m)),
      `expected same-model retry notify, got: ${notifies.map((m) => m.slice(0, 80)).join(" | ")}`,
    );
    // The ledger is observable evidence for /glla progress and audit.
    const ledger = fs.readFileSync(path.join(cwd, ".pi-glla", "active.jsonl"), "utf8");
    assert.match(ledger, /main_model_probe.*same-model-retry/, "the probe event carries the same-model-retry mode");
  } finally {
    replaceState({ goal: null } as any);
    if (original === undefined) {
      try { fs.unlinkSync(settingsFile); } catch { /* absent */ }
    } else {
      fs.writeFileSync(settingsFile, original);
    }
    try { fs.rmSync(cwd, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

test("integration: budget exhausted walks the configured chain (existing contract preserved)", async () => {
  const cwd = fs.mkdtempSync(path.join("/tmp", "glla-same-model-exhaust-"));
  const settingsFile = globalSettingsPath();
  const original = fs.existsSync(settingsFile) ? fs.readFileSync(settingsFile, "utf8") : undefined;
  const calls: string[] = [];
  const ctx: any = {
    cwd,
    model: { provider: "provider", id: "primary" },
    modelRegistry: {
      find: (provider: string, id: string) => ({ provider, id, reasoning: true }),
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
    extensionApi: { setModel: async (model: any) => { calls.push(`${model.provider}/${model.id}`); return true; }, getThinkingLevel: () => "high", setThinkingLevel: () => {} },
    extensionApiStale: false,
    continuationDispatchStoodDown: false,
    lastMainModelRecoveryResumeAt: 0,
  };
  try {
    fs.writeFileSync(settingsFile, JSON.stringify({
      mainModelFallbacks: ["provider/primary", "provider/first"],
      mainModelSameModelRetries: 10,
    }));
    replaceState({ goal: null } as any);
    createGoalRecovery(flags, {
      activeGoalSurfaceCommand: (c: string) => `/${c}`,
      clearDetachedAuditRuntime: () => {},
      updateGoal: () => {},
      clearContinuationTimer: () => {},
      freshCtxForGeneration: (g: number) => g === flags.sessionGeneration ? ctx : null,
      isSupervising: () => true,
      notifyExternal: () => {},
      persistState: () => {},
      recoverySurfaceCommand: (_k: "goal" | "loop", c: string) => `/${c}`,
      scheduleContinuation: () => {},
      scheduleSessionTimeout: () => setTimeout(() => {}, 60_000),
    });
    state.mainModelRecovery = {
      primary: "provider/primary",
      active: "provider/primary",
      attempted: ["provider/primary"],
      attempts: 5,
      sameModelRetries: 10, // budget spent
      retryAt: new Date(Date.now() - 1).toISOString(),
      reason: "main model recovery — provider error",
      kind: "goal",
    };
    await probeMainModelRecovery(ctx);
    assert.deepEqual(calls, ["provider/first"], "after the budget is spent, the probe walks the configured chain");
    assert.equal(state.mainModelRecovery?.active, "provider/first");
    assert.equal(state.mainModelRecovery?.sameModelRetries, 0, "a successful rotation restarts the budget for the backup");
  } finally {
    replaceState({ goal: null } as any);
    if (original === undefined) {
      try { fs.unlinkSync(settingsFile); } catch { /* absent */ }
    } else {
      fs.writeFileSync(settingsFile, original);
    }
    try { fs.rmSync(cwd, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

test("integration: legacy 0 budget preserves the immediate-rotation contract", async () => {
  // 0 = the operator has explicitly chosen "rotate on the first blip". The
  // pin protects that path: a fresh recovery with budget 0 must walk the
  // chain as the legacy behavior did.
  const cwd = fs.mkdtempSync(path.join("/tmp", "glla-same-model-zero-"));
  const settingsFile = globalSettingsPath();
  const original = fs.existsSync(settingsFile) ? fs.readFileSync(settingsFile, "utf8") : undefined;
  const calls: string[] = [];
  const ctx: any = {
    cwd,
    model: { provider: "provider", id: "primary" },
    modelRegistry: {
      find: (provider: string, id: string) => ({ provider, id, reasoning: true }),
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
    extensionApi: { setModel: async (model: any) => { calls.push(`${model.provider}/${model.id}`); return true; }, getThinkingLevel: () => "high", setThinkingLevel: () => {} },
    extensionApiStale: false,
    continuationDispatchStoodDown: false,
    lastMainModelRecoveryResumeAt: 0,
  };
  try {
    fs.writeFileSync(settingsFile, JSON.stringify({
      mainModelFallbacks: ["provider/primary", "provider/first"],
      mainModelSameModelRetries: 0,
    }));
    replaceState({ goal: null } as any);
    createGoalRecovery(flags, {
      activeGoalSurfaceCommand: (c: string) => `/${c}`,
      clearDetachedAuditRuntime: () => {},
      updateGoal: () => {},
      clearContinuationTimer: () => {},
      freshCtxForGeneration: (g: number) => g === flags.sessionGeneration ? ctx : null,
      isSupervising: () => true,
      notifyExternal: () => {},
      persistState: () => {},
      recoverySurfaceCommand: (_k: "goal" | "loop", c: string) => `/${c}`,
      scheduleContinuation: () => {},
      scheduleSessionTimeout: () => setTimeout(() => {}, 60_000),
    });
    // tryMainModelFallback is the agent_end path; with budget=0 the gate
    // must NOT suppress the rotation. (probe path is exercised in the
    // exhausted-budget test above.)
    const ok = await tryMainModelFallback(ctx, classifyMainModelFailure("HTTP 429 too many requests"));
    assert.equal(ok, true, "0 budget = the legacy immediate rotation path runs");
    assert.equal(calls.at(-1), "provider/first");
    assert.equal(state.mainModelRecovery?.sameModelRetries, 0, "rotation restarts the budget for the backup");
  } finally {
    replaceState({ goal: null } as any);
    if (original === undefined) {
      try { fs.unlinkSync(settingsFile); } catch { /* absent */ }
    } else {
      fs.writeFileSync(settingsFile, original);
    }
    try { fs.rmSync(cwd, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

test("integration: parkMainModelAfterFailure increments the counter; rotation resets it", () => {
  const cwd = fs.mkdtempSync(path.join("/tmp", "glla-same-model-park-"));
  const settingsFile = globalSettingsPath();
  const original = fs.existsSync(settingsFile) ? fs.readFileSync(settingsFile, "utf8") : undefined;
  const ctx: any = {
    cwd,
    model: { provider: "provider", id: "primary" },
    modelRegistry: { find: (p: string, i: string) => ({ provider: p, id: i, reasoning: true }), hasConfiguredAuth: () => true },
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
    extensionApi: { setModel: async () => true, getThinkingLevel: () => "high", setThinkingLevel: () => {} },
    extensionApiStale: false,
    continuationDispatchStoodDown: false,
    lastMainModelRecoveryResumeAt: 0,
  };
  try {
    fs.writeFileSync(settingsFile, JSON.stringify({ mainModelFallbacks: ["provider/primary", "provider/first"], mainModelSameModelRetries: 10 }));
    replaceState({ goal: null } as any);
    createGoalRecovery(flags, {
      activeGoalSurfaceCommand: (c: string) => `/${c}`,
      clearDetachedAuditRuntime: () => {},
      updateGoal: () => {},
      clearContinuationTimer: () => {},
      freshCtxForGeneration: (g: number) => g === flags.sessionGeneration ? ctx : null,
      isSupervising: () => true,
      notifyExternal: () => {},
      persistState: () => {},
      recoverySurfaceCommand: (_k: "goal" | "loop", c: string) => `/${c}`,
      scheduleContinuation: () => {},
      scheduleSessionTimeout: () => setTimeout(() => {}, 60_000),
    });
    // isSupervising is true → parkMainModelAfterFailure can arm a park.
    // We need a goal active for park to be allowed; seed a minimal one.
    replaceState({ goal: { id: "g", objective: "x", status: "active", policy: "goal", autoContinue: true, usage: { tokensUsed: 0, tokensLimit: 0 }, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" } } as any);
    const transient = classifyMainModelFailure("503 service unavailable");
    parkMainModelAfterFailure(ctx, transient);
    assert.equal(state.mainModelRecovery?.sameModelRetries, 1);
    // parkMainModelAfterFailure is a no-op while a recovery is ACTIVE
    // (retryAt set); in the real flow the timer fires, the probe re-arms
    // the surface, and the next failure re-enters via the orchestrator
    // (which calls parkMainModelAfterFailure again). Simulate the probe
    // clearing the wait so a second park re-enters the episode with the
    // existing counter intact.
    state.mainModelRecovery = { ...state.mainModelRecovery!, retryAt: undefined };
    parkMainModelAfterFailure(ctx, transient);
    assert.equal(state.mainModelRecovery?.sameModelRetries, 2, "consecutive same-model failures extend the counter");
    // Switch the model and re-park: the counter must reset for the new model.
    ctx.model = { provider: "provider", id: "first" };
    state.mainModelRecovery = { ...state.mainModelRecovery!, active: "provider/first", attempted: ["provider/first"], retryAt: undefined };
    parkMainModelAfterFailure(ctx, transient);
    assert.equal(state.mainModelRecovery?.sameModelRetries, 1, "a different active model starts a fresh budget at 1");
  } finally {
    replaceState({ goal: null } as any);
    if (original === undefined) {
      try { fs.unlinkSync(settingsFile); } catch { /* absent */ }
    } else {
      fs.writeFileSync(settingsFile, original);
    }
    try { fs.rmSync(cwd, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

test("sanitize: sameModelRetries round-trips with the documented bounds", () => {
  // Direct sanitizer checks.
  assert.equal(sanitizeMainModelRecovery({
    primary: "provider/primary",
    active: "provider/primary",
    attempted: ["provider/primary"],
    attempts: 0,
    reason: "x",
    kind: "goal",
    sameModelRetries: 5,
  })?.sameModelRetries, 5);
  assert.equal(sanitizeMainModelRecovery({
    primary: "provider/primary",
    active: "provider/primary",
    attempted: ["provider/primary"],
    attempts: 0,
    reason: "x",
    kind: "goal",
    sameModelRetries: 0,
  })?.sameModelRetries, undefined, "0 normalizes to absent (the field is a positive counter)");
  assert.equal(sanitizeMainModelRecovery({
    primary: "provider/primary",
    active: "provider/primary",
    attempted: ["provider/primary"],
    attempts: 0,
    reason: "x",
    kind: "goal",
    sameModelRetries: MAX_MAIN_MODEL_SAME_MODEL_RETRIES + 1,
  })?.sameModelRetries, MAX_MAIN_MODEL_SAME_MODEL_RETRIES, "above the cap clamps to the cap");
  assert.equal(sanitizeMainModelRecovery({
    primary: "provider/primary",
    active: "provider/primary",
    attempted: ["provider/primary"],
    attempts: 0,
    reason: "x",
    kind: "goal",
    sameModelRetries: 1.5,
  })?.sameModelRetries, undefined, "non-integer values are dropped");
  assert.equal(sanitizeMainModelRecovery({
    primary: "provider/primary",
    active: "provider/primary",
    attempted: ["provider/primary"],
    attempts: 0,
    reason: "x",
    kind: "goal",
    sameModelRetries: -3,
  })?.sameModelRetries, undefined, "negative values are dropped");
});

test("format: status surfaces the live counter so the operator can see how close rotation is", () => {
  const lines = formatMainModelRecoveryStatus({
    primary: "provider/primary",
    active: "provider/primary",
    attempted: ["provider/primary"],
    attempts: 3,
    sameModelRetries: 4,
    reason: "x",
    kind: "goal",
  });
  assert.ok(lines.some((l) => /Same-model retries: 4 \(budget before rotation\)/.test(l)), "status must show the live counter");
  // No counter line when the field is absent (legacy episodes or budget 0).
  const legacy = formatMainModelRecoveryStatus({
    primary: "provider/primary",
    active: "provider/primary",
    attempted: ["provider/primary"],
    attempts: 3,
    reason: "x",
    kind: "goal",
  });
  assert.ok(!legacy.some((l) => /Same-model retries/.test(l)), "no counter line when the field is absent");
});
