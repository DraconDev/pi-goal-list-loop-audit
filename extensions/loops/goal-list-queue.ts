/**
 * pi-goal-list-loop-audit — v0.1.0
 * extensions/loops/goal.ts
 *
 * The goal loop. The agent continues working, and on complete_goal,
 * an isolated auditor verifies the work.
 *
 * Design: see docs/DESIGN.md.
 *
 * Command surface (v0.39.x — five top-level slash commands, registered
 * in goal-activation.ts with bodies in goal-commands.ts; completion claims
 * are verified by the DETACHED auditor via goal-loop-auditor-process.ts):
 *   /goal start|plan|audit|verify|status|timeline|pause|resume|cancel|decide|tweak|archive (+ draft)
 *   /list add|show|start|resume|pause|tweak|next|remove|rm|clear|depth|cancel|plan|audit|import
 *   /loop start|respec|plan|audit|status|blockers|recheck|resume|refine|polish|stop|cancel|pause|finish (+ draft)
 *   /glla <settings table> | version|status|fleet|progress|log|resume|pause|cancel|wipe|stats|audits|agents|switchlog|tooloverride|fallbacks|owner|takeover|postaudit|bug
 *   /review <goal-id> [off|on|auto|aggressive]
 */

import * as fs from "node:fs";
import { draftingHandoff } from "../drafting-handoff.js";
import * as os from "node:os";
import * as path from "node:path";

import { defineTool, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// v0.34.109 (decomposition step 1): the state singleton and the persistence
// core moved to goal-state.ts — the SINGLE owner of the mutable state object
// (positioning doc invariant #2). Property reads on the imported binding are
// fine; wholesale replacement goes through replaceState().
import { state, replaceState, persistStateLine } from "../goal-state.js";
import { loadPromptWhole } from "../prompt-layers.js";

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
  deleteQueueItemFileResult,
  newGoalId,
  nowIso,
  compactDisplayText,
  sanitizeDisplayText,
  piGlaDir,
  stateRootPending,
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
import { gatherProactivePreRead } from "../proactive-pre-read.js";
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
  resolveDrafterThinkingLevel,
  type DrafterModelCandidate,
} from "../drafter-model.js";
import { ModelSelector } from "../model-selector.js";
import { waitForDrafterRetry } from "../drafter-recovery.js";
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

interface DraftingSwitchThinking {
  expectedLevel: string;
  modelSelected: boolean;
  manualLevel?: string;
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
  cwd: string;
  api: ExtensionAPI;
  controller: AbortController;
  recovering: boolean;
  switchInFlight?: Promise<boolean>;
  switchTargetRef?: string;
  switchThinking?: DraftingSwitchThinking;
  thinkingOverride?: string;
}

let draftingModelLease: DraftingModelLease | null = null;
let draftingStartSequence = 0;
let draftingModelRestoreInFlight: { lease: DraftingModelLease; promise: Promise<void> } | null = null;
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

/** Delayed drafting work must use the live owner, never its captured context. */
function draftingLeaseContext(lease: DraftingModelLease): ExtensionContext | null {
  if (lease.generation !== sessionGeneration || lease.api !== extensionApi
    || sessionHandoffPending || extensionApiStale || staleTerminalDone || zombieStoodDown) return null;
  const live = freshCtx();
  return live && live.cwd === lease.cwd && !isForeignCtx(live) ? live : null;
}

function releaseDraftingLease(lease: DraftingModelLease): void {
  lease.controller.abort();
  if (draftingModelLease === lease) draftingModelLease = null;
}

/** Restoration serializes behind a switch already accepted by the host.
 * A cancelled recovery may finish its host call, but cannot apply a dial
 * or send a new interview prompt afterward. */
async function switchDraftingModel(
  lease: DraftingModelLease, model: any, ctx: ExtensionContext,
): Promise<DraftingSwitchThinking & { switched: boolean }> {
  const thinking: DraftingSwitchThinking = { expectedLevel: currentThinkingLevel(ctx), modelSelected: false };
  lease.switchThinking = thinking;
  lease.switchTargetRef = modelRef(model);
  const pending = (async () => {
    try {
      const switched = await lease.api.setModel(model);
      if (switched) lease.activeRef = modelRef(model) ?? lease.activeRef;
      return switched;
    } catch { return false; }
  })();
  lease.switchInFlight = pending;
  try {
    const switched = await pending;
    const live = draftingLeaseContext(lease);
    if (switched && draftingModelLease === lease && live
      && currentThinkingLevel(live) === thinking.expectedLevel) {
      // Record the host-owned default, including when cancellation is
      // already waiting to restore behind this accepted switch.
      lease.activeThinkingLevel = thinking.expectedLevel;
    }
    return { ...thinking, switched };
  }
  finally {
    if (lease.switchInFlight === pending) {
      lease.switchInFlight = undefined;
      lease.switchTargetRef = undefined;
      lease.switchThinking = undefined;
    }
  }
}

/** Native setModel applies its default dial before model_select. Other dial
 * edits during the await belong to the user, not to the drafting lease. */
export function observeDrafterThinkingSelection(ctx: ExtensionContext, level: string): void {
  const lease = draftingModelLease;
  const thinking = lease?.switchThinking;
  if (!lease || !thinking || !draftingLeaseContext(lease) || isForeignCtx(ctx)) return;
  if (!thinking.modelSelected && modelRef(ctx.model)?.toLowerCase() === lease.switchTargetRef?.toLowerCase()) {
    thinking.expectedLevel = level;
  } else {
    thinking.manualLevel = level;
    lease.thinkingOverride = level;
  }
}

/** Recheck after the await, including hosts without thinking events. Retain
 * the manual target in case setModel itself reset the dial in the meantime. */
function preserveDrafterManualThinking(lease: DraftingModelLease, ctx: ExtensionContext, thinking: DraftingSwitchThinking): boolean {
  const current = currentThinkingLevel(ctx);
  const manual = thinking.manualLevel ?? (current !== thinking.expectedLevel ? current : undefined);
  if (manual === undefined) return false;
  lease.thinkingOverride = manual;
  lease.activeThinkingLevel = current === manual ? current : applyDrafterThinkingLevel(ctx, manual);
  return true;
}

/** A real user model selection supersedes the interview immediately. Own
 * setModel events are identified by their in-flight target, not mistaken
 * for manual selections just because the host labels them source=set. */
export function observeDrafterModelSelection(ctx: ExtensionContext, ref: string): void {
  const lease = draftingModelLease;
  if (!lease || !draftingLeaseContext(lease) || isForeignCtx(ctx)) return;
  const key = ref.toLowerCase();
  if (key === lease.switchTargetRef?.toLowerCase()) {
    if (lease.switchThinking) lease.switchThinking.modelSelected = true;
    return;
  }
  if (key === lease.activeRef.toLowerCase()) return;
  appendLedger(ctx.cwd, "drafter_model_restore_skipped", { active: lease.activeRef, current: ref, reason: "model changed during drafting" });
  releaseDraftingLease(lease);
}

/** Select the drafting-only model and retain a generation-fenced restore lease. */
async function beginDrafterModel(ctx: ExtensionContext): Promise<boolean> {
  const generation = sessionGeneration;
  const startSequence = draftingStartSequence;
  await restoreDrafterModel();
  // A failed restoration still owns the original pair. Never replace it
  // with a new lease whose "original" is the failed drafter.
  if (generation !== sessionGeneration || startSequence !== draftingStartSequence || draftingModelLease || draftingTarget === null
    || sessionHandoffPending || extensionApiStale || staleTerminalDone || zombieStoodDown) return false;
  const settings = loadSettings(ctx.cwd);
  const resolution = resolveDrafterModel(ctx, settings);
  const selected = resolution.selected;
  if (!selected || !ctx.model || !extensionApi) return true;
  const originalModel = ctx.model;
  const beforeRef = modelRef(originalModel);
  if (!beforeRef) return true;
  const originalThinkingLevel = currentThinkingLevel(ctx);
  const requestedThinkingLevel = resolveDrafterThinkingLevel(selected, originalThinkingLevel, settings.drafterThinkingLevel);
  const selectedRef = modelRef(selected.model) ?? selected.ref;
  const lease: DraftingModelLease = {
    originalModel, originalThinkingLevel, activeRef: beforeRef,
    activeThinkingLevel: originalThinkingLevel, requestedThinkingLevel,
    candidates: resolution.candidates,
    // Implicit session inheritance gets one bounded same-model retry.
    attempted: selected.via === "configured" ? [selectedRef] : [],
    generation, cwd: ctx.cwd, api: extensionApi,
    controller: new AbortController(), recovering: false,
  };
  draftingModelLease = lease;
  if (selected.via !== "configured") {
    lease.activeThinkingLevel = applyDrafterThinkingLevel(ctx, requestedThinkingLevel);
    if (resolution.configuredRefs.length > 0) {
      appendLedger(ctx.cwd, "drafter_model_fallback", { configured: resolution.configuredRefs, via: "session-model" });
      ctx.ui.notify("Configured drafter models were unavailable; drafting stays on the current session model. Main and auditor recovery chains are unchanged.", "warning");
    }
    return true;
  }
  const alreadyActive = beforeRef.toLowerCase() === selectedRef.toLowerCase();
  const selection = alreadyActive
    ? { switched: true, expectedLevel: currentThinkingLevel(ctx), modelSelected: false }
    : await switchDraftingModel(lease, selected.model, ctx);
  const live = draftingLeaseContext(lease);
  if (draftingModelLease !== lease || lease.controller.signal.aborted || draftingTarget === null || !live
    || startSequence !== draftingStartSequence) return false;
  if (!selection.switched) {
    preserveDrafterManualThinking(lease, live, selection);
    appendLedger(live.cwd, "drafter_model_fallback", { configured: resolution.configuredRefs, selected: selectedRef, via: "session-model", reason: "setModel rejected" });
    live.ui.notify(`Drafter model ${selectedRef} could not be selected; drafting stays on the current session model.`, "warning");
    return true;
  }
  if (!preserveDrafterManualThinking(lease, live, selection)) {
    lease.activeThinkingLevel = applyDrafterThinkingLevel(live, requestedThinkingLevel);
  }
  appendLedger(live.cwd, "drafter_model_selected", { from: beforeRef, to: selectedRef, candidates: resolution.configuredRefs, ...(alreadyActive ? { alreadyActive: true } : {}) });
  if (!alreadyActive) live.ui.notify(`Drafting uses ${selectedRef} temporarily; the session model will be restored when drafting ends.`, "info");
  return true;
}

/** Restore the pre-drafting model unless the user changed it meanwhile. */
async function restoreDrafterModel(): Promise<void> {
  const lease = draftingModelLease;
  if (!lease) return;
  // Abort the sleep synchronously, even when restoration itself must wait
  // for a host model switch already in flight.
  lease.controller.abort();
  if (lease.generation !== sessionGeneration || lease.api !== extensionApi) {
    releaseDraftingLease(lease);
    return;
  }
  if (draftingModelRestoreInFlight?.lease === lease) {
    await draftingModelRestoreInFlight.promise;
    return;
  }
  const restore = (async () => {
    if (lease.switchInFlight) await lease.switchInFlight;
    const currentCtx = draftingLeaseContext(lease);
    if (draftingModelLease !== lease || !currentCtx) return;
    const currentRef = modelRef(currentCtx.model);
    if (!currentRef) return;
    if (currentRef.toLowerCase() !== lease.activeRef.toLowerCase()) {
      appendLedger(currentCtx.cwd, "drafter_model_restore_skipped", { active: lease.activeRef, current: currentRef, reason: "model changed during drafting" });
      releaseDraftingLease(lease);
      return;
    }
    const originalRef = modelRef(lease.originalModel);
    if (!originalRef) return;
    if (isForbiddenModel(originalRef, loadSettings(currentCtx.cwd).forbiddenModels)) {
      appendLedger(currentCtx.cwd, "drafter_model_restore_failed", { to: originalRef, reason: "original session model is now forbidden" });
      currentCtx.ui.notify("The original session model is now forbidden; select an allowed session model before starting another drafting interview.", "warning");
      return;
    }
    const beforeThinking = currentThinkingLevel(currentCtx);
    if (beforeThinking !== lease.activeThinkingLevel) lease.thinkingOverride = beforeThinking;
    const alreadyActive = currentRef.toLowerCase() === originalRef.toLowerCase();
    const restoration = alreadyActive
      ? { switched: true, expectedLevel: beforeThinking, modelSelected: false }
      : await switchDraftingModel(lease, lease.originalModel, currentCtx);
    const restored = restoration.switched;
    const live = draftingLeaseContext(lease);
    if (draftingModelLease !== lease || !live) return;
    if (restored && modelRef(live.model)?.toLowerCase() !== lease.activeRef.toLowerCase()) {
      // A real user selection supersedes restoration; never apply the old
      // interview's dial onto that newly selected model.
      releaseDraftingLease(lease);
      return;
    }
    preserveDrafterManualThinking(lease, live, restoration);
    const thinkingTarget = lease.thinkingOverride ?? lease.originalThinkingLevel;
    const thinkingRestored = restored && (currentThinkingLevel(live) === thinkingTarget
      || applyDrafterThinkingLevel(live, thinkingTarget) === thinkingTarget);
    if (restored && thinkingRestored) {
      appendLedger(live.cwd, "drafter_model_restored", { to: originalRef, ...(alreadyActive ? { alreadyActive: true } : {}) });
      releaseDraftingLease(lease);
    } else {
      if (restored && !thinkingRestored) lease.activeThinkingLevel = currentThinkingLevel(live);
      // Keep the original pair for the next restoration attempt. Exhaustion
      // and rejected host actions are not proof that restoration happened.
      appendLedger(live.cwd, "drafter_model_restore_failed", { to: originalRef });
      live.ui.notify("The drafting model or thinking could not be restored; restoration remains pending. Main and auditor settings were not changed.", "warning");
    }
  })();
  const inFlight = { lease, promise: restore };
  draftingModelRestoreInFlight = inFlight;
  try { await restore; }
  finally { if (draftingModelRestoreInFlight === inFlight) draftingModelRestoreInFlight = null; }
}

/**
 * Generic drafting recovery: walk the dedicated chain via ModelSelector so
 * forbidden/unregistered refs are skipped with the same ledger as Main,
 * and provider retries use the bounded ladder (5s → base*2^(n-1) cap 5h).
 * The session model remains the last resort; same-model lease is preserved.
 */
async function handleDrafterModelFailure(
  ctx: ExtensionContext,
  error?: string,
  runtime: { wait?: typeof waitForDrafterRetry } = {},
): Promise<boolean> {
  const lease = draftingModelLease;
  if (!lease || lease.recovering || isForeignCtx(ctx)) return false;
  const liveOwner = (): ExtensionContext | null => {
    if (draftingModelLease !== lease || draftingTarget === null || lease.controller.signal.aborted) return null;
    const live = draftingLeaseContext(lease);
    if (live && modelRef(live.model)?.toLowerCase() !== lease.activeRef.toLowerCase()) {
      // Do not rotate a genuine user selection back into the old interview.
      releaseDraftingLease(lease);
      return null;
    }
    return live;
  };
  if (!liveOwner()) return false;
  const failure = classifyMainModelFailure(error);
  if (failure.kind === "non-recoverable") return false;
  // Canonical model identities keep aliases from granting duplicate attempts.
  // Crucially, the implicit session candidate is part of this bounded chain.
  const candidates = new Map<string, DrafterModelCandidate>();
  for (const candidate of lease.candidates) {
    const ref = modelRef(candidate.model) ?? candidate.ref;
    if (!candidates.has(ref.toLowerCase())) candidates.set(ref.toLowerCase(), { ...candidate, ref });
  }
  const refs = [...candidates.values()].map(candidate => candidate.ref);
  const selector = new ModelSelector({
    getChain: () => refs,
    resolve: ref => candidates.get(ref.toLowerCase())?.model,
    isForbidden: ref => isForbiddenModel(ref, loadSettings(lease.cwd).forbiddenModels),
    record: event => appendLedger(lease.cwd, "model_fallback_select", {
      scope: "drafter", fromRef: event.fromRef, toRef: event.toRef, reason: event.reason,
    }),
  });
  lease.recovering = true;
  try {
    let attempt = lease.attempted.length;
    for (;;) {
      if (!liveOwner()) return false;
      // An implicit session default is allowed ONE same-model retry. It is
      // unattempted initially; every visited candidate is consumed below.
      const pick = selector.selectNextValid({ kind: "drafter" }, undefined, lease.attempted);
      for (const visited of selector.lastVisitedRefs) {
        if (!lease.attempted.some(ref => ref.toLowerCase() === visited.toLowerCase())) lease.attempted.push(visited);
      }
      if (!("model" in pick)) break;
      const settings = loadSettings(lease.cwd);
      const delayMs = mainModelFailureDelayMs(failure, ++attempt, settings.mainModelRetryMinutes ?? 15);
      if (!await (runtime.wait ?? waitForDrafterRetry)(delayMs, lease.controller.signal)) return false;
      // Revalidate ownership AND policy after sleep: cancellation, a host
      // replacement, or a newly forbidden model must not launch old work.
      const before = liveOwner();
      if (!before) return false;
      if (isForbiddenModel(pick.ref, loadSettings(lease.cwd).forbiddenModels)) continue;
      if (currentThinkingLevel(before) !== lease.activeThinkingLevel) {
        // Preserve a deliberate thinking-only change made during backoff.
        // Keep the lease so cancellation can still restore its model.
        lease.controller.abort();
        return false;
      }
      const previous = lease.activeRef;
      const alreadyActive = pick.ref.toLowerCase() === previous.toLowerCase();
      const selection = alreadyActive
        ? { switched: true, expectedLevel: currentThinkingLevel(before), modelSelected: false }
        : await switchDraftingModel(lease, pick.model, before);
      const live = liveOwner();
      if (!live) return false;
      if (preserveDrafterManualThinking(lease, live, selection)) {
        lease.controller.abort();
        return false;
      }
      if (!selection.switched) continue;
      const candidate = candidates.get(pick.ref.toLowerCase())!;
      const requested = lease.thinkingOverride
        ?? resolveDrafterThinkingLevel(candidate, lease.originalThinkingLevel, lease.requestedThinkingLevel);
      lease.activeThinkingLevel = applyDrafterThinkingLevel(live, requested);
      appendLedger(live.cwd, alreadyActive ? "drafter_model_retry" : "drafter_model_fallback", {
        from: previous, to: pick.ref, attempted: lease.attempted.slice(), delayMs,
      });
      live.ui.notify(`Drafting provider failed; retrying the existing interview on ${pick.ref} after ${Math.round(delayMs / 1000)}s.`, "warning");
      if (!safeSteerUser(live, DRAFTER_RECOVERY_PROMPT)) return false;
      draftingSeedInFlight = true;
      return true;
    }
    const live = liveOwner();
    if (!live) return false;
    appendLedger(live.cwd, "drafter_model_fallback_exhausted", { attempted: lease.attempted });
    live.ui.notify("The dedicated drafter chain is exhausted; the drafting interview remains open. Restoring the original session model and thinking.", "warning");
    await restoreDrafterModel();
    return false;
  } finally { lease.recovering = false; }
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
function queueRepairAheadOfListItem(ctx: ExtensionContext, item: ListItem, assessment: ReturnType<typeof assessSuspiciousObjective>): boolean {
  const repairObjective = buildRepairTaskObjective({ policy: "list", objective: item.objective } as Goal, assessment);
  const target: ObjectiveRepairTarget = {
    id: item.id,
    objective: item.objective,
    ...(item.verificationContract ? { verificationContract: item.verificationContract } : {}),
    reasons: [...assessment.reasons],
    source: "list-activation",
  };
  const current = listQueue();
  const existing = current.find((queued) => queued.objective === repairObjective);
  /** Durable head order: lower than every existing item, with a stable
   * timestamp fallback for legacy sidecars. Persist the same final object that
   * enters RAM so reload cannot demote the repair behind the malformed head. */
  const promote = (base: ListItem): ListItem => {
    const restOrders = current.filter((queued) => queued.id !== base.id)
      .map((queued) => queued.queueOrder)
      .filter((order): order is number => typeof order === "number" && Number.isFinite(order));
    const headOrder = restOrders.length > 0 ? Math.min(...restOrders) - 1 : 0;
    return { ...base, repairTarget: target, queueOrder: headOrder };
  };
  if (existing) {
    const repaired = promote(existing);
    const written = writeQueueItemFile(ctx.cwd, repaired, { replace: true });
    if (written.failed) {
      ctx.ui.notify("Could not durably promote the repair; the original queued order remains unchanged.", "warning");
      return false;
    }
    const rest = current.filter((queued) => queued.id !== repaired.id);
    replaceState({ ...state, list: [repaired, ...rest] });
    // v0.39.45 (audit 2026-10-22): the durable projection of the queue is
    // the `list` array in the state ledger line. A persist that does not
    // land must not be journaled as a promotion the snapshot contradicts —
    // restore the RAM order and record the unpersisted promotion instead.
    if (persistState(ctx) !== true) {
      replaceState({ ...state, list: current });
      const rolledBack = !writeQueueItemFile(ctx.cwd, existing, { replace: true }).failed;
      appendLedger(ctx.cwd, "faulty_objective_repair_recovery_unpersisted", { goalId: repaired.id, targetId: item.id, source: "list-activation", queueOrder: repaired.queueOrder, sidecarRolledBack: rolledBack });
      ctx.ui.notify(rolledBack
        ? "Could not persist the repair promotion durably — the queued order is unchanged. Fix .pi-glla storage and retry."
        : "Could not persist or roll back the repair sidecar — activation stopped. Repair .pi-glla storage before retrying.", "warning");
      return false;
    }
    appendLedger(ctx.cwd, "faulty_objective_repair_target_recovered", { goalId: repaired.id, targetId: item.id, source: "list-activation", queueOrder: repaired.queueOrder });
    return true;
  }

  // Generate the id and final head order BEFORE the first sidecar write. The
  // ordinary enqueue path deliberately assigns tail order; using it here would
  // require a second write and leave a crash window between the two shapes.
  const repair: ListItem = promote({
    id: newGoalId(),
    objective: repairObjective,
    addedAt: nowIso(),
  });
  const written = writeQueueItemFile(ctx.cwd, repair);
  if (written.failed) {
    ctx.ui.notify("Could not persist the repair item; the original queued item remains unchanged.", "warning");
    return false;
  }
  replaceState({ ...state, list: [repair, ...current] });
  // v0.39.45 (audit 2026-10-22): same durable-projection contract as the
  // recovery path above — a promotion that did not land is not journaled
  // as one.
  if (persistState(ctx) !== true) {
    replaceState({ ...state, list: current });
    const rolledBack = !deleteQueueItemFileResult(ctx.cwd, repair.id).failed;
    appendLedger(ctx.cwd, "faulty_objective_repair_promoted_unpersisted", { goalId: repair.id, targetId: item.id, position: 1, source: "list-activation", reasons: assessment.reasons, queueOrder: repair.queueOrder, sidecarRolledBack: rolledBack });
    ctx.ui.notify(rolledBack
      ? "Could not persist the repair promotion durably — the queued order is unchanged. Fix .pi-glla storage and retry."
      : "Could not persist or remove the repair sidecar — activation stopped. Repair .pi-glla storage before retrying.", "warning");
    return false;
  }
  appendLedger(ctx.cwd, "faulty_objective_repair_promoted", { goalId: repair.id, targetId: item.id, position: 1, source: "list-activation", reasons: assessment.reasons, queueOrder: repair.queueOrder });
  return true;
}

function activateNextListItem(ctx: ExtensionContext, n = 1, opts?: { explicit?: boolean; displayLabel?: string; repairRetried?: boolean }): boolean {
  // An explicit list activation is user consent even when pi initially
  // reported a blank startup context; automatic restore never reaches here.
  releaseInitialSessionLoadBarrier();
  // v0.28.14: one-active-thing choke point — NO call site (session_start,
  // completion cascade, /list next, /glla resume, list_activate,
  // list-draft auto-activate) may activate a list item over a live loop,
  // present or future.
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
  if (!resolveCarryover(ctx, "list")) return false;
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
    // Audit 2026-09-06: the head-group skip was silent — ledger it so the
    // auto-advance landing is attributable instead of mysterious.
    if (scan > 0 && queue[scan]) {
      appendLedger(ctx.cwd, "list_group_auto_skipped", {
        groupId: queue[0]!.id,
        skippedGroups: scan,
        landedOn: queue[scan]!.id,
      });
    }
    n = scan + 1;
  } else if (opts?.explicit && queue[n - 1] && groupOpenChildren(queue[n - 1]!.id) > 0) {
    const target = queue[n - 1]!;
    const open = groupOpenChildren(target.id);
    appendLedger(ctx.cwd, "list_group_activation_refused", { goalId: target.id, open });
    ctx.ui.notify(
      `List item #${opts?.displayLabel ?? n} is a group with ${open} open subtask${open === 1 ? "" : "s"} — complete its subtasks first (they run in queue order, then the group closes itself).`,
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
      if (assessment.reasons.includes("report-fragment")) {
        // No recoverable task is encoded in a bare evidence row. Retain it
        // verbatim, without consuming it or generating a recursive replan.
        ctx.ui.notify(`List item #${n} is a report fragment, not an executable task. It remains queued unchanged. Use /list remove ${n} to discard it, or /list add with a concrete objective and Done when: contract; /list next <n> selects other work.`, "warning");
        return false;
      }
      if (!queueRepairAheadOfListItem(ctx, candidate, assessment)) return false;
      // v0.38.105 (field 2026-09-29, dracon-system): the promoted repair is
      // safe and actionable BY CONSTRUCTION (fixed imperative text) —
      // activate it now instead of idling the queue until a manual resume.
      // One bounded retry: the repair passes the screen, so a second
      // refusal means something genuinely new, not the item just queued
      // around. The repair rides the head (position 1); the requested
      // display label stays with the original pick.
      if (!opts?.repairRetried) {
        appendLedger(ctx.cwd, "faulty_objective_repair_auto_activate", { targetId: candidate.id, reasons: assessment.reasons });
        if (activateNextListItem(ctx, 1, { explicit: opts?.explicit, repairRetried: true })) return true;
      }
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
  // v0.35.72: the sidecar must be gone before the queue item leaves RAM.
  // Otherwise a failed unlink makes the just-activated item reappear after
  // reload as pending work. Missing sidecars are fine; failed deletion is a
  // durable-cleanup refusal and leaves the queue untouched.
  const sidecar = deleteQueueItemFileResult(ctx.cwd, next.id);
  if (sidecar.failed) {
    appendLedger(ctx.cwd, "list_activation_sidecar_delete_failed", { queueItemId: next.id });
    ctx.ui.notify("List activation paused — its durable queue sidecar could not be removed, so the item remains queued. Fix disk access and retry.", "warning");
    return false;
  }
  replaceState({ ...state, list: rest });
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
  draftingHandoff.reset();
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
      ? `${label}: free-text is valid without a "Done when:" clause — the agent will turn it into a short list item (or items, when the seed is genuinely several tasks) and grill for concrete per-item contracts (nothing activates until you confirm). A prose paragraph is ONE item, not one per sentence. If the seed is already an explicitly structured list (marked items or independent contracted records), use its wording and structure as supplied; do not ask whether it should be exact or refined. To skip drafting, include a per-item "Done when:" clause.`
      : target === "loop"
        ? `${label}: a loop target needs a metric and a direction — the agent will help you design them first (nothing activates until you confirm). Skip the interview entirely: /loop start "<target>" (bare = infinite metricless) or /loop start "<target>" measure="<cmd>" direction=min|max [window=5] [max=50] [time=h] [tokens=n] [branch=1].`
        : `${label}: the objective has no "Done when:" clause — the agent will grill you about it first (nothing activates until you confirm). Skip the interview entirely: /goal start <objective>.`);
  // Build every synchronous prompt surface BEFORE claiming the drafting gate.
  // A missing/corrupt shipped template must fail loudly without leaving later
  // proposal tools blocked by a target for an interview that never started.
  let tmpl: string;
  try {
    tmpl = loadPromptWhole(file);
  } catch (err) {
    ctx.ui.notify(`Could not start drafting: the ${target} prompt template could not be loaded. Fix the packaged file and retry.`, "warning");
    throw err;
  }
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
          "canonical anti-pattern: the auto-committer squashes, the count fails, the auditor disapproves finished work). " +
          "For an explicitly structured list (marked items or independent contracted records), preserve the supplied wording and structure. " +
          "Line wrapping alone does not make prose a list: propose a paragraph whole as one item. " +
          "strip only import syntax and empty headings/lines, and propose items[] directly — do not ask whether it should be exact " +
          "or refined; clarify only a genuinely ambiguous individual item.]",
      );
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
  // v0.36.x: proactive pre-read — ingest bounded file/image evidence from
  // the seed before the first question, so the interview does not repeat
  // claims the user already provided. No model switch; purely bounded reads.
  if (seed) {
    const pre = gatherProactivePreRead(seed, ctx.cwd);
    if (pre) tmpl += `\n\n${pre}`;
  }
  // From this point onward, every exit owns the gate it is about to claim.
  const startSequence = ++draftingStartSequence;
  draftingTarget = target;
  try {
    const modelReady = await beginDrafterModel(ctx);
    if (!modelReady || startSequence !== draftingStartSequence) {
      if (startSequence === draftingStartSequence
        && (!draftingModelLease || draftingModelLease.controller.signal.aborted)) draftingTarget = null;
      return false;
    }
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
    return true;
  }
  // S10: unhealable corruption must not fall through to a misleading gate
  // refusal ("the active work is a standalone goal — /goal pause"). The
  // ledger already carries goal_policy_heal_failed; say the true cause out
  // loud, once per entry, so the gate message below is read as a symptom.
  const policy = state.goal?.policy;
  if (state.goal && policy !== "goal" && policy !== "list") {
    ctx.ui.notify(
      `The goal mode flag is corrupted (${String(policy).slice(0, 80)}) and could not be recovered from the durable goal file — list/goal actions may refuse until the goal file is repaired or the goal is re-created.`,
      "warning",
    );
  }
  return false;
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
// Audit 2026-09-13: list_activate must screen content before the conflict
// can archive, so the repair helper joins the runtime-global bridge.
defineGoalRuntimeGlobal("queueRepairAheadOfListItem", { get: () => queueRepairAheadOfListItem });
defineGoalRuntimeGlobal("startDrafting", { get: () => startDrafting });
defineGoalRuntimeGlobal("restoreDrafterModel", { get: () => restoreDrafterModel });
defineGoalRuntimeGlobal("handleDrafterModelFailure", { get: () => handleDrafterModelFailure });
defineGoalRuntimeGlobal("healGoalPolicy", { get: () => healGoalPolicy });
defineGoalRuntimeGlobal("notifyExternal", { get: () => notifyExternal });
defineGoalRuntimeGlobal("staleToolResult", { get: () => staleToolResult });
defineGoalRuntimeGlobal("currentToolContext", { get: () => currentToolContext });
