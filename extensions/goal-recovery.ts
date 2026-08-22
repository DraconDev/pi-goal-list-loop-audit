/**
 * goal-recovery.ts — Recovery machinery: compat sidecar + main-model
 * recovery + completion-audit recovery.
 *
 * Decomposition step 3 (v0.34.111): extracted from extensions/loops/goal.ts.
 * - ZERO behavior change: moved bodies are byte-identical except module-level
 *   flag references rewritten to `flags.<name>` accessors.
 * - One-way imports: this module never imports from goal.ts or goal-commands.ts.
 * - Module-level mutable state stays OWNED by goal.ts (mainModelRecoveryTimer,
 *   mainModelSwitchInFlight, mainModelAbortForRecovery, lastMainModelFailure,
 *   completionAuditRecoveryArmed, hourlyProbeTimer, hourlyProbeFireAt,
 *   sessionGeneration, extensionApi, extensionApiStale,
 *   continuationDispatchStoodDown); this module
 *   observes them through the RecoveryFlags accessor object (the same
 *   mirror-lets pattern as goal-loop.ts's flags).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { state } from "./goal-state.js";
import { appendLedger, claimRecoveryNotice, nowIso, piGlaDir, isForbiddenModel, isStaleApiError, nextHourlyProbeMs, providerErrorFingerprint, providerErrorPresentation, sanitizeProviderDisplayText, supervisorPaused, writeGoalMd, type Goal, type MainModelRecovery, type PendingCompletion } from "./goal-loop-core.js";
import { persistStateLine } from "./goal-state.js";
import { cancelDetachedGoalCompletionAuditor } from "./goal-loop-auditor-process.js";
import {
  classifyMainModelFailure,
  isContextOverflowError,
  isMainModelFailbackAuto,
  isMainModelFallbackFailure,
  mainModelAutoRetryUntil,
  mainModelFailureDelayMs,
  mainModelPrimaryProbeDelayMs,
  mainModelRetryDelayMs,
  MAIN_MODEL_AUTO_RETRY_HORIZON_MS,
  modelRef,
  normalizeMainModelFallbackRefs,
  requiresMainModelRecovery,
  splitModelRef,
  type MainModelFailure,
} from "./main-model-recovery.js";
import { ModelSelector, type ModelScope } from "./model-selector.js";
import { loadGlobalSettings, loadSettings } from "./goal-settings.js";
import { clearLoopTimer, scheduleLoopTick } from "./goal-loop.js";

/* ------------------------------------------------------------------ */
/* Cluster A — compat sidecar marker (single-use, freshness-bounded)   */
/* ------------------------------------------------------------------ */

const RECOVERY_RESUME_MARKER = "recovery-resume.json";
const RECOVERY_RESUME_FRESH_MS = 300_000;

/** v0.34.13: consume the sidecar marker on session restore. Single-use,
 * freshness-bounded — a stale marker from an abandoned recovery must not
 * surprise-resume a later session. */
export function consumeRecoveryResume(cwd: string): boolean {
  try {
    const p = path.join(piGlaDir(cwd), RECOVERY_RESUME_MARKER);
    if (!fs.existsSync(p)) return false;
    const raw = fs.readFileSync(p, "utf-8");
    fs.unlinkSync(p);
    const at = Date.parse((JSON.parse(raw) as { at?: string }).at ?? "");
    return !Number.isNaN(at) && Date.now() - at < RECOVERY_RESUME_FRESH_MS;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* Cluster C — completion-audit recovery (durable claim rehydration)  */
/* ------------------------------------------------------------------ */

export function markCompletionAuditRecoveryPending(ctx: ExtensionContext, reason: string): boolean {
  const goal = state.goal;
  const claim = goal?.pendingCompletion;
  if (!goal || goal.status !== "auditing" || !claim) {
    // A legacy/corrupt in-memory audit can still hold the process latch even
    // when its durable claim is absent. Fail closed for the MAIN as well.
    if (goal?.status === "auditing") clearDetachedAuditRuntime();
    return false;
  }
  const failureCopy = providerErrorPresentation(reason, "completion");
  const recoveryEpisodeKey = claim.recoveryEpisodeKey ?? `${claim.at}:${failureCopy.fingerprint}`;
  const pending: PendingCompletion = {
    ...claim,
    phase: "recovery-pending",
    recoveryAt: nowIso(),
    recoveryReason: reason,
    providerErrorDiagnostic: failureCopy.sensitive ? failureCopy.diagnostic : claim.providerErrorDiagnostic,
    recoveryEpisodeKey,
    recoveryNoticeKeys: claim.recoveryNoticeKeys ?? [],
    automaticRecoveryAttempted: claim.automaticRecoveryAttempted ?? false,
  };
  // Kill any child still owned by this process before releasing the durable
  // claim. Its late result is rejected by the attempt/generation checks, and
  // it must not keep the user-facing state looking like an active audit.
  if (claim.attemptId) cancelDetachedGoalCompletionAuditor(ctx.cwd, claim.attemptId);
  clearDetachedAuditRuntime();
  updateGoal({
    status: "paused",
    pendingCompletion: pending,
    providerErrorDiagnostic: pending.providerErrorDiagnostic,
    recoveryEpisodeKey,
    recoveryNoticeKeys: pending.recoveryNoticeKeys,
    pauseKind: "blocked",
    pauseResumeAt: undefined,
    pauseReason: `completion audit blocked — no verdict${failureCopy.sensitive ? `: ${failureCopy.display}` : `: ${reason}`}`,
    pauseSuggestedAction: `The completion claim is stored and was not judged. Fix the auditor/session issue, then ${activeGoalSurfaceCommand("resume")} to start exactly one fresh audit.`,
    pauseOptions: undefined,
    pauseRecommended: undefined,
  }, ctx);
  appendLedger(ctx.cwd, "audit_recovery_pending", {
    goalId: goal.id,
    attemptId: claim.attemptId,
    reason: failureCopy.sensitive ? failureCopy.display : reason,
    diagnostic: pending.providerErrorDiagnostic,
    recoveryEpisodeKey,
    mainReleased: true,
    verdict: "none",
  });
  return true;
}

/** Park an interrupted completion claim using only its durable workspace path.
 * This is the stale-terminal escape hatch: the retained ExtensionContext is
 * explicitly probe-only, so the heartbeat must not pass it to updateGoal. */
export function parkCompletionAuditRecovery(cwd: string, reason: string): boolean {
  const goal = state.goal;
  const claim = goal?.pendingCompletion;
  if (!goal || goal.status !== "auditing" || !claim) {
    if (goal?.status === "auditing") clearDetachedAuditRuntime();
    return false;
  }
  const failureCopy = providerErrorPresentation(reason, "completion");
  const recoveryEpisodeKey = claim.recoveryEpisodeKey ?? `${claim.at}:${failureCopy.fingerprint}`;
  const pending: PendingCompletion = {
    ...claim,
    phase: "recovery-pending",
    recoveryAt: nowIso(),
    recoveryReason: reason,
    providerErrorDiagnostic: failureCopy.sensitive ? failureCopy.diagnostic : claim.providerErrorDiagnostic,
    recoveryEpisodeKey,
    recoveryNoticeKeys: claim.recoveryNoticeKeys ?? [],
    automaticRecoveryAttempted: claim.automaticRecoveryAttempted ?? false,
  };
  if (claim.attemptId) cancelDetachedGoalCompletionAuditor(cwd, claim.attemptId);
  clearDetachedAuditRuntime();
  const next: Goal = {
    ...goal,
    status: "paused",
    pendingCompletion: pending,
    providerErrorDiagnostic: pending.providerErrorDiagnostic,
    recoveryEpisodeKey,
    recoveryNoticeKeys: pending.recoveryNoticeKeys,
    pauseKind: "blocked",
    pauseResumeAt: undefined,
    pauseReason: `completion audit blocked — no verdict${failureCopy.sensitive ? `: ${failureCopy.display}` : `: ${reason}`}`,
    pauseSuggestedAction: `The completion claim is stored and was not judged. Fix the auditor/session issue, then ${activeGoalSurfaceCommand("resume")} to start exactly one fresh audit.`,
    pauseOptions: undefined,
    pauseRecommended: undefined,
    updatedAt: nowIso(),
  };
  const file = writeGoalMd(cwd, next);
  state.goal = { ...next, activePath: path.relative(cwd, file) || file };
  persistStateLine(cwd, state);
  appendLedger(cwd, "audit_recovery_pending", {
    goalId: goal.id,
    attemptId: claim.attemptId,
    reason: failureCopy.sensitive ? failureCopy.display : reason,
    diagnostic: pending.providerErrorDiagnostic,
    recoveryEpisodeKey,
    mainReleased: true,
    verdict: "none",
    via: "context-free-stale-latch",
  });
  return true;
}

export function isCompletionAuditRecoveryPending(goal: Goal | null | undefined): boolean {
  return !!goal?.pendingCompletion && goal.pendingCompletion.phase !== "running";
}

/* ------------------------------------------------------------------ */
/* Cluster B — main-model recovery + hourly retry                      */
/* ------------------------------------------------------------------ */

/* The module flags stay owned by goal.ts (they're read by goal.ts
 * watchdogs, cmdResume, the loop, etc.) and are observed here through the
 * RecoveryFlags accessor object. */
export interface RecoveryFlags {
  get completionAuditRecoveryArmed(): boolean;
  set completionAuditRecoveryArmed(v: boolean);
  get mainModelRecoveryTimer(): NodeJS.Timeout | null;
  set mainModelRecoveryTimer(v: NodeJS.Timeout | null);
  get mainModelSwitchInFlight(): boolean;
  set mainModelSwitchInFlight(v: boolean);
  get mainModelAbortForRecovery(): boolean;
  set mainModelAbortForRecovery(v: boolean);
  get lastMainModelFailure(): MainModelFailure | null;
  set lastMainModelFailure(v: MainModelFailure | null);
  get hourlyProbeTimer(): NodeJS.Timeout | null;
  set hourlyProbeTimer(v: NodeJS.Timeout | null);
  get hourlyProbeFireAt(): number | null;
  set hourlyProbeFireAt(v: number | null);
  get sessionGeneration(): number;
  set sessionGeneration(v: number);
  get extensionApi(): ExtensionAPI | null;
  set extensionApi(v: ExtensionAPI | null);
  get extensionApiStale(): boolean;
  set extensionApiStale(v: boolean);
  get continuationDispatchStoodDown(): boolean;
  set continuationDispatchStoodDown(v: boolean);
  get lastMainModelRecoveryResumeAt(): number;
  set lastMainModelRecoveryResumeAt(v: number);
}

export interface RecoveryDeps {
  // cluster C
  activeGoalSurfaceCommand: (command: string) => string;
  clearDetachedAuditRuntime: () => void;
  updateGoal: (patch: Partial<Goal>, ctx: ExtensionContext) => void;
  // cluster B — goal.ts-owned functions (continuation/loop machinery still
  // lives in goal.ts until decomposition step 5 moves it)
  clearContinuationTimer: () => void;
  freshCtxForGeneration: (generation: number) => ExtensionContext | null;
  isSupervising: () => boolean;
  notifyExternal: (ctx: ExtensionContext, message: string) => void;
  persistState: (ctx: ExtensionContext) => void;
  recoverySurfaceCommand: (kind: "goal" | "loop", command: string) => string;
  scheduleContinuation: (ctx: ExtensionContext, force?: boolean, delayMs?: number) => void;
  scheduleSessionTimeout: (callback: () => void, delayMs: number) => NodeJS.Timeout;
}

let flags: RecoveryFlags;
let activeGoalSurfaceCommand: RecoveryDeps["activeGoalSurfaceCommand"];
let clearDetachedAuditRuntime: RecoveryDeps["clearDetachedAuditRuntime"];
let updateGoal: RecoveryDeps["updateGoal"];
// cluster B — goal.ts-owned function deps
let clearContinuationTimer: RecoveryDeps["clearContinuationTimer"];
let freshCtxForGeneration: RecoveryDeps["freshCtxForGeneration"];
let isSupervising: RecoveryDeps["isSupervising"];
let notifyExternal: RecoveryDeps["notifyExternal"];
let persistState: RecoveryDeps["persistState"];
let recoverySurfaceCommand: RecoveryDeps["recoverySurfaceCommand"];
let scheduleContinuation: RecoveryDeps["scheduleContinuation"];
let scheduleSessionTimeout: RecoveryDeps["scheduleSessionTimeout"];

export function createGoalRecovery(flagsArg: RecoveryFlags, d: RecoveryDeps): void {
  flags = flagsArg;
  activeGoalSurfaceCommand = d.activeGoalSurfaceCommand;
  clearDetachedAuditRuntime = d.clearDetachedAuditRuntime;
  updateGoal = d.updateGoal;
  clearContinuationTimer = d.clearContinuationTimer;
  freshCtxForGeneration = d.freshCtxForGeneration;
  isSupervising = d.isSupervising;
  notifyExternal = d.notifyExternal;
  persistState = d.persistState;
  recoverySurfaceCommand = d.recoverySurfaceCommand;
  scheduleContinuation = d.scheduleContinuation;
  scheduleSessionTimeout = d.scheduleSessionTimeout;
}

/* ------------------------------------------------------------------ */
/* Cluster B — moved functions (byte-identical bodies, module flags   */
/* via RecoveryFlags accessor)                                         */
/* ------------------------------------------------------------------ */

export function mainModelRecoveryActive(): boolean {
  return !!state.mainModelRecovery?.retryAt || !!state.mainModelRecovery?.pendingModelSwitch;
}

/** v0.34.116: surface a one-liner when glla observes a session_compact
 * failure. The signal is a length-context exception caught during the
 * next send after a compaction attempt. When the message is genuinely the
 * context-overflow kind (the prompt still does not fit, the model just
 * cannot serve it), we wrap it with `isContextOverflow: true` so the
 * classifier routes the next fallback-step through the selector instead of
 * refusing rotation. The call site lives in goal-loop.ts; this function
 * is the single chokepoint. */
export function observeCompactFailure(ctx: ExtensionContext, error: string | undefined): boolean {
  const text = typeof error === "string" ? error.trim() : "";
  if (!text) return false;
  if (!isContextOverflowError(text)) return false;
  appendLedger(ctx.cwd, "compact_failure_observed", { at: nowIso(), error: text.slice(0, 240) });
  ctx.ui.notify("glla: session_compact did not release the overflow — walking the fallback chain to a larger-context model.", "warning");
  return true;
}

/** v0.34.119: when pi's compact subsystem throws "This extension ctx is
 * stale after session replacement or reload", the cached ctx in pi's
 * compact path is dead. /reload shares the same ctx and does not help;
 * only /new clears the cache. The user observed this exact symptom
 * (capture-anime-girls 2026-08-09 09:53, ai-auto-writer 2026-08-09 fields).
 *
 * Important SDK boundary: event handlers receive ExtensionContext, while
 * `newSession()` is public only on ExtensionCommandContext (user command
 * handlers). ExtensionAPI does NOT expose newSession. The old v0.34.117
 * implementation incorrectly cast ExtensionAPI and therefore never fired
 * against the real SDK. We now check the context capability honestly:
 * newer hosts that expose a command-capable context can self-heal; the
 * current public event API returns false and the caller uses the terminal
 * park with an explicit `/new` instruction instead of claiming recovery.
 *
 * The signature is `where: string` so every attempt/skip is observable. */
export function attemptFreshSessionRecovery(ctx: ExtensionContext, where: string): boolean {
  type FreshSessionContext = ExtensionContext & {
    newSession?: () => unknown | Promise<unknown>;
  };
  const freshCtx = ctx as FreshSessionContext;
  if (typeof freshCtx.newSession !== "function") {
    appendLedger(ctx.cwd, "fresh_session_recovery_skipped", {
      from: where,
      reason: "event context has no newSession; pi exposes it only on ExtensionCommandContext",
    });
    return false;
  }
  try {
    const result = freshCtx.newSession();
    if (result && typeof (result as Promise<unknown>).then === "function") {
      // The new session_start rehydrates the goal from disk. Do not await
      // here: this send already failed on the stale context, and waiting on
      // the replacement would touch the invalidated context again.
      (result as Promise<unknown>).catch((err) => {
        appendLedger(ctx.cwd, "fresh_session_recovery_failed", { from: where, error: err instanceof Error ? err.message : String(err) });
      });
    }
    appendLedger(ctx.cwd, "fresh_session_recovery_triggered", { from: where });
    ctx.ui.notify("glla: stale ctx detected — host supplied a fresh-session capability; rehydrating the goal now.", "info");
    return true;
  } catch (err) {
    appendLedger(ctx.cwd, "fresh_session_recovery_failed", { from: where, error: err instanceof Error ? err.message : String(err) });
    return false;
  }
}

/** v0.34.116: classify a compact-failure string and route through
 * tryMainModelFallback. Returns true when a backup was selected. The
 * caller should still cancel the in-flight send / re-arm the continuation
 * so the next attempt lands on the rotated model. */
export async function recoverFromContextOverflow(ctx: ExtensionContext, error: string | undefined): Promise<boolean> {
  const failure = classifyMainModelFailure(error, { isContextOverflow: true });
  if (failure.kind !== "context-overflow") return false;
  observeCompactFailure(ctx, error);
  return tryMainModelFallback(ctx, failure);
}

export function mainModelRecoveryKind(): "goal" | "loop" { return state.loop?.active ? "loop" : "goal"; }

export function mainModelRecoveryReason(failure: MainModelFailure): string {
  const presentation = providerErrorPresentation(failure.raw, "main");
  return `main model ${failure.kind} — ${presentation.display}`;
}

export function withMainModelRecoveryWindow(recovery: MainModelRecovery, now = Date.now()): MainModelRecovery {
  const firstMs = recovery.firstFailureAt ? Date.parse(recovery.firstFailureAt) : Number.NaN;
  const firstFailureAt = Number.isFinite(firstMs) ? recovery.firstFailureAt : new Date(now).toISOString();
  const untilMs = recovery.autoRetryUntil ? Date.parse(recovery.autoRetryUntil) : Number.NaN;
  const autoRetryUntil = Number.isFinite(untilMs) && untilMs > (Number.isFinite(firstMs) ? firstMs : now)
    ? recovery.autoRetryUntil
    : mainModelAutoRetryUntil(Number.isFinite(firstMs) ? firstMs : now, MAIN_MODEL_AUTO_RETRY_HORIZON_MS);
  return { ...recovery, firstFailureAt, autoRetryUntil };
}

export function clearMainModelRecoveryTimer(): void {
  if (flags.mainModelRecoveryTimer) {
    clearTimeout(flags.mainModelRecoveryTimer);
    flags.mainModelRecoveryTimer = null;
  }
  // v0.34.92: clear the hourly probe ticker in lockstep — session
  // replacement / recovery reset must not leave an orphaned ticker firing
  // against a dead generation. The new session's session_start will
  // re-arm via scheduleHourlyProbe() if recovery is still parked.
  cancelHourlyProbe();
}

export function mainModelFallbackRefs(ctx: ExtensionContext): string[] {
  try { return normalizeMainModelFallbackRefs(loadGlobalSettings().mainModelFallbacks); } catch { return []; }
}

function mainModelFailbackEnabled(): boolean {
  try { return isMainModelFailbackAuto(loadGlobalSettings().mainModelFailback); } catch { return true; }
}

function mainModelPrimaryProbeDelay(): number {
  try { return mainModelPrimaryProbeDelayMs(loadGlobalSettings().mainModelPrimaryProbeMinutes); } catch { return mainModelPrimaryProbeDelayMs(); }
}

function sameModelRef(left: string | undefined, right: string | undefined): boolean {
  return !!left && !!right && left.toLowerCase() === right.toLowerCase();
}

function scheduleSupervisedPrimaryProbe(ctx: ExtensionContext, recovery: MainModelRecovery): void {
  flags.continuationDispatchStoodDown = false;
  if (recovery.kind === "goal" && state.goal?.status === "active") {
    scheduleContinuation(ctx, true, 1_000);
  } else if (recovery.kind === "loop" && state.loop?.active) {
    scheduleLoopTick(ctx);
  }
}

export function holdMainModelRecovery(ctx: ExtensionContext, recovery: MainModelRecovery, why: string): void {
  const normalizedBase = withMainModelRecoveryWindow(recovery);
  const diagnostic = normalizedBase.providerErrorDiagnostic ?? normalizedBase.reason;
  const presentation = providerErrorPresentation(diagnostic, "main");
  const normalized: MainModelRecovery = {
    ...normalizedBase,
    reason: sanitizeProviderDisplayText(normalizedBase.reason),
    providerErrorDiagnostic: diagnostic,
    recoveryEpisodeKey: normalizedBase.recoveryEpisodeKey ?? `${normalizedBase.firstFailureAt ?? nowIso()}:${presentation.fingerprint}`,
    recoveryNoticeKeys: normalizedBase.recoveryNoticeKeys ?? [],
  };
  clearMainModelRecoveryTimer();
  clearContinuationTimer();
  clearLoopTimer();
  flags.continuationDispatchStoodDown = true;
  state.mainModelRecovery = {
    ...normalized,
    retryAt: undefined,
    primaryProbeAt: undefined,
    primaryProbeInFlight: undefined,
    manualResumeRequired: true,
  };
  const resumeCmd = recoverySurfaceCommand(normalized.kind, "resume");
  const pauseReason = `main model recovery — automatic probes stopped (${sanitizeProviderDisplayText(why)})`;
  const action = `No automatic provider probes remain. Switch /model if desired, then ${resumeCmd} to start a fresh recovery window; ${activeGoalSurfaceCommand("cancel")} stops it.`;
  if (normalized.kind === "goal" && state.goal) {
    updateGoal({
      status: "paused",
      pauseKind: "blocked",
      pauseResumeAt: undefined,
      pauseReason,
      pauseSuggestedAction: action,
      providerErrorDiagnostic: normalized.providerErrorDiagnostic,
      recoveryEpisodeKey: normalized.recoveryEpisodeKey,
      recoveryNoticeKeys: normalized.recoveryNoticeKeys,
    }, ctx);
  } else if (normalized.kind === "loop" && state.loop) {
    state.loop = { ...state.loop, active: false, stopReason: `${pauseReason}; ${resumeCmd} to retry manually` };
    persistState(ctx);
  } else {
    persistState(ctx);
  }
  appendLedger(ctx.cwd, "main_model_recovery_manual_hold", {
    kind: normalized.kind,
    attempts: normalized.attempts,
    autoRetryUntil: normalized.autoRetryUntil,
    why: sanitizeProviderDisplayText(why),
    diagnostic: normalized.providerErrorDiagnostic,
    recoveryEpisodeKey: normalized.recoveryEpisodeKey,
  });
  const noticeKey = `${normalized.recoveryEpisodeKey ?? "main-recovery"}:manual-hold`;
  if (claimRecoveryNotice(state.mainModelRecovery, noticeKey)) {
    persistState(ctx);
    ctx.ui.notify(`Main-model recovery stopped automatic probes: ${sanitizeProviderDisplayText(why)}. Work is saved; check the provider or switch /model, then ${resumeCmd}.`, "warning");
  }
  notifyExternal(ctx, `Main-model recovery requires manual resume: ${sanitizeProviderDisplayText(why)}.`);
}

/** Resolve a configured provider/model using only the public registry API. */
export function resolveMainModel(ctx: ExtensionContext, ref: string): any | undefined {
  const parts = splitModelRef(ref);
  if (!parts) return undefined;
  try {
    const model = ctx.modelRegistry?.find?.(parts.provider, parts.id) as any;
    if (!model) return undefined;
    const hasConfiguredAuth = (ctx.modelRegistry as any)?.hasConfiguredAuth;
    // A registry entry without credentials is not a usable fallback. Keep
    // the optional check for older/headless test registries that do not expose
    // hasConfiguredAuth; setModel remains the final host-level gate.
    if (typeof hasConfiguredAuth === "function" && !hasConfiguredAuth.call(ctx.modelRegistry, model)) return undefined;
    return model;
  } catch {
    return undefined;
  }
}

/** Build a session-scoped ModelSelector that wires the chain provider,
 * forbidden gate, resolver, and the unified model_fallback_select ledger
 * event. Reused by tryMainModelFallback and (eventually) per-agent
 * subagent fallback paths. */
function sessionModelSelector(ctx: ExtensionContext, sessionChain?: string[]): ModelSelector {
  const settings = loadSettings(ctx.cwd);
  return new ModelSelector({
    getChain: (scope) => {
      if (scope.kind === "session") return sessionChain ?? mainModelFallbackRefs(ctx);
      if (scope.kind === "subagent") return settings.subagentFallbacks?.[scope.agentName] ?? [];
      return [];
    },
    resolve: (ref) => resolveMainModel(ctx, ref),
    isForbidden: (ref) => isForbiddenModel(ref, settings.forbiddenModels),
    record: (event) => {
      appendLedger(ctx.cwd, "model_fallback_select", {
        scope: event.scope.kind === "session" ? "session" : event.scope.kind === "subagent" ? `subagent:${event.scope.agentName}` : "drafter",
        fromRef: event.fromRef,
        toRef: event.toRef,
        reason: event.reason,
      });
    },
  });
}

/** Select one configured fallback model before pi's own agent-level retry continues. */
let modelSwitchOperationToken = 0;
let activeModelSwitchToken = 0;
let modelSwitchOperationGeneration: number | null = null;

export async function tryMainModelFallback(ctx: ExtensionContext, failure: MainModelFailure): Promise<boolean> {
  const generation = flags.sessionGeneration;
  // Every recoverable failure may walk the configured fallback chain. Error
  // wording never opts a failure in or out of fallback behavior; only an
  // explicit user abort/non-recoverable result is refused here.
  if (failure.kind === "non-recoverable" || !isMainModelFallbackFailure(failure)) return false;
  // A replacement session may arrive while the old setModel promise is still
  // pending. Its fence must not block the fresh generation from recovering;
  // the old finally below is token-guarded and cannot clear the new fence.
  if (flags.mainModelSwitchInFlight && modelSwitchOperationGeneration !== generation) {
    flags.mainModelSwitchInFlight = false;
    activeModelSwitchToken = 0;
    modelSwitchOperationGeneration = null;
  }
  if (flags.mainModelSwitchInFlight) return false;
  const operationToken = ++modelSwitchOperationToken;
  activeModelSwitchToken = operationToken;
  modelSwitchOperationGeneration = generation;
  const refs = mainModelFallbackRefs(ctx);
  if (refs.length === 0) {
    activeModelSwitchToken = 0;
    modelSwitchOperationGeneration = null;
    return false;
  }
  const current = modelRef(ctx.model);
  if (!current) {
    activeModelSwitchToken = 0;
    modelSwitchOperationGeneration = null;
    return false;
  }
  const existing = state.mainModelRecovery;
  const baseRecovery = withMainModelRecoveryWindow(existing ?? {
    primary: current,
    active: current,
    attempted: [current],
    attempts: 0,
    reason: mainModelRecoveryReason(failure),
    kind: mainModelRecoveryKind(),
  });
  const failureCopy = providerErrorPresentation(failure.raw, "main");
  const recovery: MainModelRecovery = {
    ...baseRecovery,
    // A provider failure while serving a fallback returns to the normal
    // ordered recovery walk; the next successful fallback turn will arm a
    // fresh preferred-primary probe.
    primaryProbeAt: undefined,
    primaryProbeInFlight: undefined,
    reason: mainModelRecoveryReason(failure),
    providerErrorDiagnostic: failureCopy.diagnostic,
    recoveryEpisodeKey: baseRecovery.recoveryEpisodeKey ?? `${baseRecovery.firstFailureAt ?? nowIso()}:${failureCopy.fingerprint}`,
    recoveryNoticeKeys: baseRecovery.recoveryNoticeKeys ?? [],
  };
  if (!recovery.attempted.includes(current)) recovery.attempted.push(current);
  const selector = sessionModelSelector(ctx);
  const scope: ModelScope = { kind: "session" };
  for (;;) {
    const pick = selector.selectNextValid(scope, current, recovery.attempted);
    const visited = selector.lastVisitedRefs;
    const selectedKey = "model" in pick ? pick.ref.toLowerCase() : undefined;
    const attemptedKeys = new Set(recovery.attempted.map((ref) => ref.toLowerCase()));
    const skipped = [...(recovery.skipped ?? [])].filter((entry) => !selectedKey || entry.ref.toLowerCase() !== selectedKey);
    for (const ref of visited) {
      const key = ref.toLowerCase();
      if (selectedKey === key) {
        // lastVisitedRefs includes the successful selector hit as well as
        // rejected refs. It belongs in attempted, but it is not skipped.
        if (!attemptedKeys.has(key)) {
          recovery.attempted.push(ref);
          attemptedKeys.add(key);
        }
        continue;
      }
      if (!attemptedKeys.has(key)) {
        recovery.attempted.push(ref);
        attemptedKeys.add(key);
      }
      const reason = isForbiddenModel(ref, loadSettings(ctx.cwd).forbiddenModels) ? "forbidden" : "unregistered";
      if (!skipped.some((entry) => entry.ref.toLowerCase() === key)) skipped.push({ ref, reason });
    }
    recovery.skipped = skipped.slice(-16);
    if (!("model" in pick)) {
      // exhausted (or all refs forbidden / unregistered) — fail closed.
      state.mainModelRecovery = {
        ...recovery,
        active: current,
        reason: mainModelRecoveryReason(failure),
        providerErrorDiagnostic: failureCopy.diagnostic,
        primaryProbeAt: undefined,
        primaryProbeInFlight: undefined,
        skipped: recovery.skipped,
      };
      persistState(ctx);
      return false;
    }
    const candidateRef = pick.ref;
    const candidate = pick.model;
    const backupIndex = refs.findIndex((ref) => ref.toLowerCase() === candidateRef.toLowerCase()) + 1;
    const attempted = [...recovery.attempted];
    recovery.attempted = attempted;
    // Record the in-flight candidate before crossing the async host boundary.
    // A process/session replacement during setModel must not forget which
    // rung was already attempted and immediately retry it after reload. Keep
    // a short parked deadline so a crash cannot strand the episode with
    // retryAt undefined and no lifecycle callback to resume it.
    state.mainModelRecovery = {
      ...recovery,
      attempted,
      pendingModelSwitch: candidateRef,
      retryAt: new Date(Date.now() + 1_000).toISOString(),
    };
    persistState(ctx);
    flags.mainModelSwitchInFlight = true;
    try {
      // Re-check immediately before crossing the host boundary. A session
      // replacement can arrive after the durable pending marker was written;
      // never invoke setModel on that stale generation.
      if (generation !== flags.sessionGeneration || !freshCtxForGeneration(generation)) return false;
      const api = flags.extensionApi;
      const accepted = await api?.setModel(candidate);
      if (generation !== flags.sessionGeneration || !freshCtxForGeneration(generation)) return false;
      if (state.mainModelRecovery?.pendingModelSwitch?.toLowerCase() !== candidateRef.toLowerCase()) return false;
      if (!accepted) {
        state.mainModelRecovery = { ...state.mainModelRecovery, pendingModelSwitch: undefined, retryAt: undefined };
        persistState(ctx);
        appendLedger(ctx.cwd, "main_model_fallback_unavailable", { ref: candidateRef, backupIndex, backupCount: refs.length, reason: "no configured auth" });
        continue;
      }
      const nextRecovery = {
        ...state.mainModelRecovery!,
        active: candidateRef,
        pendingModelSwitch: undefined,
        retryAt: undefined,
        reason: mainModelRecoveryReason(failure),
        providerErrorDiagnostic: failureCopy.diagnostic,
        kind: mainModelRecoveryKind(),
      };
      state.mainModelRecovery = nextRecovery;
      persistState(ctx);
      appendLedger(ctx.cwd, "main_model_failover", { from: current, to: candidateRef, backupIndex, backupCount: refs.length, reason: failure.kind });
      ctx.ui.notify(`Main session model failover: ${current} → backup ${backupIndex}/${refs.length} ${candidateRef}. The next supervised turn tests it; a healthy fallback schedules a preferred-primary failback probe.`, "warning");
      return true;
    } catch (err) {
      // A user cancellation or host replacement may have cleared/replaced the
      // durable pending marker while setModel was awaiting. Never advance the
      // old operation's cursor or recreate recovery after that boundary.
      if (generation !== flags.sessionGeneration || state.mainModelRecovery?.pendingModelSwitch?.toLowerCase() !== candidateRef.toLowerCase()) return false;
      appendLedger(ctx.cwd, "main_model_fallback_unavailable", { ref: candidateRef, backupIndex, backupCount: refs.length, reason: err instanceof Error ? err.message : String(err) });
      if (isStaleApiError(err)) {
        flags.extensionApiStale = true;
        return false;
      }
    } finally {
      if (activeModelSwitchToken === operationToken) {
        activeModelSwitchToken = 0;
        modelSwitchOperationGeneration = null;
        flags.mainModelSwitchInFlight = false;
      }
    }
  }
}

export function setMainModelRecoveryPause(ctx: ExtensionContext, recovery: MainModelRecovery, delayMs: number): boolean {
  const normalizedBase = withMainModelRecoveryWindow(recovery);
  const diagnostic = normalizedBase.providerErrorDiagnostic ?? normalizedBase.reason;
  const presentation = providerErrorPresentation(diagnostic, "main");
  const normalized: MainModelRecovery = {
    ...normalizedBase,
    reason: sanitizeProviderDisplayText(normalizedBase.reason),
    providerErrorDiagnostic: diagnostic,
    recoveryEpisodeKey: normalizedBase.recoveryEpisodeKey ?? `${normalizedBase.firstFailureAt ?? nowIso()}:${presentation.fingerprint}`,
    recoveryNoticeKeys: normalizedBase.recoveryNoticeKeys ?? [],
  };
  const now = Date.now();
  const deadlineMs = normalized.autoRetryUntil ? Date.parse(normalized.autoRetryUntil) : Number.NaN;
  const requestedDelayMs = Math.max(1_000, delayMs);
  if (normalized.manualResumeRequired || (Number.isFinite(deadlineMs) && (now >= deadlineMs || now + requestedDelayMs > deadlineMs))) {
    holdMainModelRecovery(ctx, normalized, Number.isFinite(deadlineMs) && now >= deadlineMs
      ? "the 24h automatic recovery horizon was reached"
      : "the automatic recovery horizon would be exceeded");
    return false;
  }
  const retryAt = new Date(now + requestedDelayMs).toISOString();
  const minutes = Math.max(1, Math.round(requestedDelayMs / 60_000));
  state.mainModelRecovery = {
    ...normalized,
    retryAt,
    primaryProbeAt: undefined,
    primaryProbeInFlight: undefined,
    manualResumeRequired: undefined,
    reason: sanitizeProviderDisplayText(normalized.reason),
  };
  clearMainModelRecoveryTimer();
  clearContinuationTimer();
  clearLoopTimer();
  flags.continuationDispatchStoodDown = true;
  const resumeCmd = recoverySurfaceCommand(normalized.kind, "resume");
  const recoveryAction = `The provider failure is being retried automatically with bounded backoff and an extra :00:30 probe after each hour starts; configured fallback models are tried in order. ${resumeCmd} retries immediately; ${activeGoalSurfaceCommand("cancel")} stops it.`;
  if (normalized.kind === "goal" && state.goal) {
    updateGoal({
      status: "paused",
      pauseKind: "wait",
      pauseResumeAt: retryAt,
      pauseReason: `main model recovery — retrying in ${minutes}m (${sanitizeProviderDisplayText(normalized.reason)})`,
      pauseSuggestedAction: recoveryAction,
      providerErrorDiagnostic: normalized.providerErrorDiagnostic,
      recoveryEpisodeKey: normalized.recoveryEpisodeKey,
      recoveryNoticeKeys: normalized.recoveryNoticeKeys,
    }, ctx);
  } else if (normalized.kind === "loop" && state.loop) {
    state.loop = { ...state.loop, active: false, stopReason: `main model recovery — retrying in ${minutes}m (${sanitizeProviderDisplayText(normalized.reason)}); /loop resume retries immediately` };
    persistState(ctx);
  } else {
    persistState(ctx);
  }
  appendLedger(ctx.cwd, "main_model_recovery_wait", {
    kind: normalized.kind,
    retryAt,
    attempts: normalized.attempts,
    autoRetryUntil: normalized.autoRetryUntil,
    reason: normalized.reason,
    diagnostic: normalized.providerErrorDiagnostic,
    recoveryEpisodeKey: normalized.recoveryEpisodeKey,
  });
  const noticeKey = `${normalized.recoveryEpisodeKey ?? "main-recovery"}:wait`;
  if (claimRecoveryNotice(state.mainModelRecovery, noticeKey)) {
    persistState(ctx);
    ctx.ui.notify(`Main model recovery: ${sanitizeProviderDisplayText(normalized.reason)}. Trying again in ${minutes}m; work is saved and will not be abandoned.`, "warning");
  }
  const externalNoticeKey = `${normalized.recoveryEpisodeKey ?? "main-recovery"}:external-wait`;
  if (claimRecoveryNotice(state.mainModelRecovery, externalNoticeKey)) {
    persistState(ctx);
    notifyExternal(ctx, `Main model recovery scheduled in ${minutes}m — work remains saved.`);
  }
  return true;
}

export function scheduleMainModelRecoveryTimer(ctx: ExtensionContext, delayMs: number): void {
  const generation = flags.sessionGeneration;
  clearMainModelRecoveryTimer();
  flags.mainModelRecoveryTimer = scheduleSessionTimeout(() => {
    flags.mainModelRecoveryTimer = null;
    // v0.35.15: `/glla pause` freezes automatic recovery probes — the
    // parked recovery claim stays durable and a manual /glla resume probes
    // immediately (manuallyResumeMainModelRecovery path).
    if (supervisorPaused(state)) return;
    const fresh = freshCtxForGeneration(generation);
    if (!fresh || !state.mainModelRecovery) return;
    void probeMainModelRecovery(fresh).catch((err) => { if (isStaleApiError(err)) flags.extensionApiStale = true; });
  }, Math.max(1_000, delayMs));
  // Arm the optional hourly slot beside every normal recovery timer, not
  // only the initial park path. This covers fallback failures and later
  // failed probes while preserving one timer per slot.
  scheduleHourlyProbe(ctx);
}

/** Keep the preferred-primary probe separate from the parked-recovery wait.
 * `retryAt` means the goal/loop is paused; `primaryProbeAt` means the
 * fallback is serving successfully and work may continue normally. */
export function scheduleMainModelPrimaryProbe(ctx: ExtensionContext, delayMs?: number): void {
  const recovery = state.mainModelRecovery;
  if (!recovery || recovery.manualResumeRequired === true || !mainModelFailbackEnabled()) return;
  if (recovery.primaryProbeInFlight) return;
  const configuredAt = recovery.primaryProbeAt ? Date.parse(recovery.primaryProbeAt) : Number.NaN;
  const requestedDelay = delayMs === undefined
    ? Number.isFinite(configuredAt) ? Math.max(0, configuredAt - Date.now()) : mainModelPrimaryProbeDelay()
    : Math.max(0, delayMs);
  const probeAt = Number.isFinite(configuredAt) && delayMs === undefined
    ? recovery.primaryProbeAt
    : new Date(Date.now() + requestedDelay).toISOString();
  const changed = recovery.primaryProbeAt !== probeAt
    || recovery.retryAt !== undefined
    || recovery.pendingModelSwitch !== undefined;
  if (changed) {
    state.mainModelRecovery = {
      ...recovery,
      primaryProbeAt: probeAt,
      primaryProbeInFlight: undefined,
      retryAt: undefined,
      pendingModelSwitch: undefined,
      resumeCurrent: undefined,
    };
    persistState(ctx);
    appendLedger(ctx.cwd, "main_model_failback_scheduled", {
      primary: recovery.primary,
      active: recovery.active,
      probeAt,
      delayMs: requestedDelay,
    });
  }
  scheduleMainModelRecoveryTimer(ctx, requestedDelay);
}

// =================================================================
// v0.34.142: hourly retry ticker — optional (default ON) extra retry at :00:30
// every hour while main-model recovery is parked. This is a blind retry slot:
// the plugin does not query or infer provider availability state. It is co-resident
// with the configured retry ladder and only adds this extra opportunity.
// =================================================================


/** Schedule the next :00:30 probe. Re-arms itself after each fire as long
 * as recovery is parked and the setting is on. Safe to call when already
 * scheduled (no duplicate schedules). */
export function scheduleHourlyProbe(ctx: ExtensionContext): void {
  if (loadGlobalSettings().hourlyRetryProbe !== true) return;
  // The ticker is only for a parked recovery. After setModel succeeds,
  // retryAt is cleared while the next supervised turn is being tested; do
  // not let :00:30 switch models underneath that turn.
  if (!state.mainModelRecovery || state.mainModelRecovery.manualResumeRequired === true) return; // nothing to recover — silent no-op
  if (state.mainModelRecovery.retryAt === undefined) return; // active supervised turn, not parked
  if (flags.hourlyProbeTimer) return; // already pending
  const now = Date.now();
  const fireAt = nextHourlyProbeMs(now);
  const generation = flags.sessionGeneration;
  flags.hourlyProbeFireAt = fireAt;
  appendLedger(ctx.cwd, "hourly_probe_scheduled", {
    fireAt: new Date(fireAt).toISOString(),
    at: new Date(now).toISOString(),
  });
  flags.hourlyProbeTimer = scheduleSessionTimeout(() => {
    flags.hourlyProbeTimer = null;
    flags.hourlyProbeFireAt = null;
    const fresh = freshCtxForGeneration(generation);
    if (!fresh) return;
    void fireHourlyProbe(fresh);
  }, Math.max(1_000, fireAt - now));
}

/** Fire one :00:30 probe — invoke the same recovery probe path the normal
 * schedule uses. The probe is observed by the recovery envelope: a success
 * clears state.mainModelRecovery (and the ticker stops); a failure may clear
 * the current timer while updating the bounded retry state, so the ticker
 * must re-arm only after the async probe settles. Re-arming in this finally
 * block keeps the continuous hourly schedule alive without racing the
 * recovery path's timer cleanup, and a generation/host check prevents a
 * stale session from creating a new timer. */
export async function fireHourlyProbe(ctx: ExtensionContext): Promise<void> {
  if (!state.mainModelRecovery || state.mainModelRecovery.manualResumeRequired === true) return; // wall already lifted/held — silent no-op
  const generation = flags.sessionGeneration;
  if (hourlyProbeInFlight && hourlyProbeGeneration !== generation) {
    hourlyProbeInFlight = false;
    hourlyProbeToken = 0;
    hourlyProbeGeneration = null;
  }
  if (hourlyProbeInFlight) {
    appendLedger(ctx.cwd, "main_model_probe_skipped_in_flight", { at: nowIso(), source: "hourly" });
    return;
  }
  if (state.mainModelRecovery.retryAt === undefined) {
    appendLedger(ctx.cwd, "main_model_probe_skipped_in_flight", { at: nowIso(), source: "hourly-active-turn" });
    return; // setModel/probe has already claimed the active turn
  }
  hourlyProbeInFlight = true;
  const probeToken = ++hourlyProbeToken;
  hourlyProbeGeneration = generation;
  appendLedger(ctx.cwd, "hourly_probe_fired", {
    at: new Date().toISOString(),
  });
  try {
    await probeMainModelRecovery(ctx);
  } catch (err) {
    if (isStaleApiError(err)) flags.extensionApiStale = true;
  } finally {
    if (hourlyProbeToken === probeToken) {
      hourlyProbeInFlight = false;
      hourlyProbeGeneration = null;
    }
    if (generation !== flags.sessionGeneration) return;
    const fresh = freshCtxForGeneration(generation);
    if (fresh && state.mainModelRecovery && !state.mainModelRecovery.manualResumeRequired) scheduleHourlyProbe(fresh);
  }
}

/** Cancel the hourly ticker — called on session replacement, recovery
 * success, and user resume. Safe to call when no ticker is pending. */
export function cancelHourlyProbe(): void {
  if (flags.hourlyProbeTimer) {
    clearTimeout(flags.hourlyProbeTimer);
    flags.hourlyProbeTimer = null;
  }
  flags.hourlyProbeFireAt = null;
}

// v0.34.108: the hourly-ticker test-only hooks (__testOnlySetHourlyProbeNow /
// __testOnlyResetHourlyProbe / __testOnlyHourlyProbeState) were dead —
// hourly-retry-probe.test.ts is source-pin only and never called them.
// Removed with the v0.34.108 dead-code sweep.

/** An explicit resume is consent to start a fresh automatic window after the
 * five-hour/24-hour safety hold. It does not silently reset the window during
 * reload or heartbeat recovery. */
export function manuallyResumeMainModelRecovery(ctx: ExtensionContext): boolean {
  const recovery = state.mainModelRecovery;
  if (!recovery?.manualResumeRequired) return false;
  const current = modelRef(ctx.model);
  const now = Date.now();
  state.mainModelRecovery = {
    ...recovery,
    active: current ?? recovery.active,
    attempted: current ? [current] : [],
    attempts: 0,
    firstFailureAt: new Date(now).toISOString(),
    autoRetryUntil: mainModelAutoRetryUntil(now, MAIN_MODEL_AUTO_RETRY_HORIZON_MS),
    retryAt: undefined,
    primaryProbeAt: undefined,
    primaryProbeInFlight: undefined,
    manualResumeRequired: undefined,
    resumeCurrent: undefined,
    providerErrorDiagnostic: undefined,
    recoveryEpisodeKey: undefined,
    recoveryNoticeKeys: [],
  };
  clearMainModelRecoveryTimer();
  flags.continuationDispatchStoodDown = false;
  persistState(ctx);
  ctx.ui.notify("Manual resume starts a fresh bounded main-model recovery window — one provider probe, then configured fallback models if needed.", "info");
  void probeMainModelRecovery(ctx);
  return true;
}

let mainModelRecoveryProbeInFlight = false;
let mainModelRecoveryProbeToken = 0;
let mainModelRecoveryProbeGeneration: number | null = null;
let hourlyProbeInFlight = false;
let hourlyProbeToken = 0;
let hourlyProbeGeneration: number | null = null;

/** Normal and :00:30 hourly recovery timers share one provider probe. The
 * durable timer state is not enough to fence the two callbacks once both
 * have fired, so serialize the actual async probe as well. */
export async function probeMainModelRecovery(ctx: ExtensionContext): Promise<void> {
  const generation = flags.sessionGeneration;
  if (mainModelRecoveryProbeInFlight && mainModelRecoveryProbeGeneration !== generation) {
    mainModelRecoveryProbeInFlight = false;
    mainModelRecoveryProbeToken = 0;
    mainModelRecoveryProbeGeneration = null;
  }
  if (mainModelRecoveryProbeInFlight) {
    appendLedger(ctx.cwd, "main_model_probe_skipped_in_flight", { at: nowIso() });
    return;
  }
  mainModelRecoveryProbeInFlight = true;
  const probeToken = ++mainModelRecoveryProbeToken;
  mainModelRecoveryProbeGeneration = generation;
  try {
    await probeMainModelRecoveryImpl(ctx);
  } finally {
    if (mainModelRecoveryProbeToken === probeToken) {
      mainModelRecoveryProbeInFlight = false;
      mainModelRecoveryProbeGeneration = null;
    }
  }
}

async function probePreferredPrimary(ctx: ExtensionContext, recovery: MainModelRecovery): Promise<void> {
  if (!mainModelFailbackEnabled()) {
    clearMainModelRecoveryTimer();
    state.mainModelRecovery = undefined;
    persistState(ctx);
    appendLedger(ctx.cwd, "main_model_failback_cancelled", { reason: "sticky policy" });
    return;
  }
  const generation = flags.sessionGeneration;
  const primary = recovery.primary;
  const current = modelRef(ctx.model);

  // A host/session replacement may have committed the switch before the
  // replacement process rehydrated its durable marker. Treat that as the
  // same in-flight probe and wait for one real supervised turn before
  // declaring the primary healthy.
  if (recovery.primaryProbeInFlight && sameModelRef(current, primary)) {
    const reconciled = {
      ...recovery,
      active: current,
      attempted: [primary],
      primaryProbeAt: undefined,
      primaryProbeInFlight: true,
      pendingModelSwitch: undefined,
      retryAt: undefined,
    };
    state.mainModelRecovery = reconciled;
    persistState(ctx);
    appendLedger(ctx.cwd, "main_model_failback_reconciled", { primary, generation });
    scheduleSupervisedPrimaryProbe(ctx, reconciled);
    return;
  }

  // The timer can fire after the host has already selected the primary (for
  // example, a restore event races the timer). Still require a supervised
  // turn; setModel alone is not a provider health check.
  if (!recovery.primaryProbeInFlight && sameModelRef(current, primary)) {
    const inFlight = {
      ...recovery,
      active: current,
      attempted: [primary],
      primaryProbeAt: undefined,
      primaryProbeInFlight: true,
      pendingModelSwitch: undefined,
      retryAt: undefined,
    };
    state.mainModelRecovery = inFlight;
    persistState(ctx);
    appendLedger(ctx.cwd, "main_model_failback_probe", { from: current, to: primary, mode: "already-selected" });
    scheduleSupervisedPrimaryProbe(ctx, inFlight);
    return;
  }

  if (isForbiddenModel(primary, loadGlobalSettings().forbiddenModels)) {
    clearMainModelRecoveryTimer();
    state.mainModelRecovery = undefined;
    persistState(ctx);
    appendLedger(ctx.cwd, "main_model_failback_cancelled", { primary, reason: "forbidden" });
    ctx.ui.notify(`Main-model failback skipped ${primary} because forbiddenModels excludes it; the current fallback remains selected.`, "warning");
    return;
  }
  const candidate = resolveMainModel(ctx, primary);
  if (!candidate) {
    const delay = mainModelPrimaryProbeDelay();
    state.mainModelRecovery = {
      ...recovery,
      active: current ?? recovery.active,
      primaryProbeAt: new Date(Date.now() + delay).toISOString(),
      primaryProbeInFlight: undefined,
      pendingModelSwitch: undefined,
      retryAt: undefined,
    };
    persistState(ctx);
    appendLedger(ctx.cwd, "main_model_failback_unavailable", { primary, reason: "primary not in registry" });
    scheduleMainModelPrimaryProbe(ctx, delay);
    return;
  }

  if (flags.mainModelSwitchInFlight && modelSwitchOperationGeneration !== generation) {
    flags.mainModelSwitchInFlight = false;
    activeModelSwitchToken = 0;
    modelSwitchOperationGeneration = null;
  }
  if (flags.mainModelSwitchInFlight) return;
  const operationToken = ++modelSwitchOperationToken;
  activeModelSwitchToken = operationToken;
  modelSwitchOperationGeneration = generation;
  const pending = {
    ...recovery,
    active: current ?? recovery.active,
    attempted: current ? [current] : recovery.attempted,
    primaryProbeAt: undefined,
    primaryProbeInFlight: true,
    pendingModelSwitch: primary,
    retryAt: new Date(Date.now() + 1_000).toISOString(),
  };
  state.mainModelRecovery = pending;
  persistState(ctx);
  flags.mainModelSwitchInFlight = true;
  try {
    if (generation !== flags.sessionGeneration || !freshCtxForGeneration(generation)) return;
    const accepted = await flags.extensionApi?.setModel(candidate);
    if (generation !== flags.sessionGeneration || !freshCtxForGeneration(generation)) return;
    if (state.mainModelRecovery?.pendingModelSwitch?.toLowerCase() !== primary.toLowerCase()) return;
    if (!accepted) throw new Error("no configured auth for preferred primary");
    const switched = {
      ...state.mainModelRecovery!,
      active: primary,
      attempted: [primary],
      primaryProbeAt: undefined,
      primaryProbeInFlight: true,
      pendingModelSwitch: undefined,
      retryAt: undefined,
    };
    state.mainModelRecovery = switched;
    persistState(ctx);
    appendLedger(ctx.cwd, "main_model_failback", { from: current, to: primary });
    ctx.ui.notify(`Main session model failed back to ${primary} from ${current ?? "the fallback"}; the next supervised turn tests the primary.`, "info");
    scheduleSupervisedPrimaryProbe(ctx, switched);
  } catch (err) {
    if (generation !== flags.sessionGeneration || state.mainModelRecovery?.pendingModelSwitch?.toLowerCase() !== primary.toLowerCase()) return;
    const delay = mainModelPrimaryProbeDelay();
    const next = {
      ...state.mainModelRecovery!,
      active: current ?? recovery.active,
      primaryProbeAt: new Date(Date.now() + delay).toISOString(),
      primaryProbeInFlight: undefined,
      pendingModelSwitch: undefined,
      retryAt: undefined,
    };
    state.mainModelRecovery = next;
    persistState(ctx);
    appendLedger(ctx.cwd, "main_model_failback_failed", {
      primary,
      error: err instanceof Error ? err.message : String(err),
      nextProbeAt: next.primaryProbeAt,
    });
    scheduleMainModelPrimaryProbe(ctx, delay);
  } finally {
    if (activeModelSwitchToken === operationToken) {
      activeModelSwitchToken = 0;
      modelSwitchOperationGeneration = null;
      flags.mainModelSwitchInFlight = false;
    }
  }
}

async function probeMainModelRecoveryImpl(ctx: ExtensionContext): Promise<void> {
  const generation = flags.sessionGeneration;
  const recovery = state.mainModelRecovery;
  if (!recovery) return;
  const current = modelRef(ctx.model);
  // Reconcile an async model switch that crossed a session boundary. If the
  // restored host already uses the pending target, the switch committed; if
  // it does not, the pending target is re-driven below before normal cursor
  // selection instead of being silently skipped as already attempted.
  if (recovery.pendingModelSwitch && current?.toLowerCase() === recovery.pendingModelSwitch.toLowerCase()) {
    appendLedger(ctx.cwd, "main_model_switch_reconciled", { ref: recovery.pendingModelSwitch, generation });
    state.mainModelRecovery = { ...recovery, active: current, pendingModelSwitch: undefined, retryAt: undefined };
    persistState(ctx);
  }
  const preferredPrimaryRecovery = state.mainModelRecovery;
  if (preferredPrimaryRecovery?.primaryProbeAt || preferredPrimaryRecovery?.primaryProbeInFlight) {
    await probePreferredPrimary(ctx, preferredPrimaryRecovery);
    return;
  }
  if (recovery.resumeCurrent && current) {
    state.mainModelRecovery = {
      ...recovery,
      active: current,
      attempted: [current],
      primaryProbeAt: undefined,
      primaryProbeInFlight: undefined,
      retryAt: undefined,
      resumeCurrent: undefined,
      pendingModelSwitch: undefined,
    };
    flags.continuationDispatchStoodDown = false;
    if (recovery.kind === "goal" && state.goal?.status === "paused" && (state.goal.pauseReason ?? "").startsWith("main model recovery")) {
      updateGoal({ status: "active", pauseKind: undefined, pauseResumeAt: undefined, pauseReason: undefined, pauseSuggestedAction: undefined, providerErrorDiagnostic: undefined, recoveryEpisodeKey: undefined, recoveryNoticeKeys: undefined }, ctx);
      scheduleContinuation(ctx, true, 1_000);
    } else if (recovery.kind === "loop" && state.loop && !state.loop.active && (state.loop.stopReason ?? "").startsWith("main model recovery")) {
      state.loop = { ...state.loop, active: true, stopReason: undefined };
      persistState(ctx);
      scheduleLoopTick(ctx);
    }
    appendLedger(ctx.cwd, "main_model_probe", { from: current, to: current, attempts: recovery.attempts, mode: "resume-backup" });
    ctx.ui.notify(`Main model recovery probe: continuing on ${current}; primary will be tested after this supervised turn.`, "info");
    return;
  }
  // Use the same ordered selector for immediate failover and delayed probes.
  // The primary is included at the front so a later cycle can return to it,
  // while the durable attempted list prevents a probe from jumping backward
  // through the chain after a reload.
  const fallbackRefs = mainModelFallbackRefs(ctx);
  const selectorChain = [recovery.primary, ...fallbackRefs];
  const selector = sessionModelSelector(ctx, selectorChain);
  const scope: ModelScope = { kind: "session" };
  const pendingTarget = state.mainModelRecovery?.pendingModelSwitch;
  const pendingConfigured = pendingTarget !== undefined
    && selectorChain.some((ref) => ref.toLowerCase() === pendingTarget.toLowerCase());
  if (pendingTarget && !pendingConfigured) {
    // Settings can be cleared while setModel is in flight or while a parked
    // recovery is being restored. Never resurrect a removed backup merely
    // because its old intent survived in active.jsonl.
    state.mainModelRecovery = {
      ...recovery,
      pendingModelSwitch: undefined,
      retryAt: undefined,
      attempted: recovery.attempted.filter((ref) => ref.toLowerCase() !== pendingTarget.toLowerCase()),
      skipped: (recovery.skipped ?? []).filter((entry) => entry.ref.toLowerCase() !== pendingTarget.toLowerCase()),
    };
    persistState(ctx);
    appendLedger(ctx.cwd, "main_model_switch_stale_cleared", { ref: pendingTarget, reason: "removed from configured fallback chain" });
  }
  const effectivePendingTarget = pendingConfigured ? pendingTarget : undefined;
  const pendingCandidate = effectivePendingTarget ? resolveMainModel(ctx, effectivePendingTarget) : undefined;
  if (effectivePendingTarget && !pendingCandidate) {
    const attemptedPending = recovery.attempted.some((ref) => ref.toLowerCase() === effectivePendingTarget.toLowerCase())
      ? recovery.attempted
      : [...recovery.attempted, effectivePendingTarget];
    const skippedPending = [...(recovery.skipped ?? [])];
    if (!skippedPending.some((entry) => entry.ref.toLowerCase() === effectivePendingTarget.toLowerCase())) {
      skippedPending.push({ ref: effectivePendingTarget, reason: "unregistered" });
    }
    const next = { ...recovery, pendingModelSwitch: undefined, attempted: attemptedPending, skipped: skippedPending.slice(-16), attempts: recovery.attempts + 1 };
    appendLedger(ctx.cwd, "main_model_fallback_unavailable", { ref: effectivePendingTarget, reason: "pending switch target not in registry" });
    state.mainModelRecovery = next;
    persistState(ctx);
    const delay = mainModelRetryDelayMs(next.attempts, loadGlobalSettings().mainModelRetryMinutes);
    if (setMainModelRecoveryPause(ctx, next, delay)) scheduleMainModelRecoveryTimer(ctx, delay);
    return;
  }
  const pick = effectivePendingTarget && pendingCandidate
    ? { ref: effectivePendingTarget, model: pendingCandidate }
    : selector.selectNextValid(scope, current, recovery.attempted);
  const target = "ref" in pick ? pick.ref : undefined;
  const targetIndex = target === undefined
    ? selectorChain.length - 1
    : selectorChain.findIndex((ref) => ref.toLowerCase() === target.toLowerCase());
  const attempted = [...recovery.attempted];
  const attemptedKeys = new Set(attempted.map((ref) => ref.toLowerCase()));
  if (current && !attemptedKeys.has(current.toLowerCase())) {
    attempted.push(current);
    attemptedKeys.add(current.toLowerCase());
  }
  // Persist every forbidden/unavailable ref visited by the selector so a
  // reload cannot restart at the same rejected rung.
  const visited = selector.lastVisitedRefs;
  const selectedKey = target?.toLowerCase();
  const skipped = [...(recovery.skipped ?? [])].filter((entry) => !selectedKey || entry.ref.toLowerCase() !== selectedKey);
  for (const ref of visited) {
    const key = ref.toLowerCase();
    if (selectedKey === key) {
      // The selector reports its successful hit in lastVisitedRefs too. It is
      // attempted, but it is not a rejected/skipped fallback.
      if (!attemptedKeys.has(key)) {
        attempted.push(ref);
        attemptedKeys.add(key);
      }
      continue;
    }
    if (!attemptedKeys.has(key)) {
      attempted.push(ref);
      attemptedKeys.add(key);
    }
    const reason = isForbiddenModel(ref, loadSettings(ctx.cwd).forbiddenModels) ? "forbidden" : "unregistered";
    if (!skipped.some((entry) => entry.ref.toLowerCase() === key)) skipped.push({ ref, reason });
  }
  recovery.skipped = skipped.slice(-16);
  if (!target) {
    if (!current) {
      const delay = mainModelRetryDelayMs(recovery.attempts + 1, loadGlobalSettings().mainModelRetryMinutes);
      const next = { ...withMainModelRecoveryWindow(recovery), attempts: recovery.attempts + 1, attempted };
      if (setMainModelRecoveryPause(ctx, next, delay)) scheduleMainModelRecoveryTimer(ctx, delay);
      return;
    }
    // The ordered chain has been visited for this recovery cycle. Start a
    // deliberate new cycle by retrying the currently selected model; the
    // next failure can then walk primary → backup 1 → … again. This is not a
    // blind resend loop: it is one bounded probe per durable timer window.
    const next = { ...recovery, active: current, attempted: [current], retryAt: undefined, resumeCurrent: undefined, pendingModelSwitch: undefined };
    state.mainModelRecovery = next;
    persistState(ctx);
    appendLedger(ctx.cwd, "main_model_fallback_cycle_reset", { current, attempted: recovery.attempted, attempts: recovery.attempts });
    flags.continuationDispatchStoodDown = false;
    if (recovery.kind === "goal" && state.goal?.status === "paused" && (state.goal.pauseReason ?? "").startsWith("main model recovery")) {
      updateGoal({ status: "active", pauseKind: undefined, pauseResumeAt: undefined, pauseReason: undefined, pauseSuggestedAction: undefined, providerErrorDiagnostic: undefined, recoveryEpisodeKey: undefined, recoveryNoticeKeys: undefined }, ctx);
      scheduleContinuation(ctx, true, 1_000);
    } else if (recovery.kind === "loop" && state.loop && !state.loop.active && (state.loop.stopReason ?? "").startsWith("main model recovery")) {
      state.loop = { ...state.loop, active: true, stopReason: undefined };
      persistState(ctx);
      scheduleLoopTick(ctx);
    }
    appendLedger(ctx.cwd, "main_model_probe", { from: current, to: current, attempts: recovery.attempts, mode: "cycle-reset" });
    ctx.ui.notify(`Main model recovery probe: retrying ${current} after visiting the configured fallback chain.`, "info");
    return;
  }
  // A candidate can be registered but still unusable (no configured auth or
  // a provider-specific setModel rejection). Keep walking the same ordered
  // chain instead of waiting an hour before trying the next real fallback.
  const candidate = resolveMainModel(ctx, target);
  const targetTryLabel = targetIndex === 0 ? "primary" : `backup ${targetIndex}/${fallbackRefs.length}`;
  if (!candidate) {
    appendLedger(ctx.cwd, "main_model_fallback_unavailable", { ref: target, tryLabel: targetTryLabel, reason: "recovery probe not in registry" });
    const next = { ...recovery, pendingModelSwitch: undefined, skipped: recovery.skipped, attempted, attempts: recovery.attempts + 1 };
    state.mainModelRecovery = next;
    persistState(ctx);
    const delay = mainModelRetryDelayMs(next.attempts, loadGlobalSettings().mainModelRetryMinutes);
    if (setMainModelRecoveryPause(ctx, next, delay)) scheduleMainModelRecoveryTimer(ctx, delay);
    return;
  }
  state.mainModelRecovery = {
    ...recovery,
    active: current ?? recovery.active,
    attempted,
    pendingModelSwitch: target,
    retryAt: new Date(Date.now() + 1_000).toISOString(),
  };
  persistState(ctx);
  if (flags.mainModelSwitchInFlight && modelSwitchOperationGeneration !== generation) {
    flags.mainModelSwitchInFlight = false;
    activeModelSwitchToken = 0;
    modelSwitchOperationGeneration = null;
  }
  if (flags.mainModelSwitchInFlight) return;
  const operationToken = ++modelSwitchOperationToken;
  activeModelSwitchToken = operationToken;
  modelSwitchOperationGeneration = generation;
  flags.mainModelSwitchInFlight = true;
  try {
    if (generation !== flags.sessionGeneration || !freshCtxForGeneration(generation)) return;
    const accepted = await flags.extensionApi?.setModel(candidate);
    if (generation !== flags.sessionGeneration || !freshCtxForGeneration(generation)) return;
    if (state.mainModelRecovery?.pendingModelSwitch?.toLowerCase() !== target.toLowerCase()) return;
    if (!accepted) throw new Error(`no configured auth for ${target}`);
    state.mainModelRecovery = {
      ...state.mainModelRecovery!,
      active: target,
      attempted,
      primaryProbeAt: undefined,
      primaryProbeInFlight: undefined,
      pendingModelSwitch: undefined,
      retryAt: undefined,
    };
    persistState(ctx);
    appendLedger(ctx.cwd, "main_model_probe", { from: current, to: target, tryLabel: targetTryLabel, attempts: recovery.attempts });
    flags.continuationDispatchStoodDown = false;
    if (recovery.kind === "goal" && state.goal?.status === "paused" && (state.goal.pauseReason ?? "").startsWith("main model recovery")) {
      updateGoal({ status: "active", pauseKind: undefined, pauseResumeAt: undefined, pauseReason: undefined, pauseSuggestedAction: undefined, providerErrorDiagnostic: undefined, recoveryEpisodeKey: undefined, recoveryNoticeKeys: undefined }, ctx);
      scheduleContinuation(ctx, true, 1_000);
    } else if (recovery.kind === "loop" && state.loop && !state.loop.active && (state.loop.stopReason ?? "").startsWith("main model recovery")) {
      state.loop = { ...state.loop, active: true, stopReason: undefined };
      persistState(ctx);
      scheduleLoopTick(ctx);
    }
    ctx.ui.notify(`Main model recovery probe: ${targetTryLabel} ${target} selected; sending one supervised probe.`, "info");
  } catch (err) {
    // A cancellation, replacement, or another recovery operation may have
    // consumed this pending switch while the host promise was in flight.
    // Its late rejection must not resurrect a cleared episode.
    if (generation !== flags.sessionGeneration || state.mainModelRecovery?.pendingModelSwitch?.toLowerCase() !== target.toLowerCase()) return;
    appendLedger(ctx.cwd, "main_model_probe_failed", { ref: target, tryLabel: targetTryLabel, error: err instanceof Error ? err.message : String(err) });
    const failure = classifyMainModelFailure(err instanceof Error ? err.message : String(err));
    // A recoverable failure may have walked the ordered chain before reaching
    // this probe. Any remaining provider failure uses the same durable
    // bounded envelope; the current model resumes after a rejected switch.
    const failureCopy = providerErrorPresentation(failure.raw, "main");
    const next = withMainModelRecoveryWindow({
      ...(state.mainModelRecovery ?? recovery),
      attempts: recovery.attempts + 1,
      attempted,
      skipped: state.mainModelRecovery?.skipped ?? recovery.skipped,
      reason: mainModelRecoveryReason(failure),
      providerErrorDiagnostic: failureCopy.diagnostic,
      recoveryEpisodeKey: recovery.recoveryEpisodeKey ?? `${recovery.firstFailureAt ?? nowIso()}:${failureCopy.fingerprint}`,
      recoveryNoticeKeys: recovery.recoveryNoticeKeys ?? [],
      resumeCurrent: (state.mainModelRecovery ?? recovery).resumeCurrent,
      pendingModelSwitch: undefined,
    });
    // All provider failures use the same bounded envelope. Error text and
    // upstream retry hints do not alter the delay.
    const delay = mainModelFailureDelayMs(failure, next.attempts, loadGlobalSettings().mainModelRetryMinutes);
    if (setMainModelRecoveryPause(ctx, next, delay)) scheduleMainModelRecoveryTimer(ctx, delay);
  } finally {
    if (activeModelSwitchToken === operationToken) {
      activeModelSwitchToken = 0;
      modelSwitchOperationGeneration = null;
      flags.mainModelSwitchInFlight = false;
    }
  }
}

export function parkMainModelAfterFailure(ctx: ExtensionContext, failure: MainModelFailure): void {
  if (!isSupervising() || mainModelRecoveryActive()) return;
  const current = modelRef(ctx.model);
  if (!current) return;
  const existing = withMainModelRecoveryWindow(state.mainModelRecovery ?? {
    primary: current,
    active: current,
    attempted: [current],
    attempts: 0,
    reason: mainModelRecoveryReason(failure),
    kind: mainModelRecoveryKind(),
  } satisfies MainModelRecovery);
  const failureCopy = providerErrorPresentation(failure.raw, "main");
  const nextRecovery = withMainModelRecoveryWindow({
    ...existing,
    active: current,
    attempts: existing.attempts + 1,
    reason: mainModelRecoveryReason(failure),
    providerErrorDiagnostic: failureCopy.diagnostic,
    recoveryEpisodeKey: existing.recoveryEpisodeKey ?? `${existing.firstFailureAt ?? nowIso()}:${failureCopy.fingerprint}`,
    recoveryNoticeKeys: existing.recoveryNoticeKeys ?? [],
    // The next normal/hourly probe retries the current model after the
    // configured fallback chain has been visited.
    resumeCurrent: existing.resumeCurrent,
  });
  // The generic envelope owns the wait; the 24h horizon ends automatic
  // probes regardless of the provider's wording.
  const delay = mainModelFailureDelayMs(failure, nextRecovery.attempts, loadGlobalSettings().mainModelRetryMinutes);
  if (!setMainModelRecoveryPause(ctx, nextRecovery, delay)) return;
  flags.mainModelAbortForRecovery = true;
  try { ctx.abort(); } catch { /* abort is best effort; the recovery guard prevents re-send storms */ }
  scheduleMainModelRecoveryTimer(ctx, delay);
  // The configured bounded ladder is the normal recovery. An opt-in hourly
  // probe ticker (scheduleHourlyProbe) adds a :00:30 attempt when
  // hourlyRetryProbe is enabled (default ON). The recovery timer arms it
  // beside the normal slot.
}

export async function recoverMainModelFromSendStorm(ctx: ExtensionContext, kind: "continuation" | "loop"): Promise<void> {
  if (!isSupervising() || mainModelRecoveryActive()) return;
  const failure = classifyMainModelFailure("provider retry stalled with no stream activity");
  const switched = await tryMainModelFallback(ctx, failure);
  if (switched) {
    const current = modelRef(ctx.model);
    if (!current) return;
    const recovery = state.mainModelRecovery;
    if (!recovery) return;
    if (setMainModelRecoveryPause(ctx, { ...recovery, kind: kind === "loop" ? "loop" : "goal", active: current, resumeCurrent: true }, 1_000)) {
      flags.mainModelAbortForRecovery = true;
      try { ctx.abort(); } catch { /* best effort; recovery guard prevents re-send storms */ }
      scheduleMainModelRecoveryTimer(ctx, 1_000);
    }
    return;
  }
  parkMainModelAfterFailure(ctx, failure);
}

export function mainModelRecoverySucceeded(ctx: ExtensionContext): void {
  const recovery = state.mainModelRecovery;
  if (!recovery) return;
  const current = modelRef(ctx.model);
  const preferredPrimary = recovery.primary;
  const servingFallback = !!current && !sameModelRef(current, preferredPrimary);

  // A successful fallback turn proves only that the backup works. Keep the
  // original primary durable and schedule a reverse probe instead of settling
  // the episode permanently on the fallback.
  if (servingFallback && mainModelFailbackEnabled()) {
    const existingProbeAt = recovery.primaryProbeAt;
    const existingProbeMs = existingProbeAt ? Date.parse(existingProbeAt) : Number.NaN;
    const alreadyScheduled = Number.isFinite(existingProbeMs) && !recovery.primaryProbeInFlight;
    clearMainModelRecoveryTimer();
    cancelHourlyProbe();
    flags.lastMainModelFailure = null;
    flags.mainModelAbortForRecovery = false;
    flags.continuationDispatchStoodDown = false;
    flags.lastMainModelRecoveryResumeAt = Date.now();

    const probeAt = alreadyScheduled
      ? existingProbeAt!
      : new Date(Date.now() + mainModelPrimaryProbeDelay()).toISOString();
    const nextRecovery: MainModelRecovery = {
      ...recovery,
      active: current,
      primaryProbeAt: probeAt,
      primaryProbeInFlight: undefined,
      retryAt: undefined,
      pendingModelSwitch: undefined,
      resumeCurrent: undefined,
    };
    state.mainModelRecovery = nextRecovery;
    const auditRetryStarted = recovery.kind === "goal"
      && state.goal?.status === "paused"
      && !!state.goal.pendingCompletion
      && typeof maybeAutoRetryParkedCompletionAudit === "function"
      && maybeAutoRetryParkedCompletionAudit("main-model-recovery");
    persistState(ctx);
    if (!alreadyScheduled) {
      appendLedger(ctx.cwd, "main_model_fallback_healthy", {
        model: current,
        primary: preferredPrimary,
        primaryProbeAt: probeAt,
        attempts: recovery.attempts,
      });
      ctx.ui.notify(`Main session fallback ${current} is healthy; the preferred primary ${preferredPrimary} will be probed automatically.`, "info");
    }
    if (auditRetryStarted) ctx.ui.notify("The stored completion audit is retrying after the healthy main-model fallback.", "info");
    scheduleMainModelRecoveryTimer(ctx, Math.max(0, Date.parse(probeAt) - Date.now()));
    return;
  }

  clearMainModelRecoveryTimer();
  cancelHourlyProbe(); // recovery settled — ticker stops
  state.mainModelRecovery = undefined;
  flags.lastMainModelFailure = null;
  flags.mainModelAbortForRecovery = false;
  flags.continuationDispatchStoodDown = false;

  // A core retry can succeed after glla has already parked the goal. Resume
  // only our own recovery wait — never a user decision/error pause.
  const recoveryPause = state.goal
    && state.goal.status === "paused"
    && !state.goal.pendingCompletion
    && (state.goal.pauseKind === "wait" || state.goal.pauseKind === "blocked")
    && (state.goal.pauseReason ?? "").startsWith("main model recovery");
  const recoveryLoop = state.loop
    && !state.loop.active
    && (state.loop.stopReason ?? "").startsWith("main model recovery —");
  const resumed = recovery.kind === "goal" && recoveryPause
    ? "goal"
    : recovery.kind === "loop" && recoveryLoop
      ? "loop"
      : undefined;
  appendLedger(ctx.cwd, "main_model_recovered", { model: current, attempts: recovery.attempts, resumed });
  // A successful bounded provider recovery is also a healthy recovery event
  // for a parked detached-auditor claim. The auditor hook owns the durable
  // one-shot marker and generation/context fence; this call never bypasses
  // the explicit-manual-hold policy for cold startup.
  const auditRetryStarted = recovery.kind === "goal"
    && state.goal?.status === "paused"
    && !!state.goal.pendingCompletion
    && typeof maybeAutoRetryParkedCompletionAudit === "function"
    && maybeAutoRetryParkedCompletionAudit("main-model-recovery");
  // v0.34.124: stamp the resume so the continuation-start watchdog grants
  // the post-recovery grace — pi's model chain is still warming and the
  // first turn can take minutes to start (field: deals 2026-08-10 21:13
  // "did not start turn" — the watchdog interrupted a goal whose turn
  // started at +2m51s).
  flags.lastMainModelRecoveryResumeAt = Date.now();
  if (resumed === "goal") {
    // v0.35.28 (issue #16): stamp the auto-recovery so the continuation
    // prompt tells the agent it was itself that was recovered.
    updateGoal({ status: "active", pauseKind: undefined, pauseResumeAt: undefined, pauseReason: undefined, pauseSuggestedAction: undefined, providerErrorDiagnostic: undefined, recoveryEpisodeKey: undefined, recoveryNoticeKeys: undefined, autoResumedAt: new Date().toISOString(), autoResumedEvent: "main-model provider recovered" }, ctx);
    scheduleContinuation(ctx, true, 1_000);
  } else if (resumed === "loop") {
    state.loop = { ...state.loop!, active: true, stopReason: undefined };
    persistState(ctx);
    scheduleLoopTick(ctx);
  } else {
    persistState(ctx);
  }
  ctx.ui.notify(`Main session model recovered on ${current ?? "the active model"}; automatic recovery is cleared${resumed ? ` and the ${resumed} is resuming` : auditRetryStarted ? " and the stored completion audit is retrying" : ""}.`, "info");
}

/** Handle a provider error before loop/goal bookkeeping can mistake it for
 * an unproductive turn. Returns true when recovery owns this agent_end. */
