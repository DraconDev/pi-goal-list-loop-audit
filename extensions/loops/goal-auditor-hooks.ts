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
  claimRecoveryNotice,
  providerErrorPresentation,
  sanitizeProviderDisplayText,
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
  formatAuditLog,
  formatGoalAuditHistory,
  readAuditLogForGoal,
  scanLedgerRecords,
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
  countTrailingRepeatedDisapprovals,
  MAX_REPEATED_AUDIT_NO_PROGRESS,
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
  sanitizeProviderAuditReport,
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
  nextHourlyProbeMs,
  supervisorPaused,
  loadHoldActive,
  appendAuditVerdict,
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
  guardGoalBeforeContinuation,
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
  sendTerminalCompletionNotice,
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
import { capProviderRetrySeconds } from "../quota-retry.js";
import {
  mainModelAutoRetryUntil,
  mainModelRetryDelayMs,
  MAIN_MODEL_AUTO_RETRY_HORIZON_MS,
  MAX_AUDITOR_CANDIDATE_REFS,
  modelRef,
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
  buildReviewerSources,
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
import {
  auditorCandidateRefs,
  auditorResultFailureClass,
  cancelDetachedGoalCompletionAuditor,
  escalatedAuditorTimeout,
  newDetachedAuditJobAttemptId,
  runAuditorFallbackWithPolicy,
  isAuditorCursorPersistenceFailure,
  normalizeAuditorInfrastructureResult,
  runDetachedGoalCompletionAuditor,
  DEFAULT_AUDITOR_STALL_MS,
  DEFAULT_AUDITOR_TOOL_TIMEOUT_MS,
  type AuditorFallbackAttemptInfo,
  type AuditorFallbackCandidate,
  type AuditorFallbackExhaustionInfo,
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
import { buildApprovalChatLines, compactCompletionSummary, compactTerminalCompletionSummary, isGenericCompletionSummary, missingCompletionSummaryLabels, terminalHumanBrief, withoutStaleNext } from "../completion-summary.js";
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
  parkCompletionAuditRecovery,
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

type PendingCompletion = NonNullable<Goal["pendingCompletion"]>;

/** Release all process-local ownership of a detached audit. The worker is
 * already detached, so a stale MAIN must not keep the in-flight latch merely
 * because its old generation never reached the normal finally block. */
function clearDetachedAuditRuntime(): void {
  latestAuditProgress = null;
  completionAuditInFlight = false;
  completionAuditGeneration = null;
  completionAuditRecoveryArmed = false;
}

type CompletionAuditOrigin = "complete-goal" | "provider-retry" | "manual" | "session-recovery";

function clearScheduledAuditorRecoveryTimer(): void {
  if (scheduledAuditorRecoveryTimer) clearTimeout(scheduledAuditorRecoveryTimer);
  scheduledAuditorRecoveryTimer = null;
  scheduledAuditorRecoveryAt = null;
  scheduledAuditorRecoveryGeneration = null;
}

export function __testOnlyResetAuditorRecoveryRuntime(): void {
  clearScheduledAuditorRecoveryTimer();
  auditorRecoveryRetryDelayOverrideMs = null;
}

function newCompletionAuditAttemptId(): string {
  return `audit-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** A logical completion claim can be retried after its old worker has left a
 * durable job directory behind. Each detached process attempt gets its own
 * filesystem identity; the claim's `pendingCompletion.attemptId` remains the
 * parent-generation identity used for stale-result rejection. */
/**
 * v0.34.104 ([Image-#1]): detect arithmetic impossibilities in the
 * agent-supplied completionSummary text. The agent's recap occasionally
 * reports test counts that violate pass ≤ total (field: "29/28 pass" on
 * 2026-08-08 10:29 dracon-platform — a 28-test suite cannot yield 29
 * passes). Pure except for the ledger append — unit-testable in
 * isolation. On a hit, ledger `completion_summary_impossible_count` and
 * append an honest `Counts appear inconsistent: X passed vs Y total.`
 * note to the recap so the user + auditor see the discrepancy. Returns
 * the (possibly amended) text to persist.
 */
function validateCompletionSummary(text: string, ctx: ExtensionContext): string {
  const flags: string[] = [];
  // Match "X/Y pass" / "X / Y pass" — anchor on the noun "pass" so we
  // don't false-positive on ratios like "1/2 done".
  const ratio = /(\d{1,4})\s*\/\s*(\d{1,4})\s*(?:tests?\s+)?pass(?:es|ed)?\b/i;
  const m = ratio.exec(text);
  if (m) {
    const passed = Number(m[1]);
    const total = Number(m[2]);
    if (Number.isFinite(passed) && Number.isFinite(total) && passed > total) {
      flags.push(`Counts appear inconsistent: ${passed} passed vs ${total} total in the suite.`);
    }
  }
  // "X tests, Y passed" — Y cannot exceed X.
  const aggregate = /(\d{1,4})\s+tests?[\s,]+(\d{1,4})\s+passed\b/i;
  const a = aggregate.exec(text);
  if (a) {
    const total = Number(a[1]);
    const passed = Number(a[2]);
    if (Number.isFinite(total) && Number.isFinite(passed) && passed > total) {
      flags.push(`Counts appear inconsistent: ${passed} passed vs ${total} total tests reported.`);
    }
  }
  // Six-label recap per audit/COMPLETION-SUMMARY-POLICY-2026-08-19.md —
  // every label must appear even when its value is "none". This is the
  // usefulness gate: a generic "done" sentence has no evidence, file, or
  // test pointers and the archive hand-off is poor.
  const requiredLabels = ["Outcome:", "Changed:", "Evidence:", "Tests:", "Unresolved:", "Next:"] as const;
  // Use the same parser as terminal archive validation. In particular, a
  // generated NOTE is metadata and must not make its example label names
  // count as supplied recap fields.
  const missingFromBody = missingCompletionSummaryLabels(text);
  const missing = requiredLabels.filter((label) => missingFromBody.includes(label));
  if (missing.length > 0) {
    flags.push(`completionSummary missing required labels ${missing.join(", ")} — expected Outcome/Changed/Evidence/Tests/Unresolved/Next per audit/COMPLETION-SUMMARY-POLICY-2026-08-19.md.`);
  } else if (isGenericCompletionSummary(text)) {
    flags.push(`completionSummary is generic single-word prose with no evidence — expected six labeled lines per policy.`);
  }
  if (flags.length === 0) return text;
  const ledgerType = missing.length > 0 ? "completion_summary_missing_labels" : "completion_summary_impossible_count";
  // Preserve the narrow impossible-count ledger name for the original case
  // so existing log queries keep working. Missing-label annotations are
  // deliberately label-free: terminal archive validation must still replace
  // the incomplete claim with a recorded-facts-only fallback.
  if (missing.length > 0 && flags.some((f) => f.startsWith("Counts appear"))) {
    appendLedger(ctx.cwd, "completion_summary_impossible_count", {
      flags: flags.filter((f) => f.startsWith("Counts appear")),
      excerpt: text.slice(0, 240),
    });
    appendLedger(ctx.cwd, ledgerType, {
      flags: flags.filter((f) => !f.startsWith("Counts appear")),
      excerpt: text.slice(0, 240),
    });
  } else {
    appendLedger(ctx.cwd, ledgerType, {
      flags,
      excerpt: text.slice(0, 240),
    });
  }
  const annotation = missing.length > 0
    ? [
      ...flags.filter((flag) => !flag.startsWith("completionSummary missing required labels")),
      "supplied completion summary was incomplete; terminalization will use a recorded-facts-only fallback",
    ].filter(Boolean).join(" ")
    : flags.join(" ");
  return `${text.trimEnd()} — NOTE: ${annotation}`;
}

const AUDITOR_RECOVERY_RETRY_DELAY_MS = Number(process.env.GLLA_AUDITOR_RECOVERY_RETRY_DELAY_MS ?? 60_000);
let auditorRecoveryRetryDelayOverrideMs: number | null = null;
let scheduledAuditorRecoveryAt: string | null = null;
let scheduledAuditorRecoveryGeneration: number | null = null;
let scheduledAuditorRecoveryTimer: NodeJS.Timeout | null = null;

/** Conservative no-verdict recovery retains the historical 24-hour envelope.
 * Aggressive mode ignores this legacy horizon and continues from durable
 * lifecycle/progress signals until an explicit state-based stop applies. */
const CONSERVATIVE_AUDITOR_RECOVERY_HORIZON_MS = MAIN_MODEL_AUTO_RETRY_HORIZON_MS;

function aggressiveAuditorRecoveryEnabled(cwd: string): boolean {
  try { return resolveEffectiveAggressiveSettings(loadSettings(cwd)).aggressiveMode; } catch { return false; }
}

function automaticRecoveryWindow(pending: PendingCompletion, now = Date.now(), unbounded = false): { firstAt: string; until?: string; untilMs: number } {
  const firstCandidate = [pending.automaticRecoveryFirstAt, pending.automaticRecoveryAt, pending.recoveryAt]
    .map((value) => typeof value === "string" ? Date.parse(value) : Number.NaN)
    .find((value) => Number.isFinite(value));
  const firstMs = Number.isFinite(firstCandidate) ? firstCandidate! : now;
  // Aggressive automation is event-driven across arbitrary durations. Keep
  // the old horizon readable for conservative/legacy claims, but do not
  // resurrect it when the current policy explicitly opted into aggressive
  // recovery.
  const existingUntil = unbounded ? Number.NaN : typeof pending.automaticRecoveryUntil === "string" ? Date.parse(pending.automaticRecoveryUntil) : Number.NaN;
  const untilMs = unbounded
    ? Number.POSITIVE_INFINITY
    : Number.isFinite(existingUntil) && existingUntil > firstMs
      ? existingUntil
      : firstMs + CONSERVATIVE_AUDITOR_RECOVERY_HORIZON_MS;
  return {
    firstAt: new Date(firstMs).toISOString(),
    ...(Number.isFinite(untilMs) ? { until: new Date(untilMs).toISOString() } : {}),
    untilMs,
  };
}

function auditorRecoveryRetryDelayMs(): number {
  return auditorRecoveryRetryDelayOverrideMs ?? (Number.isFinite(AUDITOR_RECOVERY_RETRY_DELAY_MS) ? Math.max(1_000, AUDITOR_RECOVERY_RETRY_DELAY_MS) : 60_000);
}

/** Test-only: shrink the bounded no-verdict recovery delay without changing
 * production defaults. Null restores the one-minute retry window. */
export function __testOnlySetAuditorRecoveryRetryDelay(delayMs: number | null): void {
  clearScheduledAuditorRecoveryTimer();
  auditorRecoveryRetryDelayOverrideMs = delayMs;
}

/** Arm a durable, generation-fenced retry for a parked infrastructure/no-
 * verdict claim. Normal mode gets one fresh attempt; aggressiveMode keeps
 * re-arming the claim while state-based stop rules permit it. This remains
 * separate from the provider retry ladder: no-verdict recovery never guesses
 * a provider reason for a dead worker. */
export function scheduleParkedCompletionAuditRecovery(ctx: ExtensionContext, pending: PendingCompletion, reason: string): PendingCompletion {
  if (pending.auditorFallbackExhausted) return { ...pending, recoveryRetryAt: undefined };
  const now = Date.now();
  const aggressive = aggressiveAuditorRecoveryEnabled(ctx.cwd);
  if (pending.automaticRecoveryAttempted === true && !aggressive) return pending;
  const window = automaticRecoveryWindow(pending, now, aggressive);
  if (aggressive && Number.isFinite(window.untilMs) && now >= window.untilMs) {
    return { ...pending, recoveryRetryAt: undefined, automaticRecoveryFirstAt: window.firstAt, automaticRecoveryUntil: window.until };
  }
  const storedRetryMs = pending.recoveryRetryAt ? Date.parse(pending.recoveryRetryAt) : Number.NaN;
  const retryAt = Number.isFinite(storedRetryMs) && storedRetryMs > now
    ? pending.recoveryRetryAt!
    : new Date(now + auditorRecoveryRetryDelayMs()).toISOString();
  const next = {
    ...pending,
    recoveryRetryAt: retryAt,
    ...(aggressive ? { automaticRecoveryFirstAt: window.firstAt, ...(window.until ? { automaticRecoveryUntil: window.until } : { automaticRecoveryUntil: undefined }) } : {}),
  };
  const generation = sessionGeneration;
  if (scheduledAuditorRecoveryAt === retryAt && scheduledAuditorRecoveryGeneration === generation && scheduledAuditorRecoveryTimer) return next;
  clearScheduledAuditorRecoveryTimer();
  scheduledAuditorRecoveryAt = retryAt;
  scheduledAuditorRecoveryGeneration = generation;
  const delayMs = Math.max(1_000, Date.parse(retryAt) - Date.now());
  appendLedger(ctx.cwd, "audit_recovery_retry_scheduled", {
    goalId: state.goal?.id,
    attemptId: pending.attemptId,
    retryAt,
    delayMs,
    reason,
    generation,
  });
  let scheduledTimer: NodeJS.Timeout;
  scheduledTimer = scheduleSessionTimeout(() => {
    // A callback already queued when a newer episode replaced this timer must
    // not clear the newer timer's ownership metadata or launch its claim.
    if (scheduledAuditorRecoveryTimer !== scheduledTimer) return;
    scheduledAuditorRecoveryTimer = null;
    scheduledAuditorRecoveryAt = null;
    scheduledAuditorRecoveryGeneration = null;
    const fresh = freshCtxForGeneration(generation);
    if (!fresh) return;
    const goal = state.goal;
    const claim = goal?.pendingCompletion;
    if (!goal || goal.status !== "paused" || !claim || claim.auditorFallbackExhausted || (claim.phase ?? "recovery-pending") !== "recovery-pending" || claim.recoveryRetryAt !== retryAt) return;
    const aggressiveNow = aggressiveAuditorRecoveryEnabled(fresh.cwd);
    if (claim.automaticRecoveryAttempted === true && !aggressiveNow) {
      updateGoal({
        pendingCompletion: { ...claim, recoveryRetryAt: undefined },
        pauseKind: "blocked",
        pauseResumeAt: undefined,
        pauseReason: "completion auditor automatic recovery disabled — no verdict was produced",
        pauseSuggestedAction: `Aggressive auditor recovery is off. ${activeGoalSurfaceCommand("resume")} retries the stored claim explicitly.`,
      }, fresh);
      appendLedger(fresh.cwd, "audit_recovery_retry_suppressed", {
        goalId: goal.id,
        attemptId: claim.attemptId,
        reason: "aggressive-mode-disabled",
      });
      return;
    }
    const checkNow = Date.now();
    const currentWindow = automaticRecoveryWindow(claim, checkNow, aggressiveNow);
    if (aggressiveNow && Number.isFinite(currentWindow.untilMs) && checkNow >= currentWindow.untilMs) {
      updateGoal({
        pendingCompletion: { ...claim, recoveryRetryAt: undefined },
        pauseKind: "blocked",
        pauseResumeAt: undefined,
        pauseReason: "completion auditor aggressive recovery horizon reached — no verdict was produced",
        pauseSuggestedAction: `The aggressive auditor recovery window ended. ${activeGoalSurfaceCommand("resume")} starts a fresh bounded window.`,
      }, fresh);
      appendLedger(fresh.cwd, "audit_recovery_retry_suppressed", {
        goalId: goal.id,
        attemptId: claim.attemptId,
        reason: "aggressive-recovery-horizon",
      });
      return;
    }
    appendLedger(fresh.cwd, "audit_recovery_retry_due", { goalId: goal.id, attemptId: claim.attemptId, retryAt, generation });
    if (!maybeAutoRetryParkedCompletionAudit("auditor-recovery-timer")) {
      appendLedger(fresh.cwd, "audit_recovery_retry_not_started", { goalId: goal.id, attemptId: claim.attemptId, reason: "guard-rejected" });
    }
  }, delayMs);
  scheduledAuditorRecoveryTimer = scheduledTimer;
  return next;
}

function beginCompletionAudit(ctx: ExtensionContext, claim: PendingCompletion, origin: CompletionAuditOrigin): PendingCompletion | undefined {
  clearScheduledAuditorRecoveryTimer();
  completionAuditRecoveryArmed = true;
  const startedMs = Date.now();
  const aggressive = aggressiveAuditorRecoveryEnabled(ctx.cwd);
  const recoveryWindow = automaticRecoveryWindow(claim, startedMs, aggressive);
  const automaticRecoveryRetry = origin === "session-recovery"
    && (claim.phase ?? "recovery-pending") === "recovery-pending"
    && (claim.automaticRecoveryAttempted !== true || aggressive)
    && (!aggressive || startedMs < recoveryWindow.untilMs);
  const freshAuditorCycle = origin === "manual" && claim.auditorFallbackExhausted === true;
  const claimForAttempt = origin === "manual"
    ? {
      ...claim,
      retryAttempts: undefined,
      retryFirstAt: undefined,
      retryUntil: undefined,
      ...(freshAuditorCycle ? {
        auditorCandidateRefs: undefined,
        auditorCandidateRef: undefined,
        auditorRetryCandidateRef: undefined,
        auditorRetryAttemptStartedAt: undefined,
        auditorAttemptedRefs: undefined,
        auditorFailureCount: undefined,
        auditorFailureClass: undefined,
        auditorFallbackExhausted: undefined,
        auditorFailureAt: undefined,
      } : {}),
    }
    : claim;
  const pending: PendingCompletion = {
    ...claimForAttempt,
    phase: "running",
    attemptId: newCompletionAuditAttemptId(),
    startedAt: new Date(startedMs).toISOString(),
    recoveryAt: undefined,
    recoveryReason: undefined,
    recoveryRetryAt: undefined,
    // The next detached attempt must not inherit the previous diagnostic as
    // if it were a fresh result. Keep the generic retry window and replace
    // the diagnostic when the worker produces a new failure.
      ...(automaticRecoveryRetry
      ? {
        automaticRecoveryAttempted: true,
        automaticRecoveryAt: new Date(startedMs).toISOString(),
        automaticRecoveryGeneration: sessionGeneration,
        automaticRecoveryAttempts: (claim.automaticRecoveryAttempts ?? 0) + 1,
        ...(aggressive ? {
          automaticRecoveryFirstAt: recoveryWindow.firstAt,
          ...(recoveryWindow.until ? { automaticRecoveryUntil: recoveryWindow.until } : { automaticRecoveryUntil: undefined }),
        } : {}),
      }
      : {}),
  };
  // A stored claim may be retried after a previous infrastructure pause.
  // Clear that old operational note before rebuilding the immutable auditor
  // prompt; otherwise the detached auditor sees stale EEXIST/model-error
  // text and the UI/request snapshot describes the previous attempt.
  const persisted = updateGoal({
    status: "auditing",
    pendingCompletion: pending,
    pauseReason: undefined,
    pauseSuggestedAction: undefined,
    pauseKind: undefined,
    pauseOptions: undefined,
    pauseRecommended: undefined,
    pauseResumeAt: undefined,
    providerErrorDiagnostic: undefined,
    recoveryEpisodeKey: undefined,
    recoveryNoticeKeys: undefined,
  }, ctx);
  if (!persisted) {
    // Do not let a failed claim transition leave the process recovery latch
    // armed: no detached worker was authorized without a durable cursor.
    completionAuditRecoveryArmed = false;
    return undefined;
  }
  appendLedger(ctx.cwd, "audit_started", { goalId: state.goal?.id, attemptId: pending.attemptId, origin });
  return pending;
}

// markCompletionAuditRecoveryPending moved to extensions/goal-recovery.ts (decomposition step 3, v0.34.111, cluster C).

function isAuditorTimeoutError(error: string | undefined): boolean {
  return !!error && (/^Auditor exceeded its .* wall-clock bound/i.test(error) || /^Auditor stalled —/i.test(error));
}

/** Errors proving the detached worker failed to produce a semantic verdict.
 * Keep these off the provider retry ladder: a dead worker, malformed result,
 * or missing marker is a local auditor-infrastructure failure and gets one
 * bounded stored-claim retry instead of an indefinite provider wait. */
function isAuditorNoVerdictInfrastructureError(error: string | undefined, infrastructureClass?: string): boolean {
  if (!error || /^Auditor aborted\.?$/i.test(error.trim())) return false;
  if (infrastructureClass === "no-verdict" || infrastructureClass === "timeout" || infrastructureClass === "transport") return true;
  if (isAuditorTimeoutError(error)) return true;
  return /^(?:auditor worker exited without an atomic result|auditor produced no (?:output|verdict marker)|auditor (?:progress|result) identity\/request-hash mismatch|invalid auditor (?:progress|result)(?::|$)|auditor reported unsupported tool:|detached auditor failed$)/i.test(error.trim());
}

// isCompletionAuditRecoveryPending moved to extensions/goal-recovery.ts (decomposition step 3, v0.34.111, cluster C).
// goal-commands.ts (decomposition step 2) imports it directly from there.

const MAX_AUDITOR_AUTO_RETRY_ATTEMPTS = 5;
/** v0.34.79/v0.34.141: the FIRST auditor retry after an infrastructure
 * failure is eager — 5s, mirroring runWithInfraRetry's default backoff. The
 * scheduler does not inspect provider families or provider hints to
 * decide whether to retry: every retriable failure gets the same first probe,
 * then the next probe is aligned just after the next local hour starts. The
 * parsed provider object remains durable diagnostic metadata only. */
const EAGER_AUDITOR_RETRY_SEC = 5;

/** Seconds-aware "auto-retry in …" label: "5s" under a minute, else "60m". */
function fmtRetryDelay(seconds: number): string {
  return seconds < 60 ? `${Math.round(seconds)}s` : `${Math.round(seconds / 60)}m`;
}

// v0.34.79: exported for tests — the eager-first-retry schedule is pure.
export function auditorRetryPlan(claim: PendingCompletion, _legacyQuota?: unknown, _legacyBaseMinutes?: number, aggressive = false): {
  attempt: number;
  retryAfterSec: number;
  firstAt: string;
  /** Legacy horizon metadata; aggressive callers must not persist/use it as a stop. */
  autoRetryUntil: string;
  automatic: boolean;
  requestedSec: number;
  unbounded: boolean;
} {
  // The optional legacy parameters are accepted so older embedded callers do
  // not break, but retry scheduling is deliberately reason-agnostic.
  const now = Date.now();
  const firstMs = claim.retryFirstAt ? Date.parse(claim.retryFirstAt) : Number.NaN;
  const firstAtMs = Number.isFinite(firstMs) ? firstMs : now;
  const firstAt = new Date(firstAtMs).toISOString();
  const untilMs = claim.retryUntil && Number.isFinite(Date.parse(claim.retryUntil))
    ? Date.parse(claim.retryUntil)
    : firstAtMs + MAIN_MODEL_AUTO_RETRY_HORIZON_MS;
  const attempt = (claim.retryAttempts ?? 0) + 1;
  // v0.34.142: all failure families use one retry schedule. Do not wait on
  // an availability probe or trust a reset/Retry-After classification; retry eagerly
  // once, then probe at :00:30 after each hour starts (15:00 → 15:00:30,
  // 16:00 → 16:00:30, …). This picks up a possible reset without making a
  // availability request first.
  const requestedSec = attempt === 1
    ? EAGER_AUDITOR_RETRY_SEC
    : Math.max(60, Math.round((nextHourlyProbeMs(now) - now) / 1000));
  const retryAfterSec = capProviderRetrySeconds(requestedSec);
  const automatic = aggressive || (attempt < MAX_AUDITOR_AUTO_RETRY_ATTEMPTS && now + retryAfterSec * 1_000 <= untilMs);
  return { attempt, retryAfterSec, firstAt, autoRetryUntil: new Date(untilMs).toISOString(), automatic, requestedSec, unbounded: aggressive };
}

export type AuditorModelCandidate = AuditorFallbackCandidate;
type DetachedAuditResult = Awaited<ReturnType<typeof runDetachedGoalCompletionAuditor>>;

export type AutomaticCompletionRecoveryTrigger = "session-start" | "host-rebind" | "main-model-recovery" | "auditor-recovery-timer";

/**
 * Start the one durable automatic retry reserved for a parked completion
 * claim. The caller must already have a healthy lifecycle/recovery signal;
 * this helper adds the current-generation/context and goal guards. The
 * transition to `phase: "running"` plus `automaticRecoveryAttempted: true`
 * happens synchronously in beginCompletionAudit before the detached worker
 * is launched, so repeated lifecycle events cannot create a second worker.
 * A failed automatic retry keeps the claim safe for explicit /goal resume but
 * is not eligible for another automatic event-triggered attempt.
 */
export function maybeAutoRetryParkedCompletionAudit(trigger: AutomaticCompletionRecoveryTrigger): boolean {
  // v0.35.23 (note.md Next #2): a plain LOAD HOLD stops every automatic
  // recovery trigger — pending claims wait for an explicit decision. The
  // single exempt is "main-model-recovery": the claim was parked BY the
  // provider failure, and the recovery ladder healing IS the pinned
  // one-shot consent. Manual /glla pause freezes all triggers regardless.
  if (loadHoldActive(state) && trigger !== "main-model-recovery") return false;
  const goal = state.goal;
  const claim = goal?.pendingCompletion;
  if (!goal || goal.status !== "paused" || !claim || claim.auditorFallbackExhausted) return false;
  if ((claim.phase ?? "recovery-pending") !== "recovery-pending") return false;
  if (completionAuditInFlight) return false;

  const generation = sessionGeneration;
  const ctx = freshCtxForGeneration(generation);
  if (!ctx) return false;
  const aggressive = aggressiveAuditorRecoveryEnabled(ctx.cwd);
  if (claim.automaticRecoveryAttempted === true && !aggressive) return false;
  if (aggressive) {
    const window = automaticRecoveryWindow(claim, Date.now(), true);
    if (Number.isFinite(window.untilMs) && Date.now() >= window.untilMs) return false;
  }
  if (!guardGoalBeforeContinuation(ctx, "stored-completion-audit", goal.id, { allowAuditing: true })) return false;

  const current = state.goal;
  const currentClaim = current?.pendingCompletion;
  if (
    !current
    || current.id !== goal.id
    || current.status !== "paused"
    || !currentClaim
    || (currentClaim.phase ?? "recovery-pending") !== "recovery-pending"
    || (currentClaim.automaticRecoveryAttempted === true && !aggressive)
  ) return false;

  appendLedger(ctx.cwd, "audit_recovery_auto_retry_claimed", {
    goalId: current.id,
    previousAttemptId: currentClaim.attemptId,
    trigger,
    generation,
  });
  // beginCompletionAudit runs before retryStoredCompletionAudit reaches its
  // first await, atomically replacing the parked claim with a running claim
  // and consuming the durable one-shot marker.
  void retryStoredCompletionAudit("session-recovery", trigger === "main-model-recovery");
  return true;
}

function auditorCandidateLabel(candidate: AuditorModelCandidate): string {
  const model = candidate.model;
  const modelName = typeof model === "string"
    ? model
    : model && typeof model === "object" && typeof model.provider === "string" && typeof model.id === "string"
      ? `${model.provider}/${model.id}`
      : "(unset)";
  return `${modelName} (${candidate.via})`;
}

/** Persist a candidate/failure cursor only while the detached audit still
 * owns the current generation and logical claim. Returning false is a hard
 * stop for the fallback walker: launching or advancing without a durable
 * cursor would make a host restart repeat a provider call unpredictably. */
function persistDetachedAuditorCursor(
  generation: number,
  goalId: string,
  attemptId: string,
  info: AuditorFallbackAttemptInfo | AuditorFallbackExhaustionInfo,
  patch: Partial<PendingCompletion>,
): boolean {
  const current = detachedAuditContext(generation, goalId, attemptId);
  const claim = state.goal?.pendingCompletion;
  if (!current || !claim || claim.attemptId !== attemptId) return false;
  return updateGoal({
    pendingCompletion: {
      ...claim,
      auditorCandidateRefs: info.candidateRefs.slice(0, MAX_AUDITOR_CANDIDATE_REFS),
      ...patch,
    },
  }, current);
}

/**
 * Run a detached audit through a bounded model cascade. Model selection has a
 * primary, ordered fallback chain, and the session model as the last rung.
 * A resolved primary can still fail after launch (provider auth, RPC startup,
 * or a dead stream), so selection-time fallback alone is insufficient. Retry
 * the same model once, then advance to the next candidate at most once per
 * candidate. The worker remains detached for every rung; this is a model
 * fallback, never an in-process/session fallback.
 */
export async function runDetachedCompletionWithFallback(
  candidates: AuditorModelCandidate[],
  run: (candidate: AuditorModelCandidate) => Promise<DetachedAuditResult>,
  opts: {
    shouldRetry?: () => boolean;
    sleep?: (ms: number) => Promise<void>;
    resumeCandidateRef?: string;
    attemptedRefs?: readonly string[];
    retryCandidateRef?: string;
    retryAttemptStarted?: boolean;
    retryFailureClass?: "no-verdict" | "timeout" | "transport" | "provider";
    onAttempt?: (candidate: AuditorModelCandidate, info: AuditorFallbackAttemptInfo) => boolean | void;
    onRetry?: (candidate: AuditorModelCandidate, error: string, info?: AuditorFallbackAttemptInfo) => boolean | void;
    onCandidateExhausted?: (candidate: AuditorModelCandidate, error: string, info: AuditorFallbackExhaustionInfo) => boolean | void;
    onFallback?: (from: AuditorModelCandidate, to: AuditorModelCandidate, error: string) => void;
    forbiddenRefs?: readonly string[];
    retryBaseMinutes?: number;
    onSelection?: (event: { scope: { kind: string }; fromRef?: string; toRef?: string; reason: string }) => void;
  } = {},
): Promise<{ result: DetachedAuditResult; retriedOnce: boolean; fallbackUsed: boolean; via: string }> {
  return runAuditorFallbackWithPolicy(candidates, run, {
    forbiddenRefs: opts.forbiddenRefs,
    shouldRetry: opts.shouldRetry,
    sleep: opts.sleep,
    retryBaseMinutes: opts.retryBaseMinutes,
    onSelection: opts.onSelection,
    resumeCandidateRef: opts.resumeCandidateRef,
    attemptedRefs: opts.attemptedRefs,
    retryCandidateRef: opts.retryCandidateRef,
    retryAttemptStarted: opts.retryAttemptStarted,
    retryFailureClass: opts.retryFailureClass,
    onAttempt: (candidate, info) => opts.onAttempt?.(candidate, info),
    onRetry: (candidate, error, delayMs, info) => opts.onRetry?.(candidate, error, info),
    onCandidateExhausted: (candidate, error, info) => opts.onCandidateExhausted?.(candidate, error, info),
    onFallback: (from, to, error) => opts.onFallback?.(from, to, error),
  });
}

/**
 * v0.28.26: stored-claim retry for a completion claim. The auditor stopped
 * at complete_goal time; the claim (completionSummary + verificationSummary)
 * was persisted on the goal, and the next retry runs the AUDITOR directly —
 * no agent turn. Re-engaging the
 * agent to re-submit an unchanged claim produced a hallucinated-closure
 * repetition loop in the field (π-games: the model concluded the goal was
 * closed, repeated the same essay 4×+, stormed continuations, compacted 14×
 * in 35 minutes, and burned the stall brake).
 *
 * Outcomes: approved → close + cascade (archiveCurrentGoal handles list
 * advance + reviewer); another infrastructure failure → re-pause with a
 * fresh scheduled retry (claim preserved); anything else (disapproved,
 * impossible, semantic infra) → preserve the claim and pause for explicit `/goal resume`, while
 * semantic verdicts remain durable in auditHistory.
 */
async function retryStoredCompletionAudit(origin: CompletionAuditOrigin = "provider-retry", exemptLoadHold = false): Promise<void> {
  // v0.35.15: `/glla pause` freezes automatic audit recovery — provider
  // retries and session-recovery re-starts stay parked while the supervisor
  // is paused. Explicit manual requests (`/goal resume`, `/goal verify`)
  // still run: the user typed them, so they are not "automatic machinery".
  // v0.35.23: exemptLoadHold carves out ONE narrow path from the automatic
  // LOAD HOLD (never from a manual /glla pause): a main-model-recovery
  // triggered retry. The claim was parked by provider infrastructure
  // failure; the recovery ladder healing the provider IS the durable
  // consent for its single retry (pinned v0.35.x).
  if (origin !== "manual" && supervisorPaused(state) && !exemptLoadHold) return;
  const goal = state.goal;
  if (!goal?.pendingCompletion) return;
  if (origin !== "manual" && goal.pendingCompletion.auditorFallbackExhausted) return;
  const goalId = goal.id;
  if (completionAuditInFlight) return;
  const generation = sessionGeneration;
  // Delayed audit recovery has no safe fallback: if the current generation
  // cannot be proven live, the fresh session must rehydrate the durable claim.
  const initialCtx = freshCtxForGeneration(generation);
  if (!initialCtx) return;
  if (!guardGoalBeforeContinuation(initialCtx, "stored-completion-audit", goalId, { allowAuditing: true })) return;
  const guardedGoal = state.goal;
  if (!guardedGoal || guardedGoal.id !== goalId || !guardedGoal.pendingCompletion) return;
  completionAuditRecoveryArmed = true;
  let liveCtx: ExtensionContext = initialCtx;
  const claim = beginCompletionAudit(liveCtx, guardedGoal.pendingCompletion, origin);
  if (!claim) {
    liveCtx.ui.notify("Stored completion claim was not persisted for auditor recovery; no auditor was launched. Fix .pi-glla storage and retry explicitly.", "warning");
    appendLedger(liveCtx.cwd, "audit_dispatch_persistence_failed", { goalId, origin });
    return;
  }
  const auditGoal = state.goal;
  if (!auditGoal || auditGoal.id !== goalId) return;
  if (origin === "session-recovery") {
    appendLedger(liveCtx.cwd, "audit_recovery_started", { goalId, attemptId: claim.attemptId });
  } else {
    appendLedger(liveCtx.cwd, "goal_resumed", { via: origin === "manual" ? "manual-audit" : "provider-retry-direct-audit" });
  }
  liveCtx.ui.notify(origin === "manual"
    ? "Manual /goal verify — starting the detached auditor now (no agent turn needed)."
    : origin === "session-recovery"
      ? "Fresh session recovered the interrupted completion audit — starting a detached retry for the stored claim."
      : "Auditor provider retry is due — starting a detached retry with your stored completion claim (no agent turn needed).", "info");
  const settings = loadSettings(liveCtx.cwd);
  // v0.37.0: configurable + adaptive timeouts. The bases are user settings
  // (slow local models raise them); the durable escalation index on the
  // claim doubles the effective budget per previously launched attempt
  // (cap 4× base), so a retried audit never re-runs into the identical
  // budget that timed out before.
  const auditorToolBaseMs =
    settings.auditorToolTimeoutMs ?? DEFAULT_AUDITOR_TOOL_TIMEOUT_MS;
  const auditorStallBaseMs =
    settings.auditorStallMs ?? DEFAULT_AUDITOR_STALL_MS;
  let dispatchTimeouts = {
    toolTimeoutMs: escalatedAuditorTimeout(
      auditorToolBaseMs,
      claim.timeoutEscalation ?? 0,
    ),
    stallMs: escalatedAuditorTimeout(
      auditorStallBaseMs,
      claim.timeoutEscalation ?? 0,
    ),
  };
  const { model: auditorModel, error: modelError, via, fallbackModels } = resolveAuditorModel(liveCtx, settings.auditorModel, settings.auditorModelFallbacks, settings.auditorSameSessionSwap !== false);
  if (modelError) {
    const modelFailureCopy = providerErrorPresentation(modelError, "completion");
    liveCtx.ui.notify(`Auditor model issue: ${modelFailureCopy.display}. ${modelFailureCopy.action}`, "warning");
    appendLedger(liveCtx.cwd, "auditor_model_issue", { error: modelFailureCopy.diagnostic, display: modelFailureCopy.display });
  }
  const auditorCandidates: AuditorModelCandidate[] = [{ model: auditorModel, via: via ?? "unset" }, ...(fallbackModels ?? [])];
  const configuredAuditorRefs = auditorCandidateRefs(auditorCandidates);
  const persistedAuditorAttemptedRefs = (claim.auditorAttemptedRefs ?? [])
    .filter((ref) => configuredAuditorRefs.some((candidateRef) => candidateRef.toLowerCase() === ref.toLowerCase()))
    .slice(0, MAX_AUDITOR_CANDIDATE_REFS);
  const persistedAuditorCandidateRef = claim.auditorCandidateRef
    && configuredAuditorRefs.some((ref) => ref.toLowerCase() === claim.auditorCandidateRef!.toLowerCase())
    ? claim.auditorCandidateRef
    : undefined;
  const persistedAuditorRetryCandidateRef = claim.auditorRetryCandidateRef
    && configuredAuditorRefs.some((ref) => ref.toLowerCase() === claim.auditorRetryCandidateRef!.toLowerCase())
    ? claim.auditorRetryCandidateRef
    : undefined;
  completionAuditInFlight = true;
  completionAuditGeneration = generation;
  latestAuditProgress = {
    label: origin === "session-recovery" ? "recovery starting" : origin === "manual" ? "manual verify" : "provider retry",
    phase: "starting",
    model: modelRef(auditorModel),
    via: via ?? "unset",
    lastEventAt: Date.now(),
  };
  const auditStartMs = Date.now();
  let result: Awaited<ReturnType<typeof runDetachedGoalCompletionAuditor>>;
  let retriedOnce = false;
  let fallbackUsed = false;
  // v0.38.3: the live-inspection session path, captured from worker progress
  // BEFORE the finally clears latestAuditProgress — the approval notify uses
  // it to point the user at the kept resumable session.
  let inspectionSessionPath: string | undefined;
  try {
    ({ result, retriedOnce, fallbackUsed } = await runDetachedCompletionWithFallback(
      auditorCandidates,
      (candidate) => {
        // Progress records do not carry parent-side candidate metadata. Mark
        // the selected ref before launching each attempt; publishDetached-
        // AuditProgress preserves it across worker snapshots and fallback
        // attempts.
        latestAuditProgress = {
          ...(latestAuditProgress ?? {}),
          model: modelRef(candidate.model),
          via: candidate.via,
        };
        // v0.37.0: the worker gets the SAME budgets via env so the worker's
        // own per-tool timer and inactivity brake agree with the parent
        // watchdogs instead of racing them at different values.
        const { toolTimeoutMs, stallMs } = dispatchTimeouts;
        return runDetachedGoalCompletionAuditor({
          cwd: liveCtx.cwd,
          goal: auditGoal,
          completionSummary: claim.completionSummary,
          verificationSummary: claim.verificationSummary,
          model: candidate.model,
          // Unset follows the parent session dial, matching the Auditor
          // settings row; max is the safe detached default when a headless
          // context does not expose a thinking level.
          thinkingLevel: (settings.auditorThinkingLevel ?? liveCtx.thinkingLevel ?? "max") as any, // pi ≥0.83 understands max; dev-types predate it
          // v0.36.0: raw settings allowlist; the process layer resolves
          // entries to install paths before hashing (see
          // goal-loop-auditor-process.ts).
          allowedExtensions: settings.auditorAllowedExtensions,
          // v0.38.3: opt-in live inspection — persist the auditor's pi as a
          // resumable session pinned inside the job dir (off = --no-session).
          inspection: settings.auditorInspection === true,
          runtime: {
            attemptId: () => newDetachedAuditJobAttemptId(claim.attemptId!),
            logicalAttemptId: claim.attemptId!,
            // v0.37.0: escalated budgets — per-tool ceiling, silence/
            // no-progress window, and first-event window all derive from the
            // same escalated pair (the first-event window keeps aliasing the
            // stall budget, now explicit).
            toolTimeoutMs,
            heartbeatNoProgressMs: stallMs,
            firstEventTimeoutMs: stallMs,
            env: {
              GLLA_AUDITOR_TOOL_TIMEOUT_MS: String(toolTimeoutMs),
              GLLA_AUDITOR_STALL_MS: String(stallMs),
            },
          },
          onProgress: (progress) => {
            // toolTimeoutMs is a dispatch fact for the display layer: the
            // quiet watcher exempts an in-budget long tool from the 3m
            // warning, and the card renders "tool: X · 4m / 20m budget".
            if (progress.sessionPath) inspectionSessionPath = progress.sessionPath;
            publishDetachedAuditProgress(generation, goalId, claim.attemptId!, { ...progress, toolTimeoutMs });
          },
          // v0.34.57: the parent-side heartbeat-without-progress watchdog
          // fired — persist the auditor_stalled ledger event so the recovery
          // path can distinguish "wedged worker" from other timeouts.
          onStalled: (info) => {
            const current = detachedAuditContext(generation, goalId, claim.attemptId!);
            if (!current) return;
            appendLedger(current.cwd, "auditor_stalled", { goalId, attemptId: claim.attemptId, ...info });
          },
        });
      },
      {
        shouldRetry: () => detachedAuditContext(generation, goalId, claim.attemptId!) !== null,
        forbiddenRefs: settings.forbiddenModels,
        retryBaseMinutes: settings.mainModelRetryMinutes,
        onSelection: (event: { scope: { kind: string }; fromRef?: string; toRef?: string; reason: string }) => appendLedger(liveCtx.cwd, "model_fallback_select", { scope: "auditor", fromRef: event.fromRef, toRef: event.toRef, reason: event.reason }),
        resumeCandidateRef: persistedAuditorCandidateRef,
        attemptedRefs: persistedAuditorAttemptedRefs,
        retryCandidateRef: persistedAuditorRetryCandidateRef,
        retryAttemptStarted: !!claim.auditorRetryAttemptStartedAt,
        retryFailureClass: claim.auditorFailureClass,
        onAttempt: (_candidate, info) => {
          // v0.37.0: this launch's budgets come from the persisted index
          // BEFORE incrementing; the increment persists through the same
          // cursor write, so the NEXT launch (same-candidate retry, candidate
          // fallback, or a scheduled/manual retry after a restart) reads the
          // doubled budgets.
          const priorEscalation =
            state.goal?.pendingCompletion?.timeoutEscalation ?? 0;
          dispatchTimeouts = {
            toolTimeoutMs: escalatedAuditorTimeout(
              auditorToolBaseMs,
              priorEscalation,
            ),
            stallMs: escalatedAuditorTimeout(
              auditorStallBaseMs,
              priorEscalation,
            ),
          };
          return persistDetachedAuditorCursor(
            generation,
            goalId,
            claim.attemptId!,
            info,
            {
              auditorCandidateRef: info.candidateRef,
              auditorAttemptedRefs: info.attemptedRefs.slice(0, MAX_AUDITOR_CANDIDATE_REFS),
              auditorRetryAttemptStartedAt: info.attempt === 2 ? new Date().toISOString() : undefined,
              ...(info.failureCount === 0 ? {
                auditorRetryCandidateRef: undefined,
                auditorFailureClass: undefined,
                auditorFailureAt: undefined,
              } : {}),
              auditorFailureCount: Math.min(2, Math.max(0, info.failureCount)),
              timeoutEscalation: priorEscalation + 1,
            },
          );
        },
        onRetry: (candidate, err, info) => {
          if (!info) return false;
          const persisted = persistDetachedAuditorCursor(
            generation,
            goalId,
            claim.attemptId!,
            info,
            {
              auditorCandidateRef: info.candidateRef,
              auditorRetryCandidateRef: info.candidateRef,
              auditorRetryAttemptStartedAt: undefined,
              auditorAttemptedRefs: info.attemptedRefs.slice(0, MAX_AUDITOR_CANDIDATE_REFS),
              auditorFailureCount: 1,
              auditorFailureClass: info.failureClass ?? "provider",
              auditorFailureAt: new Date().toISOString(),
            },
          );
          if (!persisted) return false;
          const current = detachedAuditContext(generation, goalId, claim.attemptId!);
          if (current) {
            const failureCopy = providerErrorPresentation(err, "completion");
            appendLedger(current.cwd, "audit_infra_retry", {
              goalId,
              model: auditorCandidateLabel(candidate),
              error: failureCopy.diagnostic.slice(0, 200),
              diagnostic: failureCopy.diagnostic,
              display: failureCopy.display,
              candidateRef: info.candidateRef,
              failureClass: info.failureClass ?? "provider",
            });
          }
          return true;
        },
        onCandidateExhausted: (candidate, err, info) => {
          const next = info.nextCandidateRef;
          const persisted = persistDetachedAuditorCursor(
            generation,
            goalId,
            claim.attemptId!,
            info,
            next
              ? {
                auditorCandidateRef: next,
                auditorRetryCandidateRef: undefined,
                auditorRetryAttemptStartedAt: undefined,
                auditorAttemptedRefs: info.attemptedRefs.slice(0, MAX_AUDITOR_CANDIDATE_REFS),
                auditorFailureCount: 0,
                auditorFailureClass: undefined,
                auditorFallbackExhausted: undefined,
                auditorFailureAt: undefined,
              }
              : {
                auditorCandidateRef: undefined,
                auditorRetryCandidateRef: undefined,
                auditorRetryAttemptStartedAt: undefined,
                auditorAttemptedRefs: info.attemptedRefs.slice(0, MAX_AUDITOR_CANDIDATE_REFS),
                auditorFailureCount: 2,
                auditorFailureClass: info.failureClass,
                auditorFallbackExhausted: true,
                auditorFailureAt: new Date().toISOString(),
              },
          );
          if (!persisted) return false;
          const current = detachedAuditContext(generation, goalId, claim.attemptId!);
          if (current) {
            const failureCopy = providerErrorPresentation(err, "completion");
            appendLedger(current.cwd, "auditor_candidate_exhausted", {
              goalId,
              model: auditorCandidateLabel(candidate),
              candidateRef: info.candidateRef,
              nextCandidateRef: next,
              attemptedRefs: info.attemptedRefs.slice(0, MAX_AUDITOR_CANDIDATE_REFS),
              candidateRefs: info.candidateRefs.slice(0, MAX_AUDITOR_CANDIDATE_REFS),
              failureClass: info.failureClass,
              error: failureCopy.diagnostic.slice(0, 200),
              diagnostic: failureCopy.diagnostic,
              display: failureCopy.display,
              fallbackExhausted: !next,
            });
          }
          return true;
        },
        onFallback: (from, to, err) => {
          const current = detachedAuditContext(generation, goalId, claim.attemptId!);
          if (!current) return;
          const failureCopy = providerErrorPresentation(err, "completion");
          appendLedger(current.cwd, "auditor_runtime_model_fallback", { goalId, from: auditorCandidateLabel(from), to: auditorCandidateLabel(to), error: failureCopy.diagnostic.slice(0, 200), diagnostic: failureCopy.diagnostic, display: failureCopy.display });
          current.ui.notify(`Detached auditor failed on ${auditorCandidateLabel(from)} — retrying with ${auditorCandidateLabel(to)}. This is infrastructure, not a verdict.`, "warning");
        },
      },
    ));
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    const exceptionReason = `auditor run exception: ${reason}`;
    const recoveryCtx = freshCtxForGeneration(generation);
    const current = state.goal;
    // An unexpected exception is not safely attributable to a completed
    // candidate call. Stop automatic recovery at this state boundary rather
    // than allowing a restart to replay an unknown provider request; explicit
    // manual recovery clears this exhausted cursor for a fresh bounded run.
    const exceptionCursor = {
      auditorFallbackExhausted: true,
      auditorFailureClass: "transport" as const,
      auditorFailureAt: new Date().toISOString(),
    };
    if (recoveryCtx && current?.id === goalId && current.pendingCompletion?.attemptId === claim.attemptId) {
      markCompletionAuditRecoveryPending(recoveryCtx, exceptionReason, exceptionCursor);
      recoveryCtx.ui.notify("Stored completion audit failed before producing a result; the claim is parked for a bounded recovery attempt.", "warning");
      appendLedger(recoveryCtx.cwd, "audit_recovery_exception", {
        goalId,
        attemptId: claim.attemptId,
        diagnostic: providerErrorPresentation(reason, "completion").diagnostic,
      });
    } else {
      // The retained context is probe-only after a generation handoff. The
      // context-free parking helper persists through the durable cwd without
      // writing through a stale ExtensionContext.
      parkCompletionAuditRecovery(liveCtx.cwd, exceptionReason, exceptionCursor);
    }
    return;
  } finally {
    if (ownsDetachedAudit(generation, goalId, claim.attemptId!)) {
      clearDetachedAuditProgress(generation, goalId, claim.attemptId!);
      completionAuditInFlight = false;
      completionAuditGeneration = null;
    }
  }
  const currentAfterAudit = freshCtxForGeneration(generation);
  if (!currentAfterAudit || !state.goal || state.goal.id !== goalId) {
    // v0.34.80 (field: 2026-08-07): NEVER drop a completed verdict silently.
    // The gate nulls out on a latched-stale LIVE session (extensionApiStale
    // from transient heartbeat-probe failures) — the goal then froze in
    // "auditing" with no in-flight audit and the stranded backstop
    // unreachable below the stale latch in heartbeatTick. The worker's
    // verdict (result.json) sat complete on disk for 30m+ while the queue
    // was blocked. Leave a durable marker via the kept last context so the
    // fresh session's recovery path parks the claim for an explicit resume.
    if (state.goal?.status === "auditing" && state.goal.pendingCompletion?.attemptId === claim.attemptId) {
      const recoveryCtx = freshCtxForGeneration(generation);
      if (recoveryCtx) {
        appendLedger(recoveryCtx.cwd, "audit_verdict_deferred", { goalId, attemptId: claim.attemptId, reason: "stale-latch-apply-gate" });
        markCompletionAuditRecoveryPending(recoveryCtx, "verdict-apply-gate");
      } else {
        // No valid context exists in this generation. The next lifecycle must
        // rehydrate the still-auditing claim; never call updateGoal with the
        // retained stale context merely to force a durable write.
        const cwd = liveCtx.cwd;
        appendLedger(cwd, "audit_verdict_deferred", { goalId, attemptId: claim.attemptId, reason: "stale-latch-apply-gate-no-context" });
      }
    }
    return;
  }
  if (state.goal.pendingCompletion?.attemptId !== claim.attemptId) return; // a newer attempt owns the durable claim
  liveCtx = currentAfterAudit;
  // Cursor callbacks may have advanced this same claim while the worker was
  // running. Never rebuild a recovery record from the stale pre-dispatch
  // snapshot: that would erase the candidate position on the first failure.
  const durableClaim = state.goal.pendingCompletion ?? claim;
  result = normalizeAuditorInfrastructureResult(result);

  // v0.34.61: focus revision guard — contract-scoped. The detached
  // worker captured (goalId, revision) at dispatch; only a CONTRACT
  // change (tweak / newObjective) bumps the counter now, so a mismatch
  // means the goal's contract moved while the audit ran — the verdict
  // must NOT apply to the new contract. Non-contract writes (pause,
  // status flips, quota machinery) no longer trip this guard; they do
  // v0.34.74 (interrupt-didn't-continue): the guard MUST normalize the
  // never-set revision (undefined) to 0 — the raw `undefined !== 0`
  // comparison spuriously refused verdicts for goals whose revision was
  // never bumped (field-observed in junk-runner 2026-08-07: goal
  // 20260806215307-4irtlm rev undefined, auditor captured 0, verdict
  // REFUSED even though the contract had NOT moved; the refusal then
  // stranded the goal and the loop went silent for 7.5h).
  // isGoalRevisionCurrent is the canonical normalized check.
  if (result.goalRevision && !isGoalRevisionCurrent(result.goalRevision, state.goal)) {
    appendLedger(liveCtx.cwd, "stale_revision_refused", {
      goalId,
      captured: result.goalRevision,
      current: { goalId: state.goal.id, revision: state.goal.revision ?? 0 },
      attemptId: claim.attemptId,
      approvedClaimed: result.approved,
      disapprovedClaimed: result.disapproved,
      error: result.error?.slice?.(0, 200),
    });
    liveCtx.ui.notify(
      `Stale auditor verdict REFUSED: goal ${goalId} revision is ${state.goal.revision ?? 0} but the auditor captured ${result.goalRevision.revision}. The goal moved on during the audit — its verdict was not applied. Run /goal verify again to audit the current state.`,
      "warning",
    );
    // v0.34.59: leave the goal active. The stale claim is consumed
    // (cleared) so we do not loop on a forever-stale retry. The user can
    // /goal verify to re-engage on current state.
    // v0.34.74: the status flip is REQUIRED, not cosmetic — the goal is in
    // `auditing` here, and isActionableGoal() (sendContinuation's gate)
    // requires status === "active". Without the flip the scheduled
    // continuation silently never sent, the heartbeat stranded the goal
    // 90s later, and the list item sat paused "completion audit
    // interrupted — no verdict" until a manual resume (the 2026-08-07
    // junk-runner incident).
    updateGoal({ ...(state.goal?.status === "auditing" ? { status: "active" } : {}), pendingCompletion: undefined }, liveCtx);
    scheduleContinuation(liveCtx, true);
    return;
  }

  // Record the run in history via the shared push path (scope transitions
  // in appendAuditVerdict: a new disapproval retires older live rounds,
  // a clean approval clears the objection pin).
  const auditorRan = result.output.trim().length > 0;
  const history = state.goal.auditHistory ?? [];
  if (auditorRan) {
    result.output = stripThinkBlocks(result.output);
    appendAuditVerdict(history, {
      at: nowIso(),
      approved: result.approved,
      disapproved: result.disapproved,
      impossible: result.impossible,
      impossibleReason: result.impossibleReason,
      model: result.model,
      thinkingLevel: result.thinkingLevel,
      report: result.output,
      error: result.error,
      regressionShieldPassed: result.regressionShieldPassed,
      regressionShieldMissing: result.regressionShieldMissing,
      // v0.34.60 (steal #3): the revision the worker audited (captured at
      // dispatch) — the revision-bound validity gate reads this.
      revision: result.goalRevision?.revision ?? state.goal.revision ?? 0,
      durationMs: Date.now() - auditStartMs,
    });
    const verdict: AuditLogEntry["verdict"] =
      result.error && !result.approved && !result.disapproved
        ? "error"
        : result.approved && result.regressionShieldPassed === false
          ? "shield_blocked"
          : result.approved
            ? "approved"
            : result.impossible
              ? "impossible"
              : "disapproved";
    appendAuditLog(liveCtx.cwd, {
      at: nowIso(),
      goalId: state.goal.id,
      objective: state.goal.objective.slice(0, 200),
      verdict,
      model: result.model,
      thinkingLevel: result.thinkingLevel ?? "(default)",
      report: result.output,
      impossibleReason: result.impossibleReason,
      error: result.error,
      durationMs: Date.now() - auditStartMs,
      retriedOnce,
      fallbackUsed,
    } as AuditLogEntry);
  }

  if (result.approved && result.regressionShieldPassed !== false) {
    updateGoal({ auditHistory: history, pendingCompletion: undefined }, liveCtx);
    // v0.34.91: capture the recap BEFORE archiveCurrentGoal (it mutates
    // state.goal). The end-of-goal message says WHAT HAPPENED, not
    // "auditor approved" — that's process, not information (the field
    // complaint across Screenshot_20260808_012905/013220/013515: three
    // boilerplate "claim persisted/auditor queued" lines + a "Goal complete
    // — auditor X approved" card read as useless summary spam). The recap
    // is the agent's completionSummary when captured; the objective is the
    // fallback for legacy/aborted goals.
    const terminalReason = `auditor ${result.model} approved (${origin})`;
    const recap = compactTerminalCompletionSummary({
      goal: state.goal,
      status: "complete",
      stopReason: terminalReason,
      archivePath: path.relative(liveCtx.cwd, archivedGoalPath(liveCtx.cwd, state.goal.id)) || archivedGoalPath(liveCtx.cwd, state.goal.id),
    }, state.goal.completionSummary);
    // Computed pre-archive: archiveCurrentGoal clears state.goal.
    const brief = terminalHumanBrief({
      goal: state.goal,
      status: "complete",
      stopReason: terminalReason,
      archivePath: path.relative(liveCtx.cwd, archivedGoalPath(liveCtx.cwd, state.goal.id)) || archivedGoalPath(liveCtx.cwd, state.goal.id),
    }, state.goal.completionSummary);
    const approvalVia = `${origin === "manual" ? " on /goal verify" : origin === "session-recovery" ? " after session recovery" : " on the provider retry"}${fallbackUsed ? " after an auditor-model fallback" : ""}`;
    // v0.38.20: the chat record pointer. Computed pre-archive like the
    // recap/brief above (archiveCurrentGoal clears state.goal).
    const approvalRecord = `— record: ${path.relative(liveCtx.cwd, archivedGoalPath(liveCtx.cwd, state.goal.id)) || archivedGoalPath(liveCtx.cwd, state.goal.id)}`;
    const archived = archiveCurrentGoal(liveCtx, "complete", `auditor ${result.model} approved (${origin})`);
    if (!archived) {
      // archiveCurrentGoal already preserved the live record and warned the
      // user. Keep the approved claim recoverable, but never emit a terminal
      // success after the durable archive failed.
      updateGoal({
        status: "paused",
        pendingCompletion: undefined,
        pauseKind: "blocked",
        pauseReason: "completion approved but terminal archive persistence failed",
        pauseSuggestedAction: `Fix .pi-glla disk access or resolve the archive fence, then ${activeGoalSurfaceCommand("resume")} and call complete_goal again.`,
      }, liveCtx);
      appendLedger(liveCtx.cwd, "goal_archive_failed_after_approval", { goalId, attemptId: claim.attemptId, origin });
      return;
    }
    // v0.38.14: the chat notify is the human briefing — outcome first,
    // filler labels dropped — while the external notify keeps the compact
    // single line (pager/sound safe). v0.38.20: outcome + at most two
    // details + approval + record pointer; the agent's pre-verdict `Next:`
    // is stale the moment the verdict lands and never reaches the chat.
    // PR #43: live inspection — the auditor's pi persisted a resumable
    // session pinned inside the job dir. Point the user at it AFTER the
    // audit (interactive attach only now; while running it was read-only).
    liveCtx.ui.notify([...buildApprovalChatLines({
      outcome: brief.outcome,
      details: brief.details,
      approval: `— auditor ${result.model} approved${approvalVia}.`,
      record: approvalRecord,
    }),
      ...(inspectionSessionPath
        ? [`Auditor session kept for review: pi --session ${inspectionSessionPath} (or pi --fork ${inspectionSessionPath}).`]
        : []),
    ].join("\n"), "info");
    notifyExternal(liveCtx, `Goal complete (auditor approved, ${origin}): ${recap}`);
    // v0.38.18 (track 3): the toast above is ephemeral — without a
    // transcript entry the session keeps narrating "waiting on the
    // auditor's verdict" after the archive (junk-runner field). Deliver
    // the brief into the conversation. Skipped for manual /goal verify:
    // that runs inside a turn whose command output already closes the
    // transcript. Fire-once fenced inside the sender.
    if (origin !== "manual") {
      sendTerminalCompletionNotice(liveCtx, {
        goalId,
        outcome: brief.outcome,
        // v0.38.20: the transcript keeps the informing details, but the
        // stale pre-verdict `Next:` is stripped here too.
        details: [...withoutStaleNext(brief.details), `— auditor ${result.model} approved${approvalVia}.`],
      });
    }
    return;
  }

  if (result.regressionShieldPassed === false) {
    const missing = result.regressionShieldMissing ?? [];
    const detail = missing.length > 0
      ? `its evidence did not reference these contract items:\n${missing.map((item) => `- ${item}`).join("\n")}`
      : "its report did not include a valid <evidence> block";
    updateGoal({
      status: "active",
      auditHistory: history,
      pendingCompletion: undefined,
      pauseReason: "regression shield: auditor approved, but the evidence contract was not satisfied",
      pauseSuggestedAction: "Call complete_goal again — the next auditor run is told exactly which evidence the shield requires.",
    }, liveCtx);
    liveCtx.ui.notify(
      `Regression shield blocked completion: the auditor approved, but ${detail}.\n\nCall complete_goal again; the next audit will be told to quote raw evidence for each item.`,
      "warning",
    );
    appendLedger(liveCtx.cwd, "audit_shield_blocked", { goalId, attemptId: claim.attemptId, missing });
    scheduleContinuation(liveCtx, true);
    return;
  }

  const cursorPersistenceFailed = isAuditorCursorPersistenceFailure(result.error);
  if (result.error && (result.fallbackExhausted || cursorPersistenceFailed)) {
    // A candidate chain is a bounded recovery policy, not a new automatic
    // retry horizon. Once every allowed candidate has used its one retry, or
    // the parent could not persist the cursor, park the claim with no timer.
    // This is deliberately before the generic infrastructure branches so a
    // restart cannot walk the same exhausted chain again.
    const failureCopy = providerErrorPresentation(result.error, "completion");
    const recoveryEpisodeKey = durableClaim.recoveryEpisodeKey ?? `${durableClaim.at}:${failureCopy.fingerprint}`;
    const pending: PendingCompletion = {
      ...durableClaim,
      phase: "recovery-pending",
      recoveryAt: nowIso(),
      recoveryRetryAt: undefined,
      recoveryReason: cursorPersistenceFailed ? "auditor-cursor-persistence-failed" : "auditor-fallback-exhausted",
      providerErrorDiagnostic: failureCopy.diagnostic,
      recoveryEpisodeKey,
      recoveryNoticeKeys: durableClaim.recoveryNoticeKeys ?? [],
      auditorFailureClass: auditorResultFailureClass(result),
      auditorFallbackExhausted: result.fallbackExhausted || cursorPersistenceFailed ? true : undefined,
      auditorFailureAt: new Date().toISOString(),
    };
    const notifyParked = claimRecoveryNotice(pending, `${recoveryEpisodeKey}:fallback-exhausted`);
    updateGoal({
      status: "paused",
      auditHistory: history,
      pendingCompletion: pending,
      providerErrorDiagnostic: failureCopy.diagnostic,
      recoveryEpisodeKey,
      recoveryNoticeKeys: pending.recoveryNoticeKeys,
      pauseKind: "error",
      pauseResumeAt: undefined,
      pauseReason: cursorPersistenceFailed
        ? "completion auditor recovery cursor could not be persisted — automatic recovery stopped"
        : "completion auditor candidate fallback chain exhausted — no verifier verdict was produced",
      pauseSuggestedAction: `The stored completion claim is safe but automatic recovery is stopped. Inspect the auditor/provider setup, then ${activeGoalSurfaceCommand("resume")} to start a new bounded attempt.`,
    }, liveCtx);
    appendLedger(liveCtx.cwd, cursorPersistenceFailed ? "auditor_recovery_cursor_persistence_failed" : "auditor_fallback_exhausted", {
      goalId,
      attemptId: durableClaim.attemptId,
      failureClass: auditorResultFailureClass(result),
      diagnostic: failureCopy.diagnostic,
      display: failureCopy.display,
      recoveryEpisodeKey,
    });
    if (notifyParked) {
      liveCtx.ui.notify(
        cursorPersistenceFailed
          ? `Auditor recovery stopped because its durable cursor could not be saved. The completion claim remains stored; ${activeGoalSurfaceCommand("resume")} retries it explicitly.`
          : `Auditor fallback candidates are exhausted. The completion claim remains stored with no verifier verdict; inspect the provider setup, then ${activeGoalSurfaceCommand("resume")}.`,
        "warning",
      );
    }
    return;
  }

  if (result.error && !result.disapproved && isAuditorNoVerdictInfrastructureError(result.error, result.infrastructureClass)) {
    // Watchdog timeouts stay ahead of the provider retry branch: a hanging
    // verification command is a local infrastructure failure. Normal
    // mode gets one fresh stored-claim retry; aggressiveMode keeps this
    // independent recovery loop alive inside its durable window.
    const failureCopy = providerErrorPresentation(result.error, "completion");
    const recoveryEpisodeKey = durableClaim.recoveryEpisodeKey ?? `${durableClaim.at}:${failureCopy.fingerprint}`;
    let pending: PendingCompletion = {
      ...durableClaim,
      phase: "recovery-pending",
      recoveryAt: nowIso(),
      recoveryReason: result.error.startsWith("Auditor exceeded")
        ? "wall-timeout"
        : result.error.startsWith("Auditor stalled")
          ? "inactivity-timeout"
          : "auditor-no-verdict",
      providerErrorDiagnostic: failureCopy.diagnostic,
      recoveryEpisodeKey,
      recoveryNoticeKeys: durableClaim.recoveryNoticeKeys ?? [],
      automaticRecoveryAttempted: durableClaim.automaticRecoveryAttempted ?? false,
      auditorFailureClass: auditorResultFailureClass(result),
      auditorFailureAt: new Date().toISOString(),
    };
    if (typeof scheduleParkedCompletionAuditRecovery === "function") {
      pending = scheduleParkedCompletionAuditRecovery(liveCtx, pending, pending.recoveryReason ?? "auditor-timeout");
    }
    const persistentRecovery = pending.recoveryRetryAt !== undefined && aggressiveAuditorRecoveryEnabled(liveCtx.cwd);
    const notifyTimeout = claimRecoveryNotice(pending, `${recoveryEpisodeKey}:timeout`);
    const timeoutInfrastructure = result.infrastructureClass === "timeout" || /^Auditor (?:exceeded|stalled)\b/i.test(result.error);
    updateGoal({
      status: "paused",
      auditHistory: history,
      pendingCompletion: pending,
      providerErrorDiagnostic: failureCopy.diagnostic,
      recoveryEpisodeKey,
      recoveryNoticeKeys: pending.recoveryNoticeKeys,
      pauseKind: pending.recoveryRetryAt ? "wait" : "error",
      pauseResumeAt: pending.recoveryRetryAt,
      pauseReason: timeoutInfrastructure
        ? "completion audit timed out — no verifier verdict was produced"
        : "completion audit stopped before a verifier verdict — no semantic verdict was produced",
      pauseSuggestedAction: pending.recoveryRetryAt
        ? `${persistentRecovery ? "Aggressive mode keeps automatic auditor retries active" : "One bounded auditor retry is scheduled"} in ${fmtRetryDelay(Math.max(1, (Date.parse(pending.recoveryRetryAt) - Date.now()) / 1000))}; ${activeGoalSurfaceCommand("resume")} retries immediately.`
        : `The claim is stored. Check long-running verification commands, then ${activeGoalSurfaceCommand("resume")} to retry the isolated auditor.`,
    }, liveCtx);
    appendLedger(liveCtx.cwd,
      result.error.startsWith("Auditor exceeded")
        ? "audit_wall_timeout"
        : result.error.startsWith("Auditor stalled")
          ? "audit_inactivity_timeout"
          : "audit_no_verdict_infrastructure",
      { goalId, attemptId: claim.attemptId, error: failureCopy.diagnostic.slice(0, 240), diagnostic: failureCopy.diagnostic, recoveryEpisodeKey },
    );
    if (notifyTimeout) liveCtx.ui.notify(
      timeoutInfrastructure
        ? `Completion auditor timed out (infrastructure, not a verdict). The stored claim is safe; ${persistentRecovery ? "aggressive mode will keep retrying it" : `fix the command/model and ${activeGoalSurfaceCommand("resume")} to retry it`}.`
        : `Completion auditor stopped before a verdict (infrastructure, not a judgment). The stored claim is safe; ${persistentRecovery ? "aggressive mode will keep retrying it" : `fix the auditor/session issue and ${activeGoalSurfaceCommand("resume")} to retry it`}.`,
      "warning",
    );
    return;
  }

  // v0.36.0: ANY infrastructure failure enters the durable retry plan —
  // error text is not trusted to pick a failure family. Conservative mode
  // keeps its horizon; aggressive mode preserves the claim on recurring
  // per-attempt backoff until a state-based stop.
  if (result.error && !result.disapproved) {
    // Preserve the claim, but use a durable bounded plan.
    const failureCopy = providerErrorPresentation(result.error, "completion");
    const recoveryEpisodeKey = durableClaim.recoveryEpisodeKey ?? `${durableClaim.at}:${failureCopy.fingerprint}`;
    const aggressive = aggressiveAuditorRecoveryEnabled(liveCtx.cwd);
    const plan = auditorRetryPlan(durableClaim, undefined, undefined, aggressive);
    const pending = {
      ...durableClaim,
      phase: "retry-waiting" as const,
      recoveryAt: undefined,
      recoveryReason: undefined,
      recoveryRetryAt: undefined,
      providerErrorDiagnostic: failureCopy.diagnostic,
      recoveryEpisodeKey,
      recoveryNoticeKeys: durableClaim.recoveryNoticeKeys ?? [],
      auditorFailureClass: auditorResultFailureClass(result),
      auditorFailureAt: new Date().toISOString(),
      retryAttempts: plan.attempt,
      retryFirstAt: plan.firstAt,
      ...(aggressive ? { retryUntil: undefined } : { retryUntil: plan.autoRetryUntil }),
    };
    if (!plan.automatic) {
      const notifyCapped = claimRecoveryNotice(pending, `${recoveryEpisodeKey}:retry-capped`);
      updateGoal({
        status: "paused",
        auditHistory: history,
        pendingCompletion: pending,
        providerErrorDiagnostic: failureCopy.diagnostic,
        recoveryEpisodeKey,
        recoveryNoticeKeys: pending.recoveryNoticeKeys,
        pauseKind: "blocked",
        pauseResumeAt: undefined,
        pauseReason: `auditor retry: automatic retry horizon reached (${plan.attempt} attempts)`,
        pauseSuggestedAction: `The completion claim is stored, but automatic auditor retries are stopped. Check the auditor/model setup, then ${activeGoalSurfaceCommand("resume")} to start a fresh bounded window.`,
      }, liveCtx);
      appendLedger(liveCtx.cwd, "auditor_retry_capped", { streak: plan.attempt, autoRetryUntil: plan.autoRetryUntil, requestedSec: plan.requestedSec, diagnostic: failureCopy.diagnostic, recoveryEpisodeKey });
      if (notifyCapped) liveCtx.ui.notify(`Automatic auditor retries stopped after ${plan.attempt} bounded attempts — the claim stays stored; check the provider, then ${activeGoalSurfaceCommand("resume")}.`, "warning");
      return;
    }
    const notifyRetry = claimRecoveryNotice(pending, `${recoveryEpisodeKey}:retry-wait`);
    updateGoal({
      status: "paused",
      auditHistory: history,
      pendingCompletion: pending,
      providerErrorDiagnostic: failureCopy.diagnostic,
      recoveryEpisodeKey,
      recoveryNoticeKeys: pending.recoveryNoticeKeys,
      pauseKind: "wait",
      pauseResumeAt: new Date(Date.now() + plan.retryAfterSec * 1000).toISOString(),
      pauseReason: `auditor retry: ${failureCopy.display}`,
      pauseSuggestedAction: `Auto-retry in ${fmtRetryDelay(plan.retryAfterSec)} — or ${activeGoalSurfaceCommand("resume")} to retry now`,
    }, liveCtx);
    appendLedger(liveCtx.cwd, "goal_paused", { reason: `auditor retry: retry in ${plan.retryAfterSec}s (uniform schedule)`, attempt: plan.attempt, autoRetryUntil: plan.autoRetryUntil, diagnostic: failureCopy.diagnostic, recoveryEpisodeKey });
    if (notifyRetry) liveCtx.ui.notify(`Auditor still failing — next auto-retry in ${fmtRetryDelay(plan.retryAfterSec)} (your completion claim is stored; no action needed).`, "warning");
    scheduleProviderRetryForSession(liveCtx, plan.retryAfterSec, result.error, (fresh: ExtensionContext) => {
      if (state.goal && state.goal.status === "paused" && (state.goal.pauseReason ?? "").startsWith("auditor retry:") && state.goal.pendingCompletion) {
        void retryStoredCompletionAudit(origin);
      }
    }, undefined, {
      episodeKey: recoveryEpisodeKey,
      noticeKey: `${recoveryEpisodeKey}:retry-wait`,
      suppressNotice: true,
    });
    return;
  }



  // A full IMPOSSIBLE verdict is terminal even when it arrives through a
  // stored-claim retry. Partial verdicts retain the historical policy:
  // aggressive mode narrows and continues; conservative mode pauses for an
  // explicit user decision. The auditor history remains independent evidence.
  if (result.impossible) {
    const reason = result.impossibleReason || "(no reason given)";
    const aggressive = aggressiveAuditorRecoveryEnabled(liveCtx.cwd);
    if (aggressive && classifyImpossibleReason(reason) === "partial") {
      updateGoal({
        status: "active",
        auditHistory: history,
        pendingCompletion: undefined,
        pauseReason: `auditor verdict: IMPOSSIBLE (partial) — ${reason}`,
        pauseSuggestedAction: `Narrow the objective past the impossible part (complete_goal newObjective or ${activeGoalSurfaceCommand("tweak")}) and continue`,
      }, liveCtx);
      liveCtx.ui.notify(`Auditor (${origin}): part of the goal is IMPOSSIBLE — ${reason.slice(0, 140)}. aggressiveMode: narrowing and continuing.`, "warning");
      appendLedger(liveCtx.cwd, "impossible_partial_continue", { reason: reason.slice(0, 240), origin });
      scheduleContinuation(liveCtx, true);
      return;
    }
    if (classifyImpossibleReason(reason) === "partial") {
      updateGoal({
        status: "paused",
        auditHistory: history,
        pendingCompletion: undefined,
        pauseKind: "decision",
        pauseOptions: [`Tweak the objective — ${activeGoalSurfaceCommand("tweak")} <new text>`, `Cancel the goal (${activeGoalSurfaceCommand("cancel")})`],
        pauseRecommended: 1,
        pauseReason: `auditor verdict: IMPOSSIBLE (partial) — ${reason}`,
        pauseSuggestedAction: `The auditor says part of this goal can never be satisfied. ${activeGoalSurfaceCommand("tweak")} the objective to remove it, then ${activeGoalSurfaceCommand("resume")}.`,
      }, liveCtx);
      liveCtx.ui.notify(`Auditor (${origin}): part of the goal is IMPOSSIBLE — ${reason.slice(0, 140)}. Goal paused for an explicit narrowing decision.`, "warning");
      maybeDecisionPopup(liveCtx);
      appendLedger(liveCtx.cwd, "impossible_partial_paused", { reason: reason.slice(0, 240), origin });
      return;
    }
    const terminalReason = `auditor impossible: ${reason}`;
    const terminal = terminalizeImpossibleGoal(liveCtx, terminalReason, history);
    if (!terminal.archived) {
      updateGoal({
        status: "paused",
        auditHistory: history,
        pendingCompletion: undefined,
        pauseKind: "blocked",
        pauseReason: `auditor verdict: IMPOSSIBLE, but terminal archive failed — ${reason}`,
        pauseSuggestedAction: `Fix .pi-glla storage, then ${activeGoalSurfaceCommand("resume")} and retry the terminal archive.`,
      }, liveCtx);
      appendLedger(liveCtx.cwd, "goal_archive_failed_after_impossible", { reason: reason.slice(0, 240), origin });
      return;
    }
    const recap = compactCompletionSummary(terminal.summary);
    liveCtx.ui.notify(`Goal archived as aborted — auditor (${origin}) marked it IMPOSSIBLE: ${reason.slice(0, 180)}.\nRecap: ${recap}`, "warning");
    notifyExternal(liveCtx, `Goal archived as aborted (auditor impossible, ${origin}): ${recap}`);
    appendLedger(liveCtx.cwd, "provider_retry_impossible_terminalized", {
      goalId,
      attemptId: claim.attemptId,
      reason: reason.slice(0, 240),
      recap: terminal.summary.replace(/\s+/g, " ").slice(0, 600),
      origin,
    });
    return;
  }

  // Any other outcome — disapproved — belongs to the agent: resume and let
  // the continuation drive the next step. The verdict is durable in
  // auditHistory + /goal status.
  const aggressive = aggressiveAuditorRecoveryEnabled(liveCtx.cwd);
  const effectiveCap = resolveEffectiveAggressiveSettings(loadSettings(liveCtx.cwd));
  const auditCap = effectiveCap.auditCap;
  const trailingDisapprovals = countTrailingDisapprovals(history);
  const durableObjections = result.disapproved && aggressive
    ? (() => {
      const extracted = extractPendingTasks(sanitizeProviderAuditReport(result.output), 5);
      return extracted.length > 0
        ? extracted
        : [`Review the latest auditor disapproval in ${activeGoalStatusCommand()}.`];
    })()
    : [];
  if (result.disapproved && aggressive) {
    appendLedger(liveCtx.cwd, "audit_objections_todo", {
      goalId,
      attemptId: claim.attemptId,
      pendingTasks: durableObjections,
      source: "auditor-disapproval-retry",
    });
  }
  const repeatedNoProgress = countTrailingRepeatedDisapprovals(history);
  if (result.disapproved && aggressive && repeatedNoProgress >= MAX_REPEATED_AUDIT_NO_PROGRESS) {
    const stopReason = `repeated identical auditor objection ${repeatedNoProgress}× with no new progress`;
    updateGoal({
      status: "paused",
      auditHistory: history,
      pendingCompletion: undefined,
      pendingTasks: durableObjections,
      pauseKind: "decision",
      pauseOptions: [`Investigate the repeated objection, then ${activeGoalSurfaceCommand("resume")}`, `Tweak the objective — ${activeGoalSurfaceCommand("tweak")} <new text>`, `Cancel the goal (${activeGoalSurfaceCommand("cancel")})`],
      pauseRecommended: 1,
      pauseReason: stopReason,
      pauseSuggestedAction: `Automatic auditor retries stopped on a state-based no-progress signal. Inspect the repeated report and evidence, then ${activeGoalSurfaceCommand("resume")} after changing the work or contract.`,
    }, liveCtx);
    appendLedger(liveCtx.cwd, "audit_no_progress_stop", {
      goalId,
      attemptId: claim.attemptId,
      repeated: repeatedNoProgress,
      pendingTasks: durableObjections,
      reason: stopReason,
    });
    liveCtx.ui.notify(`Auditor automation paused: ${stopReason}. The objection is preserved as TODOs; inspect it before ${activeGoalSurfaceCommand("resume")}.`, "warning");
    maybeDecisionPopup(liveCtx);
    return;
  }
  if (result.disapproved && auditCap > 0 && trailingDisapprovals >= auditCap) {
    if (aggressive) {
      updateGoal({
        status: "active",
        auditHistory: history,
        pendingCompletion: undefined,
        pendingTasks: durableObjections,
        pauseReason: `auditor disapproved ${trailingDisapprovals}× consecutively (cap ${auditCap}) — aggressiveMode: continuing with TODOs`,
      }, liveCtx);
      appendLedger(liveCtx.cwd, "audit_cap_keep_going", { trailingDisapprovals, auditCap, pendingTasks: durableObjections, origin });
      liveCtx.ui.notify(`Auditor disapproved ${trailingDisapprovals}× (cap); aggressive mode keeps the goal active with durable TODOs.`, "warning");
      scheduleContinuation(liveCtx, true);
      return;
    }
    updateGoal({
      status: "paused",
      auditHistory: history,
      pendingCompletion: undefined,
      pauseKind: "decision",
      pauseOptions: [`Fix the disapproval gap, then continue (${activeGoalSurfaceCommand("resume")})`, `Tweak the objective — ${activeGoalSurfaceCommand("tweak")} <new text>`, `Cancel the goal (${activeGoalSurfaceCommand("cancel")})`],
      pauseRecommended: 1,
      pauseReason: `auditor disapproved ${trailingDisapprovals}× consecutively (cap ${auditCap})`,
      pauseSuggestedAction: `Read the audit history (${activeGoalStatusCommand()}), fix the actual gap or ${activeGoalSurfaceCommand("tweak")} the objective, then ${activeGoalSurfaceCommand("resume")}.`,
    }, liveCtx);
    appendLedger(liveCtx.cwd, "audit_cap_pause", { trailingDisapprovals, auditCap, origin });
    liveCtx.ui.notify(`Auditor disapproved ${trailingDisapprovals}× (cap ${auditCap}); the goal is paused for an explicit decision.`, "warning");
    maybeDecisionPopup(liveCtx);
    return;
  }
  const residualFailureCopy = providerErrorPresentation(result.error, "completion");
  updateGoal({
    status: "active",
    auditHistory: history,
    pendingCompletion: undefined,
    pendingTasks: aggressive ? durableObjections : undefined,
    pauseReason: result.disapproved
      ? `auditor disapproved on provider retry — see ${activeGoalStatusCommand()}`
      : result.impossible
        ? `auditor verdict: IMPOSSIBLE on provider retry — ${(result.impossibleReason ?? "").slice(0, 120)}`
        : `auditor infrastructure error on provider retry: ${residualFailureCopy.display}`,
  }, liveCtx);
  liveCtx.ui.notify(
    result.disapproved
      ? `Auditor (${origin}) DISAPPROVED — resuming; the report is in ${activeGoalStatusCommand()}.`
      : result.impossible
        ? `Auditor (${origin}): goal IMPOSSIBLE — ${(result.impossibleReason ?? "").slice(0, 100)}. Resuming; consider ${activeGoalSurfaceCommand("tweak")}.`
        : `Auditor (${origin}) hit an infrastructure error — resuming; re-call complete_goal when ready.`,
    "warning",
  );
  appendLedger(liveCtx.cwd, "provider_retry_audit_verdict", {
    approved: false,
    disapproved: result.disapproved,
    impossible: result.impossible,
    error: result.error?.slice(0, 160),
  });
  scheduleContinuation(liveCtx, true);
}

/**
 * v0.26.0: bind the reviewer to the live session. Sources for finding
 * extraction: the archived goal markdown + its audit reports + the
 * durable audit log entries for this goal. List items are enqueued via
 * the ONE enqueue path; /goal proposals go through the agent (which
 * calls propose_goal_draft → the user's Confirm dialog).
 */
function fireReviewer(
  ctx: ExtensionContext,
  source: { kind: "goal" | "list"; goalId: string; objective: string; terminal: string },
  opts: { manual?: boolean; mode?: "off" | "on" | "auto" | "aggressive" } = {},
): void {
  try {
    const settings = loadSettings(ctx.cwd);
    // v0.27.5: dual-read `reviewer` (legacy) and `postaudit` (new) settings
    // keys. `postaudit` takes precedence when both are present — the
    // existing settings file shape is preserved; the rename is purely
    // vocabulary on the user-facing surface.
    const reviewerBlock = (settings.postaudit ?? settings.reviewer) as Partial<ReviewerConfig> | undefined;
    const config = resolveReviewerConfig(reviewerBlock);
    if (opts.mode) config.mode = opts.mode;
    let archiveText: string | undefined;
    try {
      archiveText = fs.readFileSync(archivedGoalPath(ctx.cwd, source.goalId), "utf-8");
    } catch {
      /* archive md may not exist for manual review of a live goal */
    }
    // v0.26.4 source curation: an APPROVED audit report is the executor's
    // own completion claims — meta-text with zero finding signal (the
    // 0.26.2/0.26.3 misfires both mined it). Disapprovals/errors carry the
    // independent auditor's required-fixes — the real findings.
    // v0.34.61: superseded-disapproval curation — a disapproval answered
    // by a later approval on the same goal must NOT be re-mined (its
    // required fixes are already shipped; re-mining re-queues them verbatim
    // — field-observed 2026-08-06: round-1 report sliced into 3 junk /list
    // items after the round-2 approval, auto-activated by autoResume).
    const auditTexts = curateAuditReviewSources(readAuditLogForGoal(ctx.cwd, source.goalId), source.goalId).map((e) => e.report);
    // v0.35.x: automatic postaudit must not mine the archive's Objective or
    // verification contract as if either were an independent finding. That
    // metadata contains reviewer trigger words and can create truncated,
    // contract-less queue items after an otherwise approved completion. An
    // explicit /review may still inspect the archive; automatic review uses
    // only curated auditor reports.
    const sources = buildReviewerSources(archiveText, auditTexts, !!opts.manual);
    const ledgerEntries: Array<{ type: string; at?: string; value?: any }> = [];
    try {
      // Reviewer cadence only needs reviewer_fired timestamps. Stream the
      // ledger (including rotated segments) and retain that small predicate
      // set instead of materialising every lifecycle event in the main pi
      // process.
      scanLedgerRecords(ctx.cwd, (entry) => {
        if (entry.type === "reviewer_fired") ledgerEntries.push(entry);
      });
    } catch {
      /* no ledger yet */
    }
    const outcome = runReviewer(config, source, {
      cwd: ctx.cwd,
      nowMs: Date.now(),
      manual: opts.manual,
      ledgerEntries,
      sources,
      enqueueListItems: (objectives) => enqueueItems(ctx, objectives, "reviewer", { autoActivate: loadGlobalSettings().autoResume === true }),
      proposeGoal: (objective, reason) => {
        try {
          const delivered = safeSteerUser(ctx,
            `[REVIEWER FOLLOW-UP — ${reason}. Propose this as a /goal via propose_goal_draft (the user Confirms or rejects): ${objective}]`);
          if (!delivered) {
            ctx.ui.notify("Postaudit /goal proposal NOT delivered — the current session is stale or handing off; the follow-up was not counted as proposed.", "warning");
          }
          return delivered;
        } catch (err) {
          // v0.28.8 (E4): the phantom-reviewer hole — a swallowed throw used
          // to still count as "proposed" in the report + notify. Now the
          // failure is LOUD and the proposal goes uncounted.
          ctx.ui.notify(
            `Postaudit /goal proposal NOT delivered: ${err instanceof Error ? err.message : String(err)} — the follow-up never reached the session. Wait for a fresh session_start, then retry.`,
            "warning",
          );
          return false;
        }
      },
      notify: (message, level) => ctx.ui.notify(message, level),
      ledger: (type, value) => appendLedger(ctx.cwd, type, value),
    });
    if (!outcome.fired && outcome.suppressedReason && opts.manual) {
      ctx.ui.notify(`Postaudit suppressed: ${outcome.suppressedReason}`, "info");
    }
    // v0.27.5: surface the silent review to interactive users. The internal
    // runReviewer notify fires DURING the goal-completion handler, easy to
    // miss because pi is busy transitioning state. The second notify
    // arrives AFTER everything settles and points at the file directly.
    // Skipped when manual=true (manual /review has its own UX already) and
    // when the runner wasn't fired (suppressed / not applicable).
    if (!opts.manual && outcome.fired && outcome.reportPath) {
      const relPath = path.relative(ctx.cwd, outcome.reportPath) || outcome.reportPath;
      ctx.ui.notify(
        `↳ review written: ${relPath}${outcome.enqueued ? ` (${outcome.enqueued} enqueued to /list)` : ""}${outcome.proposed ? ` (${outcome.proposed} /goal proposed)` : ""}`,
        "info",
      );
    }
  } catch (err) {
    ctx.ui.notify(`Postaudit failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`, "warning");
  }
}



/* Runtime globals: preserve the old monolith lexical links across extracted modules. */
defineGoalRuntimeGlobal("clearDetachedAuditRuntime", { get: () => clearDetachedAuditRuntime });
defineGoalRuntimeGlobal("newCompletionAuditAttemptId", { get: () => newCompletionAuditAttemptId });
defineGoalRuntimeGlobal("validateCompletionSummary", { get: () => validateCompletionSummary });
defineGoalRuntimeGlobal("beginCompletionAudit", { get: () => beginCompletionAudit });
defineGoalRuntimeGlobal("isAuditorTimeoutError", { get: () => isAuditorTimeoutError });
defineGoalRuntimeGlobal("isAuditorNoVerdictInfrastructureError", { get: () => isAuditorNoVerdictInfrastructureError });
defineGoalRuntimeGlobal("MAX_AUDITOR_AUTO_RETRY_ATTEMPTS", { get: () => MAX_AUDITOR_AUTO_RETRY_ATTEMPTS });
defineGoalRuntimeGlobal("EAGER_AUDITOR_RETRY_SEC", { get: () => EAGER_AUDITOR_RETRY_SEC });
defineGoalRuntimeGlobal("fmtRetryDelay", { get: () => fmtRetryDelay });
defineGoalRuntimeGlobal("auditorRetryPlan", { get: () => auditorRetryPlan });
defineGoalRuntimeGlobal("auditorCandidateLabel", { get: () => auditorCandidateLabel });
defineGoalRuntimeGlobal("runDetachedCompletionWithFallback", { get: () => runDetachedCompletionWithFallback });
defineGoalRuntimeGlobal("retryStoredCompletionAudit", { get: () => retryStoredCompletionAudit });
defineGoalRuntimeGlobal("maybeAutoRetryParkedCompletionAudit", { get: () => maybeAutoRetryParkedCompletionAudit });
defineGoalRuntimeGlobal("scheduleParkedCompletionAuditRecovery", { get: () => scheduleParkedCompletionAuditRecovery });
defineGoalRuntimeGlobal("fireReviewer", { get: () => fireReviewer });
