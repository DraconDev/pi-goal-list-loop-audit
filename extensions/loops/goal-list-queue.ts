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

import { defineTool, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
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
  ledgerPath,
  crossRecommendMode,
  formatListDepth,
  parseListItemDeclaration,
  shouldEscalateStall,
  isStaleApiError,
  parseListImport,

  routeGoalArgs,
  draftingTemplateFile,
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
  type ObjectiveRepairTarget,
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
import {
  classifyMainModelFailure,
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
  parseLedgerEntries,
  filterPremature,
  formatRollupJson,
  formatRollupTable,
  rollupProject,
  type ProjectRollup,
} from "../goal-loop-stats.js";
import {
  cancelDetachedGoalCompletionAuditor,
  newDetachedAuditJobAttemptId,
  runDetachedGoalCompletionAuditor,
  type AuditorProgress,
} from "../goal-loop-auditor-process.js";
import {
  REPETITION,
  isActuallyStuck,
  loopInterventionDirective,
  continueVariant,
  textFingerprint,
  pushCapped as pushRepetitionCapped,
} from "../goal-loop-repetition.js";
import { buildStatusText, buildWidgetLines, type AuditDisplayProgress } from "../goal-loop-display.js";
import {
  defaultAgentDir,
  resolveEffectiveSubagentModel,
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
import {
  createGoalHeartbeat,
  endSubagentHangProbe,
  markSubagentHangProgress,
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
  AUDITOR_WALL_TIMEOUT_MS,
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
import {
  resolveDrafterModel,
  type DrafterModelCandidate,
} from "../drafter-model.js";
import {
  assessSuspiciousObjective,
  deriveObjectiveFromContract,
  buildRepairTaskObjective,
} from "../faulty-objective-recovery.js";

// =================================================================
// Loop 2: /list list
// =================================================================

function listQueue(): NonNullable<State["list"]> {
  return state.list ?? [];
}

interface DraftingModelLease {
  originalModel: any;
  originalThinkingLevel: string;
  activeRef: string;
  activeThinkingLevel: string;
  requestedThinkingLevel: string;
  candidates: DrafterModelCandidate[];
  attempted: string[];
  generation: number;
}

let draftingModelLease: DraftingModelLease | null = null;
let draftingModelRestoreInFlight: Promise<void> | null = null;
const DRAFTER_RECOVERY_PROMPT = "The drafting model turn failed. Resume the existing drafting interview from the conversation, keep the user's intent, ask at most one focused decision question if truly necessary, and continue toward the appropriate propose_* tool. Do not restart the interview or implement work.";

/** Read the host's current thinking level without making older/test hosts a
 * hard failure. The real ExtensionAPI exposes both accessors; the fallback to
 * the event context keeps the lease logic honest when only the read-only side
 * is available. */
function currentThinkingLevel(ctx: ExtensionContext): string {
  const api = extensionApi as any;
  try {
    if (typeof api?.getThinkingLevel === "function") return String(api.getThinkingLevel());
  } catch {
    // Fall through to the context snapshot.
  }
  return String(ctx.thinkingLevel ?? "off");
}

/** Apply the configured drafting level to the temporary agent. Pi clamps the
 * request to the selected model's capabilities, so the returned value is the
 * effective level that must be compared during restoration. */
function applyDrafterThinkingLevel(ctx: ExtensionContext, requested: string): string {
  const api = extensionApi as any;
  try {
    if (typeof api?.setThinkingLevel === "function") api.setThinkingLevel(requested);
  } catch {
    // A missing/stale host action must not turn a drafting model switch into
    // a new failure; the model lease remains independently recoverable.
  }
  return currentThinkingLevel(ctx);
}

/** Select the drafting-only model and retain a generation-fenced restore lease. */
async function beginDrafterModel(ctx: ExtensionContext): Promise<void> {
  await restoreDrafterModel();
  const settings = loadSettings(ctx.cwd);
  const resolution = resolveDrafterModel(ctx, settings);
  const selected = resolution.selected;
  if (!selected || !ctx.model || !extensionApi) {
    if (resolution.configuredRefs.length > 0 && selected?.via === "session-last-resort") {
      appendLedger(ctx.cwd, "drafter_model_fallback", { configured: resolution.configuredRefs, via: "session-model" });
      ctx.ui.notify("Configured drafter models were unavailable; drafting stays on the current session model. Main and auditor recovery chains are unchanged.", "warning");
    }
    return;
  }
  const originalModel = ctx.model;
  const beforeRef = modelRef(originalModel);
  if (!beforeRef) return;
  const originalThinkingLevel = currentThinkingLevel(ctx);
  const requestedThinkingLevel = String(settings.drafterThinkingLevel ?? originalThinkingLevel);
  if (selected.via === "session-last-resort") {
    const activeThinkingLevel = applyDrafterThinkingLevel(ctx, requestedThinkingLevel);
    draftingModelLease = {
      originalModel,
      originalThinkingLevel,
      activeRef: selected.ref,
      activeThinkingLevel,
      requestedThinkingLevel,
      candidates: resolution.candidates,
      // The current session model is a bounded same-model retry, not a model
      // switch. It must remain unattempted so one drafting error can replay
      // the interview without consulting main-goal recovery.
      attempted: [],
      generation: sessionGeneration,
    };
    if (resolution.configuredRefs.length > 0) {
      appendLedger(ctx.cwd, "drafter_model_fallback", { configured: resolution.configuredRefs, via: "session-model" });
      ctx.ui.notify("Configured drafter models were unavailable; drafting stays on the current session model. Main and auditor recovery chains are unchanged.", "warning");
    }
    return;
  }
  if (beforeRef.toLowerCase() === selected.ref.toLowerCase()) {
    const activeThinkingLevel = applyDrafterThinkingLevel(ctx, requestedThinkingLevel);
    draftingModelLease = {
      originalModel,
      originalThinkingLevel,
      activeRef: selected.ref,
      activeThinkingLevel,
      requestedThinkingLevel,
      candidates: resolution.candidates,
      attempted: [selected.ref],
      generation: sessionGeneration,
    };
    appendLedger(ctx.cwd, "drafter_model_selected", { from: beforeRef, to: selected.ref, candidates: resolution.configuredRefs, alreadyActive: true });
    return;
  }
  let switched = false;
  try { switched = await extensionApi.setModel(selected.model); } catch { switched = false; }
  if (!switched) {
    appendLedger(ctx.cwd, "drafter_model_fallback", { configured: resolution.configuredRefs, selected: selected.ref, via: "session-model", reason: "setModel rejected" });
    ctx.ui.notify(`Drafter model ${selected.ref} could not be selected; drafting stays on the current session model.`, "warning");
    return;
  }
  const activeThinkingLevel = applyDrafterThinkingLevel(ctx, requestedThinkingLevel);
  draftingModelLease = {
    originalModel,
    originalThinkingLevel,
    activeRef: selected.ref,
    activeThinkingLevel,
    requestedThinkingLevel,
    candidates: resolution.candidates,
    attempted: [selected.ref],
    generation: sessionGeneration,
  };
  appendLedger(ctx.cwd, "drafter_model_selected", { from: beforeRef, to: selected.ref, candidates: resolution.configuredRefs });
  ctx.ui.notify(`Drafting uses ${selected.ref} temporarily; the session model will be restored when drafting ends.`, "info");
}

/** Restore the pre-drafting model unless the user changed it meanwhile. */
async function restoreDrafterModel(): Promise<void> {
  if (draftingModelRestoreInFlight) {
    await draftingModelRestoreInFlight;
    return;
  }
  const lease = draftingModelLease;
  draftingModelLease = null;
  if (!lease || lease.generation !== sessionGeneration || !extensionApi) return;
  const fresh = (globalThis as any).freshCtx as (() => ExtensionContext | null) | undefined;
  const liveCtx = fresh ? fresh() : null;
  const currentCtx = liveCtx ?? lastCtx;
  const currentRef = modelRef(currentCtx?.model);
  if (currentRef && currentRef.toLowerCase() !== lease.activeRef.toLowerCase()) {
    appendLedger(currentCtx?.cwd ?? process.cwd(), "drafter_model_restore_skipped", { active: lease.activeRef, current: currentRef, reason: "model changed during drafting" });
    return;
  }
  if ((globalThis as any).extensionApiStale) {
    appendLedger(currentCtx?.cwd ?? process.cwd(), "drafter_model_restore_skipped", { active: lease.activeRef, reason: "extension handle stale" });
    return;
  }
  const originalRef = modelRef(lease.originalModel);
  const currentThinking = currentCtx ? currentThinkingLevel(currentCtx) : undefined;
  const shouldRestoreThinking = currentThinking === lease.activeThinkingLevel;
  if (currentRef && originalRef && currentRef.toLowerCase() === originalRef.toLowerCase()) {
    if (shouldRestoreThinking && currentCtx) applyDrafterThinkingLevel(currentCtx, lease.originalThinkingLevel);
    appendLedger(currentCtx?.cwd ?? process.cwd(), "drafter_model_restored", { to: originalRef, alreadyActive: true });
    return;
  }
  const restore = (async () => {
    try {
      const restored = await extensionApi.setModel(lease.originalModel);
      if (restored && shouldRestoreThinking && currentCtx) applyDrafterThinkingLevel(currentCtx, lease.originalThinkingLevel);
      appendLedger(currentCtx?.cwd ?? process.cwd(), restored ? "drafter_model_restored" : "drafter_model_restore_failed", { to: originalRef });
      if (!restored) currentCtx?.ui.notify("The drafting model could not be restored; the current model remains active. Main and auditor settings were not changed.", "warning");
    } catch {
      appendLedger(currentCtx?.cwd ?? process.cwd(), "drafter_model_restore_failed", { to: originalRef });
      currentCtx?.ui.notify("The drafting model could not be restored; the current model remains active. Main and auditor settings were not changed.", "warning");
    }
  })();
  draftingModelRestoreInFlight = restore;
  try {
    await restore;
  } finally {
    if (draftingModelRestoreInFlight === restore) draftingModelRestoreInFlight = null;
  }
}

/**
 * Generic drafting recovery: walk the dedicated chain after any provider
 * error and replay a continuation of the existing interview. No error text
 * is classified and the main-model recovery chain is never consulted.
 */
async function handleDrafterModelFailure(ctx: ExtensionContext): Promise<boolean> {
  const lease = draftingModelLease;
  if (!lease || draftingTarget === null || lease.generation !== sessionGeneration || !extensionApi) return false;
  for (const candidate of lease.candidates) {
    if (lease.attempted.some((ref) => ref.toLowerCase() === candidate.ref.toLowerCase())) continue;
    lease.attempted.push(candidate.ref);
    let switched = false;
    try { switched = await extensionApi.setModel(candidate.model); } catch { switched = false; }
    const alreadyActive = candidate.ref.toLowerCase() === lease.activeRef.toLowerCase();
    if (!switched && !alreadyActive) continue;
    const previous = lease.activeRef;
    lease.activeRef = candidate.ref;
    lease.activeThinkingLevel = applyDrafterThinkingLevel(ctx, lease.requestedThinkingLevel);
    appendLedger(ctx.cwd, alreadyActive ? "drafter_model_retry" : "drafter_model_fallback", { from: previous, to: candidate.ref, attempted: lease.attempted });
    ctx.ui.notify(`Drafting provider failed; retrying the existing interview on ${candidate.ref}.`, "warning");
    const safeSteer = (globalThis as any).safeSteerUser as ((context: ExtensionContext, text: string) => boolean) | undefined;
    if (!safeSteer || !safeSteer(ctx, DRAFTER_RECOVERY_PROMPT)) return false;
    draftingSeedInFlight = true;
    return true;
  }
  draftingModelLease = null;
  appendLedger(ctx.cwd, "drafter_model_fallback_exhausted", { attempted: lease.attempted });
  ctx.ui.notify("The dedicated drafter chain is exhausted; the drafting interview remains open on the current model. Retry the drafting command when ready.", "warning");
  return false;
}

/**
 * v0.34.81 (LIGHT parent/child): count of open children for a queue item
 * (used as the GROUP cardinality surfaced in /list show). A child is open
 * while it is queued OR while it is the active goal (it gets taken out of
 * the queue at activation). When the active child completes, archiveCurrentGoal
 * reads the goal's parentId and uses this helper to decide whether the parent
 * is now childless → cascade close.
 */
function groupOpenChildren(groupId: string): number {
  const inQueue = listQueue().filter((c) => c.parentId === groupId).length;
  const activeChild = state.goal && state.goal.parentId === groupId && state.goal.status !== "complete" && state.goal.status !== "aborted" ? 1 : 0;
  return inQueue + activeChild;
}

/** Keep the malformed queue item in place and put a safe, actionable repair
 * item immediately ahead of it. The original is not silently dropped or
 * archived merely because activation was attempted. */
function queueRepairAheadOfListItem(ctx: ExtensionContext, item: ListItem, assessment: ReturnType<typeof assessSuspiciousObjective>): void {
  const repairObjective = buildRepairTaskObjective({ policy: "list", objective: item.objective } as Goal, assessment);
  const target: ObjectiveRepairTarget = {
    id: item.id,
    objective: item.objective,
    ...(item.verificationContract ? { verificationContract: item.verificationContract } : {}),
    reasons: [...assessment.reasons],
    source: "list-activation",
  };
  const existing = listQueue().find((queued) => queued.objective === repairObjective);
  if (existing) {
    if (!existing.repairTarget) {
      const repaired = { ...existing, repairTarget: target };
      const written = writeQueueItemFile(ctx.cwd, repaired, { replace: true });
      if (written.failed) {
        ctx.ui.notify("Could not persist the repair target; the original queued item remains unchanged.", "warning");
        return;
      }
      replaceState({ ...state, list: listQueue().map((queued) => queued.id === existing.id ? repaired : queued) });
      persistState(ctx);
      appendLedger(ctx.cwd, "faulty_objective_repair_target_recovered", { goalId: existing.id, targetId: item.id, source: "list-activation" });
    }
    return;
  }
  const before = new Set(listQueue().map((queued) => queued.id));
  enqueueItems(ctx, [repairObjective], "faulty-objective", { autoActivate: false });
  const added = listQueue().find((queued) => !before.has(queued.id) && queued.objective === repairObjective);
  if (!added) return;
  const repair = { ...added, repairTarget: target };
  const repairWritten = writeQueueItemFile(ctx.cwd, repair, { replace: true });
  if (repairWritten.failed) {
    ctx.ui.notify("Could not persist the repair target; the queued repair remains without promotion metadata.", "warning");
    return;
  }
  const rest = listQueue().filter((queued) => queued.id !== added.id);
  replaceState({ ...state, list: [repair, ...rest] });
  persistState(ctx);
  appendLedger(ctx.cwd, "faulty_objective_repair_promoted", { goalId: repair.id, targetId: item.id, position: 1, source: "list-activation", reasons: assessment.reasons });
}

function activateNextListItem(ctx: ExtensionContext, n = 1, opts?: { explicit?: boolean }): boolean {
  // An explicit list activation is user consent even when pi initially
  // reported a blank startup context; automatic restore never reaches here.
  releaseInitialSessionLoadBarrier();
  // v0.28.14: one-active-thing choke point — NO call site (session_start,
  // completion cascade, /list next, list_activate, list-draft auto-activate)
  // may activate a list item over a live loop, present or future.
  if (isLoopActive()) {
    // v0.35.22 (note.md Next #3, field 2026-08-21): this refusal used to be
    // LEDGER-ONLY — a queued repair card behind a paused suspicious goal
    // was unstartable AND invisibly so (screenshots 134442/134645: the user
    // is told to run /list next, it silently no-ops while a loop holds the
    // surface). One-active-thing still refuses, but LOUDLY and with the way
    // out; the loop-end cascade (announceQueuedListAfterLoopEnd) surfaces
    // that the item is startable again once the loop ends.
    const head = listQueue()[0];
    appendLedger(ctx.cwd, "list_activation_blocked_loop", {
      ...(head ? { queueItemId: head.id, objective: head.objective.slice(0, 200) } : {}),
    });
    ctx.ui.notify(
      head
        ? `The queued item cannot start while a loop owns the surface — "${head.objective.slice(0, 80)}" stays queued. /loop stop the loop (or let its bounds end it), then /list next starts the item.`
        : "A loop is active — one active thing at a time. /loop stop it first, then /list next.",
      "warning",
    );
    return false;
  }
  // v0.28.14: carryover resolution runs BEFORE the item is taken — under
  // carryover=clear the stale queue is dropped first and there is nothing
  // to activate; under pause the ONE summary precedes the activation.
  // Durable sidecars are actionable queue state. Recover them before
  // carryover policy or explicit activation can inspect the head.
  hydrateListQueueFromDisk(ctx);
  resolveCarryover(ctx, "list");
  const queue = listQueue();  // v0.34.81 (LIGHT parent/child): a group (queue item with one or more
  // open children) is not a work item. The auto-advance SILENTLY SKIPS the
  // head group and lands on its first open child — children are queued
  // immediately after the parent, so the scan takes the natural next item
  // for free. An EXPLICIT user pick on a group refuses loudly: `/list next 1`
  // landing on a group would silently activate a child, which is confusing
  // ("I asked for item 1 but item 2 started"). list_activate (the tool) and
  // `/list next <n>` both pass explicit:true; the cascade advance and
  // enqueue auto-activate leave it false.
  if (n === 1 && !opts?.explicit) {
    let scan = 0;
    while (scan < queue.length && groupOpenChildren(queue[scan]!.id) > 0) scan++;
    n = scan + 1;
  } else if (opts?.explicit && queue[n - 1] && groupOpenChildren(queue[n - 1]!.id) > 0) {
    const target = queue[n - 1]!;
    const open = groupOpenChildren(target.id);
    appendLedger(ctx.cwd, "list_group_activation_refused", { goalId: target.id, open });
    ctx.ui.notify(
      `List item #${n} is a group with ${open} open subtask${open === 1 ? "" : "s"} — complete its subtasks first (they run in queue order, then the group closes itself).`,
      "warning",
    );
    return false;
  }
  const candidate = queue[n - 1];
  let derivedObjective: string | undefined;
  if (candidate) {
    // v0.35.53: heal legacy malformed items deterministically — an item with
    // an EMPTY objective but a clean, actionable contract (field: the draft
    // batch that wrote "" + full intent into the contract, then got blocked
    // as "empty" ×42 over 22h) derives its objective from the contract's
    // leading imperative instead of demanding a repair card. Contracts that
    // are themselves suspicious stay on the true broken-objective path.
    let objectiveText = candidate.objective;
    derivedObjective = undefined;
    if (!objectiveText.trim() && candidate.verificationContract) {
      const derived = deriveObjectiveFromContract(candidate.verificationContract);
      if (derived) {
        objectiveText = derived;
        derivedObjective = derived;
      }
    }
    const assessment = assessSuspiciousObjective(objectiveText, candidate.verificationContract);
    if (assessment.suspicious) {
      appendLedger(ctx.cwd, "faulty_objective_list_activation_blocked", {
        queueItemId: candidate.id,
        reasons: assessment.reasons,
      });
      queueRepairAheadOfListItem(ctx, candidate, assessment);
      ctx.ui.notify("The queued item looks like reviewer/verification text, so it was not activated; a safe repair item is next in the list.", "warning");
      return false;
    }
  }
  const taken = takeAt(queue, n);
  if (!taken) return false;
  const [rawNext, rest] = taken;
  if (derivedObjective) {
    appendLedger(ctx.cwd, "list_objective_derived_from_contract", { queueItemId: rawNext.id, objective: derivedObjective.slice(0, 200) });
  }
  const next = { ...rawNext, ...(derivedObjective ? { objective: derivedObjective } : {}) };
  replaceState({ ...state, list: rest });
  // v0.34.60: remove the disk sidecar. The active goal .md takes its
  // place via setGoal → writeGoalMd; the sidecar would re-show the item
  // as queued if a stale-handle /list read happened later.
  deleteQueueItemFile(ctx.cwd, next.id);
  const goal = createGoal(next.objective, ctx, "list");
  if (next.agentRole) goal.agentRole = next.agentRole;
  if (next.verificationContract) {
    goal.verificationContract = next.verificationContract;
    goal.objectiveProvenance = {
      ...(goal.objectiveProvenance ?? { originalObjective: next.objective }),
      originalContract: next.verificationContract,
    };
  }
  // v0.34.81: carry the subtask binding onto the active goal so the cascade
  // in archiveCurrentGoal can find the parent at completion time, and so the
  // group-open counter (active child = +1) stays accurate while a child runs.
  if (next.parentId) goal.parentId = next.parentId;
  if (next.repairTarget) {
    goal.repairTarget = next.repairTarget;
    goal.objectiveProvenance = {
      ...(goal.objectiveProvenance ?? { originalObjective: next.objective }),
      ...(next.repairTarget.verificationContract ? { originalContract: next.repairTarget.verificationContract } : {}),
    };
  }
  if (!setGoal(goal, ctx, "list-cascade")) {
    // The queue item was removed before activation so its sidecar could not
    // masquerade as waiting work. Restore both durable representations when
    // the prior live objective could not be archived safely.
    const restored = writeQueueItemFile(ctx.cwd, next);
    if (restored.failed) ctx.ui.notify("Could not restore the list sidecar after activation failed; fix disk access before retrying.", "warning");
    replaceState({ ...state, list: queue });
    persistState(ctx);
    return false;
  }
  iterationCounter = 0;
  consecutiveErrorIterations = 0;
  consecutiveAbortIterations = 0;
  ctx.ui.notify(`List item #${n} activated (${rest.length} remaining): ${displaySlice(goal.objective, 80)}`, "info");
  scheduleContinuation(ctx, true);
  return true;
}

// =================================================================
// Drafting: /goal with no args → clarify → Confirm dialog → activate
// =================================================================

async function startDrafting(ctx: ExtensionContext, target: "goal" | "list" | "loop", seed?: string, depth: "normal" | "plan" = "normal"): Promise<boolean> {
  // A stale/handoff-bound MAIN cannot deliver the seed. Do not leave the
  // module in drafting mode: that orphaned gate makes later list_add and
  // propose_goal_draft calls look like user disapprovals until restart.
  if (sessionHandoffPending || extensionApiStale || staleTerminalDone || zombieStoodDown || probeExtensionApiStale()) {
    clearDraftingState();
    return false;
  }
  draftingTarget = target;
  // v0.35.44: no draftingDepth write — the write-only global was removed;
  // template selection goes through draftingTemplateFile(target, depth).
  const labels: Record<string, [string, string]> = {
    goal: ["Goal drafting", "propose_goal_draft"],
    list: ["Goal drafting (for the list)", "propose_goal_draft"],
    loop: ["Loop drafting", "propose_loop_draft"],
  };
  const [baseLabel, tool] = labels[target]!;
  // v0.35.33: plan depth swaps in the extended-draft prompt (research-first,
  // multi-round interview, structured expanded objective).
  const file = draftingTemplateFile(target, depth);
  const label = depth === "plan" ? `${baseLabel} — deep planning` : baseLabel;
  // v0.35.33: plan depth tells the user (and the seeded agent) what makes it
  // different: research before questions, rounds, structured expanded objective.
  const planNote = depth === "plan"
    ? " DEEP PLANNING MODE: research the code FIRST, then interview in ROUNDS (architecture → scope → failure conditions → verification); the proposal will be a structured expanded contract, far more detailed than a regular draft."
    : "";
  // v0.35.45 (audit finding): join with an explicit separator — direct
  // concatenation produced "…regular draft.Goal drafting — deep planning: …".
  const seededHint = (planNote ? `${planNote} ` : "") + (
    target === "list"
      ? `${label}: free-text is valid without a "Done when:" clause — the agent will turn it into short list items and grill for concrete per-item contracts (nothing activates until you confirm). To skip drafting, include a per-item "Done when:" clause.`
      : target === "loop"
        ? `${label}: a loop target needs a metric and a direction — the agent will help you design them first (nothing activates until you confirm). Skip the interview entirely: /loop start "<target>" (bare = infinite metricless) or /loop start "<target>" measure="<cmd>" direction=min|max [window=5] [max=50] [time=h] [tokens=n] [branch=1].`
        : `${label}: the objective has no "Done when:" clause — the agent will grill you about it first (nothing activates until you confirm). Skip the interview entirely: /goal start <objective>.`);
  const tmplPath = path.resolve(__dirname, "..", "..", "prompts", file);
  let tmpl: string;
  try {
    tmpl = fs.readFileSync(tmplPath, "utf-8");
    if (target === "list") {
      tmpl = tmpl.replace(
        "[GOAL DRAFTING]",
        "[LIST DRAFTING — the confirmed item goes into the /list LIST, it does not activate immediately. " +
          "/list items are SHORT tasks, not multi-hour objectives: each item should fit comfortably in a single agent run " +
          "(minutes of work, a single focused change). The list's long-running property is QUEUE DEPTH — hundreds of short " +
          "items activated one at a time over days/weeks — never any single item's scope. " +
          "If the user describes work that would take hours, propose breaking it into multiple /list items, or suggest /goal " +
          "for the big version. When the user has many items to enqueue at once ('queue these 50 audits'), propose them ALL AT " +
          "ONCE with the items[] parameter — one Confirm for the whole batch, never 50 separate proposals. Each items[] entry " +
          "is still a SHORT task — never an aggregate wrapper ('land all N findings' with a '≥N commits' contract is the " +
          "canonical anti-pattern: the auto-committer squashes, the count fails, the auditor disapproves finished work).]",
      );
    }
  } catch {
    tmpl = `[DRAFTING] Clarify the user's ${target}, then call ${tool}.`;
  }
  // v0.14.0: the LLM grills (its strength — v0.13.0's canned questionnaire
  // accepted non-answers), the plugin enforces the floor: propose_goal_draft
  // is blocked until the user has replied at least once (see message_start).
  if (seed) {
    tmpl = buildSeedGrillMessage(tmpl, seed, tool);
    // v0.25.3: cross-mode recommendation — catch wrapper-goal seeds and
    // mode mismatches BEFORE the draft crystallizes.
    if (target === "goal" || target === "list") {
      const xr = crossRecommendMode(seed, target);
      if (xr) tmpl += `\n\n${xr}`;
    }
  }
  try {
    await beginDrafterModel(ctx);
  } catch (err) {
    // v0.35.44 (audit finding): beginDrafterModel sat OUTSIDE the try below,
    // so a throw left the orphaned drafting gate this function's own header
    // warns about — target set, no interview running, later proposals look
    // like disapprovals until restart. Clear the gate and rethrow.
    clearDraftingState();
    throw err;
  }
  try {
    const wasStale = extensionApiStale;
    const sent = safeSteerUser(ctx, tmpl);
    if (!sent) {
      clearDraftingState();
      // safeSteerUser deliberately catches stale API errors, so its caller
      // must handle a false result explicitly rather than relying on catch.
      if (extensionApiStale && !wasStale) {
        appendLedger(ctx.cwd, "extension_api_stale", { where: "startDrafting seed" });
        ctx.ui.notify("glla: can't start the drafting interview — this session's extension handle is stale (pi session replacement). A fresh session_start will rebind it; if no replacement arrives, restart pi normally, then re-run the command.", "warning");
      }
      return false;
    }
    ctx.ui.notify(
      seed
        ? seededHint
        : `${label} started. The agent will grill until the contract is concrete, then ${tool} opens a Confirm dialog. No work begins before confirmation.`,
      "info",
    );
    draftingUserReplies = 0;
    draftingBlockedProposals = 0;
    draftingSeedInFlight = true; // our injected prompt also arrives as a user message — don't count it
    return true;
  } catch (err) {
    clearDraftingState();
    // v0.28.1 (E6): the seed send used to fail SILENTLY — the user pressed
    // Enter on /goal and nothing happened. Now: loud, and stale handles get
    // the honest restart guidance.
    if (isStaleApiError(err)) {
      extensionApiStale = true;
      appendLedger(ctx.cwd, "extension_api_stale", { where: "startDrafting seed" });
      ctx.ui.notify("glla: can't start the drafting interview — this session's extension handle is stale (pi session replacement). A fresh session_start will rebind it; if no replacement arrives, restart pi normally, then re-run the command.", "warning");
    } else {
      ctx.ui.notify(`glla: couldn't start the drafting interview (${err instanceof Error ? err.message : String(err)}) — try again.`, "warning");
    }
    return false;
  }
}

// =================================================================
// /goal router (v0.8.0): subcommands route to their handlers; everything
// else is an objective (draft if empty, set+start otherwise).
// =================================================================

/** v0.34.68 (bug 1.7 — "list/goal drafting disallows until we restart",
 * Screenshot_20260804_212233): mode-gate self-heal. A corrupted
 * state.goal.policy (readState parse failure — the ledger `state` event is
 * trusted verbatim) made every mode gate silently refuse /list and /goal
 * actions until a restart. Heal from the durable goal .md and persist so
 * the next readState sees the corrected value. A visible notify replaces
 * the old silent rejection. Returns true when the policy was repaired. */
function healGoalPolicy(ctx: ExtensionContext): boolean {
  const healed = healCorruptedGoalPolicy(state, ctx.cwd);
  if (healed) {
    persistState(ctx);
    ctx.ui.notify(
      `Recovered the goal mode (${healed === "list" ? "list item" : "goal"}) from the durable goal file — the corrupted in-memory mode flag was self-healed; no restart needed.`,
      "info",
    );
  }
  return healed !== undefined;
}

function notifyExternal(ctx: ExtensionContext, message: string): void {
  try {
    // A stale or handoff-bound runtime has no valid pi exec API. The TUI
    // warning may still be best-effort, but never call the old pi handle.
    if (sessionHandoffPending || extensionApiStale) return;
    const settings = loadSettings(ctx.cwd);
    if (settings.notifyCmd === "off" || !extensionApi) return;
    const cmd = settings.notifyCmd ?? autoNotifyCmd;
    if (!cmd) {
      if (settings.notifyCmd === undefined && autoNotifyCmd === undefined) probeAutoNotify(ctx);
      return;
    }
    void extensionApi.exec("bash", ["-c", cmd, "pi-goal-list-loop-audit", sanitizeDisplayText(message)], { cwd: ctx.cwd }).catch(() => {});
  } catch {
    // non-fatal by design
  }
}

// =================================================================
// Loop 3: /loop — metric-driven process loop (never completes)
//
// The anti-doorknob law: the loop only believes a number. The orchestrator
// runs the user's measure command (via pi.exec) after every agent turn;
// the agent never self-reports progress. Termination: plateau, iteration
function staleToolResult(): { content: Array<{ type: "text"; text: string }>; details: Record<string, never> } {
  return { content: [{ type: "text", text: STALE_TOOL_CONTEXT_MESSAGE }], details: {} };
}

/**
 * v0.34.20: registerAgentTools runs once per extension instance, but pi
 * invokes the registered tool with the current event context. Never use the
 * context captured when the tools were registered after a reload/rebind.
 * Prefer the invocation context, validate it cheaply, and fall back only to
 * the current fresh context — never to the registration-time ctx.
 */
function currentToolContext(execCtx: unknown): ExtensionContext | null {
  const candidate = execCtx as ExtensionContext | undefined;
  if (candidate) {
    try {
      candidate.isIdle();
      rememberCtx(candidate);
      return candidate;
    } catch {
      // The invocation itself may be a late event; try the current binding.
    }
  }
  return freshCtx();
}



/* Runtime globals: preserve the old monolith lexical links across extracted modules. */
defineGoalRuntimeGlobal("listQueue", { get: () => listQueue });
defineGoalRuntimeGlobal("groupOpenChildren", { get: () => groupOpenChildren });
defineGoalRuntimeGlobal("activateNextListItem", { get: () => activateNextListItem });
defineGoalRuntimeGlobal("startDrafting", { get: () => startDrafting });
defineGoalRuntimeGlobal("restoreDrafterModel", { get: () => restoreDrafterModel });
defineGoalRuntimeGlobal("handleDrafterModelFailure", { get: () => handleDrafterModelFailure });
defineGoalRuntimeGlobal("healGoalPolicy", { get: () => healGoalPolicy });
defineGoalRuntimeGlobal("notifyExternal", { get: () => notifyExternal });
defineGoalRuntimeGlobal("staleToolResult", { get: () => staleToolResult });
defineGoalRuntimeGlobal("currentToolContext", { get: () => currentToolContext });
