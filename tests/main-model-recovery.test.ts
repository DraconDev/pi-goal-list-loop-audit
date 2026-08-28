// Main-session model failover/recovery is pure policy; runtime switching is
// exercised by the orchestrator, while these tests pin the safe decisions.
import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  classifyInBandProviderFailure,
  classifyMainModelFailure,
  isMainModelFallbackFailure,
  isMainModelFailbackAuto,
  isPromptPolicyRejection,
  requiresMainModelRecovery,
  mainModelAutoRetryUntil,
  mainModelFailureDelayMs,
  mainModelPrimaryProbeDelayMs,
  mainModelRetryDelayMs,
  modelRef,
  nextUntriedModelRef,
  MAX_MAIN_MODEL_FALLBACKS,
  normalizeMainModelFallbackRefs,
  normalizeModelRefs,
  formatMainModelFallbacks,
  splitModelRef,
} from "../extensions/main-model-recovery.js";
import {
  clearMainModelRecoveryTimer,
  createGoalRecovery,
  mainModelRecoverySucceeded,
  probeMainModelRecovery,
  tryMainModelFallback,
} from "../extensions/goal-recovery.js";
import { replaceState, state } from "../extensions/goal-state.js";
import { globalSettingsPath } from "../extensions/goal-settings.js";

test("main model refs preserve order, dedupe, and support nested model ids", () => {
  assert.deepEqual(normalizeModelRefs("openai/a, openrouter/provider/model;openai/a"), [
    "openai/a",
    "openrouter/provider/model",
  ]);
  assert.deepEqual(normalizeModelRefs(["x/a", " x/a ", "unset", 42]), ["x/a"]);
  assert.deepEqual(splitModelRef("openrouter/provider/model"), { provider: "openrouter", id: "provider/model" });
  assert.equal(splitModelRef("bare-model"), undefined);
});

test("main model fallback candidates are ordered and never retried in a cycle", () => {
  const refs = ["a/one", "b/two", "c/three"];
  assert.equal(nextUntriedModelRef("a/one", refs, ["a/one"]), "b/two");
  assert.equal(nextUntriedModelRef("b/two", refs, ["a/one", "b/two"]), "c/three");
  assert.equal(nextUntriedModelRef("c/three", refs, refs), undefined);
});

test("main fallback settings dedupe case-insensitively and cap the chain at ten", () => {
  const input = [
    "provider/one", "PROVIDER/ONE", "provider/two", "provider/three", "provider/four",
    "provider/five", "provider/six", "provider/seven", "provider/eight", "provider/nine",
    "provider/ten", "provider/eleven", "provider/twelve",
  ];
  const refs = normalizeMainModelFallbackRefs(input);
  assert.equal(MAX_MAIN_MODEL_FALLBACKS, 10);
  assert.equal(refs.length, 10);
  assert.deepEqual(refs[0], "provider/one");
  assert.deepEqual(refs.at(-1), "provider/ten");
  assert.equal(refs.some((ref) => /eleven|twelve/i.test(ref)), false, "the 11th and later rungs are not persisted");
});

test("runtime fallback walk uses one supervised model at a time and preserves left-to-right order", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "glla-main-fallback-runtime-"));
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
  try {
    fs.writeFileSync(settingsFile, JSON.stringify({
      mainModelFallbacks: ["provider/blocked", "provider/first", "provider/second"],
      forbiddenModels: ["blocked"],
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
    const accountFailure = classifyMainModelFailure("usage limit reached; switch billing");
    assert.equal(await tryMainModelFallback(ctx, accountFailure), true);
    assert.deepEqual(calls, ["provider/first"], "the first failure selects only the first eligible backup");
    assert.deepEqual(state.mainModelRecovery?.attempted, ["provider/primary", "provider/blocked", "provider/first"]);
    assert.deepEqual(state.mainModelRecovery?.skipped, [{ ref: "provider/blocked", reason: "forbidden" }]);
    assert.equal(state.mainModelRecovery?.skipped?.some((entry) => entry.ref === "provider/first"), false, "the selected backup is not labelled skipped");

    ctx.model = { provider: "provider", id: "first" };
    assert.equal(await tryMainModelFallback(ctx, accountFailure), true);
    assert.deepEqual(calls, ["provider/first", "provider/second"], "the next failure advances to the next backup");
    assert.deepEqual(state.mainModelRecovery?.attempted, ["provider/primary", "provider/blocked", "provider/first", "provider/second"]);
    assert.equal(state.mainModelRecovery?.skipped?.some((entry) => entry.ref === "provider/first" || entry.ref === "provider/second"), false, "successful backups remain absent from skipped");

    // The delayed/scheduled probe has its own selector path. A successful
    // probe target must be attempted, not persisted as an unregistered skip.
    ctx.model = { provider: "provider", id: "primary" };
    state.mainModelRecovery = {
      primary: "provider/primary",
      active: "provider/primary",
      attempted: ["provider/primary"],
      attempts: 1,
      reason: "main model recovery — provider error",
      kind: "goal",
    };
    await probeMainModelRecovery(ctx);
    assert.equal(calls.at(-1), "provider/first", "the scheduled probe selects the first eligible backup");
    assert.deepEqual(state.mainModelRecovery?.skipped, [{ ref: "provider/blocked", reason: "forbidden" }]);
    assert.equal(state.mainModelRecovery?.skipped?.some((entry) => entry.ref === "provider/first"), false, "the scheduled probe target is not labelled skipped");

    // Error wording does not suppress fallback: a 429-shaped failure uses
    // the same generic chain as every other recoverable provider failure.
    ctx.model = { provider: "provider", id: "first" };
    assert.equal(await tryMainModelFallback(ctx, classifyMainModelFailure("HTTP 429 too many requests")), true);
    assert.equal(calls.at(-1), "provider/second");

    fs.writeFileSync(settingsFile, JSON.stringify({
      mainModelFallbacks: ["provider/first"],
      mainModelFallbackOnRateLimit: false,
    }));
    ctx.model = { provider: "provider", id: "primary" };
    state.mainModelRecovery = {
      primary: "provider/primary",
      active: "provider/primary",
      attempted: ["provider/primary"],
      attempts: 0,
      reason: "provider error",
      kind: "goal",
      quotaSignal: "rate-limit",
    };
    const beforeLegacySetting = calls.length;
    assert.equal(await tryMainModelFallback(ctx, classifyMainModelFailure("HTTP 429 too many requests")), true);
    assert.equal(calls.length, beforeLegacySetting + 1, "the removed legacy opt-out cannot suppress generic fallback");

    state.mainModelRecovery = {
      primary: "provider/primary",
      active: "provider/primary",
      attempted: ["provider/primary"],
      attempts: 0,
      reason: "provider error",
      kind: "goal",
      quotaSignal: "rate-limit",
      pendingModelSwitch: "provider/removed",
    };
    await probeMainModelRecovery(ctx);
    assert.ok(calls.length > beforeLegacySetting, "the removed pending target is replaced by the configured generic fallback");
    assert.equal(calls.includes("provider/removed"), false, "a removed pending backup is not resurrected by a delayed probe");
    assert.equal(state.mainModelRecovery?.pendingModelSwitch, undefined);
  } finally {
    replaceState({ goal: null } as any);
    if (original === undefined) {
      try { fs.unlinkSync(settingsFile); } catch { /* absent */ }
    } else {
      fs.writeFileSync(settingsFile, original);
    }
  }
});

test("successful fallback turns keep the preferred primary and fail back after a supervised probe", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "glla-main-failback-runtime-"));
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
  try {
    fs.writeFileSync(settingsFile, JSON.stringify({
      mainModelFallbacks: ["provider/backup"],
      mainModelFailback: "auto",
      mainModelPrimaryProbeMinutes: 1,
      forbiddenModels: [],
      hourlyRetryProbe: false,
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
      scheduleSessionTimeout: (callback: () => void, delayMs: number) => setTimeout(callback, delayMs),
    });

    const failure = classifyMainModelFailure("503 temporarily unavailable");
    assert.equal(await tryMainModelFallback(ctx, failure), true);
    ctx.model = { provider: "provider", id: "backup" };
    mainModelRecoverySucceeded(ctx);
    assert.equal(calls[0], "provider/backup");
    assert.equal(state.mainModelRecovery?.primary, "provider/primary");
    assert.equal(state.mainModelRecovery?.active, "provider/backup");
    assert.ok(state.mainModelRecovery?.primaryProbeAt, "a successful fallback keeps a durable primary probe");
    assert.equal(state.mainModelRecovery?.primaryProbeInFlight, undefined);

    await probeMainModelRecovery(ctx);
    assert.equal(calls.at(-1), "provider/primary", "the failback probe selects the original primary");
    assert.equal(state.mainModelRecovery?.primaryProbeInFlight, true, "setModel alone does not settle provider health");
    ctx.model = { provider: "provider", id: "primary" };
    assert.equal(await tryMainModelFallback(ctx, failure), true, "a failed primary probe returns to the serving fallback");
    ctx.model = { provider: "provider", id: "backup" };
    mainModelRecoverySucceeded(ctx);
    assert.equal(state.mainModelRecovery?.primary, "provider/primary");
    assert.equal(state.mainModelRecovery?.active, "provider/backup");
    assert.ok(state.mainModelRecovery?.primaryProbeAt, "a failed primary probe schedules the next reverse probe");

    await probeMainModelRecovery(ctx);
    ctx.model = { provider: "provider", id: "primary" };
    mainModelRecoverySucceeded(ctx);
    assert.equal(state.mainModelRecovery, undefined, "a successful supervised primary turn settles failback");
    assert.deepEqual(calls, ["provider/backup", "provider/primary", "provider/backup", "provider/primary"]);
  } finally {
    clearMainModelRecoveryTimer();
    replaceState({ goal: null } as any);
    if (original === undefined) {
      try { fs.unlinkSync(settingsFile); } catch { /* absent */ }
    } else {
      fs.writeFileSync(settingsFile, original);
    }
  }
});

test("sticky failback preserves the old fallback-settles behavior", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "glla-main-sticky-failback-"));
  const settingsFile = globalSettingsPath();
  const original = fs.existsSync(settingsFile) ? fs.readFileSync(settingsFile, "utf8") : undefined;
  const ctx: any = {
    cwd,
    model: { provider: "provider", id: "backup" },
    ui: { notify: () => {} },
  };
  try {
    fs.writeFileSync(settingsFile, JSON.stringify({ mainModelFailback: "sticky", forbiddenModels: [] }));
    replaceState({
      goal: null,
      mainModelRecovery: {
        primary: "provider/primary",
        active: "provider/backup",
        attempted: ["provider/primary", "provider/backup"],
        attempts: 1,
        reason: "provider error",
        kind: "goal",
      },
    } as any);
    mainModelRecoverySucceeded(ctx);
    assert.equal(state.mainModelRecovery, undefined);
  } finally {
    clearMainModelRecoveryTimer();
    replaceState({ goal: null } as any);
    if (original === undefined) {
      try { fs.unlinkSync(settingsFile); } catch { /* absent */ }
    } else {
      fs.writeFileSync(settingsFile, original);
    }
  }
});

test("in-band provider output is recognized only for strong repeated-pane markers", () => {
  assert.equal(classifyInBandProviderFailure("ordinary command output with no provider signal"), undefined);
  assert.equal(classifyInBandProviderFailure("HTTP 503 upstream unavailable")?.kind, "transient");
  assert.ok(classifyInBandProviderFailure("HTTP 429 Too Many Requests"), "429 remains recoverable even when the generic classifier stays opaque");
  assert.equal(classifyInBandProviderFailure("network_error: fetch failed")?.kind, "transient");
});

test("prompt-policy rejections are a narrow terminal main-model class", () => {
  for (const raw of [
    "Codex error event: invalid prompt",
    "Invalid prompt: your prompt was flagged as potentially violating our usage policy. Please try again with a different prompt",
    "content_filter",
    "prompt_filter: blocked",
    "safety_filter triggered",
    "content_policy_violation",
    "usage policy violation",
    "safety policy violation",
    "prompt blocked",
    "The prompt was rejected due to content safety",
    "request refused by the usage policy",
    "HTTP 403 content_filter",
    "500 prompt blocked",
  ]) {
    assert.equal(isPromptPolicyRejection(raw), true, raw);
    const failure = classifyMainModelFailure(raw);
    assert.equal(failure.kind, "non-recoverable", raw);
    assert.equal(failure.nonRecoverableReason, "prompt-policy", raw);
    assert.equal(requiresMainModelRecovery(failure), false, raw);
    assert.equal(isMainModelFallbackFailure(failure), false, raw);
  }
});

test("bare policy tokens, stray invalid-prompt, and transient failures stay recoverable", () => {
  for (const raw of [
    "prompt-policy",
    "project-policy: use bun test",
    "project-policy violation",
    "invalid prompt",
    "invalid_prompt",
    "the policy is documented in AGENTS.md",
    "HTTP 403 forbidden",
    "HTTP 500 upstream",
    "503 temporarily unavailable",
    "first-token timeout",
    "HTTP 429 Too Many Requests",
    "rate limit reached",
    "mysterious provider prose with no hint",
  ]) {
    assert.equal(isPromptPolicyRejection(raw), false, raw);
    const failure = classifyMainModelFailure(raw);
    assert.notEqual(failure.nonRecoverableReason, "prompt-policy", raw);
    assert.equal(requiresMainModelRecovery(failure), true, raw);
    assert.equal(isMainModelFallbackFailure(failure), true, raw);
  }
  assert.equal(classifyMainModelFailure("user aborted").nonRecoverableReason, undefined);
  assert.equal(classifyMainModelFailure("max_tokens exceeds context window").nonRecoverableReason, undefined);
});

test("main model errors stay opaque to the recovery policy", () => {
  for (const raw of [
    "429 usage limit; retry in 2 hours",
    "Token Plan usage limit reached",
    "Token Plan rate limit reached (2062)",
    "HTTP 429 Too Many Requests",
    "too-many-requests",
    "request rate exceeded",
    "insufficient credits — buy credits",
  ]) {
    assert.equal(classifyMainModelFailure(raw).kind, "unknown", raw);
    assert.equal(classifyMainModelFailure(raw).quotaSignal, undefined, raw);
    assert.equal(isMainModelFallbackFailure(classifyMainModelFailure(raw)), true, raw);
  }
  assert.equal(classifyMainModelFailure("503 temporarily unavailable").kind, "transient");
  assert.equal(isMainModelFallbackFailure(classifyMainModelFailure("503 temporarily unavailable")), true);
  assert.equal(classifyMainModelFailure("401 invalid API key").kind, "auth");
  assert.equal(isMainModelFallbackFailure(classifyMainModelFailure("401 invalid API key")), true);
  assert.equal(classifyMainModelFailure("503 upstream overloaded").kind, "transient");
  assert.equal(classifyMainModelFailure("max_tokens exceeds context window").kind, "non-recoverable");
  assert.equal(classifyMainModelFailure("user aborted").kind, "non-recoverable");
});

test("main model recovery backs off without giving up", () => {
  assert.equal(mainModelRetryDelayMs(1, 15), 15 * 60_000);
  assert.equal(mainModelRetryDelayMs(2, 15), 30 * 60_000);
  assert.equal(isMainModelFailbackAuto(undefined), true);
  assert.equal(isMainModelFailbackAuto("sticky"), false);
  assert.equal(mainModelPrimaryProbeDelayMs(15), 15 * 60_000);
  assert.equal(mainModelRetryDelayMs(3, 15), 60 * 60_000);
  assert.equal(mainModelRetryDelayMs(4, 15), 2 * 60 * 60_000);
  assert.equal(mainModelRetryDelayMs(5, 15), 4 * 60 * 60_000);
  assert.equal(mainModelRetryDelayMs(6, 15), 5 * 60 * 60_000);
  assert.equal(mainModelRetryDelayMs(20, 15), 5 * 60 * 60_000);
  const nowMs = Date.parse("2026-08-07T01:18:01.930Z");
  // Every recoverable provider failure gets the same eager retry, then joins
  // the configured ladder.
  assert.equal(mainModelFailureDelayMs(classifyMainModelFailure("429 Too Many Requests"), 1, 15, nowMs), 5_000);
  assert.equal(mainModelFailureDelayMs(classifyMainModelFailure("429 Too Many Requests"), 2, 15, nowMs), 30 * 60_000);
  for (const raw of [
    "503 temporarily unavailable",
    "insufficient credits — buy credits",
    "401 invalid API key",
    "mysterious provider prose with no hint",
  ]) {
    assert.equal(mainModelFailureDelayMs(classifyMainModelFailure(raw), 1, 15, nowMs), 5_000, raw);
    assert.equal(mainModelFailureDelayMs(classifyMainModelFailure(raw), 2, 15, nowMs), 30 * 60_000, raw);
  }
  // The setting controls the later ladder; the first retry stays eager.
  assert.equal(mainModelFailureDelayMs(classifyMainModelFailure("503 temporarily unavailable"), 1, 45, nowMs), 5_000);
  assert.equal(mainModelFailureDelayMs(classifyMainModelFailure("503 temporarily unavailable"), 2, 45, nowMs), 90 * 60_000);
  assert.equal(mainModelFailureDelayMs(classifyMainModelFailure("Token Plan rate limit reached (2062); retry after 3 hours"), 1, 15, nowMs), 5_000);
  assert.equal(mainModelAutoRetryUntil(Date.parse("2026-08-03T00:00:00Z")), "2026-08-04T00:00:00.000Z");
  assert.equal(modelRef({ provider: "openai", id: "gpt" }), "openai/gpt");
  assert.equal(modelRef({ provider: "openai" }), undefined);
  assert.equal(formatMainModelFallbacks(["a/one", "b/two"]), "1. a/one → 2. b/two");
  assert.equal(formatMainModelFallbacks([]), "none");
});

test("main recovery requirements are generic across provider wording", () => {
  for (const raw of ["HTTP 429 too many requests", "account usage limit reached", "503 unavailable"]) {
    assert.equal(isMainModelFallbackFailure(classifyMainModelFailure(raw)), true, raw);
  }
});
