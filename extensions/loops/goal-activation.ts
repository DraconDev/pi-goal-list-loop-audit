/**
 * pi-goal-list-loop-audit — v0.1.0
 * extensions/loops/goal.ts
 *
 * The goal loop. The agent continues working, and on complete_goal,
 * an isolated auditor verifies the work.
 *
 * Design: see docs/DESIGN.md.
 *
 * Command surface (v0.8.0 — four top-level commands):
 *   /goal "<objective>" | /goal (draft) | /goal status|pause|resume|cancel|tweak <text>|archive
 *   /list add|show|tweak|next|remove|clear
 *   /loop (draft) | /loop start|status|stop
 *   /glla (settings UI) | /glla <action>
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { defineTool, type ContextEvent, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// v0.34.109 (decomposition step 1): the state singleton and the persistence
// core moved to goal-state.ts — the SINGLE owner of the mutable state object
// (positioning doc invariant #2). Property reads on the imported binding are
// fine; wholesale replacement goes through replaceState().
import { state, replaceState, persistStateLine } from "../goal-state.js";

import {
  type Goal,
  type Policy,
  type State,
  type MainModelRecovery,
  type Status,
  type ModeCommand,
  modeCommand,
  workCommand,
  workCommandRoot,
  appendLedger,
  claimRecoveryNotice,
  normalizeProviderErrorText,
  providerErrorPresentation,
  archiveDir,
  archivedGoalPath,
  buildTaskList,
  buildTaskSummary,
  auditFeedbackExcerpt,
  auditVerdictLabel,
  DEFAULT_AUDIT_FEEDBACK_CHARS,
  DEFAULT_STALL_ESCALATION_REFIRES,
  DEFAULT_TOKEN_LIMIT,
  classifyImpossibleReason,
  extractPendingTasks,
  isFullAuditObjective,
  resolveEffectiveAggressiveSettings,
  supervisorPaused,
  appendAuditLog,
  computeListDepth,
  formatAuditLog,
  formatGoalAuditHistory,
  runWithInfraRetry,
  isRetriableInfraError,
  readAuditLog,
  bumpGoalRevision,
  stripThinkBlocks,
  type AuditLogEntry,
  crossRecommendMode,
  formatListDepth,
  parseListItemDeclaration,
  shouldEscalateStall,
  isStaleApiError,
  parseListImport,

  routeGoalArgs,
  routeListText,
  listMutationBlocked,
  LIST_DRAFTING_BLOCK_MESSAGE,
  LIST_MUTATING_SUBCOMMANDS,
  SETTINGS_MUTATING_ACTIONS,
  sumNewAssistantTokens,
  takeAt,
  countTrailingDisapprovals,
  goalArgsNeedDrafting,
  buildSeedGrillMessage,
  askUserQuestionAnswered,
  draftProposalBlock,
  type TaskProposal,
  validateTaskProposal,
  ensureDirs,
  findNextPendingTask,
  goalMdPath,
  newGoalId,
  nowIso,
  compactDisplayText,
  sanitizeDisplayText,
  piGlaDir,
  setRuntimeSessionDirFromSessionManager,
  normalizeDraftContract,
  draftContractItemCount,
  extractVerificationContract,
  classifySessionCtx,
  readState,
  healCorruptedGoalPolicy,
  renderGoalMarkdown,
  shouldAutoResumeOnSessionStart,
  statusLabel,
  writeGoalMd,
  writeQueueItemFile,
  readQueueFromDisk,
  readArchiveIntent,
  finalizeArchiveIntent,
  clearArchiveIntent,
  deleteQueueItemFile,
  missingGllaTools,
  runPersistStep,
  isPersistenceDegraded,
  lastPersistenceFailure,
  modelSwitch,
  isForbiddenModel,
isGoalRevisionCurrent,
  nextHourlyPromptMs,
  nextHourlyProbeMs,
  type ModelSwitchRecord,
  type ListItem,
} from "../goal-loop-core.js";
import {
  createContinuationDispatch,
  dispatchMatchesOwner,
  dispatchPromptMatches,
  dispatchTimedOut,
  dispatchRecordPath,
  clearDispatchRecord,
  persistDispatchRecord,
  readDispatchRecord,
  transitionDispatch,
  type ContinuationDispatch,
} from "../goal-loop-dispatch.js";
import { readHandoffBriefExcerpt, runEmergencyCompactorIfDue } from "../goal-compactor.js";
import {
  createGoalContinuation,
  scheduleContinuation,
  sendContinuation,
  sendStallEscalation,
  sendLengthContinue,
  dispatchStartAcknowledged,
  dispatchAccepted,
  dispatchFailed,
  dispatchPrepare,
  releaseContinuationDispatchStandDown,
  clearContinuationTimer,
  clearContinuationStartWatchdog,
  clearQueueStuckProbe,
  accountSendRearm,
  sendRearmDelayMs,
  armQueueStuckProbe,
  buildPostCompactResync,
  continuationTimerPending,
  continuationTimerRef,
  continuationStartTimerRef,
  pendingContinuationDispatchRef,
  setPendingContinuationDispatchRef,
  continuationDispatchStoodDownRef,
  setContinuationDispatchStoodDownRef,
  lastContinuationSentAtRef,
  setLastContinuationSentAtRef,
  lastContinuationSentPayloadRef,
  setLastContinuationSentPayloadRef,
  setContinuationRearmStreak,
  setContinuationRearmSince,
  resetContinuationDispatchState,
  type ContinuationFlags,
  type ContinuationDeps,
} from "../goal-continuation.js";
export { __testOnlySetContinuationStartTimeout, __testOnlySetContinuationRetryBackoff } from "../goal-continuation.js";
import {
  LENGTH_CONTINUE_MAX,
  LENGTH_CONTINUE_TEXT,
  isContextStarvedLengthStop,
  resetLengthContinue,
  tickLengthContinue,
} from "../length-continue.js";
import { isSubagentProviderFailure } from "../quota-retry.js";
import { captureProviderTokenUsage } from "../context-growth.js";
import { noteOwnershipStanding, refreshOwnerHeartbeat, supersedeLiveOwnerRoot } from "../state-root-owner.js";
import {
  classifyInBandProviderFailure,
  classifyMainModelFailure,
  isMainModelFallbackFailure,
  requiresMainModelRecovery,
  mainModelAutoRetryUntil,
  mainModelFailureDelayMs,
  mainModelRetryDelayMs,
  MAIN_MODEL_AUTO_RETRY_HORIZON_MS,
  modelRef,
  nextUntriedModelRef,
  normalizeModelRefs,
  sendStormEscalateMs,
  splitModelRef,
  type MainModelFailure,
} from "../main-model-recovery.js";
import {
  globalSettingsPath,
  loadGlobalSettings,
  loadSettings,
  projectSettingsPath,
  saveSettings,
  settingsProvenance,
  type Settings,
} from "../goal-settings.js";
import {
  curateAuditReviewSources,
  normalizeObjective,
  resolveReviewerConfig,
  reviewerMenuOptions,
  runReviewer,
  type ReviewerConfig,
} from "../reviewer.js";
import {
  discoverGllaProjects,
  filterPremature,
  formatRollupJson,
  formatRollupTable,
  rollupProject,
  type ProjectRollup,
} from "../goal-loop-stats.js";
import { releaseAuditorSurface, suppressAuditorSurfaceAfterColdRestore } from "./goal-auditor-surface.js";
import {
  cancelDetachedGoalCompletionAuditor,
  newDetachedAuditJobAttemptId,
  runDetachedGoalCompletionAuditor,
  type AuditorProgress,
} from "../goal-loop-auditor-process.js";
import {
  REPETITION,
  isActuallyStuck,
  repeatedInBandProviderFailure,
  loopInterventionDirective,
  continueVariant,
  textFingerprint,
  pushCapped as pushRepetitionCapped,
} from "../goal-loop-repetition.js";
import { auditorVerdictTally, buildLoadHoldRecoveryLines, buildStatusText, buildWidgetLines, type AuditDisplayProgress } from "../goal-loop-display.js";
import { compactLoopCompletionSummary } from "../completion-summary.js";
import {
  defaultAgentDir,
  resolveEffectiveSubagentModel,
  resolveSubagentOverrideRef,
  syncSubagentModelOverrides,
  type SubagentModelStrategy,
} from "../goal-loop-subagents.js";
import {
  buildSettingsRows,
  SettingsMenuComponent,
  type SettingsRow,
  type SettingsSectionId,
} from "../settings-menu.js";
import {
  VISION_ASSIST_GUIDANCE,
  routeVisionCheck,
  visionAssistLedger,
} from "../vision-assist.js";
import {
  buildModelPickItems,
  ModelPickerComponent,
  type ModelPickItem,
} from "../model-picker.js";
import { consumeRecoveryResume } from "../goal-recovery.js"; // decomposition step 3 (v0.34.111)
import { payloadGuardProjection } from "../payload-guard.js"; // v0.35.51 image-413 guard
import { dropFailedErrorOnlyTurns, pruneCompactionPreparation } from "../context-hygiene.js"; // v0.35.52 error-turn hygiene
import { buildAuthoritativeContextCheckpoint, projectBoundedGllaContext } from "../context-checkpoint.js"; // v0.36.2 bounded continuation context
import {
  createGoalHeartbeat,
  bindSubagentRpcHost,
  observeSubagentRpcReadiness,
  observeCurrentSubagentStart,
  observeCurrentSubagentProgress,
  observeCurrentSubagentComplete,
  observeCurrentSubagentTerminal,
  releaseSubagentRpcHost,
  releaseZombieAbortKey,
  endSubagentHangProbe,
  markSubagentHangProgress,
  signalSupervisionEvent,
  startHeartbeat,
  upsertSubagentHangProbe,
  type HeartbeatDeps,
  type HeartbeatFlags,
} from "../goal-heartbeat.js"; // decomposition step 4 (v0.34.112)
import {
  clearMainModelRecoveryTimer,
  createGoalRecovery,
  isCompletionAuditRecoveryPending,
  mainModelRecoveryActive,
  mainModelRecoveryKind,
  mainModelRecoveryReason,
  mainModelRecoverySucceeded,
  mainModelFallbackRefs,
  manuallyResumeMainModelRecovery,
  markCompletionAuditRecoveryPending,
  parkMainModelAfterFailure,
  probeMainModelRecovery,
  recoverMainModelFromSendStorm,
  recoverFromContextOverflow,
  resolveMainModel,
  scheduleHourlyProbe,
  scheduleMainModelRecoveryTimer,
  setMainModelRecoveryPause,
  tryMainModelFallback,
  withMainModelRecoveryWindow,
  type RecoveryDeps,
  type RecoveryFlags,
} from "../goal-recovery.js"; // decomposition step 3 (v0.34.111) — clusters B (main-model recovery) + C (completion-audit recovery)
import {
  ConfirmDraftComponent,
} from "../confirm-draft.js";
import {
  applyMeasurement,
  applyMetriclessTick,
  applyRefinement,
  loopBranchName,
  parseLoopStartArgs,
  loopFinishStopReason,
  isLoopWriteTool,
  parseMetric,
  LOOP_DEFAULTS,
  resolveSpecFiles,
  respecTarget,
  topOpenAuditFinding,
  specFileHash,
  countCheckedSpecItems,
  auditMeasureCmd,
  auditTarget,
  AUDIT_PLATEAU_MAX_REPRIEVES,
  countOpenAuditFindings,
  AUDIT_FINDINGS_REL,
  projectAuditTarget,
  LIST_AUDIT_COLLECT_MARKER,
  GOAL_AUDIT_ONESHOT_MARKER,
  LOOP_AUDIT_MARKER,
  listAuditCollectTarget,
  parseAuditFindingsForFanout,
  listAuditFanoutItemText,
  type LoopTickOutcome,
  HELD_ON_RESTORE,
  isLifecycleHeldLoopReason,
  type LoopState,
} from "../goal-loop-forever.js";
import {
  accountTurnForNudgesRich,
  BACKOFF_IDLE_RETRY_MS,
  DEFAULT_STALL_SIM_THRESHOLD,
  DEFAULT_STALL_SHORT_WORDS,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_MAX_NUDGES,
  HEARTBEAT_STALL_MS,
  shouldHeartbeatRefire,
  MEASURE_TIMEOUT_MS,
  WEDGE_ALERT_DEFAULT_MINUTES,
  shouldWedgeAlert,
  PENDING_LATCH_STUCK_MS,
  shouldFirePendingLatchWatchdog,
  DEFAULT_ZOMBIE_RETRY_MAX_ATTEMPTS,
  ZOMBIE_RETRY_DELAY_MS,
  zombieRetryDecision,
  type ZombieRetryStreak,
} from "../goal-loop-backoff.js";
import {
  addSingleItem,
  autoNotifyCmd,
  cmdGoal,
  cmdList,
  cmdReview,
  cmdReviewerSettings,
  cmdSettings,
  createGoalCommands,
  enqueueItems,
  hydrateListQueueFromDisk,
  maybeDecisionPopup,
  probeAutoNotify,
  recentlyCompletedObjectives,
  warnIfAuditorProviderRisky,
  warnOnCommandCollision,
  type CommandDeps,
  type CommandFlags,
} from "../goal-commands.js";
import {
  STALE_TOOL_CONTEXT_MESSAGE,
  clearLoopTimer,
  cmdLoop,
  announceQueuedListAfterLoopEnd,
  createGoalLoop,
  isLoopActive,
  loopTimerPending,
  runLoopTick,
  scheduleLoopTick,
  startLoopFromConfig,
  type LoopDeps,
  type LoopFlags,
} from "../goal-loop.js";
import { defineGoalRuntimeGlobal } from "./goal-runtime-globals.js";

/** v0.35.x: queue a repair task without auto-activating over the paused
 * suspicious objective. The normal enqueue path keeps disk-first ordering,
 * duplicate guards, and list provenance intact. */
export function enqueueFaultRepairTask(ctx: ExtensionContext, objective: string, target?: Goal["repairTarget"]): void {
  const existing = (state.list ?? []).find((item) => item.objective === objective);
  if (existing) {
    if (target && !existing.repairTarget) {
      const repaired = { ...existing, repairTarget: target };
      const written = writeQueueItemFile(ctx.cwd, repaired, { replace: true });
      if (written.failed) {
        ctx.ui.notify("Could not persist the repair target; the original queued item remains unchanged.", "warning");
        return;
      }
      replaceState({ ...state, list: (state.list ?? []).map((item) => item.id === existing.id ? repaired : item) });
      persistState(ctx);
      appendLedger(ctx.cwd, "faulty_objective_repair_target_recovered", { goalId: existing.id, targetId: target.id, source: target.source });
    }
    return;
  }
  const before = new Set((state.list ?? []).map((item) => item.id));
  enqueueItems(ctx, [objective], "faulty-objective", { autoActivate: false });
  const added = (state.list ?? []).find((item) => !before.has(item.id) && item.objective === objective);
  if (!added) return;
  const repair = target ? { ...added, repairTarget: target } : added;
  if (target) {
    const repairWritten = writeQueueItemFile(ctx.cwd, repair, { replace: true });
    if (repairWritten.failed) {
      ctx.ui.notify("Could not persist the repair target; the queued repair remains without promotion metadata.", "warning");
      return;
    }
  }
  const rest = (state.list ?? []).filter((item) => item.id !== added.id);
  replaceState({ ...state, list: [repair, ...rest] });
  persistState(ctx);
  appendLedger(ctx.cwd, "faulty_objective_repair_promoted", { goalId: repair.id, targetId: target?.id, position: 1, source: target?.source ?? "unknown" });
}

/** v0.35.x — bounded repeated automatic recovery after a confirmed
 * zero-stream abort.
 *
 * A Pi-core retry sleeper can keep the host BUSY long after the useful stream
 * has stopped. GLLA owns the safe boundary: abort the stale host turn, park
 * durable work, and re-dispatch while the configured zero-stream retry budget
 * remains. A real stream resets the episode; uninterrupted silence eventually
 * reaches the budget and stays parked instead of producing an infinite retry
 * storm.
 *
 * `/glla pause` freezes the retry like every other automatic side-effect, and
 * manual /goal resume · /loop resume remain available at all times. The streak
 * counter is process-memory by design: a session restart inside the retry
 * window leaves the park standing for manual resume.
 */
const ZOMBIE_PAUSE_REASON = "automatic zero-stream abort — no provider activity was observed";

// Streak state is process-memory by design (see the block comment above
// scheduleZombieAutoRetry): a session restart inside the retry window leaves
// the park standing for manual resume — an honest degradation.
let zombieRetryStreak: ZombieRetryStreak = { key: "", count: 0, lastAbortStreamAt: 0 };
let zombieRetryTimer: NodeJS.Timeout | null = null;
// v0.38.18 (track 2): the stream clock when the current turn's begin-marker
// was last observed. Compared against the abort's observation point to tell
// "wedged after streaming" (deserves budget retries) from "never streamed
// since birth" (an immediate retry replays the silence — park at once).
// 0 means no begin-marker observed (extension loaded mid-turn): unknown, and
// unknown preserves the legacy retry-within-budget behavior.
let lastTurnStartAt = 0;
// An in-band provider pane is observed during tool_result and consumed at the
// matching agent_end. Keep the raw text only in memory; the durable ledger
// records the bounded classification, never the provider payload.
let inBandProviderFailureRaw: string | null = null;
function clearInBandProviderFailure(): void {
  inBandProviderFailureRaw = null;
}

/** Arm the next automatic re-dispatch after a successful zombie abort.
 * The configured retry budget keeps repeated recovery finite; the caller gets
 * the attempt number so user-facing copy and ledger evidence stay truthful. */
function scheduleZombieAutoRetry(
  ctx: ExtensionContext,
  generation: number,
  goalId: string | undefined,
  observedStreamAt: number,
  silentMinutes: number,
): { scheduled: boolean; attempt: number; maxAttempts: number; reason?: "never-streamed" | "budget-exhausted" } {
  const key = goalId ?? "loop";
  const maxAttempts = zombieRetryMaxAttemptsOverride
    ?? loadSettings(ctx.cwd).zombieRetryMaxAttempts
    ?? DEFAULT_ZOMBIE_RETRY_MAX_ATTEMPTS;
  const { retry, streak, neverStreamed } = zombieRetryDecision(observedStreamAt, key, zombieRetryStreak, maxAttempts, lastTurnStartAt);
  zombieRetryStreak = streak;
  const plan = { scheduled: retry, attempt: streak.count, maxAttempts, reason: neverStreamed ? "never-streamed" as const : retry ? undefined : "budget-exhausted" as const };
  appendLedger(ctx.cwd, retry ? "zombie_auto_retry_scheduled" : neverStreamed ? "zombie_auto_retry_refused_never_streamed" : "zombie_auto_retry_refused_streak", {
    goalId,
    streakCount: streak.count,
    maxAttempts,
    delayMs: zombieRetryDelayOverride ?? ZOMBIE_RETRY_DELAY_MS,
  });
  if (!retry) return plan;
  const retryAttempt = plan.attempt;
  const retryMaxAttempts = plan.maxAttempts;
  if (zombieRetryTimer) {
    clearTimeout(zombieRetryTimer);
    zombieRetryTimer = null;
  }
  // scheduleSessionTimeout carries the generation/stale/zombie fences — an
  // old session's callback can never re-arm work after stale/shutdown/reload.
  zombieRetryTimer = scheduleSessionTimeout(() => {
    zombieRetryTimer = null;
    // v0.35.15 semantics: a frozen supervisor keeps everything automatic off.
    // The parked claim stays durable; /glla resume then /goal resume apply.
    if (supervisorPaused(state)) return;
    const fresh = freshCtxForGeneration(generation);
    if (!fresh) return;
    const goal = state.goal;
    if (goalId !== undefined || goal) {
      if (!goal || goal.status !== "paused" || goal.id !== goalId) return;
      if (goal.pauseReason !== ZOMBIE_PAUSE_REASON) return; // superseded pause — not ours to clear
      const freshLimit = loadSettings(fresh.cwd).tokenLimit ?? DEFAULT_TOKEN_LIMIT;
      const usage = goal.usage ? { tokensUsed: goal.usage.tokensUsed, tokensLimit: freshLimit } : undefined;
      abortedStandDown = false;
      setContinuationDispatchStoodDownRef(false);
      updateGoal({
        status: "active",
        pauseKind: undefined,
        pauseReason: undefined,
        pauseSuggestedAction: undefined,
        ...(usage ? { usage } : {}),
      }, fresh);
      appendLedger(fresh.cwd, "zombie_auto_retry_dispatched", {
        goalId: goal.id,
        policy: goal.policy,
        attempt: retryAttempt,
        maxAttempts: retryMaxAttempts,
      });
      releaseZombieAbortKey();
      try {
        fresh.ui.notify(`Automatic retry ${retryAttempt}/${retryMaxAttempts} starting — the earlier ${goal.policy === "list" ? "list item" : "goal"} turn was aborted after ${silentMinutes}m of zero stream activity. If it hangs again, GLLA keeps retrying within this budget before requiring ${activeGoalSurfaceCommand("resume")}.`, "info");
      } catch { /* best-effort */ }
      scheduleContinuation(fresh, true);
      return;
    }
    // Loop owner: revive the preserved iteration and tick once.
    const loop = state.loop;
    if (!loop || !loop.stopReason?.includes("zero-stream abort")) return;
    abortedStandDown = false;
    setContinuationDispatchStoodDownRef(false);
    loop.active = true;
    loop.stopReason = undefined;
    persistState(fresh);
    appendLedger(fresh.cwd, "zombie_auto_retry_dispatched", {
      kind: "loop",
      iteration: loop.iteration,
      attempt: retryAttempt,
      maxAttempts: retryMaxAttempts,
    });
    releaseZombieAbortKey();
    try {
      fresh.ui.notify(`Automatic retry ${retryAttempt}/${retryMaxAttempts} starting — the loop was stopped after a zero-stream abort. GLLA keeps retrying within this budget; if it hangs again after the budget, it stays stopped for /loop resume.`, "info");
    } catch { /* best-effort */ }
    scheduleLoopTick(fresh);
  }, zombieRetryDelayOverride ?? ZOMBIE_RETRY_DELAY_MS);
  return plan;
}

/** Test-only: reset the module-global retry streak/timer state. */
export function __testOnlyResetZombieAutoRetry(): void {
  if (zombieRetryTimer) {
    clearTimeout(zombieRetryTimer);
    zombieRetryTimer = null;
  }
  zombieRetryStreak = { key: "", count: 0, lastAbortStreamAt: 0 };
  zombieRetryMaxAttemptsOverride = null;
  lastTurnStartAt = 0;
}

/** Test-only: pretend a turn begin-marker was observed at the given clock. */
export function __testOnlySetTurnStartAt(at: number): void {
  lastTurnStartAt = at;
}

let zombieRetryDelayOverride: number | null = null;
let zombieRetryMaxAttemptsOverride: number | null = null;

/** Test-only: shrink the automatic-retry delay (null restores the 90s
 * production default). Never called by production code. */
export function __testOnlySetZombieRetryDelay(ms: number | null): void {
  zombieRetryDelayOverride = ms;
}

/** Test-only: pin the retry budget without depending on the caller's global
 * settings file. Null restores the loaded setting/default. */
export function __testOnlySetZombieRetryMaxAttempts(attempts: number | null): void {
  zombieRetryMaxAttemptsOverride = attempts;
}

/** v0.35.x: terminate one confirmed zero-stream host turn and park the
 * owning goal/list item before asking pi to abort. This is deliberately an
 * activation-owned operation: it can clear the durable continuation sidecar,
 * stand down re-arms, and validate the current generation before touching the
 * host. A later /goal or /list resume explicitly clears the stand-down and
 * starts a new attempt; each uninterrupted silence can also consume the
 * configured bounded retry budget through scheduleZombieAutoRetry below. */
export function abortZombieRun(
  ctx: ExtensionContext,
  generation: number,
  goalId: string | undefined,
  observedStreamAt: number,
): boolean {
  const current = freshCtxForGeneration(generation);
  if (!current || sessionGeneration !== generation || mainModelRecoveryActive()) return false;
  if (lastStreamActivityAt !== observedStreamAt) return false;
  const goal = state.goal;
  const loop = state.loop;
  if (goal) {
    if (goal.status !== "active" || (goalId !== undefined && goal.id !== goalId)) return false;
  } else if (!loop?.active) {
    return false;
  }

  // Remove every in-memory and file-backed dispatch artifact before the
  // abort. Otherwise a queued follow-up can resurrect after the host turn is
  // interrupted and recreate the exact retry storm this watchdog is curing.
  resetContinuationDispatchState(current.cwd);
  setContinuationDispatchStoodDownRef(true);
  abortedStandDown = true;
  const silentMinutes = Math.max(1, Math.round((Date.now() - observedStreamAt) / 60_000));
  const reason = ZOMBIE_PAUSE_REASON;
  if (goal) {
    const noun = goal.policy === "list" ? "list item" : "goal";
    updateGoal({
      status: "paused",
      pauseKind: "error",
      pauseReason: reason,
      pauseSuggestedAction: `The stalled ${noun} turn was aborted safely and the work is saved. ${lastTurnStartAt > 0 && observedStreamAt <= lastTurnStartAt ? `The turn never produced stream activity, so no automatic retry was scheduled; ${activeGoalSurfaceCommand("resume")} retries immediately and ${activeGoalSurfaceCommand("cancel")} discards it.` : `Automatic retries use the configured zero-stream budget; ${activeGoalSurfaceCommand("resume")} retries immediately and ${activeGoalSurfaceCommand("cancel")} discards it.`}`,
    }, current);
  } else if (loop) {
    clearLoopTimer();
    loop.active = false;
    loop.stopReason = `stopped: ${reason} after ${silentMinutes}m (iteration ${loop.iteration} preserved; /loop resume to retry)`;
    persistState(current);
    appendLedger(current.cwd, "loop_stopped", { reason: loop.stopReason, iterations: loop.iteration, zombie: true });
  }

  let abortError: string | undefined;
  try {
    current.abort();
  } catch (error) {
    abortError = error instanceof Error ? error.message : String(error);
  }
  appendLedger(current.cwd, "zombie_run_aborted", {
    goalId: goal?.id,
    generation,
    observedStreamAt,
    silentMs: Math.max(0, Date.now() - observedStreamAt),
    abortError,
  });
  const resume = goal ? activeGoalSurfaceCommand("resume") : "/loop resume";
  const cancel = goal ? activeGoalSurfaceCommand("cancel") : "/loop stop";
  // v0.35.x: keep the park as a bounded waystation for repeated
  // zero-stream attempts. Once the configured budget is exhausted the
  // refusal remains manual and durable.
  // v0.38.18 (track 2): a turn that never streamed gets no hot retry — say
  // so in the park copy instead of promising budget retries that never come.
  const neverStreamed = lastTurnStartAt > 0 && observedStreamAt <= lastTurnStartAt;
  const retryPlan = scheduleZombieAutoRetry(current, generation, goal?.id, observedStreamAt, silentMinutes);
  const loopRecap = loop
    ? compactLoopCompletionSummary({ ...loop, historyLength: loop.history.length })
    : undefined;
  const message = `${goal ? goal.policy === "list" ? "List item" : "Goal" : "Loop"} paused after ${silentMinutes}m with zero stream activity; the zombie turn was aborted and queued retries were stopped. Work is saved. ${
    retryPlan.scheduled
      ? `Automatic retry ${retryPlan.attempt}/${retryPlan.maxAttempts} starts in ~90s; ${resume} retries immediately instead.`
      : retryPlan.reason === "never-streamed"
        ? `The turn never produced stream activity, so no automatic retry was scheduled — a retry would replay the same silence. ${resume} retries it, or ${cancel} discards/stops it.`
        : `${resume} retries it, or ${cancel} discards/stops it; the automatic retry budget is exhausted.`
  }${loopRecap ? `\nRecap: ${loopRecap}` : ""}`;
  current.ui.notify(message, abortError ? "warning" : "info");
  notifyExternal(current, message);
  return true;
}

// Slash commands are an independent mutation surface from registered agent
// tools. Keep this guard outside the completion-factory source block so the
// command registration remains a pure shared factory (and source pin).
function refuseForeignCommand(ctx: ExtensionContext): boolean {
  const refusal = foreignToolGuard(ctx);
  if (!refusal) return false;
  try { ctx.ui.notify(refusal, "warning"); } catch { /* child UI may be headless */ }
  return true;
}

export function __testOnlyClassifyStaleContinuation(content: string, cwd: string): string | null {
  const goalIdMatch = content.match(/\[GOAL CHECKPOINT goalId=([^\]\s]+)\]/);
  const loopMatch = content.match(/\[LOOP ITERATION (\d+)\]/);
  const isStall = content.includes("[STALL WARNING");
  const isLengthContinue = content.includes("Your previous response was cut off") || content.includes("Response hit the output-token cap");
  if (isLengthContinue) return null;
  if (goalIdMatch) {
    const gid = goalIdMatch[1]!;
    if (!state.goal) return `no active goal (expected ${gid})`;
    if (state.goal.id !== gid) return `goal mismatch (expected ${gid}, active ${state.goal.id})`;
    if (state.goal.status !== "active") return `goal ${gid} not active (status=${state.goal.status})`;
    try {
      const p = archivedGoalPath(cwd, gid);
      if (fs.existsSync(p)) return `goal ${gid} already archived`;
    } catch {}
    if ((state.goal as any).stopReason) return `goal ${gid} terminal stopReason present`;
    return null;
  }
  if (loopMatch) {
    if (!state.loop?.active) return `loop not active (iteration ${loopMatch[1]})`;
    return null;
  }
  if (isStall) {
    if (!state.goal || state.goal.status !== "active") return "stall warning with no active goal";
    return null;
  }
  if (!state.goal && !state.loop?.active) return "no active supervision for generic goal-event";
  return null;
}

export function registerGoalRuntime(pi: ExtensionAPI): void {
  // Factories run before lifecycle events, so observe readiness now; the
  // admitted session_start below decides which bus/generation may control a
  // child. Worker factories can never claim this binding.
  observeSubagentRpcReadiness(pi.events);
  // Four top-level commands, that's all (v0.8.0 consolidation):
  //   /goal  — set/draft + status|pause|resume|cancel|tweak|archive subcommands
  //   /list — the list (add|show|tweak|next|remove|clear)
  //   /loop  — the metric loop (draft|start|status|stop)
  //   /glla   — the settings UI; nonempty arguments are actions
  // v0.22.5: subcommand autocomplete for the /-menu.
  // v0.27.4: pi's applyCompletion does NOT add a trailing space for argument
  // completions (it does for the top-level /goal itself). Without a trailing
  // space the user has to press Space before typing — and if they forget
  // they end up with `/goal startasdahlasf` (goal.ts:3545 area). Items whose
  // value ends in `=` get no space; everything else gets a single trailing
  // space. `label` stays clean for the picker display. The glla namespace
  // itself exposes actions only; settings live in the `/glla` table.
  const completions = (items: Array<[string, string]>) => (prefix: string) =>
    items
      .filter(([value]) => value.startsWith(prefix))
      .map(([value, description]) => ({
        value: value.endsWith("=") ? value : value + " ",
        label: value,
        description,
      }));

  pi.registerCommand("goal", {
    description: "Set/draft a goal, or /goal status|pause|resume|cancel|tweak <text>|archive|start <objective>. Objectives without a 'Done when:' clause are grilled into a contract first; include the clause or use /goal start to skip the interview and activate instantly. Bare /goal start inherits one clear recent objective or falls back to drafting.",
    getArgumentCompletions: completions([
      ["start", "skip drafting — /goal start <objective> activates immediately; bare start uses one clear recent objective"],
      ["plan", "extended draft for greenfield/megaplan work: research-first, multi-round interview, structured expanded objective (still Confirm-gated)"],
      ["audit", "one-shot project audit goal: /goal audit [focus] — fix the non-decisions, present the decisions (v0.29.8)"],
      ["verify", "run the isolated auditor on the current goal NOW (v0.28.27, renamed from /goal audit)"],
      ["status", "show the active goal and its task list"],
      ["pause", "pause the active goal"],
      ["resume", "resume a paused goal (and the list, when items are queued)"],
      ["cancel", "abort the active goal"],
      ["decide", "re-open the decision picker for a decision pause"],
      ["tweak", "change the objective: /goal tweak <text>"],
      ["archive", "list archived goals"],
    ]),
    handler: (args: string, ctx: ExtensionContext) => {
      rememberCtx(ctx);
      if (refuseForeignCommand(ctx)) return Promise.resolve();
      return cmdGoal(args, ctx);
    },
  });
  const settingsHandler = (args: string, ctx: ExtensionContext) => {
    rememberCtx(ctx);
    if (refuseForeignCommand(ctx)) return Promise.resolve();
    return cmdSettings(args, ctx);
  };
  pi.registerCommand("glla", {
    description: "Open the settings UI for goals, loops, lists, and the auditor. `/glla version` shows the installed package version; `/glla pause` freezes the supervisor's automatic machinery (re-arms/recovery/auto-resume/dispatch) without touching active work; `/glla resume` also starts a waiting-only list; `/glla cancel` cancels the active objective; `/glla wipe` Confirm-gatedly clears all live state while preserving history.",
    getArgumentCompletions: completions([
      // Operational verbs only. Settings and section navigation belong in
      // the bare `/glla` table, so they do not compete with action completion.
      ["version", "show the installed package version and registry check"],
      ["status", "show goal, list, loop, and pending decisions"],
      ["log", "show the recent event trail"],
      ["resume", "resume paused/held work or start a waiting-only list; also unfreezes a /glla pause"],
      ["pause", "freeze ALL supervisor automation (re-arms/recovery/dispatch) — active work keeps running"],
      ["cancel", "cancel the active objective (list item + queue)"],
      ["wipe", "Confirm-gated idempotent reset of all live goal/list/loop state"],
      ["stats", "show per-project ledger rollups"],
      ["audits", "browse the audit log"],
      ["agents", "show tracked subagents; --tail <id> reads a child transcript"],
      ["switchlog", "show the model-switch trail (model_switch / forbidden_model_switch)"],
      ["tooloverride", "configure agent-tool visibility"],
      ["bug", "capture failure context/logs to a separate artifact without touching durable goal state"],
    ]),
    handler: settingsHandler,
  });
  pi.registerCommand("review", {
    description: "Manually run the postaudit on an archived goal: /review <goal-id> [off|on|auto|aggressive] — extracts findings, writes a report to .pi-glla/reviews/, cascades per the mode (auto/aggressive = no Confirms). Bypasses the trigger gates (explicit user request).",
    handler: (args: string, ctx: ExtensionContext) => {
      rememberCtx(ctx);
      if (refuseForeignCommand(ctx)) return Promise.resolve();
      return cmdReview(args, ctx);
    },
  });
  pi.registerCommand("list", {
    description: "Loop 2: the list of audited goals — order is the default, not the law. /list <describe tasks or name a plan file> (dumps get shaped into items, files import, 'Done when:' adds directly) | /list audit [focus] (collect findings, then drain them as items) | /list show | /list start | /list resume | /list tweak <text> | /list next [n] | /list remove <n> | /list clear | /list cancel. /list start explicitly activates the queued head or drafts one clear recent objective with the normal Confirm gate. Settings are under /glla, not /list — bare /glla opens the settings table.",
    getArgumentCompletions: completions([
      ["show", "display the waiting items"],
      ["start", "explicitly activate the queued head; with no queue, draft one clear recent objective"],
      ["add", "alias — same as bare /list <text>: detection routes everything"],
      ["import", "alias — /list import <file-or-text> shapes the dump into items (v0.19.0 no-op verb)"],
      ["settings", "settings live under /glla — bare /glla opens the settings table"],
      ["audit", "collect-then-drain: audit the project, queue every finding as its own item"],
      ["plan", "extended draft: deep research + multi-round interview, then ONE Confirm proposes the whole items[] batch"],
      ["resume", "resume the paused list head; use /glla resume for a waiting-only queue"],
      ["pause", "pause the active list item (it stays head; /list resume brings it back)"],
      ["tweak", "change the paused list item: /list tweak <text>"],
      ["next", "activate the next item (or /list next <n> for position n)"],
      ["remove", "remove an item: /list remove <n>"],
      ["rm", "alias of /list remove <n>"],
      ["clear", "empty the list"],
      ["depth", "queue depth, oldest item age, average item duration"],
      ["cancel", "stop the whole list: abort the active item + drop all waiting"],
    ]),
    handler: (args: string, ctx: ExtensionContext) => {
      rememberCtx(ctx);
      if (refuseForeignCommand(ctx)) return Promise.resolve();
      return cmdList(args, ctx);
    },
  });
  pi.registerCommand("loop", {
    description: "Loop 3: metric-driven process — it never completes. /loop <target> drafts the metric with you · /loop start \"<target>\" = infinite metricless loop (no plateau, no cap; ends at time=/tokens= or /loop stop) · bare /loop start inherits one clear recent target but does not infer metric, bounds, or branch options · /loop respec = infinite metricless reconcile against the root SPEC.md · add measure=\"<cmd>\" direction=min|max [window=5] [max=50] [cadence=<seconds>] [branch=1] for a loop · cadence is opt-in and limits automatic wakes between successful iterations · /loop status · /loop stop (alias /loop cancel). 'Improve until X' is a /goal, not a loop.",
    getArgumentCompletions: completions([
      ["start", "skip drafting: /loop start \"<target>\" measure=\"<cmd>\" direction=min|max [window=5] [max=50] [cadence=<seconds>]; bare start uses one clear recent target"],
      ["respec", "infinite metricless loop reconciling the codebase against the root SPEC.md"],
      ["plan", "extended loop draft: deep research + multi-round metric design, same Confirm as a regular draft"],
      ["audit", "project-audit loop: each iteration audits fresh, appends findings, fixes the top ones — plateau stops when the well is dry (v0.29.0)"],
      ["status", "show metric, iteration, best/last values, stall count, and cadence"],
      ["resume", "resume a held loop (session-restore gate / manual main-model recovery)"],
      ["refine", "queue an operator respec suggestion into the next iteration's prompt: /loop refine <text>"],
      ["polish", "alias of /loop refine"],
      ["stop", "end the loop (keeps the best state)"],
      ["cancel", "alias of /loop stop — end the loop"],
      ["finish", "end the loop cleanly: /loop finish [reason] → stopReason 'completed: <reason>'"],
    ]),
    handler: (args: string, ctx: ExtensionContext) => {
      rememberCtx(ctx);
      if (refuseForeignCommand(ctx)) return Promise.resolve();
      return cmdLoop(args, ctx);
    },
  });

  // Tool registration is lazy: done on the first session event, when a
  // context exists. Tools show even without an active goal (and return
  // "no active goal" if called).
  // Tool definitions are re-registered at lifecycle boundaries; the current
  // invocation context is resolved inside each execute handler.
  let toolsRegistered = false;

  // v0.24.5 tool-visibility self-heal: surface the notify exactly once
  // per session so the user learns about an external allowlist once and
  // can fix their profile to silence it.
  // v0.27.9: also applies toolOverrides.allow / toolOverrides.hide from
  // .pi-glla/settings.json — the project's per-tool policy wins over the
  // external allowlist (allow) or over the session default (hide).
  let toolHealNotified = false;
  function ensureAgentToolsActive(pi: ExtensionAPI, ctx: ExtensionContext): void {
    try {
      const active = pi.getActiveTools();
      const missing = missingGllaTools(active);
      const overrides = loadSettings(ctx.cwd).toolOverrides;
      let next = [...active, ...missing];
      let changed = missing.length > 0;
      // Apply per-tool allowlist — force tools visible despite an external modlist.
      if (overrides?.allow && overrides.allow.length > 0) {
        const toAdd = overrides.allow.filter((t) => !next.includes(t));
        if (toAdd.length > 0) {
          next = [...next, ...toAdd];
          changed = true;
        }
      }
      // Apply per-tool hide — force tools hidden even when the session allows them.
      if (overrides?.hide && overrides.hide.length > 0) {
        const before = next.length;
        next = next.filter((t) => !overrides.hide!.includes(t));
        if (next.length !== before) changed = true;
      }
      if (changed) pi.setActiveTools(next);
      if (!toolHealNotified && missing.length > 0) {
        // v0.29.3: the notify used to fire even when NOTHING was missing —
        // "glla: 0 agent tool(s) were hidden … re-activated ()" at every pi
        // start (field-observed in darklord). Warn only on a real heal.
        toolHealNotified = true;
        const list = missing.join(", ");
        ctx.ui.notify(
          `glla: ${missing.length} agent tool(s) were hidden by an external tool allowlist (e.g. a modlist profile) and have been re-activated (${list}). Add them to your allowlist profile to silence this.`,
          "warning",
        );
      }
    } catch {
      // Older pi without getActiveTools/setActiveTools — nothing we can do.
    }
  }

  // v0.35.60: tool visibility is a pre-turn invariant, not merely a
  // session-start/agent-end repair. Another extension may replace the active
  // tool set between those events; if that happens, the model can emit a
  // valid glla call that pi answers with "Tool <name> not found". Register
  // definitions and heal the model-facing active set immediately before a
  // turn (and on older hosts' agent_start fallback). Re-registration is
  // intentional: a replacement session can reset Pi's registry without
  // resetting this extension's toolsRegistered flag.
  function ensureAgentToolsReady(ctx: ExtensionContext, forceRegister = false): void {
    if (forceRegister || !toolsRegistered) {
      registerAgentTools(pi);
      toolsRegistered = true;
    }
    ensureAgentToolsActive(pi, ctx);
  }

  // v0.26.1: compaction ends WITHOUT an agent_end (the compaction turn is
  // not an agent turn), so the continuation chain can dangle until the
  // 60s heartbeat notices. Re-arm it as soon as pi settles post-compact.
  pi.on("session_compact", async (_event: any, ctx: ExtensionContext) => {
    signalSupervisionEvent({ plane: "auditor", kind: "recover", source: "session_compact" });
    // v0.34.25: a compact event from the live replacement session is the
    // field's most common post-swap contact — absorb/heal it BEFORE the gates
    // drop it (post-park the owner is nulled, so it is not even "foreign").
    rememberCtx(ctx);
    if (!tryAbsorbHostSuccessor(ctx, "session_compact") && isForeignCtx(ctx)) return;
    // A late compact event can arrive after pi has already invalidated this
    // extension. It must not reclaim the old ctx or schedule settle refires.
    if (sessionHandoffPending || extensionApiStale || staleTerminalDone || zombieStoodDown) return;
    if (!isSupervising()) return;
    appendLedger(ctx.cwd, "session_compact", {});
    // v0.28.24: a compaction is LEGITIMATE busy time — reset the send-rearm
    // storm streaks (π-web nearly escalated a "send-retry storm" pause during
    // a 3.5-minute compact) and open the post-compaction stall grace.
    setContinuationRearmStreak(0); setContinuationRearmSince(0);
    loopRearmStreak = 0; loopRearmSince = 0;
    compactionGraceUntil = Date.now() + COMPACTION_GRACE_MS;
    lastCompactionAt = Date.now();
    // v0.34.97: persist lastCompactionAt to state so the ⏳ compacting…
    // chip survives a reload. Without this, the chip vanishes on reload
    // and the user thinks the compaction didn't happen
    // (Screenshot_20260808_003007/003024 ai-auto-writer 222,368 tokens).
    replaceState({ ...state, lastCompactionAt });
    persistState(ctx);
    // v0.34.97: surface the compaction to the user. Field evidence
    // (Screenshot_20260808_003007/003024 ai-auto-writer): a 222,368-token
    // compaction happened but the user only saw "[compaction]" on RELOAD —
    // the session_compact event fired in-process but no UI surface told
    // the user what just happened. A brief info notification on the
    // session_compact event itself makes the compaction visible
    // immediately. The widget's status line below also paints a
    // ⏳ compacting… chip while compactionGraceUntil is in the future
    // (see buildStatusText compaction check).
    try {
      ctx.ui.notify(`glla: session compacting — stall counter reset, grace timer started. The widget will show ⏳ compacting… for the next 3 minutes.`, "info");
    } catch {
      /* stale ctx best-effort */
    }
    // v0.34.82: a real compaction landed — clear the starvation refuse
    // gate. The agent_end yield path will resume deferring on the next
    // near-full length stop, and the heartbeat can refire again.
    onCompactionLanded();
    // v0.32.1: arm the resume debt + the resync block (the settle probes
    // below stay as the fast path; the heartbeat now retries the debt on
    // EVERY post-grace tick until agent_start discharges it).
    postCompactResumeOwed = true;
    postCompactResyncPending = true;
    scheduleSessionTimeout(() => {
      const c = freshCtx();
      if (!c) return;
      try {
        if (c.isIdle() && !c.hasPendingMessages() && !continuationTimerPending() && !loopTimerPending() && isSupervising() && !abortedStandDown) {
          appendLedger(c.cwd, "compaction_refire", {});
          if (isLoopActive()) scheduleLoopTick(c);
          else scheduleContinuation(c, true);
        }
      } catch {
        /* settle race — the 60s heartbeat covers it */
      }
    }, 2000);
    // v0.29.21: a SECOND settle at grace expiry. The 2s settle almost
    // always loses (pi is mid-compact / mid-resumed-turn then), and the
    // heartbeat's first post-grace tick lands up to one interval late —
    // meanwhile the continuation chain can dangle with ZERO rearm
    // attempts (field: hellhunter 2026-07-31 — auto-compact 04:31 at
    // 195.8k after two output-limit turns, zero rearms after the compact
    // event, recovery only at 04:34:48 via the post-grace heartbeat;
    // ~4 min that read as a stoppage). Refire the moment the grace ends.
    scheduleSessionTimeout(() => {
      const c = freshCtx();
      if (!c) return;
      try {
        if (c.isIdle() && !c.hasPendingMessages() && !continuationTimerPending() && !loopTimerPending() && isSupervising() && !abortedStandDown) {
          appendLedger(c.cwd, "compaction_grace_refire", {});
          if (isLoopActive()) scheduleLoopTick(c);
          else scheduleContinuation(c, true);
        }
      } catch {
        /* settle race — the 60s heartbeat covers it */
      }
    }, COMPACTION_GRACE_MS + 2_000);
  });

  pi.on("message_start", async (event: any, ctx: ExtensionContext) => {
    // v0.34.27: a replacement may first become visible on the user's next
    // message. Absorb it before the drafting-only handler can ignore it.
    rememberCtx(ctx);
    if (tryAbsorbHostSuccessor(ctx, "message_start")) return;
    if (sessionHandoffPending || extensionApiStale || staleTerminalDone || zombieStoodDown || isForeignCtx(ctx)) return;
    // v0.14.0 drafting floor: count real user replies while drafting. Our
    // own injected draft prompt arrives as a user message — skip that one.
    if (draftingTarget === null) return;
    if (event?.message?.role !== "user") return;
    if (draftingSeedInFlight) {
      draftingSeedInFlight = false;
      return;
    }
    draftingUserReplies++;
  });

  // v0.37.2: stale queued goal-event continuations (hidden display:false
  // custom messages) can survive goal archival via Pi's followUp queue.
  // Pi has no public clear queue API, so sanitize at delivery: replace
  // stale content before it is persisted or drives a turn.
  pi.on("message_end", async (event: any, ctx: ExtensionContext) => {
    const msg: any = event?.message;
    if (!msg || msg.role !== "custom" || msg.customType !== "goal-event") return;
    if (isForeignCtx(ctx)) return;
    let content = "";
    if (typeof msg.content === "string") content = msg.content;
    else if (Array.isArray(msg.content)) content = msg.content.map((c: any) => typeof c === "string" ? c : (c?.text ?? "")).join("\n");
    else if (msg.content != null) content = String(msg.content);
    const staleReason = __testOnlyClassifyStaleContinuation(content, ctx.cwd);
    if (!staleReason) return;
    const goalIdMatch = content.match(/\[GOAL CHECKPOINT goalId=([^\]\s]+)\]/);
    const loopMatch = content.match(/\[LOOP ITERATION (\d+)\]/);
    const sanitizedContent = `[GLLA: discarded stale continuation — ${staleReason}. No action required. Live state: ${state.goal ? `goal ${state.goal.id} (${state.goal.status})` : state.loop?.active ? `loop active iteration ${state.loop.iteration}` : "idle (no goal/loop)"}.]`;
    appendLedger(ctx.cwd, "stale_continuation_sanitized", {
      reason: staleReason,
      goalId: goalIdMatch?.[1],
      loopIteration: loopMatch?.[1],
      originalPreview: content.slice(0, 200),
    });
    const sanitized = {
      ...msg,
      content: sanitizedContent,
      display: false,
    };
    return { message: sanitized };
  });

  // v0.15.1: ask_user_question answers arrive as tool results, not chat
  // messages — count answered (non-cancelled) questionnaires as replies too.
  pi.on("tool_result", async (event: any, eventCtx: ExtensionContext) => {
    // v0.34.27: tool results are another valid first contact after a silent
    // host swap; absorb before stale/foreign filtering and never let a worker
    // session mutate the main loop's repetition/telemetry state.
    rememberCtx(eventCtx);
    if (tryAbsorbHostSuccessor(eventCtx, "tool_result")) return;
    if (sessionHandoffPending || extensionApiStale || staleTerminalDone || zombieStoodDown || isForeignCtx(eventCtx)) return;
    noteToolResult(event); // v0.33.0: slim widget "last action" feed
    // v0.24.0: roll loop tool-result fingerprints (same-tool-same-result
    // detection) — recorded for ANY tool result while a loop is active.
    if (isLoopActive()) {
      const loop = state.loop!;
      const out = event?.output ?? event?.result ?? event?.details ?? "";
      const text = typeof out === "string" ? out : JSON.stringify(out) ?? "";
      const tool = String(event?.toolName ?? "?");
      const inBandFailure = classifyInBandProviderFailure(text);
      loop.recentToolResults = pushRepetitionCapped(
        loop.recentToolResults ?? [],
        {
          tool,
          hash: textFingerprint(text),
          isError: Boolean(event?.isError ?? event?.error) || !!inBandFailure,
          ...(inBandFailure ? { providerFailure: true } : {}),
        },
        REPETITION.toolWindow,
      );
      // Successful transport is not proof of successful work: only a stable
      // repeated provider pane becomes a loop-level recovery signal. One-off
      // 503/429 text in a searched document remains ordinary tool output.
      // The explicit provider prompt-policy event is different: it is a
      // terminal signal on its first occurrence and must not be discarded as
      // an ordinary non-recoverable tool result.
      if (inBandFailure && (inBandFailure.nonRecoverableReason === "prompt-policy" || repeatedInBandProviderFailure(loop.recentToolResults))) {
        inBandProviderFailureRaw = text.slice(0, 800);
        appendLedger(eventCtx.cwd, "loop_in_band_provider_failure", {
          tool,
          kind: inBandFailure.kind,
          repeats: REPETITION.toolResultRepeat,
        });
      }
      // v0.25.1: file-write progress signal for the multi-signal stuck
      // gate — a loop that is WRITING files is shipping, not stuck.
      if (isLoopWriteTool(String(event?.toolName ?? ""))) {
        const metrics = loop.iterMetrics ?? { fileWrites: 0 };
        metrics.fileWrites++;
        loop.iterMetrics = metrics;
      }
    }
    // v0.25.2: per-goal tool telemetry (/glla stats premature detection).
    if (state.goal && state.goal.status === "active") {
      const toolName = String(event?.toolName ?? "");
      if (isLoopWriteTool(toolName) || toolName === "bash") {
        const t = state.goal.telemetry ?? { turns: 0, fileWrites: 0, bashCalls: 0 };
        if (isLoopWriteTool(toolName)) t.fileWrites++;
        if (toolName === "bash") t.bashCalls++;
        state.goal.telemetry = t;
      }
    }
    // A failed subagent result is surfaced as a generic provider/runtime
    // failure. Recovery deliberately does not inspect status or quota
    // wording before deciding what to do.
    if (isSubagentProviderFailure(String(event?.toolName ?? ""), Boolean(event?.isError ?? event?.error), event?.output ?? event?.result ?? event?.details ?? "")) {
      const errText = typeof (event?.output ?? event?.result) === "string" ? (event?.output ?? event?.result) : JSON.stringify(event?.output ?? event?.result ?? event?.details ?? "");
      const current = currentToolContext(eventCtx);
      if (current) {
        appendLedger(current.cwd, "subagent_provider_error", { error: String(errText).slice(0, 200) });
        current.ui.notify(
          "Subagent provider/runtime error. Retry the subagent, choose a configured model if needed, or do the work inline; the continuation path does not classify quota state.",
          "warning",
        );
      }
    }
    if (draftingTarget === null) return;
    if (askUserQuestionAnswered(String(event?.toolName ?? ""), event?.details)) {
      draftingUserReplies++;
    }
  });

  pi.on("session_shutdown", async (event: any, ctx: ExtensionContext) => {
    if (isForeignCtx(ctx)) return;
    releaseSubagentRpcHost(pi.events);
    // v0.30.0: attribution + rebind window. pi announces WHY the session
    // is being replaced (reload/resume/new/fork/quit) — the ledger can
    // now answer "what killed the handle?" without guesswork (hegemon's
    // 5-hour orphan silence 2026-07-31 was unattributable). The window
    // tells the stale probe that a rebind (session_start) is imminent.
    const shutdownReason = typeof event?.reason === "string" ? event.reason : "unknown";
    if (state.goal?.status === "auditing" && state.goal.pendingCompletion) {
      const oldAttemptId = state.goal.pendingCompletion.attemptId;
      markCompletionAuditRecoveryPending(ctx, `session_shutdown:${shutdownReason}`);
      if (oldAttemptId && cancelDetachedGoalCompletionAuditor(ctx.cwd, oldAttemptId)) {
        appendLedger(ctx.cwd, "audit_worker_cancelled", { goalId: state.goal.id, attemptId: oldAttemptId, reason: shutdownReason });
      }
      completionAuditRecoveryArmed = false;
    }
    // A user quit is explicit stop consent. Do not let a scheduled
    // infrastructure retry silently resume on a later cold startup; the
    // claim remains durable and /goal|/list resume is still available.
    if (
      shutdownReason.trim().toLowerCase() === "quit"
      && state.goal?.status === "paused"
      && state.goal.pendingCompletion?.phase === "recovery-pending"
      && state.goal.pendingCompletion.recoveryRetryAt
    ) {
      const pending = { ...state.goal.pendingCompletion, recoveryRetryAt: undefined };
      updateGoal({
        pendingCompletion: pending,
        pauseKind: "blocked",
        pauseResumeAt: undefined,
        pauseSuggestedAction: `The automatic auditor retry was stopped by quit. ${activeGoalSurfaceCommand("resume")} retries the stored claim explicitly.`,
      }, ctx);
      appendLedger(ctx.cwd, "audit_recovery_retry_suppressed", {
        goalId: state.goal.id,
        attemptId: pending.attemptId,
        reason: "quit",
      });
    }
    appendLedger(ctx.cwd, "session_shutdown", { reason: shutdownReason });
    clearInBandProviderFailure();
    markSessionOwnerShutdown(ctx.cwd, shutdownReason);
    writeSessionHandoff(ctx, shutdownReason);
    sessionReplacementUntil = Date.now() + SESSION_REBIND_GRACE_MS;
    clearDraftingState();
    clearSessionOwnedTimers();
    toolsRegistered = false;
    toolHealNotified = false;
  });

  pi.on("session_start", async (event: any, ctx: ExtensionContext) => {
    // A child session can bind this extension before or after the MAIN host.
    // Reject it before root registration, restore, owner-file writes, or tool
    // repair; otherwise an owner-null first child can claim the plane.
    if (isWorkerSessionCtx(ctx)) return;
    // v0.23.8: subagent sessions (pi-subagents binds extensions there too)
    // are workers — never run the restore gate or reschedule the loop from
    // a foreign session. Host replacement events are the exception: pi can
    // deliver /new, /resume, /fork, or /reload with a new SessionManager and
    // no session_shutdown, so rejecting them here would permanently lose the
    // only fresh context that can rebind the loop (v0.34.23).
    // v0.34.27: a real file-backed successor can report plain `startup`
    // after pi invalidated the old handle. Recognize that contact before the
    // foreign-session gate; in-memory subagent startup remains refused.
    const hostSuccessorStart = isHostSuccessorContact(ctx);
    const lifecycleSignal = isHostLifecycleSessionStart(event);
    const sameOwnerStart = ownerSession !== null && ctx.sessionManager === ownerSession;
    // A lifecycle reason is evidence from pi, not proof that an arbitrary
    // in-memory SessionManager is the MAIN host. New managers must still be
    // file-backed (the pi host shape); subagent workers remain refused even
    // if they manufacture a reload/resume-looking event.
    const hostLifecycleStart = hostSuccessorStart || sameOwnerStart || (lifecycleSignal && isHostSuccessorCtx(ctx));
    // `ownerSession` is intentionally nulled at a stale/shutdown terminal,
    // so isForeignCtx() alone cannot protect the parked plane. Compare with
    // the retained dead owner too: an in-memory subagent startup must not
    // consume the recovery event and erase the host's successor proof.
    const recordedOwner = ownerSession ?? deadOwnerSession;
    const foreignRecordedSession = recordedOwner !== null && ctx.sessionManager !== recordedOwner;
    // v0.34.63: quit → fresh pi → blank startup (load barrier pending) →
    // resume. pi delivers the resumed session with a NEW SessionManager
    // object, so identity (and possibly file-backed) checks fail and the
    // resume was silently DROPPED — the goal stayed parked forever with a
    // dead countdown (dracon-platform 2026-08-07: wall at 01:18, probe at
    // 01:33 never ran). While this process is waiting on the load barrier,
    // a lifecycle start from the same workspace carrying the same session
    // identity IS that load completing — accept it before the gate.
    const barrierAwaitingLoadedSession = initialSessionLoadPending && lifecycleSignal;
    const resumeCompletesLoad = barrierAwaitingLoadedSession
      && (ownerCwd == null || ctx.cwd === ownerCwd)
      && sameSessionIdentity(ctx.sessionManager, recordedOwner);
    if (foreignRecordedSession && !hostLifecycleStart && !resumeCompletesLoad) return;
    // v0.35.58: register the admitted host root before any lifecycle,
    // ownership, or restore ledger write. In-memory worker managers have no
    // directory and therefore remain pending rather than falling back to cwd.
    setRuntimeSessionDirFromSessionManager(ctx.sessionManager);
    // v0.38.12 (last-wins sessions): a newer MAIN host does not queue
    // behind the previous session — it takes the root and the old session
    // stands down to read-only on its next recheck. Workers keep the old
    // refusal: a subagent must never dethrone the main session it serves.
    let ownsRoot = claimProcessOwner(ctx.cwd);
    if (!ownsRoot && hostLifecycleStart) {
      const supersede = supersedeLiveOwnerRoot(ctx.cwd, { isMainHost: true, bySession: sessionManagerId(ctx) });
      ownsRoot = supersede !== "refused";
      if (supersede === "stolen") {
        ctx.ui.notify("glla: this fresh session took over the state root — the previous live session is now read-only. Your new objective is the real one; the old session's disk state is preserved.", "warning");
      }
    }
    if (!ownsRoot) {
      processOwnerDeniedCwd = ctx.cwd;
      ctx.ui.notify("glla: this session could not own the working-directory state root (a worker contact, or an unresolved sessionDir) — it is read-only to prevent competing goal/loop writes. /glla owner inspects the holder; /glla takeover resolves it with confirmation.", "warning");
      return;
    }
    processOwnerDeniedCwd = null;
    // v0.34.73 (OPEN-ISSUES 1.12): capture the pre-rebind invalidation flags
    // BEFORE the block below clears them — the id_invalidation reason needs
    // to know which mechanism invalidated the old handle.
    const invalidationFlags = {
      staleTerminal: staleTerminalDone,
      zombieStoodDown,
      extensionApiStale,
      rebindWithoutShutdown: hostLifecycleStart && ownerSession !== null && ctx.sessionManager !== ownerSession,
    };
    if (hostLifecycleStart && ownerSession !== null && ctx.sessionManager !== ownerSession) {
      // No shutdown means the old timers were not cleared by pi. Clear them
      // before claiming the replacement, then reopen the handoff gate below.
      clearSessionOwnedTimers();
      sessionHandoffPending = false;
      appendLedger(ctx.cwd, "session_rebind_without_shutdown", {
        reason: typeof event?.reason === "string" ? event.reason : "unknown",
      });
    }
    extensionApi = pi;
    // Session-scoped resources are reset only after this context has passed
    // the host-admission gate; child factories never touch host state.
    resetLengthContinue();
    sessionHandoffPending = false;
    // Reset terminal ownership before rememberCtx: this is the only event
    // allowed to bind a context after a stale/shutdown handoff.
    staleTerminalDone = false; // v0.33.1: a rebound session can go terminal again
    zombieStoodDown = false;
    deadOwnerSession = null; // v0.34.25: a real session_start supersedes the silent-swap record
    deadOwnerCwd = null;
    sessionGeneration++;
    // A fresh host owns a fresh activity era even when pi skipped
    // session_shutdown. Old tool starts are not evidence for this session.
    clearToolActivityState();
    bindSubagentRpcHost(pi.events, sessionGeneration);
    clearDraftingState();
    // An auditor belonging to the disposed generation cannot block the fresh
    // session's recovery gate; its finally block is generation-guarded too.
    completionAuditInFlight = false;
    completionAuditGeneration = null;
    completionAuditRecoveryArmed = false;
    latestAuditProgress = null;
    streamActivityObserved = false;
    // Ephemeral watchdog counters belong to the old session, not the
    // persisted goal. Reset them so a stale boundary cannot make the next
    // fresh session inherit a false stall count.
    heartbeatNudges = 0;
    consecutiveStalls = 0;
    heartbeatStaleStreak = 0;
    const startReason = typeof event?.reason === "string" ? event.reason : "unknown";
    initialSessionLoadPending = isBlankInitialStartup(ctx, startReason);
    rememberCtx(ctx);
    clearInBandProviderFailure();
    startHeartbeat();
    startUITicker();
    // v0.30.0: rebind bookkeeping — claim ownership, close any replacement
    // window, and reset a stale flag left over from the PREVIOUS session's
    // invalidation. pi rebinds THIS module to the new session (switch) or
    // re-imports it (/reload — fresh module, flag already false); either
    // way the fresh ctx makes the old poison flag wrong. Re-probe to
    // confirm the new handle actually works.
    writeOwnerFile(ctx.cwd);
    sessionReplacementUntil = 0;
    postCompactResumeOwed = false; // v0.33.1: a compact from a previous session must not resync THIS one
    postCompactResyncPending = false;
    appendLedger(ctx.cwd, "session_rebound", { reason: startReason });
    if (extensionApiStale) {
      extensionApiStale = false; // fresh ctx delivered — re-probe
      const stillStale = probeExtensionApiStale();
      appendLedger(ctx.cwd, "stale_flag_reset_on_rebind", { reason: startReason, stillStale });
      if (stillStale) {
        ctx.ui.notify("glla: session rebound but the extension handle is still stale — waiting for another fresh session_start; restart pi normally only if no replacement arrives, then /glla resume.", "warning");
      }
    }
    replaceState(readState(ctx.cwd));
    // v0.36.1: finish a terminal archive whose owner died between archive
    // publication, state persistence, and active-md cleanup. readState has
    // already overlaid the journal's terminal projection, so this boundary
    // only needs to land it and then remove the old projection. If the archive
    // was never published, the prepared intent is safe to discard and the
    // normal archive command can retry from the still-live goal.
    const archiveRecovery = readArchiveIntent(ctx.cwd);
    if (archiveRecovery) {
      if (fs.existsSync(archiveRecovery.archivePath)) {
        if (state.goal?.id === archiveRecovery.goalId && (state.goal.status === "complete" || state.goal.status === "aborted")) {
          if (persistState(ctx) && finalizeArchiveIntent(ctx.cwd, archiveRecovery.goalId)) {
            appendLedger(ctx.cwd, "archive_recovered", { goalId: archiveRecovery.goalId, phase: archiveRecovery.phase, via: "session-start" });
            ctx.ui.notify(`glla: recovered terminal archive for ${archiveRecovery.goalId} after an interrupted cleanup.`, "info");
          } else {
            ctx.ui.notify(`glla: terminal archive ${archiveRecovery.goalId} is durable but cleanup is still pending; persistence will retry at the next lifecycle boundary.`, "warning");
          }
        } else if (archiveRecovery.phase !== "prepared" && state.goal?.id !== archiveRecovery.goalId) {
          // A successor state proves the terminal snapshot was followed by a
          // different live objective. Finish only the old archive's cleanup;
          // never let a stale one-record journal block every later archive.
          if (finalizeArchiveIntent(ctx.cwd, archiveRecovery.goalId)) {
            appendLedger(ctx.cwd, "archive_recovered", { goalId: archiveRecovery.goalId, phase: archiveRecovery.phase, via: "successor-state" });
          } else {
            ctx.ui.notify(`glla: prior terminal archive ${archiveRecovery.goalId} is durable but its old active projection is still present; cleanup will retry safely.`, "warning");
          }
        }
      } else {
        clearArchiveIntent(ctx.cwd);
      }
    }
    // v0.35.21 (list-invisible-until-restart): the durable queue is the
    // UNION of the persisted state and the per-item .queue.json sidecars
    // (v0.34.60 disk-first writes). readState replays only the state
    // ledger, so a plugin re-init / stale-handle window that reset RAM to
    // defaults used to leave the sidebar queue blank — active item only,
    // no "N waiting · up next" line — until a full restart re-ran the
    // disk merge on some other path. Converge memory to the union at EVERY
    // lifecycle restore so the rendered surface is truthful immediately.
    const hydratedFromDisk = hydrateListQueueFromDisk(ctx);
    if (hydratedFromDisk > 0) {
      ctx.ui.notify(`glla: restored ${hydratedFromDisk} queued list item(s) from durable sidecars.`, "info");
    }
    // v0.35.x: a fresh session_start is the coalesced recovery boundary for
    // a silent host death. Consume the one-shot arm after durable state is
    // reloaded so the marker is cleared in the new context, and let the
    // active-goal restore gate below schedule the continuation.
    const staleRearmedOnSessionStart = !initialSessionLoadPending
      && consumeStaleContinuationRearm(ctx, "session_start");
    if (staleRearmedOnSessionStart) {
      appendLedger(ctx.cwd, "stale_continuation_rearm_contact", { via: "session_start" });
    }
    // v0.34.68 (bug 1.7): heal a corrupted in-memory policy BEFORE the
    // restore gate below persists state — otherwise the hold/auto-resume
    // would rewrite the durable goal .md with the corrupted policy and
    // destroy the only source the gate heal can re-parse.
    healGoalPolicy(ctx);
    clearMainModelRecoveryTimer();
    mainModelAbortForRecovery = false;
    lastMainModelFailure = null;
    setContinuationDispatchStoodDownRef(false);
    clearContinuationStartWatchdog();
    const recoveredDispatch = readDispatchRecord(ctx.cwd);
    if (recoveredDispatch) {
      appendLedger(ctx.cwd, "continuation_dispatch_recovered", {
        id: recoveredDispatch.id,
        phase: recoveredDispatch.phase,
        kind: recoveredDispatch.kind,
        generation: recoveredDispatch.generation,
      });
      clearDispatchRecord(ctx.cwd);
    } else if (fs.existsSync(dispatchRecordPath(ctx.cwd))) {
      appendLedger(ctx.cwd, "continuation_dispatch_invalid", {});
      clearDispatchRecord(ctx.cwd);
    }
    // v0.28.14: snapshot carryover BEFORE any restore logic mutates state —
    // a paused goal, waiting list items, or a loop that was live/held when
    // the last session ended. Resolved once at the first NEW activation.
    carryoverSnapshot = {
      pausedGoal: state.goal && state.goal.status === "paused" ? state.goal.objective.slice(0, 60) : undefined,
      pausedGoalPolicy: state.goal && state.goal.status === "paused" ? state.goal.policy : undefined,
      listCount: listQueue().length,
      heldLoop: state.loop && (state.loop.active || state.loop.stopReason === HELD_ON_RESTORE) ? state.loop.target.slice(0, 60) : undefined,
    };
    carryoverResolved = !(carryoverSnapshot.pausedGoal || carryoverSnapshot.listCount > 0 || carryoverSnapshot.heldLoop);
    ensureAgentToolsReady(ctx);
    warnOnCommandCollision(ctx);
    warnIfAuditorProviderRisky(ctx);
    // Sync current pi-subagents role overrides with settings. Idempotent;
    // applies to NEW sessions (the companion registers its agents at start).
    // v0.34.115: when subagentFallbacks[name] is set for an agent, the
    // first eligible ref in the chain is written as the override model; the
    // per-type pin (s.subagentModelOverrides[name]) still wins when the
    // chain is empty (legacy behavior unchanged).
    try {
      const s = loadSettings(ctx.cwd);
      const isForbidden = (ref: string) => isForbiddenModel(ref, s.forbiddenModels);
      const resolve = (ref: string): unknown => {
        const parts = (() => { const idx = ref.indexOf("/"); return idx > 0 ? { provider: ref.slice(0, idx), id: ref.slice(idx + 1) } : undefined; })();
        if (!parts) return undefined;
        try { return (ctx.modelRegistry as any)?.find?.(parts.provider, parts.id); } catch { return undefined; }
      };
      const fallbackOverrides: Record<string, string> = {};
      if (s.subagentFallbacks) {
        for (const [name, chain] of Object.entries(s.subagentFallbacks)) {
          const picked = resolveSubagentOverrideRef(name, chain, resolve, isForbidden);
          if (picked) fallbackOverrides[name] = picked;
        }
      }
      const mergedOverrides = { ...(s.subagentModelOverrides ?? {}), ...fallbackOverrides };
      const sync = syncSubagentModelOverrides({
        agentDir: defaultAgentDir(),
        strategy: s.subagentModelStrategy ?? "inherit-parent",
        overrides: mergedOverrides,
      });
      for (const skip of sync.skipped) {
        const overrideFailureCopy = providerErrorPresentation(skip.reason, "recovery");
        ctx.ui.notify(`glla subagent override skipped [${skip.name}]: ${overrideFailureCopy.display}`, "warning");
      }
      // v0.25.6: notify-with-repair — a managed override that went missing
      // or was altered externally (pi update, manual edit, sync churn) is
      // re-written AND surfaced, not silently restored.
      if (sync.repaired.length > 0) {
        ctx.ui.notify(
          `glla repaired managed subagent override(s): ${sync.repaired.join(", ")} — the file(s) were missing or altered externally; re-written per your subagent settings.`,
          "warning",
        );
      }
    } catch (err) {
      ctx.ui.notify(`glla subagent override sync failed: ${err instanceof Error ? err.message : String(err)}`, "warning");
    }
    // Consume ownership markers before the startup barrier so a later loaded
    // session cannot mistake this placeholder runtime for a rebind. The
    // owner sidecar carries the predecessor generation and identity that the
    // handoff must match; a proper shutdown never gets the looser same-pid
    // rebind consent on its own.
    const recoveryResume = consumeRecoveryResume(ctx.cwd);
    const ownerClaim = claimSessionOwnerAndDetectRebind(ctx.cwd, sessionGeneration, sessionManagerId(ctx));
    sessionGeneration = ownerClaim.generation;
    // v0.34.73 (OPEN-ISSUES 1.12): forced rewrite/handoff — the previous
    // owner recorded a different session id in the owner sidecar (or the
    // recorded in-memory owner was invalidated). Record the old/new id pair
    // and the mechanism so active.jsonl history can repro the invalidation.
    const oldOwnerId = ownerClaim.previousOwnerSessionId ?? (recordedOwner ? sessionIdOf(recordedOwner) : null);
    emitIdInvalidation(ctx, oldOwnerId, sessionManagerId(ctx), classifyIdInvalidationReason({
      staleTerminal: invalidationFlags.staleTerminal,
      zombieStoodDown: invalidationFlags.zombieStoodDown,
      extensionApiStale: invalidationFlags.extensionApiStale,
      rebindWithoutShutdown: invalidationFlags.rebindWithoutShutdown,
      hadShutdown: ownerClaim.hadShutdown,
      previousPid: ownerClaim.previousPid,
    }), ownerClaim.previousShutdownReason);
    // A pending list journal may use the looser owner-shutdown fallback only
    // when the primary handoff marker is genuinely absent. If a marker is
    // present but malformed/foreign/mismatched, its rejection is authoritative
    // and the journal must be discarded rather than replayed via hadShutdown.
    const handoffMarkerPresent = fs.existsSync(sessionHandoffPath(ctx.cwd));
    const handoffResume = consumeSessionHandoff(ctx.cwd, ownerClaim.previousGeneration, ownerClaim.previousOwnerSessionId);
    if (handoffResume) appendLedger(ctx.cwd, "session_handoff_resumed", { pid: process.pid, reason: startReason });
    const nonQuitShutdownResume = ownerClaim.hadShutdown && ownerClaim.previousShutdownReason?.trim().toLowerCase() !== "quit";
    const listOperationLifecycleResume = handoffResume
      || (!handoffMarkerPresent && nonQuitShutdownResume);
    const pendingListOperations = listOperationLifecycleResume
      ? consumePendingListOperations(ctx.cwd, ownerClaim.previousGeneration, ownerClaim.previousOwnerSessionId)
      : (discardPendingListOperations(ctx.cwd, handoffMarkerPresent ? "handoff-rejected" : "handoff-not-resumed"), [] as string[]);
    const rebindResume = ownerClaim.rebind;
    if (rebindResume) appendLedger(ctx.cwd, "rebind_resume", { pid: process.pid });
    const explicitRecovery = handoffResume || recoveryResume || rebindResume;
    // v0.35.23 (note.md Next #2): a non-quit shutdown successor no longer
    // consents to loop auto-resume by itself — a crash restart IS a cold
    // load, and cold loads hold for an explicit decision. The SAME-PROCESS
    // successor case stays consented: pi replaced its session without dying
    // (the /reload family), so the held work is mid-flight continuity, not
    // a cold start. Different-pid successors hold like any cold load.
    const sameProcessSuccessorResume = nonQuitShutdownResume && ownerClaim.previousPid === process.pid;
    // v0.35.50 (note.md Now #2): MAIN-thread consent for the same-process
    // successor corner — shutdown recorded + same pid AND no contradicting
    // handoff evidence. A PRESENT handoff marker is authoritative even when
    // mismatched (v0.34.49 one-shot identity law: rejection holds); only an
    // ABSENT marker with a same-pid non-quit shutdown is mid-flight
    // continuity — the same distinction listOperationLifecycleResume already
    // draws. This closes the asymmetry where the loop branch (v0.35.23)
    // resumed on sameProcessSuccessorResume while a plain goal held
    // ("list keeps going, goal awaits first turn"). Different-pid crash
    // successors and cold loads still hold for an explicit decision.
    const sameProcessContinuityResume = sameProcessSuccessorResume && !handoffMarkerPresent;
    const heldLoopSuccessorResume = !!state.loop
      && !state.loop.active
      && isLifecycleHeldLoopReason(state.loop.stopReason)
      && nonQuitShutdownResume;
    // Close terminal slots before the blank-start barrier as well. A blank
    // startup is still a real state load, and returning before this cleanup
    // used to leave legacy `complete`/`aborted` cards visible until a second
    // lifecycle event.
    if (state.goal && (state.goal.status === "complete" || state.goal.status === "aborted") && fs.existsSync(archivedGoalPath(ctx.cwd, state.goal.id))) {
      const terminal = state.goal;
      replaceState({ ...state, goal: null });
      persistState(ctx);
      appendLedger(ctx.cwd, "terminal_goal_slot_closed", { goalId: terminal.id, status: terminal.status, via: "session-start" });
    }
    if (initialSessionLoadPending && !explicitRecovery && !heldLoopSuccessorResume) {
      // The objective/status projection remains visible below, but the
      // previous auditor report must not become fresh model/UI context before
      // this session has granted continuation consent.
      suppressAuditorSurfaceAfterColdRestore();
      // Even a blank startup must not leave a stored completion claim in the
      // old AUDITING state: there is no worker verdict to wait for after a
      // session boundary. Release it before the transcript-load barrier;
      // the later explicit /goal resume can retry from the durable claim.
      if (state.goal?.status === "auditing" && state.goal.pendingCompletion) {
        markCompletionAuditRecoveryPending(ctx, "session_start:blank-load");
        ctx.ui.notify(`Completion audit blocked — no verdict. The claim is safe; load the session, then ${activeGoalSurfaceCommand("resume")} to retry.`, "warning");
      }
      appendLedger(ctx.cwd, "session_waiting_for_load", { reason: startReason });
      // The blank startup barrier must defer continuation, not the durable
      // status surface. Paint the state we just rehydrated before returning so
      // a freshly restarted session does not look nonexistent while pi loads
      // its transcript; the later loaded session_start will repaint it.
      refreshUI(ctx, true);
      ctx.ui.notify(`glla: pi has not loaded a conversation yet — waiting before auto-resume. Load/resume the session, or explicitly run ${activeGoalSurfaceCommand("resume")} or /loop start.`, "info");
      return;
    }
    // An explicit lifecycle handoff/rebind is continuation consent even if
    // pi reported a blank startup context. Release the barrier before any
    // scheduling path below can observe it.
    initialSessionLoadPending = false;
    // v0.29.6: stacked-state auto-arbitration FIRST — one live artifact
    // survives before the restore gate decides hold-vs-resume for it.
    autoArbitrateStackedState(ctx);
    // Restore gate (v0.26.9 tri-state): a human LOADING a session
    // ("startup"/"new"/"resume", or no reason) HOLDS — the popup shows what
    // is waiting and nothing starts until they resume explicitly. In-session
    // machinery ("reload"/"fork") auto-resumes. Enable Auto-resume in
    // /glla settings to opt into startup auto-resume.
    // into auto-resume everywhere (unattended rigs); autoresume=off never
    // auto-resumes. v0.29.5: the setting is GLOBAL-only — project-level
    // autoResume keys are ignored. Once running, the chain auto-continues
    // forever unless a super-stuck brake (stall escalation / stale-api /
    // latch) stops it loudly.
    // v0.35.23 (note.md Next #2): auto-resume consent is now the RAW global
    // setting, not the aggressive-mode coercion. resolveEffectiveAggressive
    // Settings coerced unset→true (aggressiveMode defaults on), which made
    // stock installs AUTO-RESUME everything on every load — defeating the
    // documented v0.28.21 tri-state whose undefined default is HOLD, and
    // the pinned settings-menu copy ("default: hold on EVERY load"). The
    // aggressive dial still owns its caps; only explicit `autoResume: true`
    // consents to load-time automation now.
    // autoResume is an explicit global consent, not an aggressive-mode
    // fallback. Keep cold restore hold-first even though aggressiveMode owns
    // the other keep-going defaults; only autoResume:true releases it.
    const autoResumeSetting = loadGlobalSettings().autoResume;
    const autoResume = shouldAutoResumeOnSessionStart(event?.reason, autoResumeSetting);
    // Consent is established by the same lifecycle paths that are allowed to
    // resume work. Do not release merely because a scheduler was asked to
    // run; rejected/held schedules must leave the old report suppressed.
    const continuationConsent = autoResume
      || explicitRecovery
      || staleRearmedOnSessionStart
      || sameProcessSuccessorResume
      || heldLoopSuccessorResume;
    if (continuationConsent) releaseAuditorSurface();
    else suppressAuditorSurfaceAfterColdRestore();
    const mainRecovery = state.mainModelRecovery;
    if (mainRecovery?.manualResumeRequired) {
      const recoveryResumeCmd = recoverySurfaceCommand(mainRecovery.kind, "resume");
      ctx.ui.notify(`Main-model recovery stopped automatic probes — the work is safe; ${recoveryResumeCmd} starts a fresh bounded window after you check the provider.`, "warning");
    } else if (mainRecovery?.retryAt || mainRecovery?.pendingModelSwitch) {
      const retryAtMs = mainRecovery.retryAt ? Date.parse(mainRecovery.retryAt) : Number.NaN;
      const recoveryConsent = autoResume || explicitRecovery;
      if (recoveryConsent) {
        const delay = Number.isFinite(retryAtMs) ? Math.max(0, retryAtMs - Date.now()) : 0;
        ctx.ui.notify(`Restored main-model recovery (${mainRecovery.kind}) — ${mainRecovery.pendingModelSwitch ? `reconciling ${mainRecovery.pendingModelSwitch}` : delay > 0 ? `next probe in ${Math.max(1, Math.ceil(delay / 60_000))}m` : "probe is due now"}.`, "info");
        if (delay > 0) scheduleMainModelRecoveryTimer(ctx, delay);
        else void probeMainModelRecovery(ctx);
        // v0.34.92: re-arm the hourly probe ticker on session_start if the
        // session is still parked — the timer died with the old session.
        scheduleHourlyProbe(ctx);
      } else {
        const recoveryResumeCmd = recoverySurfaceCommand(mainRecovery.kind, "resume");
        ctx.ui.notify(`Main-model recovery is waiting with the work safe — ${recoveryResumeCmd} retries the provider, or enable Auto-resume in /glla settings.`, "info");
      }
    } else if (mainRecovery && (mainRecovery.primaryProbeAt || mainRecovery.primaryProbeInFlight)) {
      const recoveryConsent = autoResume || explicitRecovery;
      const recoveryResumeCmd = recoverySurfaceCommand(mainRecovery.kind, "resume");
      if (recoveryConsent) {
        if (mainRecovery.primaryProbeInFlight) {
          ctx.ui.notify(`Restored preferred-primary failback — the primary is selected and needs one supervised probe.`, "info");
          void probeMainModelRecovery(ctx);
        } else {
          const probeAtMs = mainRecovery.primaryProbeAt ? Date.parse(mainRecovery.primaryProbeAt) : Number.NaN;
          const delay = Number.isFinite(probeAtMs) ? Math.max(0, probeAtMs - Date.now()) : 0;
          ctx.ui.notify(`Restored preferred-primary failback — next probe ${delay > 0 ? `in ${Math.max(1, Math.ceil(delay / 60_000))}m` : "is due now"}.`, "info");
          scheduleMainModelRecoveryTimer(ctx, delay);
        }
      } else {
        ctx.ui.notify(`Preferred-primary failback is waiting with the fallback serving — ${recoveryResumeCmd} probes the primary, or enable Auto-resume in /glla settings.`, "info");
      }
    }
    // Stored completion-auditor retry waits are also durable. The old timer
    // dies with the session, so a reload must restore only the same bounded
    // probe when auto-resume/rebind consent exists; otherwise the claim waits
    // for an explicit /goal resume.
    const retryClaim = state.goal?.pendingCompletion;
    if (state.goal?.status === "paused" && retryClaim?.phase === "retry-waiting" && state.goal.pauseKind === "wait" && state.goal.pauseResumeAt) {
      const retryConsent = autoResume || explicitRecovery;
      const retryResumeCmd = activeGoalSurfaceCommand("resume");
      const retryAtMs = Date.parse(state.goal.pauseResumeAt);
      if (retryConsent) {
        const delay = Number.isFinite(retryAtMs) ? Math.max(0, retryAtMs - Date.now()) : 0;
        if (delay > 0) {
          const failureCopy = providerErrorPresentation(state.goal.pauseReason ?? "auditor retry", "completion");
          const recoveryEpisodeKey = retryClaim.recoveryEpisodeKey ?? `${retryClaim.at}:${failureCopy.fingerprint}`;
          const pending = {
            ...retryClaim,
            providerErrorDiagnostic: retryClaim.providerErrorDiagnostic ?? (failureCopy.sensitive ? failureCopy.diagnostic : undefined),
            recoveryEpisodeKey,
            recoveryNoticeKeys: retryClaim.recoveryNoticeKeys ?? [],
          };
          const notifyRetry = claimRecoveryNotice(pending, `${recoveryEpisodeKey}:retry-wait`);
          updateGoal({ pendingCompletion: pending, providerErrorDiagnostic: pending.providerErrorDiagnostic, recoveryEpisodeKey, recoveryNoticeKeys: pending.recoveryNoticeKeys }, ctx);
          scheduleProviderRetryForSession(ctx, delay / 1_000, state.goal.pauseReason ?? "auditor retry", () => {
            if (state.goal?.status === "paused" && state.goal.pendingCompletion?.phase === "retry-waiting") void retryStoredCompletionAudit("session-recovery");
          }, undefined, {
            episodeKey: recoveryEpisodeKey,
            noticeKey: `${recoveryEpisodeKey}:retry-wait`,
            suppressNotice: !notifyRetry,
          });
        } else {
          void retryStoredCompletionAudit("session-recovery");
        }
      } else {
        ctx.ui.notify(`Stored completion claim is waiting on an auditor provider retry — ${retryResumeCmd} retries it, or enable Auto-resume in /glla settings.`, "info");
      }
    }
    // v0.25.0 (contract item 6): aggressiveMode announces every auto-event.
    if (
      autoResume &&
      resolveEffectiveAggressiveSettings(loadSettings(ctx.cwd)).aggressiveMode &&
      (isLoopActive() || (state.goal && state.goal.status === "active") || listQueue().length > 0)
    ) {
      ctx.ui.notify("Auto-resume fired (event: session start). Continue working.", "info");
    }
    // v0.29.11: loops stopped by the stale-handle terminal or the stall
    // escalation told the user "restart pi, then /loop start" — but a
    // fresh start discards iteration/best/history. Hold them on load like
    // any restore-held loop: /loop resume continues from the saved state.
    if (state.loop && !state.loop.active && isLifecycleHeldLoopReason(state.loop.stopReason)
        && state.loop.stopReason !== HELD_ON_RESTORE) {
      appendLedger(ctx.cwd, "loop_held_for_resume", { was: (state.loop.stopReason ?? "").slice(0, 40) });
      state.loop = { ...state.loop, stopReason: HELD_ON_RESTORE };
      persistState(ctx);
    }
    // Lifecycle/provider holds resume from the durable loop object without
    // resetting metric, bounds, history, iteration, or progress counters.
    // Deliberate `/loop stop`/`cancel`, provider/manual safety stops, plateau,
    // stuck, and zero-stream abort reasons are intentionally excluded by the
    // shared predicate and remain explicitly resumable only.
    if (state.loop && !state.loop.active && isLifecycleHeldLoopReason(state.loop.stopReason)
        && (autoResume || explicitRecovery || sameProcessSuccessorResume)) {
      const held = state.loop;
      state.loop = { ...held, active: true, stopReason: undefined };
      persistState(ctx);
      releaseContinuationDispatchStandDown();
      appendLedger(ctx.cwd, "loop_auto_resumed_on_restore", {
        via: recoveryResume ? "recovery" : rebindResume ? "rebind" : handoffResume ? "handoff" : sameProcessSuccessorResume ? "same-process-successor" : "auto-resume",
        iteration: held.iteration,
        best: held.bestValue,
      });
      ctx.ui.notify(
        `Resuming held loop (iteration ${held.iteration}/${held.maxIterations > 0 ? held.maxIterations : "∞"}, best ${held.bestValue ?? "n/a"}): ${displaySlice(held.target, 60)}`,
        "info",
      );
    }
    // v0.29.14: migrate live/held audit loops off the open-count/min
    // metric — it punished DISCOVERY (11 new real findings read as a
    // regression; iter 27→38→37 nearly plateau-stopped mid-work). Flip to
    // closed-count/max, null the pinned best (the next closed-count
    // measure becomes the honest baseline), reset the stall streak. This
    // supersedes the v0.29.10 baseline-0 reseed (every old-measure loop
    // gets nulled here).
    if (state.loop && state.loop.measureCmd?.includes("audit-loop/findings.md") && state.loop.measureCmd?.includes("\\[ \\]")
      && state.loop.direction !== "max") {
      state.loop = { ...state.loop, measureCmd: auditMeasureCmd(), direction: "max", bestValue: null, stallCount: 0, kind: state.loop.kind ?? "audit" };
      persistState(ctx);
      appendLedger(ctx.cwd, "audit_loop_metric_migrated", { from: "open-count/min", to: "closed-count/max" });
    }
    // v0.29.18: migrate live/held audit loops to the FIX-FIRST target —
    // the audit-every-iteration template made discovery (8-12/iter)
    // outpace fixes (1/iter) and allowed "no new action" iterations with
    // open boxes (field: hegemon iter 26 — the user watched it find and
    // present instead of fix). Target-only swap: the metric (closed
    // count/max) is unchanged, so best/stall stay.
    if (state.loop?.kind === "audit" && state.loop.target?.includes("Every iteration: (1) run a FRESH audit pass")) {
      state.loop = { ...state.loop, target: auditTarget() };
      persistState(ctx);
      appendLedger(ctx.cwd, "audit_loop_target_migrated", { from: "audit-every-iteration", to: "fix-first" });
    }
    // v0.34.15 compatibility: the legacy recovery marker and v0.34.16
    // rebind marker were consumed before the startup barrier above.
    if (isLoopActive()) {
      const l = state.loop!;
      // v0.35.23: a different-pid crash successor no longer consents by
      // itself — a crash restart IS a cold load, and cold loads hold for an
      // explicit decision (note.md Next #2). Validated handoffs/rebinds,
      // SAME-PROCESS successors, and the Auto-resume setting keep today's
      // continuity.
      if (autoResume || explicitRecovery || sameProcessSuccessorResume) {
        ctx.ui.notify(
          `Resuming loop (iteration ${l.iteration}/${l.maxIterations > 0 ? l.maxIterations : "∞"}, best ${l.bestValue ?? "n/a"}, stall ${l.stallCount}/${l.plateauWindow}): ${displaySlice(l.target, 60)}`,
          "info",
        );
        scheduleLoopTick(ctx);
      } else {
        state.loop = { ...l, active: false, stopReason: HELD_ON_RESTORE };
        persistState(ctx);
        ctx.ui.notify(
          `Loop held on restore: ${displaySlice(l.target, 60)} — /loop resume to continue, or enable Auto-resume in /glla settings for session-load recovery.`, 
          "info",
        );
      }
    } else if (state.goal && state.goal.status === "active" && state.goal.autoContinue) {
      const wasInterrupted = !!state.goal.interruptedAt;
      // v0.28.21: the 0.28.3 interrupted-goal exemption is SUPERSEDED —
      // the default is now hold-everything on session load (user directive:
      // "load it but not auto start it"). Interrupted goals hold like
      // everything else; autoresume=on (unattended rigs) still auto-resumes
      // them, and the marker is cleared only on that promised auto-resume.
      // Keep the established lifecycle-consent expression source-visible for
      // downstream policy checks; staleRearmedOnSessionStart is the additional
      // one-shot consent for silent host-handle death.
      // if (autoResume || recoveryResume || rebindResume || handoffResume) {
    // Different-pid crash successors still hold like any cold load;
    // Auto-resume stays the only load-time automation for them.
    if (autoResume || recoveryResume || rebindResume || handoffResume || staleRearmedOnSessionStart || sameProcessContinuityResume) {
        // v0.28.1 (S2): clear the stale-handle interrupt marker — this IS
        // the auto-resume the marker promised.
        if (wasInterrupted) updateGoal({ interruptedAt: undefined, interruptedReason: undefined }, ctx);
        ctx.ui.notify(
          `Resuming ${state.goal.policy === "list" ? "list item" : "goal"}: ${displaySlice(state.goal.objective, 70)}${listQueue().length > 0 ? ` (+${listQueue().length} queued)` : ""}${staleRearmedOnSessionStart ? " — re-armed after the stale-host boundary" : wasInterrupted ? " — auto-resumed after the stale-handle interrupt" : ""}`,
          "info",
        );
        // v0.28.4 (P3): skip nudge accounting for the first recovery turns.
        postRestoreGraceTurns = 2;
        scheduleContinuation(ctx, true);
      } else {
        const queued = listQueue().length;
        // v0.22.7: name WHAT is held — a list head resumes through /list.
        const isListItem = state.goal.policy === "list";
        const resumeCmd = activeGoalSurfaceCommand("resume");
        const resumeHint = `${resumeCmd} to continue${queued > 0 ? ` (+${queued} waiting in the list)` : ""} · enable Auto-resume in /glla settings for load-time recovery`;
        // v0.31.1: name the supersession — a held one-shot audit whose work a
        // live audit loop now owns reads as "stalled" for HOURS otherwise
        // (junk-runner: 8h21m of "held for explicit resume" on a goal the
        // loop had superseded). The widget surface must say so.
        const auditSuperseded =
          state.goal.objective.includes(GOAL_AUDIT_ONESHOT_MARKER) &&
          !!state.loop &&
          (state.loop.active || state.loop.stopReason === HELD_ON_RESTORE) &&
          !!state.loop.target?.includes(LOOP_AUDIT_MARKER);
        updateGoal({
          status: "paused",
          pauseKind: "blocked",
          pauseReason: auditSuperseded
            ? "restored on session load — SUPERSEDED by the audit loop in this session"
            : "restored on session load — held for explicit resume",
          pauseSuggestedAction: auditSuperseded
            ? `${activeGoalSurfaceCommand("cancel")} clears it (the loop already owns the audit) · ${resumeHint} if you disagree`
            : resumeHint,
        }, ctx);
        ctx.ui.notify(
          `${isListItem ? "List item" : "Goal"} held on restore: ${displaySlice(state.goal.objective, 70)}${queued > 0 ? ` (+${queued} waiting in the list)` : ""} — ${resumeCmd} to continue.`,
          "info",
        );
      }
    } else if (state.goal && state.goal.status === "active") {
      // Active but autoContinue off: nothing auto-fires — just surface it.
      ctx.ui.notify(
        `Restored ${state.goal.policy === "list" ? "list item" : "goal"}: ${displaySlice(state.goal.objective, 70)}${listQueue().length > 0 ? ` (+${listQueue().length} queued)` : ""}`,
        "info",
      );
    } else if ((!state.goal || state.goal.status === "complete" || state.goal.status === "aborted") && listQueue().length > 0) {
      if (autoResume) {
        // Session restarted with a non-empty queue but no active goal.
        activateNextListItem(ctx);
      } else {
        ctx.ui.notify(`List has ${listQueue().length} item(s) waiting — /list next to activate the head.`, "info");
      }
    }
    // v0.35.x: an interrupted stored completion claim is released from the
    // MAIN's auditing wait before any recovery policy is considered. A valid
    // handoff/rebind or global autoResume may then start one fresh attempt;
    // cold/manual sessions remain paused until /goal resume. A claim already
    // parked as recovery-pending is the durable form produced by a stale
    // host/session boundary; it must receive the same policy on the first
    // genuinely fresh session instead of requiring a second manual command.
    const storedCompletionGoal = state.goal;
    const storedCompletionClaim = storedCompletionGoal?.pendingCompletion;
    const interruptedCompletionAudit = !!storedCompletionGoal && !!storedCompletionClaim && (
      storedCompletionGoal.status === "auditing" ||
      (storedCompletionGoal.status === "paused" && (storedCompletionClaim.phase ?? "recovery-pending") === "recovery-pending")
    );
    if (interruptedCompletionAudit && storedCompletionGoal && storedCompletionClaim) {
      if (storedCompletionGoal.status === "auditing") {
        markCompletionAuditRecoveryPending(ctx, `session_start:${startReason}`);
      }
      const recoveredClaim = state.goal?.pendingCompletion;
      // v0.35.23 (note.md Next #2): the old third disjunct — a validated
      // host lifecycle consuming the durable retry slot even without
      // Auto-resume — dispatched automation on a cold load. Removed: parked
      // claims hold for explicit consent like every other pending state;
      // the else branch below defers them with a truthful ledger event.
      // v0.35.50: same-process continuity consent — parity with the goal
      // branch above; a same-pid session replacement without contradicting
      // handoff evidence is mid-flight continuity for the stored claim too.
      const canRecoverNow = explicitRecovery || autoResume || sameProcessContinuityResume;
      if (canRecoverNow && recoveredClaim && (recoveredClaim.phase ?? "recovery-pending") === "recovery-pending") {
        completionAuditRecoveryArmed = true;
        const started = maybeAutoRetryParkedCompletionAudit(hostLifecycleStart || explicitRecovery ? "host-rebind" : "session-start");
        if (!started) {
          ctx.ui.notify(`Completion audit remains parked after its one automatic recovery attempt. The stored claim is safe; ${activeGoalSurfaceCommand("resume")} retries it explicitly.`, "warning");
        }
      } else {
        if (recoveredClaim?.recoveryRetryAt) {
          updateGoal({
            pendingCompletion: { ...recoveredClaim, recoveryRetryAt: undefined },
            pauseKind: "blocked",
            pauseResumeAt: undefined,
            pauseSuggestedAction: `The automatic recovery was held for this cold/manual startup. ${activeGoalSurfaceCommand("resume")} retries the stored claim.`,
          }, ctx);
          appendLedger(ctx.cwd, "audit_recovery_retry_deferred", { goalId: storedCompletionGoal.id, retryAt: recoveredClaim.recoveryRetryAt, reason: "cold-start-without-consent" });
        }
        ctx.ui.notify(`Completion audit blocked — no verdict. The stored claim is safe; ${activeGoalSurfaceCommand("resume")} retries the isolated auditor.`, "warning");
      }
    }
    // v0.35.x: commands received during a validated lifecycle handoff are
    // replayed only after the fresh context has restored durable state. The
    // operation journal is consumed once, ordered, and identity-fenced; a
    // stale handle never mutates the queue or starts an unreachable item.
    for (const operation of pendingListOperations) {
      try {
        await cmdList(operation, ctx);
        appendLedger(ctx.cwd, "list_operation_handoff_replayed", { chars: operation.length });
      } catch (error) {
        appendLedger(ctx.cwd, "list_operation_handoff_replay_failed", { chars: operation.length, error: error instanceof Error ? error.message.slice(0, 160) : String(error).slice(0, 160) });
        ctx.ui.notify(`glla: deferred /list operation could not be replayed after session_start: ${operation.slice(0, 120)}`, "warning");
      }
    }
    // v0.29.6: the 0.28.21 loop-vs-goal decision picker is SUPERSEDED by
    // auto-arbitration above — stacked states resolve deterministically
    // (most recent activity keeps the slot; the loser is archived) before
    // the restore gate, so a live loop and a live goal cannot coexist here.
    // Always paint on session load (v0.22.1): the branches above only reach
    // refreshUI via persistState, so a goal that was ALREADY paused (or any
    // state that doesn't mutate on load) rendered nothing — "can't tell if
    // it's on" is a bug. Painting unconditionally also clears/refreshes any
    // stale widget carried over from a previous in-process session.
    // v0.35.23 (note.md Next #2): a consent-less cold load with pending
    // durable state engages the LOAD HOLD — same freeze gates as /glla
    // pause (continuation dispatch, loop ticks, heartbeat probes, recovery
    // timers all check supervisorPaused()), but DISTINCT from it: released
    // by any explicit work command, never by timers. State stays fully
    // restored and DISPLAYED — only automation waits for the user.
    if (!autoResume && !explicitRecovery && !staleRearmedOnSessionStart) {
      const somethingLive = (!!state.goal && ["active", "auditing"].includes(state.goal.status)) || isLoopActive();
      const pendingDurableState = !!state.goal || (state.list?.length ?? 0) > 0 || !!state.loop;
      // v0.35.23: restore itself may have consented to live work (journal
      // replay activating a deferred item, stale rearm) — a hold must never
      // freeze what restore deliberately started.
      if (pendingDurableState && !somethingLive && typeof state.loadHoldAt !== "number") {
        replaceState({ ...state, loadHoldAt: Date.now() });
        persistState(ctx);
        appendLedger(ctx.cwd, "load_hold_engaged", { reason: startReason ?? "startup" });
        ctx.ui.notify(
          "Loaded without starting: your goal/list/loop state is restored and shown below, but automation is HELD for your decision. /goal resume, /list resume, or /list next starts work; enable Auto-resume in /glla settings to restore load-time automation.",
          "warning",
        );
        // v0.38.7 (note.md Next: objectives seemingly lost on reload) —
        // the recovery banner: objective + next task + verdict tally +
        // resume command, all from durable disk state. The transcript is
        // empty in exactly the sessions that need this, so nothing here
        // may depend on in-memory progress. Fires with the fresh hold
        // (guarded above), never as a timer re-arm.
        const tasks = state.goal?.taskList?.tasks ?? [];
        const pendingTasks = tasks.filter((t) => t.status === "pending" || t.status === "in_progress");
        const tally = auditorVerdictTally(state.goal?.auditHistory);
        const resumeCommand = state.goal
          ? (state.goal.policy === "list" ? "/list resume" : "/goal resume")
          : (state.list?.length ?? 0) > 0 ? "/list resume" : state.loop ? "/loop resume" : "/goal resume";
        const banner = buildLoadHoldRecoveryLines({
          objective: state.goal?.objective ?? ((state.list?.length ?? 0) > 0 ? `${state.list!.length} queued list items` : null),
          status: state.goal?.status ?? (state.loop ? "loop" : "held"),
          nextTask: pendingTasks[0]?.title ?? null,
          tally,
          resumeCommand,
          listWaiting: state.goal?.policy === "list" ? undefined : state.list?.length ?? 0,
          // v0.38.10: the emergency compactor's handoff, when one exists —
          // the /new + resume path lands warm instead of cold.
          briefExcerpt: readHandoffBriefExcerpt(ctx.cwd),
        });
        appendLedger(ctx.cwd, "load_hold_recovery_banner", {
          goalId: state.goal?.id ?? null,
          status: state.goal?.status ?? null,
          pendingTasks: pendingTasks.length,
          totalVerdicts: tally.total,
          disapprovals: tally.disapprovals,
        });
        ctx.ui.notify(banner.join("\n"), "info");
      }
    } else if ((autoResume || explicitRecovery) && typeof state.loadHoldAt === "number") {
      // v0.35.28 (issue #16): a hold persisted by a PREVIOUS process must
      // not outlive the user's consent — with auto-resume on, a stale
      // hold would freeze supervisorPaused()-gated machinery (including
      // the due-wait backstop) until a manual resume that may never come.
      replaceState({ ...state, loadHoldAt: undefined });
      persistState(ctx);
      appendLedger(ctx.cwd, "load_hold_released", { via: "consenting-reload" });
    }
    refreshUI(ctx, true);
  });

  pi.on("agent_end", async (event: any, ctx: ExtensionContext) => {
    rememberCtx(ctx);
    signalSupervisionEvent({ plane: state.mainModelRecovery ? "provider-recovery" : state.loop?.active ? "loop" : state.goal?.policy === "list" ? "list" : state.goal ? "goal" : "queue", kind: "progress", source: "agent_end" });
    // A late agent_end from the disposed session is not a fresh turn. Do not
    // account it, run length continuation, or schedule another send after a
    // stale terminal/handoff.
    if (sessionHandoffPending || extensionApiStale || staleTerminalDone || zombieStoodDown) {
      // v0.34.25: pi's silent swap means the first live sign may be the
      // replacement session's own turn events. Absorb a file-backed host
      // successor — the absorb already scheduled the recovery continuation
      // from durable state, so this half-known turn is never also accounted.
      tryAbsorbHostSuccessor(ctx, "agent_end");
      return;
    }
    // v0.23.8: a subagent finishing must not drive the main session's
    // continuation loop.
    if (isForeignCtx(ctx)) return;
    noteActivity(true);
    refreshOwnerHeartbeat(ctx.cwd); // v0.38.11: throttled (60s) claim refresh so /glla owner shows real idle
    noteOwnershipStanding(ctx); // v0.38.12: stand down to read-only when a newer session stole the root
    dispatchStartAcknowledged(ctx, "agent_end");
    lastStreamActivityAt = Date.now();
    streamActivityObserved = true;
    // v0.27.2: folded-in length-continue (standalone pi-length-continue is
    // deprecated). A response cut by the per-response output cap is NOT a
    // completed turn (no telemetry), NOT a stall (no no-tool nudge), and
    // must not run the loop measure or the normal goal continuation on half
    // a response — re-trigger immediately with split-smaller guidance and
    // skip ALL turn bookkeeping; the NEXT agent_end processes the run.
    // Works with no goal active (plain sessions truncate too).
    // v0.27.3: enrich lastA with text + priorText for the smarter nudge
    // accounting below.
    const assistants = (event.messages as any[]).filter((m: any) => m.role === "assistant");
    let rawLastA = assistants.length ? assistants[assistants.length - 1] : null;
    const rawPriorA = assistants.length >= 2 ? assistants[assistants.length - 2] : null;
    const extractText = (m: any): string => (m && Array.isArray(m.content)) ? m.content.filter((p: any) => p.type === "text").map((p: any) => p.text).join("\n") : "";
    let lastA = rawLastA ? { stopReason: rawLastA.stopReason, text: extractText(rawLastA), priorText: extractText(rawPriorA) } : null;
    // v0.34.19: pi-ai clamps max_tokens to the remaining context before the
    // provider call. At ~99% context that clamp can be 1 token, which the
    // provider reports as stopReason "length" — but this is NOT an overlong
    // assistant response. Extension agent_end runs BEFORE pi's own
    // auto-compaction check (agent-session.js _handlePostAgentRun), so sending
    // LENGTH_CONTINUE_TEXT here queues another 1-token request and delays the
    // real cure. Defer to pi compaction; session_compact's resume debt owns
    // the next continuation. Older pi/test doubles without getContextUsage()
    // fail open to the legacy true-length path.
    const contextUsage = (() => {
      try { return typeof ctx.getContextUsage === "function" ? ctx.getContextUsage() : undefined; } catch { return undefined; }
    })();
    // v0.36.1: retain exact provider input/output usage alongside the host's
    // context estimate. The prompt text is intentionally not persisted; this
    // bounded sample is enough to compare repeated continuation turns with
    // the provider's real input-token count. Error-only assistant fixtures
    // carry EMPTY_USAGE and are not provider observations.
    const providerUsage = rawLastA && !rawLastA.errorMessage && rawLastA.stopReason !== "error"
      ? captureProviderTokenUsage(rawLastA)
      : null;
    if (providerUsage || contextUsage) {
      appendLedger(ctx.cwd, "context_usage_sample", {
        goalId: state.goal?.id ?? null,
        provider: rawLastA?.provider ?? ctx.model?.provider ?? null,
        model: rawLastA?.model ?? ctx.model?.id ?? null,
        providerUsage: providerUsage ? {
          inputTokens: providerUsage.inputTokens,
          outputTokens: providerUsage.outputTokens,
          cacheReadTokens: providerUsage.cacheReadTokens,
          cacheWriteTokens: providerUsage.cacheWriteTokens,
          totalTokens: providerUsage.totalTokens,
        } : null,
        contextUsage: contextUsage ? {
          // pi documents this value as an estimate; keep it separate from
          // providerUsage so a host estimate is never called raw usage.
          tokens: contextUsage.tokens,
          contextWindow: contextUsage.contextWindow,
          percent: contextUsage.percent,
        } : null,
      });
    }
    const contextStarvedLength = isContextStarvedLengthStop(rawLastA, contextUsage);
    const lc = tickLengthContinue(lastA?.stopReason === "length" && !contextStarvedLength);
    if (contextStarvedLength) {
      const starved = noteContextStarvedYield();
      appendLedger(ctx.cwd, "length_continue_deferred_context_full", {
        outputTokens: rawLastA?.usage?.output,
        contextTokens: contextUsage?.tokens ?? null,
        contextWindow: contextUsage?.contextWindow ?? null,
        contextPercent: contextUsage?.percent ?? null,
        starvedStreak: starved.streak,
      });
      // v0.34.116: when pi already tried to compact within the last 90s
      // (the COMPACTION_GRACE_MS window) and the prompt STILL does not fit,
      // the model is too small for the prompt — not the prompt too big for
      // any model. Walk the fallback chain to a larger-context ref so the
      // next turn can land. Without this, the user sees "Context overflow
      // recovery FAILED after one compact-and-retry attempt" with no
      // automated recourse (Screenshot_20260808_192604 hegemion).
      const sinceLastCompactMs = state.lastCompactionAt ? Date.now() - state.lastCompactionAt : Number.POSITIVE_INFINITY;
      if (sinceLastCompactMs < COMPACTION_GRACE_MS && mainModelFallbackRefs(ctx).length > 0) {
        const overflowMessage = `output-token stop at ${contextUsage?.percent?.toFixed(1) ?? "near-full"}% after recent compaction — model is too small for the prompt; walking fallback chain`;
        const switched = await recoverFromContextOverflow(ctx, overflowMessage);
        if (switched) {
          ctx.ui.notify("glla: rotated to a larger-context backup model. The next turn will retry on the new model.", "info");
          return;
        }
      }
      // Ladder banner (v0.38.6; v0.38.9 skips stale step 1 after a failed compact-and-retry).
      ctx.ui.notify(buildStarvationLadderMessage({ percent: typeof contextUsage?.percent === "number" ? contextUsage.percent : null, streak: starved.streak, recentCompact: sinceLastCompactMs < COMPACTION_GRACE_MS }), "info");
      // v0.38.10: emergency compactor, one shot per episode (fire-and-forget).
      void runEmergencyCompactorIfDue(ctx, starved.shouldRefuse, {
        notify: (message) => ctx.ui.notify(message, "info"),
        page: (message) => notifyExternal(ctx, message),
      });
      return;
    }
    if (lc.giveUpNow) {
      // v0.34.26: exhaustion is a DURABLE failure state, not a transient
      // notify. Pre-fix the goal stayed green-active while every heartbeat
      // re-kick silently truncated again (the tracker stays gaveUp, so no
      // fire, no state, no card) — an invisible infinite ping-pong.
      appendLedger(ctx.cwd, "length_continue_exhausted", { consecutive: lc.consecutive });
      ctx.ui.notify(`glla: response hit the output-token cap ${LENGTH_CONTINUE_MAX}× in a row — stepping aside. Ask the model to split the work into smaller pieces.`, "warning");
      if (state.goal && state.goal.status === "active") {
        notifyExternal(ctx, `Response truncated ${LENGTH_CONTINUE_MAX}× in a row — ${goalNoun()} paused; split the work, then ${activeGoalSurfaceCommand("resume")}.`);
        updateGoal({
          status: "paused",
          pauseKind: "error",
          pauseReason: `output-token limit — ${LENGTH_CONTINUE_MAX} responses in a row were truncated mid-artifact; auto-continue exhausted`,
          pauseSuggestedAction: `Re-scope the current artifact into smaller pieces (several smaller write/edit calls across turns instead of one giant response), then ${activeGoalSurfaceCommand("resume")} — the truncation budget restarts fresh.`,
        }, ctx);
        // The pause is the durable record; an explicit recovery gets a full
        // fresh truncation budget (otherwise the sticky gaveUp flag would
        // make the resumed turn silently dead on the first truncation).
        resetLengthContinue();
      } else if (state.loop?.active) {
        state.loop.active = false;
        state.loop.stopReason = `output-token limit — ${LENGTH_CONTINUE_MAX} consecutive truncated responses (iteration ${state.loop.iteration} preserved; /loop resume after re-scoping the work into smaller pieces)`;
        persistState(ctx);
        const recap = compactLoopCompletionSummary({ ...state.loop, historyLength: state.loop.history.length });
        ctx.ui.notify(`glla: response hit the output-token cap ${LENGTH_CONTINUE_MAX}× in a row — the loop stopped. Ask the model to split the work into smaller pieces.\nRecap: ${recap}`, "warning");
        notifyExternal(ctx, `Response truncated ${LENGTH_CONTINUE_MAX}× in a row — loop stopped; /loop resume after re-scoping. Recap: ${recap}`);
        appendLedger(ctx.cwd, "loop_stopped", { reason: state.loop.stopReason, iterations: state.loop.iteration, best: state.loop.bestValue, recap });
        resetLengthContinue();
      } else {
        notifyExternal(ctx, "Response truncated 3× in a row — giving up auto-continue.");
      }
    }
    if (lastA?.stopReason === "length") {
      if (lc.fire && !ctx.hasPendingMessages()) sendLengthContinue(ctx, lc.consecutive);
      return;
    }
    // Drafting owns its temporary model chain. Provider/runtime errors during
    // an interview must retry that chain before the main-goal recovery path;
    // otherwise a drafting failure would silently consume main-model backups.
    if (lastA?.stopReason === "error" && draftingTarget !== null) {
      const retryDrafting = (globalThis as any).handleDrafterModelFailure as ((context: ExtensionContext, error?: string) => Promise<boolean>) | undefined;
      if (retryDrafting) await retryDrafting(ctx, (rawLastA as any)?.errorMessage ?? (rawLastA as any)?.error ?? lastA.text);
      // Whether a configured fallback was available or not, drafting owns
      // this error. Leave the interview open for an explicit user retry and
      // never pass the same failure into main-goal recovery.
      return;
    }
    // A repeated provider pane arrived through a successful tool transport,
    // so pi reports an ordinary end_turn. Convert it into the same bounded
    // recovery envelope as a provider error before loop measurement/stuck
    // accounting can consume the dead turn.
    if (inBandProviderFailureRaw) {
      const raw = inBandProviderFailureRaw;
      clearInBandProviderFailure();
      if (isLoopActive()) {
        const loop = state.loop!;
        // The normal loop error branch owns the consecutive-error counter and
        // its bounded recovery cap. Clearing the fingerprints here prevents
        // the same pane from being reclassified before that branch runs.
        loop.recentToolResults = [];
        rawLastA = { ...(rawLastA ?? {}), stopReason: "error", errorMessage: raw, content: [] };
        lastA = { stopReason: "error", text: raw, priorText: lastA?.priorText ?? "" };
      } else if (state.goal?.status === "active") {
        // An explicit policy refusal can arrive through a successful tool
        // transport while a one-shot goal is active. Promote that exact
        // marker to the same main-model settlement path instead of clearing
        // it as loop-only bookkeeping.
        rawLastA = { ...(rawLastA ?? {}), stopReason: "error", errorMessage: raw, content: [] };
        lastA = { stopReason: "error", text: raw, priorText: lastA?.priorText ?? "" };
      }
    }
    if (await handleMainModelAgentEnd(ctx, rawLastA, lastA)) return;
    // v0.25.2: per-goal turn telemetry (/glla stats).
    if (state.goal && state.goal.status === "active") {
      const t = state.goal.telemetry ?? { turns: 0, fileWrites: 0, bashCalls: 0 };
      t.turns++;
      state.goal.telemetry = t;
    }
    ensureAgentToolsReady(ctx);
    // v0.27.3: nudge accounting — substantive analytical turns (long, novel
    // text) reset the counter even with no tool calls. Polis-session
    // incident showed the tool-only check fired on real investigation work.
    if (isSupervising()) {
      if (postRestoreGraceTurns > 0) {
        // v0.28.4 (P3): the first turns after a session_start restore are
        // recovery chatter (orientation reads, plan narration) — counting
        // them toward the stall brake paused restored goals mid-recovery.
        postRestoreGraceTurns--;
        appendLedger(ctx.cwd, "post_restore_grace", { remaining: postRestoreGraceTurns });
      } else if (lastA?.stopReason === "error") {
        // v0.28.13 (endless-td 429 incident 2026-07-28): provider-error
        // turns (provider errors) are NOT model unproductivity —
        // the model never got a say. Counting them tripped the brake on a
        // healthy goal mid-CDP-capture (4 MiniMax-M3 429s → wrong
        // "unproductive turns" pause). pi's own retry owns the backoff;
        // the nudge counter neither increments nor resets on these turns.
        appendLedger(ctx.cwd, "stall_nudge_exempt_error", { nudgesSoFar: heartbeatNudges });
      } else if (lastA?.stopReason === "aborted") {
        // v0.29.4: user aborts are not model unproductivity either — the
        // user pressed Esc. Counting the interrupt tripped the stall brake
        // on the USER's action (pully field case: Esc-spam → STALL WARNING
        // 1/3, 2/3 → a bogus "stalled" pause). Neither increment nor reset.
        appendLedger(ctx.cwd, "stall_nudge_exempt_aborted", { nudgesSoFar: heartbeatNudges });
      } else {
      const s = loadSettings(ctx.cwd);
      const shortWordsThr = s.stallShortWords ?? DEFAULT_STALL_SHORT_WORDS;
      const simThr = s.stallSimilarityThreshold ?? DEFAULT_STALL_SIM_THRESHOLD;
      heartbeatNudges = accountTurnForNudgesRich(
        { toolCalls: toolCallsThisTurn, text: lastA?.text ?? "", priorText: lastA?.priorText ?? "", shortWords: shortWordsThr, simThreshold: simThr },
        heartbeatNudges,
      );
      if (heartbeatNudges >= HEARTBEAT_MAX_NUDGES) {
        heartbeatNudges = 0;
        if (isLoopActive()) {
          clearLoopTimer();
          state.loop = { ...state.loop!, active: false, stopReason: `stalled: ${HEARTBEAT_MAX_NUDGES} consecutive unproductive turns (no tools, short or repetitive)` };
          persistState(ctx);
          const recap = compactLoopCompletionSummary({ ...state.loop, historyLength: state.loop.history.length });
          ctx.ui.notify(`Loop stopped: stalled (${HEARTBEAT_MAX_NUDGES} unproductive turns). /loop start to begin a new one.\nRecap: ${recap}`, "warning");
          notifyExternal(ctx, `Loop stopped: stalled (no tool calls). Recap: ${recap}`);
          return;
        }
        if (state.goal) {
          updateGoal({
            status: "paused",
            pauseKind: "decision",
            pauseOptions: [`Retry — ${activeGoalSurfaceCommand("resume")}`, `Tweak the objective — ${activeGoalSurfaceCommand("tweak")} <new text>`, `Cancel the goal (${activeGoalSurfaceCommand("cancel")})`],
            pauseRecommended: 1,
            pauseReason: `stalled: ${HEARTBEAT_MAX_NUDGES} consecutive unproductive turns (no tools, short or repetitive)`,
            pauseSuggestedAction: `Inspect the goal — ${activeGoalSurfaceCommand("resume")} to retry, ${activeGoalSurfaceCommand("tweak")} to narrow it, ${activeGoalSurfaceCommand("cancel")} to abort.`,
          }, ctx);
          ctx.ui.notify(`${goalNoun()} paused: stalled (${HEARTBEAT_MAX_NUDGES} unproductive turns).`, "warning");
          maybeDecisionPopup(ctx);
          notifyExternal(ctx, "Goal paused: stalled (no tool calls).");
          return;
        }
      }
      // v0.28.4 (P1): graduated escalation — before the brake can fire,
      // tell the model exactly what closes the turn. A done-but-unclosed
      // goal gets "call complete_goal NOW", not a silent count. Replaces
      // this turn's normal continuation (the escalation IS the entry).
      if (heartbeatNudges >= 1 && state.goal && state.goal.status === "active" && !isLoopActive()) {
        toolCallsThisTurn = 0;
        sendStallEscalation(ctx, heartbeatNudges);
        return;
      }
      } // end post-restore grace else
    }
    toolCallsThisTurn = 0;
    // Loop 3 runs on the same heartbeat: measure after every agent turn.
    if (isLoopActive()) {
      clearLoopTimer();
      // v0.29.19: provider-error / user-abort turns are NOT iterations —
      // the model never got a say, so a dead turn carries no stall/stuck/
      // plateau signal (field 2026-07-31, MiniMax token-plan 429 storm:
      // hegemon false-plateau'd with 13 open findings, polis with 3+,
      // hellhunter stuck-stopped at iter 93 — every counted turn was a
      // dead 429 turn; the v0.28.13/v0.29.4 exemptions only covered the
      // goal nudge counter). Skip the measure and refire — bounded, so a
      // real outage stops the loop honestly instead of burning turns.
      const sr = lastA?.stopReason;
      if (sr === "error" || sr === "aborted") {
        const loop = state.loop!;
        loop.consecutiveErrors = (loop.consecutiveErrors ?? 0) + 1;
        persistState(ctx);
        appendLedger(ctx.cwd, "loop_turn_exempt_error", { stopReason: sr, consecutive: loop.consecutiveErrors, iteration: loop.iteration });
        const cap = sr === "aborted" ? LOOP_MAX_CONSECUTIVE_ABORTS : LOOP_MAX_CONSECUTIVE_ERRORS;
        if (loop.consecutiveErrors >= cap) {
          const providerFailure = lastMainModelFailure;
          const durableProviderFailure = providerFailure
            && (requiresMainModelRecovery(providerFailure)
              || isMainModelFallbackFailure(providerFailure));
          if (sr === "error" && durableProviderFailure) {
            // Recoverable provider failures may rotate through backups; the
            // bounded recovery envelope owns the loop instead of stopping on
            // a dead turn.
            parkMainModelAfterFailure(ctx, providerFailure);
            if (state.mainModelRecovery) return;
          }
          loop.active = false;
          loop.stopReason = sr === "aborted"
            ? `stopped by user — ${loop.consecutiveErrors} consecutive aborts (iteration ${loop.iteration} preserved; /loop resume to continue)`
            : `provider errors — ${loop.consecutiveErrors} consecutive error turns (iteration ${loop.iteration} preserved; /loop resume when the provider recovers)`;
          persistState(ctx);
          const recap = compactLoopCompletionSummary({ ...loop, historyLength: loop.history.length });
          ctx.ui.notify(`Loop stopped: ${loop.stopReason}\nRecap: ${recap}`, "warning");
          appendLedger(ctx.cwd, "loop_stopped", { reason: loop.stopReason, iterations: loop.iteration, best: loop.bestValue, recap });
          notifyExternal(ctx, `Loop stopped: ${sr === "aborted" ? "user aborts" : "provider errors"} (${loop.consecutiveErrors}×). Recap: ${recap}`);
          // v0.35.41 (audit finding): this route frees the surface like any
          // other loop stop — announce the waiting queue instead of leaving
          // it a dead silent entry.
          announceQueuedListAfterLoopEnd(ctx);
          return;
        }
        scheduleLoopTick(ctx);
        return;
      }
      if ((state.loop!.consecutiveErrors ?? 0) > 0) state.loop!.consecutiveErrors = 0; // a real turn clears the streak (runLoopTick persists)
      await runLoopTick(ctx, event);
      return;
    }
    if (!state.goal) return;
    if (state.goal.status !== "active") return;
    clearContinuationTimer();
    // v0.38.6: feed the sticky refuse gate + compact-first nudge with the
    // live percent. Placed AFTER the goal gate: the length-continue order
    // pin requires the length path first, and starved sessions already
    // returned via the yield ladder above. Recording null clears a stale
    // reading (host estimate gone) so the refuse can lapse instead of
    // sticking forever.
    noteContextPercent(typeof contextUsage?.percent === "number" ? contextUsage.percent : null);
    if (shouldCompactFirstNudge(contextUsage?.percent)) {
      appendLedger(ctx.cwd, "context_compact_first_nudge", {
        goalId: state.goal?.id ?? null,
        contextPercent: contextUsage?.percent ?? null,
      });
      ctx.ui.notify(`glla: context at ${contextUsage!.percent!.toFixed(1)}% — run /compact now while summarization still fits. Below 90% the compact succeeds; past it you get the over-cap ladder (retry /compact, larger model, or /new + resume).`, "info");
    }

    const last = [...(event.messages as any[])].reverse().find((m) => m.role === "assistant");
    const text = last && Array.isArray(last.content) ? last.content.filter((p: any) => p.type === "text").map((p: any) => p.text).join("\n") : "";
    const stopReason = last?.stopReason;
    iterationCounter++;

    // Token accounting + cost guard: accumulate this turn's assistant tokens
    // (deduped — agent_end may replay seen messages). Crossing the goal's
    // token limit pauses it; raise Token limit in /glla settings.
    const newTokens = sumNewAssistantTokens(event.messages as unknown[], countedTokenMessages);
    if (newTokens > 0) {
      const used = (state.goal.usage?.tokensUsed ?? 0) + newTokens;
      const limit = state.goal.usage?.tokensLimit ?? DEFAULT_TOKEN_LIMIT;
      // v0.12.0: the guard is opt-in — limit 0/unset means never pause.
      if (limit > 0 && used > limit) {
        updateGoal({
          usage: { tokensUsed: used, tokensLimit: limit },
          status: "paused",
          pauseKind: "error",
          pauseReason: `token limit exceeded (${used.toLocaleString()} > ${limit.toLocaleString()})`,
          pauseSuggestedAction: `Raise Token limit in /glla settings (or set 0 to disable), then ${activeGoalSurfaceCommand("resume")}`,
        }, ctx);
        ctx.ui.notify(`${goalNoun()} paused: token limit exceeded (${used.toLocaleString()} > ${limit.toLocaleString()}). Raise Token limit in /glla settings, or set it to 0 to disable.`, "warning");
        notifyExternal(ctx, `Goal paused: token limit exceeded (${used} > ${limit}).`);
        return;
      }
      updateGoal({ usage: { tokensUsed: used, tokensLimit: limit } }, ctx);
    }

    if (stopReason === "error") {
      consecutiveErrorIterations++;
      consecutiveAbortIterations = 0;
      if (consecutiveErrorIterations >= 5) {
        // v0.28.5 (E8): carry the REAL error text — the pause used to say
        // literally "5 consecutive errors: error" (stopReason, not the
        // provider error). And give transient flakes ONE auto-resume per brake
        // (escalating cooldown, reason re-checked) — the E8 incident lost 1.5h to a
        // 60-second provider hiccup waiting on a manual /goal resume.
        const rawErrorText = normalizeProviderErrorText(rawLastA, text);
        const failureCopy = providerErrorPresentation(rawErrorText, "main");
        const detail = rawErrorText
          ? ` (last: ${failureCopy.sensitive ? failureCopy.display : rawErrorText.replace(/\s+/g, " ").slice(0, 160)})`
          : "";
        const recoveryEpisodeKey = state.goal!.recoveryEpisodeKey ?? `${state.goal!.createdAt}:${failureCopy.fingerprint}`;
        const recoveryNoticeKeys = state.goal!.recoveryNoticeKeys ?? [];
        // v0.34.26: an output-token-limit rejection is NOT a generic provider
        // flake — the same prompt shape deterministically fails, so
        // "transient flake auto-resume" and "switch provider / wait out the
        // window" guidance are both wrong for it. Name the real wall.
        const outputLimitWall = /output[ -]?token|max_?tokens|length limit|output length|too many tokens/i.test(rawErrorText);
        const reason = outputLimitWall
          ? `output-token limit — the provider rejected ${consecutiveErrorIterations} overlong responses`
          : `5 consecutive errors${detail}`;
        // v0.34.15: the streak now lives ON THE GOAL so it survives the
        // auto-recovery /reloads that used to zero the module counter —
        // hegemon 2026-08-01: a hard-exhausted MiniMax plan churned 1-minute
        // probes for an hour because every reload reset the ladder to rung 1
        // and the 6-brake park (v0.29.9) could never engage.
        const brakeStreak = state.goal!.errorBrakeStreak ?? 0;
        // v0.34.26: deterministic output-limit wall — durable error pause,
        // no flake ladder, no hourly probes. Only re-scoping the work helps.
        if (outputLimitWall) {
          updateGoal({
            status: "paused",
            pauseKind: "error",
            pauseReason: reason,
            providerErrorDiagnostic: failureCopy.sensitive ? failureCopy.diagnostic : undefined,
            recoveryEpisodeKey,
            recoveryNoticeKeys,
            errorBrakeStreak: brakeStreak + 1,
            pauseSuggestedAction: `Deterministic wall — the provider rejects this response shape every time, so blind retries never help. Re-scope the work into smaller pieces (several smaller write/edit calls across turns), then ${activeGoalSurfaceCommand("resume")}.`,
          }, ctx);
          const notifyOutputLimit = claimRecoveryNotice(state.goal!, `${recoveryEpisodeKey}:output-limit`);
          if (notifyOutputLimit) {
            ctx.ui.notify(`Goal paused: ${failureCopy.sensitive ? "provider output-token wall" : reason}. Re-scope into smaller pieces, then ${activeGoalSurfaceCommand("resume")}.`, "warning");
            notifyExternal(ctx, `Goal paused: ${failureCopy.sensitive ? "provider output-token wall" : reason}.`);
          }
          appendLedger(ctx.cwd, "goal_paused", { reason, diagnostic: failureCopy.diagnostic, recoveryEpisodeKey });
          return;
        }
        // v0.29.1: brake-cycle CAP. The v0.28.25 ladder slows the thrash
        // (1m→16m) but never STOPS it — junk-runner/hellhunter/pully each
        // burned 4+ pause↔retry cycles against repeated provider failures that last
        // hours. After 6 consecutive brakes: park. v0.29.9: the park keeps
        // probing at the top of each hour (clock-aligned window resets).
        if (brakeStreak >= 6) {
          // v0.29.9: park — but keep probing at the top of each hour
          // (user: "simply adding an hourly retry … just to pick up work
          // faster assuming the retry expired"). The hourly retry is simply
          // an additional bounded attempt; it makes no claim about why the
          // provider failed or whether a reset occurred.
          updateGoal({
            status: "paused",
            pauseKind: "error",
            pauseReason: `${failureCopy.sensitive ? "provider recovery wall" : reason} — 6 error-brakes in a row; the provider has been erroring for an extended window`,
            providerErrorDiagnostic: failureCopy.sensitive ? failureCopy.diagnostic : undefined,
            recoveryEpisodeKey,
            recoveryNoticeKeys,
            pauseSuggestedAction: `Probing at :00:30 after each hour starts; ${activeGoalSurfaceCommand("resume")} retries now.`,
          }, ctx);
          const notifyCapped = claimRecoveryNotice(state.goal!, `${recoveryEpisodeKey}:error-brake-capped`);
          if (notifyCapped) {
            ctx.ui.notify(`${goalNoun()} parked: ${failureCopy.sensitive ? "provider error" : reason} — 6 brakes in a row. An automatic probe is scheduled for :00:30 after the next hour starts.`, "warning");
            notifyExternal(ctx, `${goalNoun()} parked: provider erroring across 6 error-brake cycles — hourly top-of-hour probes scheduled.`);
          }
          appendLedger(ctx.cwd, "error_brake_capped", { streak: brakeStreak, reason, diagnostic: failureCopy.diagnostic, recoveryEpisodeKey });
          const probeMs = Math.max(1_000, nextHourlyProbeMs(Date.now()) - Date.now());
          scheduleProviderRetryForSession(ctx, probeMs / 1000, reason, (fresh: ExtensionContext) => {
            // Re-check: only probe if STILL parked by the error-brake cap —
            // a user pause/resume/cancel meanwhile is never stomped.
            if (state.goal && state.goal.status === "paused" && state.goal.pauseKind === "error"
              && (state.goal.pauseReason ?? "").includes("error-brakes in a row")) {
              appendLedger(fresh.cwd, "hourly_provider_retry", { goalId: state.goal.id, streak: state.goal.errorBrakeStreak ?? 0 });
              updateGoal({ status: "active", pauseKind: undefined, pauseResumeAt: undefined, pauseReason: undefined, pauseSuggestedAction: undefined, providerErrorDiagnostic: undefined, recoveryEpisodeKey: undefined, recoveryNoticeKeys: undefined }, fresh);
              appendLedger(fresh.cwd, "goal_resumed", { via: "hourly-provider-retry" });
              fresh.ui.notify("Hourly provider retry: resuming after the hour boundary.", "info");
              scheduleContinuation(fresh, true);
            }
          }, "Hourly provider retry", { episodeKey: recoveryEpisodeKey, noticeKey: `${recoveryEpisodeKey}:error-brake-capped`, suppressNotice: true });
          return;
        }
        // v0.28.25: the cooldown escalates per CONSECUTIVE brake — a fleet-wide
        // 403 window is not cleared by re-braking every 60 seconds.
        const cooldownMs = 60_000 * 2 ** Math.min(brakeStreak, 4);
        const cooldownMin = Math.round(cooldownMs / 60_000);
        updateGoal({
          status: "paused",
          pauseKind: "wait",
          pauseResumeAt: new Date(Date.now() + cooldownMs).toISOString(),
          pauseReason: failureCopy.sensitive ? `provider recovery wall — ${failureCopy.display}` : reason,
          providerErrorDiagnostic: failureCopy.sensitive ? failureCopy.diagnostic : undefined,
          recoveryEpisodeKey,
          recoveryNoticeKeys,
          errorBrakeStreak: brakeStreak + 1,
          pauseSuggestedAction: `The provider error will be retried in ${cooldownMin}m if still paused for this reason — or ${activeGoalSurfaceCommand("resume")} now.`,
        }, ctx);
        const notifyBrake = claimRecoveryNotice(state.goal!, `${recoveryEpisodeKey}:error-brake-wait`);
        if (notifyBrake) {
          ctx.ui.notify(`Goal paused: ${failureCopy.sensitive ? "provider error" : reason}. Automatic retries continue; ${activeGoalSurfaceCommand("resume")} retries now.`, "warning");
          notifyExternal(ctx, `Goal paused: ${failureCopy.sensitive ? "provider error" : reason}.`);
        }
        appendLedger(ctx.cwd, "goal_paused", { reason, diagnostic: failureCopy.diagnostic, recoveryEpisodeKey });
        scheduleProviderRetryForSession(ctx, cooldownMs / 1000, reason, (fresh: ExtensionContext) => {
          // Re-check: only auto-resume if STILL paused for the error brake
          // (a user /goal pause during the window is not stomped).
          if (state.goal && state.goal.status === "paused" && (state.goal.pauseReason ?? "").startsWith("5 consecutive errors")) {
            updateGoal({ status: "active", pauseKind: undefined, pauseResumeAt: undefined, pauseReason: undefined, pauseSuggestedAction: undefined, providerErrorDiagnostic: undefined, recoveryEpisodeKey: undefined, recoveryNoticeKeys: undefined }, fresh);
            appendLedger(fresh.cwd, "goal_resumed", { via: "error-brake-retry" });
            fresh.ui.notify("Auto-resumed after the 5-error brake (cooldown elapsed).", "info");
            scheduleContinuation(fresh, true);
          }
        }, "5 consecutive errors — auto-retry", { episodeKey: recoveryEpisodeKey, noticeKey: `${recoveryEpisodeKey}:error-brake-wait`, suppressNotice: true });
        return;
      }
      // v0.28.25: under the brake, the retry rides the exponential ladder —
      // NOT the immediate scheduleContinuation at the bottom of this handler
      // (an errored turn leaves the session idle, so the default delay is 0:
      // exactly how 5 retries fired back-to-back in dracon-utilities).
      const retryDelayMs = ERROR_RETRY_LADDER_MS[Math.min(consecutiveErrorIterations - 1, ERROR_RETRY_LADDER_MS.length - 1)];
      appendLedger(ctx.cwd, "error_retry_backoff", { attempt: consecutiveErrorIterations, delayMs: retryDelayMs });
      scheduleContinuation(ctx, true, retryDelayMs);
      return;
    } else if (stopReason === "aborted") {
      // v0.28.5 (E8): user aborts are not provider errors. Separate brake,
      // honest message, and NO auto-resume — aborting five turns in a row
      // is the user telling the goal to stop; we stay stopped.
      consecutiveAbortIterations++;
      consecutiveErrorIterations = 0;
      if (consecutiveAbortIterations >= 5) {
        updateGoal({
          status: "paused",
          pauseKind: "blocked",
          pauseReason: "5 consecutive aborts (user interrupted)",
          pauseSuggestedAction: `You interrupted 5 turns in a row — the goal stays paused until you ${activeGoalSurfaceCommand("resume")} (or ${activeGoalSurfaceCommand("cancel")}).`,
        }, ctx);
        ctx.ui.notify("Goal paused: 5 consecutive aborts (user interrupted).", "warning");
        appendLedger(ctx.cwd, "goal_paused", { reason: "5 consecutive aborts (user interrupted)" });
        return;
      }
      // v0.29.4: an abort stands the chain DOWN — no auto re-fire. The old
      // fall-through re-fired the continuation immediately, so every Esc
      // was answered by another turn under the user's hands ("it auto
      // triggered and I kept spamming esc on it" — pully, 2026-07-30).
      ctx.ui.notify(`${goalNoun()} standing down — turn aborted by user (not counted toward stalls). ${activeGoalSurfaceCommand("resume")} to continue, ${activeGoalSurfaceCommand("cancel")} to stop.`, "info");
      abortedStandDown = true; // v0.29.5: heartbeat/compaction refires must not resurrect the chain
      appendLedger(ctx.cwd, "abort_stand_down", { consecutiveAborts: consecutiveAbortIterations });
      return;
    } else {
      consecutiveErrorIterations = 0;
      consecutiveAbortIterations = 0;
      // v0.28.25/v0.34.15: a healthy turn clears the (now persisted) brake streak
      if ((state.goal?.errorBrakeStreak ?? 0) > 0) updateGoal({ errorBrakeStreak: undefined }, ctx);
    }

    // No wall-clock cap by design: a goal ends via completion, explicit
    // pause/cancel, the stall watchdog, the 5-consecutive-errors pause, or
    // the token guard — never via an elapsed-time cutoff.

    // v0.34.12: NOT immediately — agent_end is the blackhole boundary.
    scheduleContinuation(ctx, false, EAGER_CONTINUATION_SETTLE_MS);
  });

  // Some pi hosts expose a settled turn boundary separately from agent_end.
  // Treat it as the same fresh-contact point for a coalesced stale-host arm;
  // with no pending arm this handler is intentionally inert.
  pi.on("turn_end", async (_event: any, ctx: ExtensionContext) => {
    rememberCtx(ctx);
    if (tryAbsorbHostSuccessor(ctx, "turn_end")) return;
    if (sessionHandoffPending || extensionApiStale || staleTerminalDone || zombieStoodDown) {
      // Same-generation late turn boundaries are disposed-session callbacks;
      // only a validated file-backed successor may consume the stale arm.
      tryAbsorbHostSuccessor(ctx, "turn_end");
      return;
    }
    if (isForeignCtx(ctx)) return;
    if (consumeStaleContinuationRearm(ctx, "turn_end")) {
      if (state.goal?.status === "active" && !continuationTimerPending() && !pendingContinuationDispatchRef()) {
        scheduleContinuation(ctx, true);
      }
    }
  });

  // A model switch can happen on an agent_end before pi's core decides
  // whether its own retry budget will continue. If that budget is disabled
  // or already exhausted, settled is the safe point for exactly one fresh
  // supervised continuation — never queue it while the old run is alive.
  pi.on("agent_settled", async (_event: any, ctx: ExtensionContext) => {
    if (tryAbsorbHostSuccessor(ctx, "agent_settled")) return;
    if (sessionHandoffPending || extensionApiStale || staleTerminalDone || zombieStoodDown || isForeignCtx(ctx)) return;
    if (!state.mainModelRecovery || state.mainModelRecovery.retryAt || !lastMainModelFailure) return;
    if (!isSupervising()) return;
    lastMainModelFailure = null;
    appendLedger(ctx.cwd, "main_model_failover_continuation", { model: modelRef(ctx.model) });
    if (isLoopActive()) scheduleLoopTick(ctx);
    else if (isActionableGoal()) scheduleContinuation(ctx, true, EAGER_CONTINUATION_SETTLE_MS);
  });

  pi.on("tool_call", (event: any, ctx: ExtensionContext) => {
    // v0.34.27: ordinary tool activity can be the first observable event
    // after pi replaces a host without session_start. A file-backed,
    // same-workspace successor is absorbed; an in-memory worker is refused.
    rememberCtx(ctx);
    if (tryAbsorbHostSuccessor(ctx, "tool_call")) return;
    if (sessionHandoffPending || extensionApiStale || staleTerminalDone || zombieStoodDown || isForeignCtx(ctx)) return;
    toolCallsThisTurn++;
    noteActivity(true);
    lastStreamActivityAt = Date.now();
    streamActivityObserved = true;
    noteToolCall(event); // v0.33.0
    // v0.24.0: count loop-iteration tool calls (narration-only detection).
    if (isLoopActive()) {
      state.loop!.toolsThisTurn = (state.loop!.toolsThisTurn ?? 0) + 1;
    }
  });

  // v0.29.16: stream liveness for the zombie-run watchdog — deltas, run
  // starts, and turn starts all prove the provider stream is alive.
  // v0.34.24: before_agent_start is the strongest dispatch proof because
  // pi exposes the follow-up prompt itself. The low-level start events below
  // remain compatibility proofs for older pi builds and for custom messages.
  pi.on("before_agent_start", (event: any, ctx: ExtensionContext) => {
    // v0.34.27: absorb before the stale/foreign gates. This is the strongest
    // replacement contact because pi exposes the prompt itself.
    rememberCtx(ctx);
    if (tryAbsorbHostSuccessor(ctx, "before_agent_start")) {
      ensureAgentToolsReady(ctx, true);
      return;
    }
    if (sessionHandoffPending || extensionApiStale || staleTerminalDone || zombieStoodDown || isForeignCtx(ctx)) return;
    ensureAgentToolsReady(ctx, true);
    // v0.34.57: turn-boundary model drift (bug #1.14) — the session is about
    // to run a turn on a model different from the last observed one. Ledger
    // only: the turn already started, there is nothing to block.
    observeTurnBoundaryModel(ctx);
    dispatchStartAcknowledged(ctx, "before_agent_start", event?.prompt);
  });
  pi.on("model_select", async (event: any, ctx: ExtensionContext) => {
    rememberCtx(ctx);
    if (tryAbsorbHostSuccessor(ctx, "model_select")) return;
    if (sessionHandoffPending || extensionApiStale || staleTerminalDone || zombieStoodDown || isForeignCtx(ctx)) return;
    // v0.34.57: model-switch ledger + forbidden-model gate (bug #1.14) —
    // runs for EVERY model change (user set/cycle/restore AND the plugin's
    // own recovery rotation). The recovery-cancel block below stays scoped
    // to user-driven selections exactly as before.
    const from = modelRef(event?.previousModel);
    const to = modelRef(event?.model);
    const source = typeof event?.source === "string" ? event.source : undefined;
    const reason = mainModelSwitchInFlight ? "recovery" : source === "restore" ? "restore" : source === "cycle" ? "cycle" : "manual";
    const blocked = observeModelChange(ctx, from, to, reason, source);
    if (blocked && event?.previousModel) {
      // The forbidden gate wants the selection undone. Revert to the
      // previous model — the resulting model_select is a plain switch
      // back and is ledgered normally.
      try {
        const reverted = await extensionApi?.setModel(event.previousModel);
        if (reverted) {
          ctx.ui.notify(`Forbidden model ${to} was blocked by the glla policy gate (forbiddenModels) and reverted to ${from}.`, "warning");
        } else {
          ctx.ui.notify(`Forbidden model ${to} selected — the glla policy gate blocks it, but pi did not accept the revert. Switch away manually.`, "warning");
        }
      } catch {
        // The violation is already ledgered; the session keeps the model.
      }
    }
    // A host restore selection is lifecycle plumbing, not user consent to
    // cancel a durable recovery episode. Only a real user/cycle selection
    // rebases the automatic chain; the plugin's own recovery selection is
    // fenced by mainModelSwitchInFlight above.
    if (mainModelSwitchInFlight || source === "restore" || !state.mainModelRecovery) return;
    clearMainModelRecoveryTimer();
    state.mainModelRecovery = undefined;
    setContinuationDispatchStoodDownRef(false);
    appendLedger(ctx.cwd, "main_model_recovery_cancelled", { via: "manual-model-select", model: modelRef(ctx.model), source });
    persistState(ctx);
    ctx.ui.notify("Manual model selection cancelled the automatic main-model recovery cycle. Resume the goal when ready.", "info");
  });

  pi.on("message_update", (_event: any, ctx: ExtensionContext) => {
    rememberCtx(ctx);
    if (tryAbsorbHostSuccessor(ctx, "message_update")) return;
    if (sessionHandoffPending || extensionApiStale || staleTerminalDone || zombieStoodDown || isForeignCtx(ctx)) return;
    lastStreamActivityAt = Date.now();
    streamActivityObserved = true;
    dispatchStartAcknowledged(ctx, "message_update");
  });
  pi.on("agent_start", (_event: any, ctx: ExtensionContext) => {
    rememberCtx(ctx);
    signalSupervisionEvent({ plane: state.mainModelRecovery ? "provider-recovery" : state.loop?.active ? "loop" : state.goal?.policy === "list" ? "list" : state.goal ? "goal" : "queue", kind: "start", source: "agent_start" });
    clearInBandProviderFailure();
    if (tryAbsorbHostSuccessor(ctx, "agent_start")) {
      ensureAgentToolsReady(ctx, true);
      return;
    }
    if (sessionHandoffPending || extensionApiStale || staleTerminalDone || zombieStoodDown || isForeignCtx(ctx)) return;
    ensureAgentToolsReady(ctx, true);
    lastStreamActivityAt = Date.now();
    lastTurnStartAt = lastStreamActivityAt;
    streamActivityObserved = true;
    // v0.32.1: a real turn started — the post-compaction resume debt is
    // discharged (the heartbeat stops retrying it).
    postCompactResumeOwed = false;
    dispatchStartAcknowledged(ctx, "agent_start");
  });
  pi.on("turn_start", (_event: any, ctx: ExtensionContext) => {
    rememberCtx(ctx);
    if (tryAbsorbHostSuccessor(ctx, "turn_start")) {
      ensureAgentToolsReady(ctx, true);
      return;
    }
    if (sessionHandoffPending || extensionApiStale || staleTerminalDone || zombieStoodDown || isForeignCtx(ctx)) return;
    ensureAgentToolsReady(ctx, true);
    lastStreamActivityAt = Date.now();
    lastTurnStartAt = lastStreamActivityAt;
    streamActivityObserved = true;
    dispatchStartAcknowledged(ctx, "turn_start");
  });

  // v0.34.71 — subagent_session ledger (OPEN-ISSUES 1.16: "Subagents lost
  // between restarts"): pi-subagents broadcasts a cross-extension lifecycle
  // event (pi.events) when an Agent-tool subagent transitions to running —
  // once per spawn, foreground AND background, payload { id, type,
  // description }. Ledger the spawn (session id + summary) so the parent
  // can recover the reference after a /reload: the ledger lives on disk in
  // .pi-glla/active.jsonl and survives restarts, unlike the in-process
  // agent registry. Queued/repeating observations (resume, re-run) append
  // again — fresh evidence the reference is alive.
  // Current pi-subagents uses versioned `subagent:*` events instead of the
  // legacy `subagents:*` names. The heartbeat adapter also reads its durable
  // async status artifact, so these listeners deliberately do not capture a
  // context for later use.
  pi.events.on("subagent:async-started", (data: unknown) => {
    if (sessionHandoffPending || extensionApiStale || staleTerminalDone || zombieStoodDown) return;
    observeCurrentSubagentStart(data);
    const ctx = freshCtx();
    if (!ctx) return;
    signalSupervisionEvent({ plane: "subagent", kind: "start", source: "subagent:async-started" });
    const e = (data ?? {}) as { id?: unknown; runId?: unknown; sessionId?: unknown; agent?: unknown; task?: unknown; goal?: unknown; mode?: unknown };
    const sessionId = typeof e.sessionId === "string" && e.sessionId.trim()
      ? e.sessionId.trim()
      : typeof e.id === "string" && e.id.trim()
        ? e.id.trim()
        : typeof e.runId === "string" && e.runId.trim() ? e.runId.trim() : undefined;
    if (!sessionId) return;
    const candidate = [e.task, e.goal].find((value) => typeof value === "string" && value.trim() && !/^\[prompt redacted\]$/i.test(value.trim()));
    const summary = typeof candidate === "string" ? candidate : typeof e.mode === "string" ? e.mode : "async run";
    appendLedger(ctx.cwd, "subagent_session", {
      sessionId,
      agentType: typeof e.agent === "string" ? e.agent : undefined,
      summary,
      goalId: state.goal?.status === "active" ? state.goal.id : undefined,
      at: nowIso(),
    });
  });
  pi.events.on("subagent:steering-notice", (data: unknown) => {
    if (sessionHandoffPending || extensionApiStale || staleTerminalDone || zombieStoodDown) return;
    observeCurrentSubagentProgress(data);
    if (!freshCtx()) return;
    signalSupervisionEvent({ plane: "subagent", kind: "progress", source: "subagent:steering-notice" });
  });
  pi.events.on("subagent:async-complete", (data: unknown) => {
    if (sessionHandoffPending || extensionApiStale || staleTerminalDone || zombieStoodDown) return;
    observeCurrentSubagentComplete(data);
    if (!freshCtx()) return;
    signalSupervisionEvent({ plane: "subagent", kind: "complete", source: "subagent:async-complete" });
  });
  pi.events.on("subagent:process-terminal", (data: unknown) => {
    if (sessionHandoffPending || extensionApiStale || staleTerminalDone || zombieStoodDown) return;
    observeCurrentSubagentTerminal(data);
    if (!freshCtx()) return;
    signalSupervisionEvent({ plane: "subagent", kind: "complete", source: "subagent:process-terminal" });
  });
  pi.events.on("subagent:foreground-complete", (data: unknown) => {
    if (sessionHandoffPending || extensionApiStale || staleTerminalDone || zombieStoodDown) return;
    observeCurrentSubagentComplete(data);
    if (!freshCtx()) return;
    signalSupervisionEvent({ plane: "subagent", kind: "complete", source: "subagent:foreground-complete" });
  });

  pi.events.on("subagents:started", (data: unknown) => {
    if (sessionHandoffPending || extensionApiStale || staleTerminalDone || zombieStoodDown) return;
    const ctx = freshCtx();
    if (!ctx) return;
    signalSupervisionEvent({ plane: "subagent", kind: "start", source: "subagents:started" });
    const e = (data ?? {}) as { id?: unknown; type?: unknown; description?: unknown };
    const sessionId = typeof e.id === "string" && e.id.length > 0 ? e.id : undefined;
    if (!sessionId) return;
    appendLedger(ctx.cwd, "subagent_session", {
      sessionId,
      agentType: typeof e.type === "string" ? e.type : undefined,
      summary: typeof e.description === "string" ? e.description : undefined,
      goalId: state.goal?.status === "active" ? state.goal.id : undefined,
      at: nowIso(),
    });
    // v0.34.85: seed the hang-watchdog probe (spawn = baseline evidence).
    upsertSubagentHangProbe(sessionId, typeof e.type === "string" ? e.type : undefined, typeof e.description === "string" ? e.description : undefined, Date.now(), sessionId);
  });

  // v0.34.85 — subagent hang watchdog inputs. Progress evidence (compacted =
  // the session survived a compaction → alive and working; steered = a steer
  // landed) refreshes the probe's streak; terminal events (completed/failed)
  // stop the watch. The watchdog scan itself lives in heartbeatTick.
  pi.events.on("subagents:compacted", (data: unknown) => {
    if (sessionHandoffPending || extensionApiStale || staleTerminalDone || zombieStoodDown) return;
    if (!freshCtx()) return;
    const e = (data ?? {}) as { id?: unknown };
    const recordId = typeof e.id === "string" && e.id.length > 0 ? e.id : undefined;
    signalSupervisionEvent({ plane: "subagent", kind: "progress", source: "subagents:compacted" });
    if (recordId) markSubagentHangProgress(recordId);
  });
  pi.events.on("subagents:steered", (data: unknown) => {
    if (sessionHandoffPending || extensionApiStale || staleTerminalDone || zombieStoodDown) return;
    if (!freshCtx()) return;
    const e = (data ?? {}) as { id?: unknown };
    const recordId = typeof e.id === "string" && e.id.length > 0 ? e.id : undefined;
    signalSupervisionEvent({ plane: "subagent", kind: "progress", source: "subagents:steered" });
    if (recordId) markSubagentHangProgress(recordId);
  });
  pi.events.on("subagents:completed", (data: unknown) => {
    if (sessionHandoffPending || extensionApiStale || staleTerminalDone || zombieStoodDown) return;
    if (!freshCtx()) return;
    const e = (data ?? {}) as { id?: unknown };
    const recordId = typeof e.id === "string" && e.id.length > 0 ? e.id : undefined;
    signalSupervisionEvent({ plane: "subagent", kind: "complete", source: "subagents:completed" });
    if (recordId) endSubagentHangProbe(recordId);
  });
  pi.events.on("subagents:failed", (data: unknown) => {
    if (sessionHandoffPending || extensionApiStale || staleTerminalDone || zombieStoodDown) return;
    if (!freshCtx()) return;
    const e = (data ?? {}) as { id?: unknown };
    const recordId = typeof e.id === "string" && e.id.length > 0 ? e.id : undefined;
    signalSupervisionEvent({ plane: "subagent", kind: "block", source: "subagents:failed" });
    if (recordId) endSubagentHangProbe(recordId);
  });

  // v0.35.51 (note.md Now): payload guard — bound inline base64 image bytes
  // on EVERY outgoing LLM call. Generated images accumulate in history until
  // the provider rejects the request with 413 ("Downloaded image content
  // cannot exceed 30MB"), and every main-model-recovery probe re-sent the
  // same bloated history so recovery could never classify or heal the
  // failure. The `context` event fires before each provider call with the
  // outgoing message list; projecting it here protects ordinary turns AND
  // recovery probes at one chokepoint. The session transcript on disk is
  // NOT touched — this is a per-send projection. Always-on (not gated on a
  // live goal): the wedge hits any image-heavy session this extension runs.
  // The cast at the boundary is sound: the projection only replaces image
  // blocks with text placeholders inside existing message objects, never
  // re-shapes messages.
  pi.on("context", (event: ContextEvent, ctx: ExtensionContext) => {
    const messages = event?.messages;
    if (!Array.isArray(messages)) return {};
    const projection = payloadGuardProjection(messages);
    // v0.35.52: error-turn hygiene — failed error-only assistant turns
    // (stopReason "error", no tool calls) are dropped from the effective
    // context except the most recent one (retry continuity). Failed turns
    // accumulate forever otherwise: polis hit 122.7% of a 200k window on
    // error entries alone, and compaction then aborted on its own bloat.
    const hygiene = dropFailedErrorOnlyTurns(projection.messages);
    // v0.36.2: continuation payloads are control-plane state, not durable
    // conversation. Once more than one has accumulated, retain only the
    // newest dispatch payload and insert one bounded checkpoint built from
    // the current durable goal. This is a per-send projection: the transcript
    // and lifecycle state remain untouched, while compaction/recovery turns
    // still receive the objective, contract, audit evidence, and fences.
    // v0.36.3: metric/spec loops are a separate authoritative work surface
    // from Goal. A loop may legitimately run with no goal, and a paused goal
    // may coexist with an active loop. Project whenever either surface is
    // active, while passing both states so a paused goal is not mistaken for
    // the loop's current objective.
    const activeLoop = state.loop?.active === true ? state.loop : null;
    const checkpointProjection = state.goal || activeLoop
      ? projectBoundedGllaContext(
        hygiene.messages,
        buildAuthoritativeContextCheckpoint({
          goal: state.goal,
          loop: activeLoop,
          sessionGeneration,
          ownerSessionId: sessionManagerId(ctx),
        }),
      )
      : {
        messages: hygiene.messages,
        removedPayloads: 0,
        insertedCheckpoint: false,
        retainedPayloads: 0,
        originalPayloads: 0,
        checkpointChars: 0,
      };
    if (projection.evicted.length === 0 && hygiene.dropped.length === 0 && checkpointProjection.removedPayloads === 0) return {};
    try {
      if (hygiene.dropped.length > 0) {
        appendLedger(ctx.cwd, "context_hygiene_dropped", {
          dropped: hygiene.dropped.length,
          kept: hygiene.kept,
          lastError: hygiene.dropped[hygiene.dropped.length - 1]?.errorMessage?.slice(0, 160),
          generation: sessionGeneration,
        });
      }
      if (projection.evicted.length > 0) {
        appendLedger(ctx.cwd, "payload_guard_eviction", {
          evicted: projection.evicted.length,
          bytesFreed: projection.totalImageBytes - projection.remainingImageBytes,
          remainingImageBytes: projection.remainingImageBytes,
          generation: sessionGeneration,
        });
      }
      if (checkpointProjection.removedPayloads > 0) {
        appendLedger(ctx.cwd, "context_checkpoint_projection", {
          goalId: state.goal?.id,
          loopTarget: activeLoop?.target?.slice(0, 300),
          loopIteration: activeLoop?.iteration,
          removedPayloads: checkpointProjection.removedPayloads,
          retainedPayloads: checkpointProjection.retainedPayloads,
          checkpointChars: checkpointProjection.checkpointChars,
          generation: sessionGeneration,
        });
      }
    } catch {
      // The projection itself must never fail a send over ledger bookkeeping.
    }
    return { messages: checkpointProjection.messages as unknown as ContextEvent["messages"] };
  });

  // v0.35.52: the same bounded rule prunes the compaction summarization
  // input — the preparation object is shared by reference with the compaction
  // runner, so reassigning the message arrays here shrinks the summarizer
  // request and keeps failed turns out of the summary. Never cancels and
  // never supplies its own compaction; firstKeptEntryId and friends untouched.
  pi.on("session_before_compact", (event: { preparation?: unknown }, ctx: ExtensionContext) => {
    const dropped = pruneCompactionPreparation(event?.preparation);
    if (dropped > 0) {
      try {
        appendLedger(ctx.cwd, "context_hygiene_compaction_input", { dropped, generation: sessionGeneration });
      } catch {
        // bookkeeping must never break compaction
      }
    }
    return {};
  });
}
