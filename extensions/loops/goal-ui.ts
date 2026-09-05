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
  supervisorPaused,
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
  AUDITOR_QUIET_MS,
  auditorDisplayPhase,
  fmtElapsed,
} from "../goal-loop-display.js";
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
  LENGTH_CONTINUE_CONTEXT_STARVED_PERCENT,
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
import { buildStatusText, buildWidgetLines, type AuditDisplayProgress, type ModelProvenanceDisplay } from "../goal-loop-display.js";
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
import { getSubagentAgentsSnapshot } from "../goal-heartbeat.js";
import { assembleAgentsExtras, type AgentsPanelRow } from "../goal-agents-panel.js";
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

function clearDraftingState(): void {
  const restore = (globalThis as any).restoreDrafterModel as (() => Promise<void>) | undefined;
  if (restore) void restore();
  draftingTarget = null;
  // v0.35.44: no draftingDepth to reset — the write-only global was removed.
  draftingUserReplies = 0;
  draftingBlockedProposals = 0;
  draftingSeedInFlight = false;
}

const DRAFT_SESSION_INTERRUPTED_MESSAGE =
  "The drafting flow was interrupted by a pi session replacement. This is NOT a rejection — do not refine or re-propose from the old turn. Wait for a fresh session_start, then run the drafting command again.";

// Dedup set for token accounting (agent_end may replay seen messages).
const countedTokenMessages = new Set<string>();
const countedLoopTokenMessages = new Set<string>();

// Heartbeat self-watchdog state: liveness is the loop's own job.
let lastActivityAt = Date.now();
// v0.29.16: zombie-run watchdog clock — updated ONLY by genuine pi stream
// events (message_update / tool_call / agent_start / turn_start /
// agent_end), never by heartbeat-internal bookkeeping. A session pi
// reports as BUSY with zero stream events for N min is a hung provider
// stream (pi has no read timeout): continuations queue into the void and
// the busy flag conceals the wedge from every other watchdog (field:
// hellhunter + hegemon 2026-07-30, MiniMax streams died silently).
let lastStreamActivityAt = Date.now();
// A fresh UI session starts without stream proof. The clock still has a
// startup value for the zombie watchdog, but the live-work pulse must wait
// for a real host stream event in this session.
let streamActivityObserved = false;
let heartbeatNudges = 0;
// v0.28.4 (P3): skip nudge accounting for the first agent_end turns after a
// session_start restore — recovery chatter is not a stall.
let postRestoreGraceTurns = 0;
// v0.26.1: consecutive heartbeat refires that produced NO real agent turn.
// Resets only on real activity (agent_end / tool_call) — never on the
// refire's own noteActivity, which is what made the hegemon zombie spin
// self-sustaining (619 refires / 23.5h / zero turns).
let consecutiveStalls = 0;
// v0.28.14: carryover snapshot — unfinished work loaded from disk at
// session_start (predates this session). Resolved ONCE per session at the
// first NEW activation (new goal / new loop) per the carryover setting.
let carryoverSnapshot: { pausedGoal?: string; pausedGoalPolicy?: Policy; listCount: number; heldLoop?: string } | null = null;
let carryoverResolved = true;
// v0.26.6: precise replacement for the removed ship-recency suppression —
// set while complete_goal's isolated audit runs, so the heartbeat never
// refires into an in-flight completion.
let completionAuditInFlight = false;
// v0.34.20: an old auditor's finally block must not clear the in-flight
// marker belonging to a fresh lifecycle generation.
let completionAuditGeneration: number | null = null;
// v0.34.21: durable recovery is only auto-fired when the lifecycle event or
// an explicit /goal resume supplied continuation consent. A cold startup with
// autoResume off may display a recovery-pending claim without launching it.
let completionAuditRecoveryArmed = false;
let heartbeatTimer: NodeJS.Timeout | null = null;

// v0.34.11/v0.34.24: compatibility alias for the old unanswered-send
// watchdog. The bounded dispatch-start timer is now the primary proof path;
// this value remains named for older ledger/tests and fallback diagnostics.
const CONTINUATION_UNANSWERED_MS = Number(process.env.GLLA_CONTINUATION_START_TIMEOUT_MS ?? 30_000);
const CONTINUATION_UNANSWERED_THROTTLE_MS = 300_000;
// v0.34.12: eager-continuation settle delay. Hellhunter 2026-08-01 (post-
// restart): every turn cycle paid a 60s heartbeat tax because the eager
// continuation fires AT agent_end — exactly pi's turn-teardown blackhole
// window — so it vanished and the 60s heartbeat refire did the real work.
// Ledger showed the tell: goal_continuation_sent pairs + a refire per
// cycle. Sending 2.5s AFTER agent_end lets teardown settle; the send lands
// and the next turn starts immediately. 2.5s per turn beats 60s per turn.
const EAGER_CONTINUATION_SETTLE_MS = Number(process.env.GLLA_EAGER_SETTLE_MS ?? 2_500);
// v0.34.16: retain the old recovery marker for one compatibility window so
// an in-flight v0.34.15 reload can still resume once. New recovery debt uses
// the session lifecycle handoff below and never injects terminal keystrokes.
// RECOVERY_RESUME_MARKER / RECOVERY_RESUME_FRESH_MS moved to extensions/goal-recovery.ts (decomposition step 3, v0.34.111).
// v0.34.104 ([Image-#1] 2026-08-08 10:29 dracon-platform): a list item
// completing and auto-advancing fires a continuation AT pi while pi is
// still settling the completion acknowledgement. The v0.34.88
// no-turn-start watchdog (30s + 60s retry backoff) declared the new item
// unacknowledged → the queue was stuck for manual /list resume, even
// though pi was about to start a turn on its own. The settle window
// delays the FIRST continuation dispatched from the list-complete cascade
// so pi has time to settle the verdict; any agent activity (message_update,
// agent_start, turn_start) clears the window — if pi wakes up on its own,
// the deferred send is cancelled and no double-dispatch happens.
const LIST_COMPLETION_SETTLE_MS = Number(process.env.GLLA_LIST_COMPLETION_SETTLE_MS ?? 15_000);
let postCompletionSettleUntil = 0;
// v0.29.19: dead-turn caps (agent_end exemption path). 6 consecutive
// provider-error turns = a real outage, not bad luck — stop honestly.
// 3 consecutive user aborts = the user means it (user aborts mean STOP).
const LOOP_MAX_CONSECUTIVE_ERRORS = 6;
const LOOP_MAX_CONSECUTIVE_ABORTS = 3;

let lastRealActivityAt = 0;

function noteActivity(real = false): void {
  lastActivityAt = Date.now();
  if (real) { consecutiveStalls = 0; lastRealActivityAt = lastActivityAt; }
}

function isSupervising(): boolean {
  return isLoopActive() || (!!state.goal && state.goal.status === "active" && state.goal.autoContinue);
}

// =================================================================
// Live TUI (v0.9.0): persistent status segment + above-editor widget.
// "Can't tell if it's on" is a bug, not a nice-to-have.
// =================================================================

let latestAuditProgress: AuditDisplayProgress | null = null;
let uiTicker: NodeJS.Timeout | null = null;
let deferredUIRefresh: NodeJS.Timeout | null = null;
const UI_REFRESH_SETTLE_MS = 50;
// v0.36.2: the live card is a display aid, not a heartbeat. A one-second
// repaint in every active pi session can become a cross-terminal redraw storm
// when several sessions share one WezTerm. Keep the ticker useful for elapsed
// time/countdown changes, but put a hard ceiling on UI work per session.
const UI_TICK_INTERVAL_MS = 5_000;
const UI_RENDER_MIN_INTERVAL_MS = 2_000;
const LIVE_STREAM_PROOF_MS = 15_000;
let lastUIRenderAt = 0;
let lastUIRenderContext: ExtensionContext | null = null;
let lastUIStatusText: string | undefined;
let lastUIWidgetKey: string | undefined;

/**
 * Completion-auditor progress is ephemeral, but it still has an owner. A
 * session generation alone is not enough: a cancelled goal can be replaced
 * by a new goal without a session replacement, and the old detached worker
 * may report one last progress snapshot after cancellation.
 */
function ownsDetachedAudit(generation: number, goalId: string, attemptId: string): boolean {
  return completionAuditGeneration === generation
    && state.goal?.id === goalId
    && state.goal.pendingCompletion?.attemptId === attemptId;
}

function detachedAuditContext(generation: number, goalId: string, attemptId: string): ExtensionContext | null {
  if (!ownsDetachedAudit(generation, goalId, attemptId)) return null;
  return freshCtxForGeneration(generation);
}

function publishDetachedAuditProgress(
  generation: number,
  goalId: string,
  attemptId: string,
  progress: AuditorProgress,
): boolean {
  const current = detachedAuditContext(generation, goalId, attemptId);
  if (!current) return false;
  latestAuditProgress = {
    // Candidate identity is marked by the parent before the worker starts;
    // preserve it across progress-file snapshots so the card never loses
    // which model actually handled the audit.
    model: latestAuditProgress?.model,
    via: latestAuditProgress?.via,
    currentTool: progress.currentTool,
    currentToolArgs: progress.currentToolArgs,
    currentToolStartedAt: progress.currentToolStartedAt,
    phase: progress.phase,
    elapsedMs: progress.elapsedMs,
    // Progress files only change on worker events. Preserve an inferred start
    // epoch so the UI ticker can advance the elapsed counter during a long
    // read/bash/thinking interval instead of looking frozen between events.
    startedAt: latestAuditProgress?.startedAt
      ?? Date.now() - Math.max(0, progress.elapsedMs),
    reportBytes: progress.reportBytes,
    recentOutput: progress.recentOutput,
    toolCalls: progress.toolCalls,
    // v0.34.56: expose explicit unmatched-tool-fact counts to the HUD.
    unmatchedToolStarts: progress.unmatchedToolStarts?.length ?? 0,
    unmatchedToolEnds: progress.unmatchedToolEnds?.length ?? 0,
    // v0.37.0: dispatch fact — the effective per-tool budget for this
    // attempt; the quiet watcher and the "tool: X · 4m / 20m budget" line
    // consume it.
    toolTimeoutMs: progress.toolTimeoutMs,
    // v0.38.3: live-inspection session file (undefined = --no-session spawn).
    sessionPath: progress.sessionPath,
    lastEventAt: Date.now(),
    lastActivityAt: progress.lastActivityAt,
  };
  refreshUI(current);
  return true;
}

function clearDetachedAuditProgress(generation: number, goalId: string, attemptId: string): void {
  if (!ownsDetachedAudit(generation, goalId, attemptId)) return;
  latestAuditProgress = null;
}


// v0.33.0: slim widget "last action" feed — a tiny ring of finished tool
// calls {name, arg, ms, ok} captured from the tool_call/tool_result stream.
// Display-only, never persisted; cleared at every session/objective
// boundary. The scope/epoch fields are defensive: a late result from a
// disposed goal must not become the newest action on its replacement.
const recentActions: import("../goal-loop-display.js").RecentActionDisplay[] = [];
const inFlightToolCalls = new Map<string, { name: string; arg?: string; at: number; scope?: string; epoch: number }>();
let toolActivityEpoch = 0;

function currentToolActivityScope(): string | undefined {
  const loop = state.loop?.active ? state.loop : undefined;
  if (loop) return `loop:${loop.startedAt}`;
  const goal = state.goal?.status === "active" ? state.goal : undefined;
  if (goal) return `goal:${goal.id}`;
  return undefined;
}

/** Clear ephemeral host activity whenever ownership changes. The persisted
 * goal/loop is deliberately untouched; only evidence tied to the old
 * session/objective is discarded. */
function clearToolActivityState(): void {
  toolActivityEpoch++;
  inFlightToolCalls.clear();
  recentActions.length = 0;
}

function hasCurrentToolActivity(scope: string | undefined, startedAt: string | undefined): boolean {
  if (!scope) return false;
  const boundary = Date.parse(startedAt ?? "");
  for (const call of inFlightToolCalls.values()) {
    if (call.epoch !== toolActivityEpoch || call.scope !== scope) continue;
    // An invalid boundary is not proof that an old call belongs to this
    // objective. Fail closed rather than painting WORKING from stale state.
    if (Number.isFinite(boundary) && call.at >= boundary) return true;
  }
  return false;
}
function summarizeToolArg(name: string, input: any): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const v = input.file_path ?? input.path ?? input.command ?? input.pattern ?? input.query ?? input.url ?? input.title;
  if (typeof v !== "string" || v.length === 0) return undefined;
  // v0.33.1: strip control chars BEFORE truncating — a raw \n breaks the
  // widget card into un-prefixed lines (footer spoof), a raw ESC corrupts
  // the TUI. The objective path was already whitespace-collapsed; this
  // path was the gap.
  const base = (name === "bash" ? v : v.split("/").pop() || v).replace(/[\x00-\x1f\x7f-\x9f]/g, " ").replace(/\s+/g, " ").trim();
  return base.length <= 24 ? base : base.slice(0, 23) + "…";
}
function noteToolCall(event: any): void {
  const name = String(event?.toolName ?? "?");
  const id = String(event?.toolCallId ?? event?.id ?? `anon-${Date.now()}`);
  if (inFlightToolCalls.size >= 20) inFlightToolCalls.delete(inFlightToolCalls.keys().next().value!); // v0.33.1: evict BEFORE the 21st
  inFlightToolCalls.set(id, {
    name,
    arg: summarizeToolArg(name, event?.input ?? event?.args),
    at: Date.now(),
    scope: currentToolActivityScope(),
    epoch: toolActivityEpoch,
  });
}
function noteToolResult(event: any): void {
  const id = String(event?.toolCallId ?? event?.id ?? "");
  const f = id ? inFlightToolCalls.get(id) : undefined;
  if (id) inFlightToolCalls.delete(id);
  // A result without a matching start is not a completed action: it may be a
  // late callback from the previous session/objective (or a host event that
  // arrived while the handoff gate was closed). Do not let it repaint a new
  // goal's card. The operational tool-result handler still processes the
  // event below this display-only hook.
  if (!f || f.epoch !== toolActivityEpoch || f.scope !== currentToolActivityScope()) return;
  const ok = !Boolean(event?.isError ?? event?.error);
  // v0.34.124: stamp the result epoch so the widget can drop actions that
  // predate the CURRENT goal (the ring outlived a goal change and showed
  // the previous goal's ✓ complete_goal on the new goal's card — note.md
  // 221249 "time ticking but nothing else").
  recentActions.push({ name: f.name, arg: f.arg, ms: Date.now() - f.at, ok, at: Date.now() });
  if (recentActions.length > 3) recentActions.shift();
}

function displayActivityFor(ctx: ExtensionContext): {
  activity?: import("../goal-loop-display.js").GoalDisplayActivity;
  lastActivityAt?: number;
  lastStreamActivityAt?: number;
} {
  // A loop can be the only live artifact. The old goal-only guard made an
  // active loop show iteration/elapsed counters but no evidence-backed
  // WORKING/BUSY/QUEUED/IDLE state, which forced users to infer liveness from
  // hidden thinking text. Scope the same host projection to the loop's own
  // start boundary; a previous goal's event must not make a new loop look
  // live.
  const loop = state.loop?.active ? state.loop : undefined;
  if (loop) return displayLoopActivityFor(ctx, loop);

  const goal = state.goal;
  if (!goal) return {};
  const goalStartedAt = Date.parse(goal.createdAt);
  // Paused goals do not need an active/busy/queued host projection, but their
  // last real timestamps remain useful evidence: the card must say when work
  // last moved before it was safely parked instead of showing only a wall
  // clock. Guard by goal creation so a previous item's activity cannot leak.
  const lastActivityAt = lastRealActivityAt > 0
    && (!Number.isFinite(goalStartedAt) || lastRealActivityAt >= goalStartedAt)
    ? lastRealActivityAt
    : undefined;
  const streamAt = streamActivityObserved
    && (!Number.isFinite(goalStartedAt) || lastStreamActivityAt >= goalStartedAt)
    ? lastStreamActivityAt
    : undefined;
  if (goal.status !== "active") return { lastActivityAt, lastStreamActivityAt: streamAt };
  const telemetry = goal.telemetry;
  const hasRealActivity = lastActivityAt !== undefined;
  const noTurnYet = !telemetry
    && !hasRealActivity
    && (goal.usage?.tokensUsed ?? 0) === 0
    && pendingContinuationDispatchRef() === null;
  if (noTurnYet) return { activity: "awaiting-first-turn" };
  let idle = false;
  let pending = false;
  try {
    idle = ctx.isIdle();
    pending = ctx.hasPendingMessages();
  } catch {
    // A stale/unknown host state is not proof of work. Keep the durable
    // active marker, but do not animate it.
    return { activity: "active" };
  }
  const scheduled = continuationTimerRef() !== null || pendingContinuationDispatchRef() !== null || continuationDispatchStoodDownRef();
  const streamFresh = streamAt !== undefined && Date.now() - streamAt <= LIVE_STREAM_PROOF_MS;
  const toolActive = hasCurrentToolActivity(`goal:${goal.id}`, goal.createdAt);
  // A spinner means pi is busy AND we have recent stream/tool evidence. A
  // busy host with no fresh evidence gets a static BUSY label instead, so a
  // hung provider cannot masquerade as progress.
  if (toolActive || (!idle && streamFresh)) {
    return { activity: "working", lastActivityAt, lastStreamActivityAt: streamAt };
  }
  if (!idle) return { activity: "busy", lastActivityAt, lastStreamActivityAt: streamAt };
  if (pending || scheduled) return { activity: "queued", lastActivityAt, lastStreamActivityAt: streamAt };
  // A short idle gap is normal between agent_end and the settled eager
  // continuation. Only surface idle after a real minute with no queued send;
  // otherwise keep the durable state neutral rather than inventing work.
  if (lastActivityAt === undefined || Date.now() - lastActivityAt >= 60_000) {
    return { activity: "idle", lastActivityAt, lastStreamActivityAt: streamAt };
  }
  return { activity: "active", lastActivityAt, lastStreamActivityAt: streamAt };
}

function displayLoopActivityFor(ctx: ExtensionContext, loop: LoopState): {
  activity?: import("../goal-loop-display.js").GoalDisplayActivity;
  lastActivityAt?: number;
  lastStreamActivityAt?: number;
} {
  const loopStartedAt = Date.parse(loop.startedAt);
  const lastActivityAt = lastRealActivityAt > 0
    && (!Number.isFinite(loopStartedAt) || lastRealActivityAt >= loopStartedAt)
    ? lastRealActivityAt
    : undefined;
  const streamAt = streamActivityObserved
    && (!Number.isFinite(loopStartedAt) || lastStreamActivityAt >= loopStartedAt)
    ? lastStreamActivityAt
    : undefined;
  const hasRealActivity = lastActivityAt !== undefined;
  const pendingDispatch = pendingContinuationDispatchRef() !== null;
  const loopTimer = loopTimerPending();
  // Iteration zero with no dispatch/timer/activity is the honest pre-turn
  // state. Do not label it IDLE: the loop has not had its first opportunity to
  // run yet.
  if (loop.iteration === 0 && !hasRealActivity && streamAt === undefined && !pendingDispatch && !loopTimer) {
    return { activity: "awaiting-first-turn" };
  }
  let idle = false;
  let pending = false;
  try {
    idle = ctx.isIdle();
    pending = ctx.hasPendingMessages();
  } catch {
    return { activity: "active" };
  }
  const scheduled = continuationTimerRef() !== null
    || pendingDispatch
    || continuationDispatchStoodDownRef()
    || loopTimer;
  const streamFresh = streamAt !== undefined && Date.now() - streamAt <= LIVE_STREAM_PROOF_MS;
  const toolActive = hasCurrentToolActivity(`loop:${loop.startedAt}`, loop.startedAt);
  if (toolActive || (!idle && streamFresh)) {
    return { activity: "working", lastActivityAt, lastStreamActivityAt: streamAt };
  }
  if (!idle) return { activity: "busy", lastActivityAt, lastStreamActivityAt: streamAt };
  if (pending || scheduled) return { activity: "queued", lastActivityAt, lastStreamActivityAt: streamAt };
  if (lastActivityAt === undefined || Date.now() - lastActivityAt >= 60_000) {
    return { activity: "idle", lastActivityAt, lastStreamActivityAt: streamAt };
  }
  return { activity: "active", lastActivityAt, lastStreamActivityAt: streamAt };
}

function refreshUI(ctx: ExtensionContext, force = false): void {
  if (!ctx.hasUI) return;
  const now = Date.now();
  // A render timestamp is process-global, but the UI surface belongs to the
  // admitted host context. Never let a render in an old/replaced context
  // suppress the successor's first paint; otherwise a fresh session can
  // inherit durable state while its own status/widget remains blank.
  const contextChanged = lastUIRenderContext !== ctx;
  if (!force && !contextChanged && lastUIRenderAt > 0 && now - lastUIRenderAt < UI_RENDER_MIN_INTERVAL_MS) return;
  try {
    const theme = ctx.ui.theme as unknown as import("../goal-loop-display.js").DisplayTheme | undefined;
    // Terminal width for truncation budgets: on wide terminals the widget
    // uses the room instead of cutting at fixed ~60-char floors.
    const width = process.stdout.columns || 80;
    const activity = displayActivityFor(ctx);
    const settings = loadSettings(ctx.cwd);
    const sessionRef = modelRef(ctx.model);
    const recovery = state.mainModelRecovery;
    const durableDeferRecommendation = state.goal?.durableDeferRecommendation;
    const fallbackRefs = settings.mainModelFallbacks ?? [];
    const skippedForbiddenRefs = [
      ...fallbackRefs.filter((ref) => isForbiddenModel(ref, settings.forbiddenModels)),
      ...(recovery?.skipped ?? []).filter((entry) => entry.reason === "forbidden").map((entry) => entry.ref),
    ];
    const modelProvenance: ModelProvenanceDisplay = {
      // Main-model pins are session-owned today; an explicit goal pin will be
      // able to set primarySource:"pinned" without changing the renderer.
      primary: recovery?.primary ?? sessionRef,
      primarySource: "inherited",
      fallbackRefs,
      skippedForbiddenRefs,
      handledTurn: state.lastModelRef ?? recovery?.active ?? sessionRef,
      ...(latestAuditProgress?.model ? {
        handledAudit: latestAuditProgress.model,
        handledAuditSource: latestAuditProgress.via,
      } : {}),
    };
    const extras = {
      stalls: consecutiveStalls,
      recent: recentActions,
      // v0.38.22 (display unification): richness ladder for ambient
      // workers — `rich` (default) restores the detailed rows the v0.37.1
      // jitter fix removed, now safe because silence ages are bucketed
      // (widget key only changes on genuine state transitions, not every
      // tick) plus the task-linkage header native UI can never show.
      // `compact` keeps the single line; `quiet` surfaces hung/aborting
      // workers only (HUNG is never silent at any level).
      ...(() => {
        try {
          const { agents } = getSubagentAgentsSnapshot();
          const rows = agents as AgentsPanelRow[];
          const extras = assembleAgentsExtras(rows, settings.subagentDisplayRichness ?? "rich", state.goal?.objective ?? "", now);
          return extras ? { agents: extras } : {};
        } catch { return {}; }
      })(),
      ...activity,
      turnPending: pendingContinuationDispatchRef() !== null,
      auditorSilent: settings.auditorSilent !== false,
      auditorProgressSignals: settings.auditorProgressSignals !== false,
      mainModelFallbacks: fallbackRefs,
      modelProvenance,
      ...(durableDeferRecommendation ? { durableDeferRecommendation } : {}),
      ...(lastAuditorQuietStretch ? { auditorQuietStretch: lastAuditorQuietStretch } : {}),
    };
    const statusText = buildStatusText(state, latestAuditProgress, now, theme, extras);
    const widgetLines = buildWidgetLines(state, latestAuditProgress, now, theme, width, extras);
    const widgetKey = widgetLines?.join("\n") ?? "";
    const statusChanged = contextChanged || statusText !== lastUIStatusText;
    const widgetChanged = contextChanged || widgetKey !== lastUIWidgetKey;
    if (!statusChanged && !widgetChanged) return;
    if (statusChanged) ctx.ui.setStatus("pi-glla", statusText);
    if (widgetChanged) ctx.ui.setWidget("pi-glla", widgetLines);
    lastUIRenderAt = now;
    lastUIRenderContext = ctx;
    lastUIStatusText = statusText;
    lastUIWidgetKey = widgetKey;
  } catch {
    // stale ctx — next event refreshes
  }
}

/**
 * Repaint once more after the current event/tool turn yields back to pi.
 *
 * `refreshUI()` is called synchronously when state is persisted, but pi can
 * repaint the transcript/editor after that callback and restore the previous
 * extension widget. The regular ticker is intentionally best-effort and can
 * also be between session contexts at that boundary. A debounced next-turn
 * repaint makes the durable state transition win without making the detached
 * auditor or the main turn wait for UI work.
 */
function scheduleUIRefresh(): void {
  if (deferredUIRefresh) return;
  deferredUIRefresh = setTimeout(() => {
    deferredUIRefresh = null;
    const ctx = freshCtx();
    if (ctx) refreshUI(ctx, true);
  }, UI_REFRESH_SETTLE_MS);
  deferredUIRefresh.unref?.();
}

// v0.35.15: proactive auditor quiet reporting (runtime-only state).
// The seed complaint (2026-08-21): an auditor sat silent for 8 minutes and
// the user only learned about it afterwards from the status line — nothing
// ever NOTIFIED. The phase chip recolors at ~3 min, but a chip is not a
// report. The watcher below fires exactly ONE notify when a detached audit
// crosses into the quiet phase, then records the ended stretch so the
// footer can show "silent Xm then resumed" afterwards. `/glla pause`
// suppresses the notify (it is automatic machinery), never the recording.
let auditorQuietSince: number | null = null;
let auditorQuietNotified = false;
let lastAuditorQuietStretch: { ms: number; endedAt: number } | null = null;

/** Drive the quiet watcher once per UI tick. Returns a warning message to
 * deliver, or null. Split out for testability. */
export function __auditorQuietWatchTick(now = Date.now()): string | null {
  const g = state.goal;
  if (!g || g.status !== "auditing") {
    // No live audit — reset any open stretch so a stale silence cannot leak
    // into a later goal's display.
    if (auditorQuietSince !== null) {
      const ms = now - auditorQuietSince;
      if (ms >= AUDITOR_QUIET_MS) lastAuditorQuietStretch = { ms, endedAt: now };
      auditorQuietSince = null;
      auditorQuietNotified = false;
    }
    return null;
  }
  const phase = auditorDisplayPhase(g, latestAuditProgress, now);
  if (phase === "quiet") {
    // Entering quiet: anchor the stretch at the worker's last activity.
    if (auditorQuietSince === null) {
      auditorQuietSince = typeof latestAuditProgress?.lastActivityAt === "number"
        ? latestAuditProgress.lastActivityAt
        : now;
    }
    if (!auditorQuietNotified && !supervisorPaused(state)) {
      auditorQuietNotified = true;
      return `glla: the detached auditor shows NO worker activity for ${fmtElapsed(now - auditorQuietSince)} — it may be stuck (or doing one long read). The status footer keeps counting. /glla pause freezes all supervisor machinery; /goal cancel discards the claim.`;
    }
    return null;
  }
  // Left the quiet phase: record the ended stretch for the footer summary.
  if (auditorQuietSince !== null) {
    const ms = now - auditorQuietSince;
    if (ms >= AUDITOR_QUIET_MS) lastAuditorQuietStretch = { ms, endedAt: now };
    auditorQuietSince = null;
  }
  auditorQuietNotified = false;
  return null;
}

function startUITicker(): void {
  if (uiTicker) return;
  uiTicker = setInterval(() => {
    const ctx = freshCtx();
    // v0.34.12: keep ticking during a timed wait-pause too — the status
    // line counts down to resumeAt live (pully field request 2026-08-01).
    const auditVisible = state.goal?.status === "auditing";
    if (!ctx) return;
    if (!(isSupervising() || auditVisible || (state.goal?.status === "paused" && !!state.goal.pauseResumeAt))) return;
    // v0.35.15: proactive quiet-phase notification (once per stretch).
    if (auditVisible) {
      const warning = __auditorQuietWatchTick();
      if (warning && !supervisorPaused(state)) {
        try { ctx.ui.notify(warning, "warning"); } catch { /* stale handle — next tick retries the notify gate honestly */ }
        scheduleUIRefresh();
      }
    }
    refreshUI(ctx);
  }, UI_TICK_INTERVAL_MS);
  uiTicker.unref?.();
}

/** v0.26.5: shared loud-stop for both stall paths (refire streak and
 * pending-latch streak). Returns true when it escalated. */
// v0.28.5 (E3): send-retry re-arm accounting. The 50ms BACKOFF_IDLE_RETRY
// re-arm loop used to spin for HOURS with zero ledger events while the idle
// watchdogs stayed suppressed. Now: counted, ledgered (start + every 30s),
// and escalated loudly past 5 minutes.
let loopRearmStreak = 0;
// v0.34.82: deduplicate the "compaction appears off" notify to once per
// second (the heartbeat fires every 60s, but a busy session may have
// multiple refire checks within a single second).
// v0.28.24: post-compaction grace — a just-replaced session gets 3 minutes
// to settle (queue drain, provider recovery) before stall counting resumes.
// Field-observed in junk-runner: a 196k-token compact finished, then the
// heartbeat burned all 5 stall refires in the next 5 minutes into a session
// whose turn trigger was still dead — pausing a resumable goal 4 minutes
// after the compact instead of giving pi room to recover.
let compactionGraceUntil = 0;
// v0.34.57: timestamp of the most recent session_compact event. The 30s
// continuation-start watchdog checks this so a compaction that lands inside
// the watchdog window pauses/resets the watchdog instead of being misread
// as a stall (field: 115855/115858/115901 — the watchdog fired while the
// session was still mid-compact; the work was completed on disk but the
// session handle was lost, so the user saw the false-positive warning).
let lastCompactionAt = 0;
// v0.34.82: context-starvation streak — when pi auto-compaction is
// DISABLED (or otherwise absent) the agent_end yield path is correct (do
// not send a 1-token length-continue) but the heartbeat refire would
// queue another full turn against the same near-full context, growing
// from 98% to 120%+ in six retries. The user only sees that as a stalled
// session. Track consecutive yielded length stops with no
// session_compact between them; when that crosses the cap, freeze
// scheduleContinuation until a real compaction lands or the user takes
// the manual `compaction` or `/compact` path. A session_compact
// immediately clears the streak.
const CONTEXT_STARVATION_REFUSE_THRESHOLD = 2;
const CONTEXT_STARVATION_RECENT_WINDOW_MS = 90_000;
// v0.38.6: compact-first band — heavy but still compactable. One proactive
// nudge per episode here avoids the over-cap ladder entirely (summarization
// still fits below the 90% starvation line).
export const COMPACT_FIRST_NUDGE_PERCENT = 85;
export const COMPACT_FIRST_RESET_PERCENT = 80;
let contextStarvedStreak = 0;
let lastContextStarvedAt = 0;
// v0.38.6: last-known context percent (sampled at agent_end). Keeps the
// refuse sticky while the session is physically over cap even after the 90s
// recency window lapses — a slow-truncating 120%+ session must not re-arm
// the spin (field 2026-09-03: 119–243% truncation loops).
let lastContextPercent: number | null = null;
let compactFirstNudged = false;
export function noteContextPercent(pct: number | null | undefined): void {
  lastContextPercent = typeof pct === "number" && Number.isFinite(pct) ? pct : null;
}
/** v0.38.6: compact-first decision — pure. True exactly once per episode
 * while percent sits at/above the nudge band; resets below 80% or on
 * compaction. Returns false for missing/non-finite input. */
export function shouldCompactFirstNudge(percent: number | null | undefined): boolean {
  if (typeof percent !== "number" || !Number.isFinite(percent)) return false;
  if (percent < COMPACT_FIRST_RESET_PERCENT) { compactFirstNudged = false; return false; }
  if (percent < COMPACT_FIRST_NUDGE_PERCENT || compactFirstNudged) return false;
  compactFirstNudged = true;
  return true;
}
/** v0.38.6: the over-cap ladder, user-facing. Three recoveries in order
 * (retry /compact after GLLA's deterministic trim, larger-context model,
 * /new + resume from durable state) plus the no-LLM backstop: the
 * post-compact resync re-anchors a fresh session with no summarization.
 * `recentCompact` skips the stale retry (v0.38.9). */
export function buildStarvationLadderMessage(input: { percent?: number | null; streak?: number; recentCompact?: boolean } = {}): string {
  const at = typeof input.percent === "number" && Number.isFinite(input.percent)
    ? `${input.percent.toFixed(1)}%` : "nearly full";
  // One recovery per line (v0.38.8) — same content, scannable shape.
  return [
    `glla: output-token stop was context starvation (tiny output at ${at} context) — yielding to pi auto-compaction instead of re-sending.`,
    `If compaction fails or context is already over cap, in order:`,
    input.recentCompact === true
      ? `(1) skip the /compact retry — one already failed within the last 90s; the trim below already ran, so go straight to (2)/(3);`
      : `(1) run /compact again — GLLA already trimmed repeat payloads to a checkpoint, so the retry may now fit;`,
    `(2) switch to a larger-context model, then /compact (GLLA auto-rotates its fallback chain after a failed compact-and-retry);`,
    `(3) /new, then /goal resume — the goal, tasks, ledger and audits are durable on disk, and the post-compact resync re-anchors the fresh session with no summarization needed.`,
    `Automatic turns stay parked until a real compaction lands.`,
  ].join("\n");
}
function noteContextStarvedYield(): { streak: number; shouldRefuse: boolean } {
  const now = Date.now();
  if (now - lastContextStarvedAt > CONTEXT_STARVATION_RECENT_WINDOW_MS) {
    contextStarvedStreak = 0;
  }
  contextStarvedStreak++;
  lastContextStarvedAt = now;
  return { streak: contextStarvedStreak, shouldRefuse: contextStarvedStreak >= CONTEXT_STARVATION_REFUSE_THRESHOLD };
}
function clearContextStarvedStreak(): void {
  contextStarvedStreak = 0;
  lastContextStarvedAt = 0;
}
/** Public: a session_compact landed — clear the starvation refuse gate. */
function onCompactionLanded(): void {
  clearContextStarvedStreak();
  compactFirstNudged = false; // v0.38.6: fresh episode after real room
}
/** Public: has the yield path declared compaction absent? The heartbeat
 * consults this to refuse to schedule a new continuation while the
 * session is stuck in the same near-full context. */
function isContextStarvedRefused(): boolean {
  if (contextStarvedStreak < CONTEXT_STARVATION_REFUSE_THRESHOLD) return false;
  if (lastCompactionAt > lastContextStarvedAt) return false; // a compact happened after the streak — fresh slate
  if (Date.now() - lastContextStarvedAt <= CONTEXT_STARVATION_RECENT_WINDOW_MS) return true;
  // v0.38.6: sticky while physically over cap — recency lapse must not
  // re-arm the spin against a session that never got room (field: 243%).
  return lastContextPercent !== null && lastContextPercent >= LENGTH_CONTINUE_CONTEXT_STARVED_PERCENT;
}
/** Test-only: simulate a compaction event at a controlled time without firing
 * the full session_compact plumbing. Pass null to clear. */
export function __testOnlySetLastCompactionAt(at: number | null): void {
  lastCompactionAt = at ?? 0;
}
/** Test-only: set the real-stream clock directly so busy-silence scenarios
 * (answered question, phantom-busy host, zero stream) are drivable without
 * wall-clock waits. Exported through loops/goal.js like the other hooks. */
export function __testOnlySetLastRealActivityAt(at: number): void {
  lastRealActivityAt = at;
}

/** Test-only: expose the live activity projection without requiring a TUI
 * renderer. This drives the same scope/timestamp checks used by refreshUI. */
export function __testOnlyDisplayActivityFor(ctx: ExtensionContext): ReturnType<typeof displayActivityFor> {
  return displayActivityFor(ctx);
}

/** Test-only: reset ephemeral activity after a fixture's synthetic boundary. */
export function __testOnlyResetToolActivity(): void {
  clearToolActivityState();
}

/** Load the module state singleton from a cwd's disk state — the exact
 * assignment session_start performs (goal.ts:8827) — WITHOUT firing
 * session_start (co-residency rule: a second session_start claim in a
 * co-resident test file poisons the behavioral driver). */
export function __testOnlyLoadState(cwd: string): void {
  replaceState(readState(cwd));
}

/** Register the agent tools (complete_goal etc.) the way session_start
 * does, WITHOUT firing session_start (co-residency rule). runTool tests
 * that must not claim the session use this. MockPi.registerTool is a map
 * write — re-registration is idempotent on the harness. */
export function __testOnlyRegisterAgentTools(pi: any): void {
  registerAgentTools(pi);
}

/** Pin the context freshCtx() resolves to (normally set by event/command
 * handlers) WITHOUT firing session_start — lets the detached-audit apply
 * path (freshCtxForGeneration) rebind in co-resident test files. */
export function __testOnlyRememberCtx(ctx: ExtensionContext): void {
  rememberCtx(ctx);
}

/** v0.35.15 test-only: drive the auditor quiet watcher with a controlled
 * progress snapshot + clock. Pass null progress to simulate no audit.
 * Returns the tick's notify message (null = silent) exactly like the
 * production ticker consumes it. */
export function __testOnlyAuditorQuietWatchTick(
  progress: import("../goal-loop-display.js").AuditDisplayProgress | null,
  now = Date.now(),
): string | null {
  latestAuditProgress = progress;
  return __auditorQuietWatchTick(now);
}

/** v0.35.15 test-only: reset the quiet-watcher runtime state between tests. */
export function __testOnlyResetAuditorQuietWatch(): void {
  auditorQuietSince = null;
  auditorQuietNotified = false;
  lastAuditorQuietStretch = null;
}

/** v0.35.15 test-only: the last ended quiet stretch the footer extras carry. */
export function __testOnlyLastAuditorQuietStretch(): { ms: number; endedAt: number } | null {
  return lastAuditorQuietStretch;
}
// v0.32.1 (pi-goal-x's lesson — "recover from compacts smarter"): a compact
// leaves a RESUME DEBT, not just two fixed-offset settle probes that can both
// lose (field: hellhunter 4-min dangle 2026-07-31; polis stall same day).
// postCompactResumeOwed discharges only when a real turn starts (agent_start);
// every heartbeat tick past grace retries it. postCompactResyncPending arms a
// deterministic [POST-COMPACTION RESYNC] block on the next continuation/loop
// message (pi-goal-x's #5) so the compacted agent re-anchors on artifact
// state instead of lost chat history.
let postCompactResumeOwed = false;
let postCompactResyncPending = false;
const COMPACTION_GRACE_MS = 3 * 60_000;
// v0.28.25: provider-error retry cadence. Field-observed in dracon-utilities
// (kimi, 19-session fleet on one provider account): a "concurrent request
// limit" 403 storm got 5 retries BACK-TO-BACK (delay 0 after each errored
// turn — the session is idle at agent_end, so scheduleContinuation fired
// instantly) and the brake then cycled on a flat 60s cooldown for 1h 38m.
// The condition clears on a minutes-to-fleet scale, not milliseconds:
// ladder the inter-error retries (5s, 15s, 45s, 90s, 3m — the 5-retry
// budget now spans ~5.5m) and escalate the brake cooldown per consecutive
// brake (1m, 2m, 4m, 8m, 16m cap). A successful turn resets both.
const ERROR_RETRY_LADDER_MS = [5_000, 15_000, 45_000, 90_000, 180_000];
let loopRearmSince = 0;
let loopRearmMilestone = 0;




/* Runtime globals: preserve the old monolith lexical links across extracted modules. */
defineGoalRuntimeGlobal("clearDraftingState", { get: () => clearDraftingState });
defineGoalRuntimeGlobal("DRAFT_SESSION_INTERRUPTED_MESSAGE", { get: () => DRAFT_SESSION_INTERRUPTED_MESSAGE });
defineGoalRuntimeGlobal("countedTokenMessages", { get: () => countedTokenMessages });
defineGoalRuntimeGlobal("countedLoopTokenMessages", { get: () => countedLoopTokenMessages });
defineGoalRuntimeGlobal("lastActivityAt", { get: () => lastActivityAt, set: (v) => { lastActivityAt = v as any; } });
defineGoalRuntimeGlobal("lastStreamActivityAt", { get: () => lastStreamActivityAt, set: (v) => { lastStreamActivityAt = v as any; } });
defineGoalRuntimeGlobal("streamActivityObserved", { get: () => streamActivityObserved, set: (v) => { streamActivityObserved = v as any; } });
defineGoalRuntimeGlobal("heartbeatNudges", { get: () => heartbeatNudges, set: (v) => { heartbeatNudges = v as any; } });
defineGoalRuntimeGlobal("postRestoreGraceTurns", { get: () => postRestoreGraceTurns, set: (v) => { postRestoreGraceTurns = v as any; } });
defineGoalRuntimeGlobal("consecutiveStalls", { get: () => consecutiveStalls, set: (v) => { consecutiveStalls = v as any; } });
defineGoalRuntimeGlobal("carryoverSnapshot", { get: () => carryoverSnapshot, set: (v) => { carryoverSnapshot = v as any; } });
defineGoalRuntimeGlobal("carryoverResolved", { get: () => carryoverResolved, set: (v) => { carryoverResolved = v as any; } });
defineGoalRuntimeGlobal("completionAuditInFlight", { get: () => completionAuditInFlight, set: (v) => { completionAuditInFlight = v as any; } });
defineGoalRuntimeGlobal("completionAuditGeneration", { get: () => completionAuditGeneration, set: (v) => { completionAuditGeneration = v as any; } });
defineGoalRuntimeGlobal("completionAuditRecoveryArmed", { get: () => completionAuditRecoveryArmed, set: (v) => { completionAuditRecoveryArmed = v as any; } });
defineGoalRuntimeGlobal("heartbeatTimer", { get: () => heartbeatTimer, set: (v) => { heartbeatTimer = v as any; } });
defineGoalRuntimeGlobal("CONTINUATION_UNANSWERED_MS", { get: () => CONTINUATION_UNANSWERED_MS });
defineGoalRuntimeGlobal("CONTINUATION_UNANSWERED_THROTTLE_MS", { get: () => CONTINUATION_UNANSWERED_THROTTLE_MS });
defineGoalRuntimeGlobal("EAGER_CONTINUATION_SETTLE_MS", { get: () => EAGER_CONTINUATION_SETTLE_MS });
defineGoalRuntimeGlobal("LIST_COMPLETION_SETTLE_MS", { get: () => LIST_COMPLETION_SETTLE_MS });
defineGoalRuntimeGlobal("postCompletionSettleUntil", { get: () => postCompletionSettleUntil, set: (v) => { postCompletionSettleUntil = v as any; } });
defineGoalRuntimeGlobal("LOOP_MAX_CONSECUTIVE_ERRORS", { get: () => LOOP_MAX_CONSECUTIVE_ERRORS });
defineGoalRuntimeGlobal("LOOP_MAX_CONSECUTIVE_ABORTS", { get: () => LOOP_MAX_CONSECUTIVE_ABORTS });
defineGoalRuntimeGlobal("lastRealActivityAt", { get: () => lastRealActivityAt, set: (v) => { lastRealActivityAt = v as any; } });
defineGoalRuntimeGlobal("noteActivity", { get: () => noteActivity });
defineGoalRuntimeGlobal("isSupervising", { get: () => isSupervising });
defineGoalRuntimeGlobal("latestAuditProgress", { get: () => latestAuditProgress, set: (v) => { latestAuditProgress = v as any; } });
defineGoalRuntimeGlobal("uiTicker", { get: () => uiTicker, set: (v) => { uiTicker = v as any; } });
defineGoalRuntimeGlobal("LIVE_STREAM_PROOF_MS", { get: () => LIVE_STREAM_PROOF_MS });
defineGoalRuntimeGlobal("ownsDetachedAudit", { get: () => ownsDetachedAudit });
defineGoalRuntimeGlobal("detachedAuditContext", { get: () => detachedAuditContext });
defineGoalRuntimeGlobal("publishDetachedAuditProgress", { get: () => publishDetachedAuditProgress });
defineGoalRuntimeGlobal("clearDetachedAuditProgress", { get: () => clearDetachedAuditProgress });
defineGoalRuntimeGlobal("recentActions", { get: () => recentActions });
defineGoalRuntimeGlobal("inFlightToolCalls", { get: () => inFlightToolCalls });
defineGoalRuntimeGlobal("summarizeToolArg", { get: () => summarizeToolArg });
defineGoalRuntimeGlobal("noteToolCall", { get: () => noteToolCall });
defineGoalRuntimeGlobal("noteToolResult", { get: () => noteToolResult });
defineGoalRuntimeGlobal("clearToolActivityState", { get: () => clearToolActivityState });
defineGoalRuntimeGlobal("displayActivityFor", { get: () => displayActivityFor });
defineGoalRuntimeGlobal("refreshUI", { get: () => refreshUI });
defineGoalRuntimeGlobal("scheduleUIRefresh", { get: () => scheduleUIRefresh });
defineGoalRuntimeGlobal("startUITicker", { get: () => startUITicker });
defineGoalRuntimeGlobal("loopRearmStreak", { get: () => loopRearmStreak, set: (v) => { loopRearmStreak = v as any; } });
defineGoalRuntimeGlobal("compactionGraceUntil", { get: () => compactionGraceUntil, set: (v) => { compactionGraceUntil = v as any; } });
defineGoalRuntimeGlobal("lastCompactionAt", { get: () => lastCompactionAt, set: (v) => { lastCompactionAt = v as any; } });
defineGoalRuntimeGlobal("CONTEXT_STARVATION_REFUSE_THRESHOLD", { get: () => CONTEXT_STARVATION_REFUSE_THRESHOLD });
defineGoalRuntimeGlobal("CONTEXT_STARVATION_RECENT_WINDOW_MS", { get: () => CONTEXT_STARVATION_RECENT_WINDOW_MS });
defineGoalRuntimeGlobal("contextStarvedStreak", { get: () => contextStarvedStreak, set: (v) => { contextStarvedStreak = v as any; } });
defineGoalRuntimeGlobal("lastContextStarvedAt", { get: () => lastContextStarvedAt, set: (v) => { lastContextStarvedAt = v as any; } });
defineGoalRuntimeGlobal("noteContextStarvedYield", { get: () => noteContextStarvedYield });
defineGoalRuntimeGlobal("noteContextPercent", { get: () => noteContextPercent });
defineGoalRuntimeGlobal("shouldCompactFirstNudge", { get: () => shouldCompactFirstNudge });
defineGoalRuntimeGlobal("buildStarvationLadderMessage", { get: () => buildStarvationLadderMessage });
defineGoalRuntimeGlobal("COMPACT_FIRST_NUDGE_PERCENT", { get: () => COMPACT_FIRST_NUDGE_PERCENT });
defineGoalRuntimeGlobal("lastContextPercent", { get: () => lastContextPercent, set: (v) => { lastContextPercent = v as any; } });
defineGoalRuntimeGlobal("clearContextStarvedStreak", { get: () => clearContextStarvedStreak });
defineGoalRuntimeGlobal("onCompactionLanded", { get: () => onCompactionLanded });
defineGoalRuntimeGlobal("isContextStarvedRefused", { get: () => isContextStarvedRefused });
defineGoalRuntimeGlobal("__testOnlySetLastCompactionAt", { get: () => __testOnlySetLastCompactionAt });
defineGoalRuntimeGlobal("__testOnlyLoadState", { get: () => __testOnlyLoadState });
defineGoalRuntimeGlobal("__testOnlyRegisterAgentTools", { get: () => __testOnlyRegisterAgentTools });
defineGoalRuntimeGlobal("__testOnlyRememberCtx", { get: () => __testOnlyRememberCtx });
defineGoalRuntimeGlobal("postCompactResumeOwed", { get: () => postCompactResumeOwed, set: (v) => { postCompactResumeOwed = v as any; } });
defineGoalRuntimeGlobal("postCompactResyncPending", { get: () => postCompactResyncPending, set: (v) => { postCompactResyncPending = v as any; } });
defineGoalRuntimeGlobal("COMPACTION_GRACE_MS", { get: () => COMPACTION_GRACE_MS });
defineGoalRuntimeGlobal("ERROR_RETRY_LADDER_MS", { get: () => ERROR_RETRY_LADDER_MS });
defineGoalRuntimeGlobal("loopRearmSince", { get: () => loopRearmSince, set: (v) => { loopRearmSince = v as any; } });
defineGoalRuntimeGlobal("loopRearmMilestone", { get: () => loopRearmMilestone, set: (v) => { loopRearmMilestone = v as any; } });
