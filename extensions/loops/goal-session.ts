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
  stateRootPending,
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
  clearQueueItemFiles,
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

// =================================================================
// Constants
// =================================================================

const GOAL_EVENT_ENTRY = "goal-event";
// HELD_ON_RESTORE (stopReason marker for a restore-held loop) lives in
// goal-loop-forever.js since v0.28.17 — the display layer imports it too.

// =================================================================
// Module-level state (one per session)
// =================================================================

// The ExtensionAPI captured in the factory. sendMessage lives on the API,
// not on ExtensionContext, so continuation sends need it at module scope.
let extensionApi: ExtensionAPI | null = null;
// v0.26.7: pi invalidates the extension runtime on session replacement
// (newSession/fork/switchSession/reload). Once stale, every sendMessage
// throws FOREVER in this process — retrying for hours is the hegemon
// failure shape. Detect the stale signature once and go terminally loud.
let extensionApiStale = false;
// v0.32.0: CRITICAL — goStaleTerminal must gate on its OWN flag, not
// extensionApiStale: probeExtensionApiStale() sets extensionApiStale on
// detection, so the heartbeat's `probe → goStaleTerminal` sequence always
// found the flag already true and returned silently. The terminal orphan
// path must still ledger the stale handle, stop stale work, and preserve the
// interrupt marker so a later fresh lifecycle can restore it.
let staleTerminalDone = false;
// v0.35.x: a silent host-handle death is a coalesced recovery boundary. Keep
// the durable interrupt marker for an orphan with no successor, but remember
// that the first genuinely fresh lifecycle/turn event may re-arm the goal
// immediately instead of leaving it parked behind that marker.
let staleContinuationRearmPending = false;
// v0.34.19: delayed session-owned callbacks capture this generation. A
// clearTimeout can race a callback already queued by Node; without a
// generation check, an old compaction/refire callback can run after /reload
// and schedule work against the fresh session.
let sessionGeneration = 0;


function sessionManagerId(ctx: ExtensionContext): string {
  try {
    const getId = (ctx.sessionManager as { getSessionId?: () => string }).getSessionId;
    return typeof getId === "function" ? String(getId.call(ctx.sessionManager)) : "unknown-session";
  } catch {
    return "unknown-session";
  }
}

/** The session id of a raw sessionManager object (no ctx), or null when the
 * object exposes no usable id. The id_invalidation path uses this on the
 * RECORDED owner (ownerSession/deadOwnerSession) — objects whose ctx is
 * gone but whose manager still answers getSessionId. */
function sessionIdOf(manager: unknown): string | null {
  try {
    const getId = (manager as { getSessionId?: () => string } | null | undefined)?.getSessionId;
    return typeof getId === "function" ? String(getId.call(manager)) : null;
  } catch {
    return null;
  }
}

/** v0.34.73 (OPEN-ISSUES 1.12): the id_invalidation reason enum. The old
 * session handle was invalidated; the fresh session carries a new id. The
 * reason says WHICH invalidation mechanism produced the pair:
 * - stale_terminal — the handle went stale in-process (goStaleTerminal);
 * - zombie_stood_down — a successor INSTANCE owns the cwd; this one stood down;
 * - rebind_without_shutdown — pi swapped the session with no session_end;
 * - session_shutdown — the old session ended cleanly (shutdown record);
 * - forced_rewrite — a new process took over with NO shutdown record
 *   (crash/kill — the screenshot's orphan case);
 * - successor_absorption — a live file-backed successor claimed the plane;
 * - session_handoff — generic handoff with an id change. */
export function classifyIdInvalidationReason(flags: {
  staleTerminal?: boolean;
  zombieStoodDown?: boolean;
  extensionApiStale?: boolean;
  rebindWithoutShutdown?: boolean;
  hadShutdown?: boolean;
  previousPid?: number | null;
}): string {
  if (flags.staleTerminal) return "stale_terminal";
  if (flags.zombieStoodDown) return "zombie_stood_down";
  if (flags.rebindWithoutShutdown) return "rebind_without_shutdown";
  if (flags.hadShutdown) return "session_shutdown";
  if (flags.previousPid != null && flags.previousPid !== process.pid) return "forced_rewrite";
  return "session_handoff";
}

/** v0.34.75 (host-session-lost): the session_handle_invalidated reason enum.
 * goStaleTerminal detects the death of the extension handle but cannot see
 * the cause from a generic stale error — the class is inferred from what
 * the loop itself knows at the moment of the terminal:
 * - session_shutdown — a lifecycle shutdown already ran (clearSessionOwnedTimers
 *   → sessionHandoffPending). In practice the shutdown ALSO nulls lastCtx, so
 *   the heartbeat cannot fire the terminal at all — this branch only guards
 *   the rare race where a send-path stale error beats the shutdown handler's
 *   cleanup, and any future caller with better knowledge;
 * - provider_disconnect — the main model was in provider-failure recovery when
 *   the handle died (weak signal: provider recovery was active);
 * - silent_handle_death — neither: pi invalidated the handle WITHOUT delivering
 *   a replacement session and without a shutdown record. This is the exact
 *   "host session lost" case the user keeps hitting (13 screenshots 08-05→08-07);
 *   the terminal event ONLY fires for this class in practice.
 * Priority: a recorded shutdown wins even if recovery is also active. */
export function classifySessionHandleInvalidation(flags: {
  sessionHandoffPending?: boolean;
  mainModelRecoveryActive?: boolean;
}): "session_shutdown" | "provider_disconnect" | "silent_handle_death" {
  if (flags.sessionHandoffPending) return "session_shutdown";
  if (flags.mainModelRecoveryActive) return "provider_disconnect";
  return "silent_handle_death";
}

/** v0.34.63: identity-tolerant session comparison. pi can deliver the SAME
 * resumed session with a NEW SessionManager object (quit → fresh pi → blank
 * startup → resume), so object identity is not enough; the session id it
 * reports is. Two managers match when both expose a real, equal session id.
 * In-memory workers (or unknown ids) never match — fail closed. */
function sameSessionIdentity(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  try {
    const ga = (a as { getSessionId?: () => string } | null)?.getSessionId;
    const gb = (b as { getSessionId?: () => string } | null)?.getSessionId;
    if (typeof ga !== "function" || typeof gb !== "function") return false;
    const ia = String(ga.call(a));
    const ib = String(gb.call(b));
    return ia !== "unknown-session" && ib !== "unknown-session" && ia === ib;
  } catch {
    return false;
  }
}

/** v0.26.7: a stale api is terminal for this process — go loudly with
 * restart guidance instead of retrying sends that can never land.
 * v0.28.1 (S1/S2): goals STAY ACTIVE with an interrupt marker instead of
 * pausing — the restore gate only auto-resumes ACTIVE goals, so pausing
 * here stranded goals until manual /goal resume (hegemon/sraaal shape).
 * sendContinuation's extensionApiStale guard already stops further sends
 * in this doomed process; the next fresh session can restore the work. */
/** v0.34.16: lifecycle-first session-replacement survival. pi's
 * sanctioned pattern (docs/extensions.md lifecycle + the stale error text):
 * session_shutdown → persist handoff debt + stop old timers,
 * session_start → re-establish with the NEW ctx and consume the debt.
 * A successor module may still stand down via the owner file. An orphan with
 * no replacement is reported honestly: an invalid extension cannot repair its
 * own pi host, so glla never injects terminal keystrokes. */
const SESSION_REBIND_GRACE_MS = 60_000;
let sessionReplacementUntil = 0;
const instanceStartedAt = Date.now();
const instanceId = `${process.pid}:${instanceStartedAt}`;
let zombieStoodDown = false;

function ownerFilePath(cwd: string): string {
  return path.join(piGlaDir(cwd), "owner.json");
}

function writeOwnerFile(cwd: string): void {
  try {
    if (stateRootPending()) return;
    fs.mkdirSync(piGlaDir(cwd), { recursive: true });
    fs.writeFileSync(ownerFilePath(cwd), JSON.stringify({ instanceId, pid: process.pid, at: Date.now() }));
  } catch {
    /* owner file is advisory — never block activation on it */
  }
}

function readOwnerFile(cwd: string): { instanceId?: string; pid?: number; at?: number } | null {
  try {
    return JSON.parse(fs.readFileSync(ownerFilePath(cwd), "utf8")) as { instanceId?: string; pid?: number; at?: number };
  } catch {
    return null;
  }
}

/** A stale probe is terminal only for ORPHANS. Returns true when the
 * stale sighting was absorbed (a rebind window is open, or a successor
 * instance owns this cwd and we stand down silently), false when the
 * caller should go terminal (orphan — no replacement came). */
function absorbStaleIfSuperseded(ctx: ExtensionContext): boolean {
  if (Date.now() < sessionReplacementUntil) {
    appendLedger(ctx.cwd, "stale_awaiting_rebind", {});
    return true;
  }
  const owner = readOwnerFile(ctx.cwd);
  if (owner && owner.pid === process.pid && typeof owner.instanceId === "string" && owner.instanceId !== instanceId) {
    appendLedger(ctx.cwd, "zombie_stood_down", { owner: owner.instanceId });
    zombieStoodDown = true;
    extensionApiStale = true; // silence the send paths WITHOUT the terminal theatre
    clearSessionOwnedTimers();
    return true;
  }
  return false;
}

function persistInterruptedGoalWithoutContext(cwd: string, where: string): void {
  const goal = state.goal;
  if (!goal || goal.status !== "active") return;
  goal.interruptedAt = nowIso();
  goal.interruptedReason = `extension api stale (${where})`;
  goal.updatedAt = nowIso();
  try {
    const file = writeGoalMd(cwd, goal);
    goal.activePath = path.relative(cwd, file) || file;
    persistStateLine(cwd, state);
  } catch {
    // The persistence-degraded path will surface a later retry; do not call
    // a context-bound UI/update helper from a stale handle.
  }
}

function goStaleTerminal(ctx: ExtensionContext, where: string): void {
  if (staleTerminalDone) return; // already terminal — don't re-spam
  staleTerminalDone = true;
  extensionApiStale = true;
  appendLedger(ctx.cwd, "extension_api_stale", { where, kind: isLoopActive() ? "loop" : "goal" });
  // v0.34.57 (OPEN-ISSUES bug #1.1/#1.3 / tasklist item #2): also write a
  // structured `session_handle_invalidated` event with a `reason` enum so the
  // recovery path can pick the right strategy. The current stale-handle
  // detection cannot infer the cause from a generic stale error, so the
  // default reason is "unknown". Future callers MAY pass a more specific
  // reason when known (oom | manual-kill | provider-disconnect | unknown).
  // v0.34.75 (host-session-lost): the reason is now CLASSIFIED at emission
  // from what the loop knows: a lifecycle shutdown already recorded
  // (sessionHandoffPending) → the invalidation is the tail of a proper
  // session replacement; main-model provider recovery active →
  // provider_disconnect; neither → silent_handle_death, the exact
  // "invalidated without delivering a replacement" case the user keeps
  // hitting. The field distribution in the ledger now separates proper
  // session cycles from genuine host losses.
  const invalidationReason = classifySessionHandleInvalidation({
    sessionHandoffPending,
    mainModelRecoveryActive: mainModelRecoveryActive(),
  });
  appendLedger(ctx.cwd, "session_handle_invalidated", {
    where,
    kind: isLoopActive() ? "loop" : "goal",
    reason: classifySessionHandleInvalidation({
      sessionHandoffPending,
      mainModelRecoveryActive: mainModelRecoveryActive(),
    }),
  });
  // A silent death is the coalescing boundary: retain the durable interrupt
  // marker for an orphan with no successor, but let the first fresh host
  // lifecycle/turn event consume it and re-arm the continuation. Provider
  // disconnects and announced shutdowns keep their existing recovery policy.
  staleContinuationRearmPending = invalidationReason === "silent_handle_death"
    && state.goal?.status === "active"
    && state.goal.autoContinue !== false;
  if (staleContinuationRearmPending) {
    appendLedger(ctx.cwd, "stale_continuation_rearm_armed", {
      goalId: state.goal?.id,
      where,
      reason: invalidationReason,
    });
  }
  const guidance = "pi invalidated this session's extension handle without delivering a replacement session. glla stopped stale sends and kept the work safe in .pi-glla/. Use /new to create a fresh context; its session_start will resume the work. If /new does not create one, restart pi normally and glla will restore the saved work.";
  // v0.35.x: an orphaned detached completion audit is not allowed to leave
  // the durable goal in AUDITING. Release the MAIN-side wait immediately and
  // preserve the exact claim as infrastructure/no-verdict recovery debt.
  if (state.goal?.status === "auditing") {
    // The handle that triggered this path may already be stale. Use the
    // context-free durable park so updateGoal/UI never receive a dead ctx.
    parkCompletionAuditRecovery(ctx.cwd, `extension_api_stale:${where}`);
  }
  // v0.32.0: kill the continuation re-arm too — otherwise an orphaned goal
  // keeps spinning a flat 50ms retry below every watchdog. Keep only the
  // heartbeat/UI recovery probes alive: a stale handle cannot send, but the
  // same host can become healthy again without delivering session_start.
  // Stale gates still forbid all continuation/auditor sends.
  clearSessionOwnedTimers(true);
  if (isLoopActive()) {
    clearLoopTimer();
    state.loop = { ...state.loop!, active: false, stopReason: `extension api stale: ${guidance}` };
    try { persistStateLine(ctx.cwd, state); } catch { /* stale handle: next lifecycle persists the held loop */ }
  } else if (state.goal && state.goal.status === "active") {
    // The triggering ctx is precisely the handle that just proved stale;
    // persist through the cwd-only state path instead of updateGoal(ctx).
    persistInterruptedGoalWithoutContext(ctx.cwd, where);
  }
  // The stale process loses its ticker immediately, so paint the durable
  // interrupted state synchronously while the old UI handle can still accept
  // updates. The next session_start paints it again from disk.
  try { refreshUI(ctx); } catch { /* stale UI handle is best effort */ }
  try { ctx.ui.notify(`glla: ${guidance}`, "warning"); } catch { /* stale UI handle is best effort */ }
  try { notifyExternal(ctx, `glla: extension api stale — waiting for a fresh session_start; restart pi normally only if no replacement arrives. (${where})`); } catch { /* stale notifier is best effort */ }
}

/** Consume the one-shot coalesced recovery armed by goStaleTerminal. The
 * caller must already have a context that belongs to the fresh host and must
 * schedule the appropriate continuation after this returns true. */
function consumeStaleContinuationRearm(ctx: ExtensionContext, via: string): boolean {
  if (!staleContinuationRearmPending) return false;
  staleContinuationRearmPending = false;
  const goal = state.goal;
  if (!goal || goal.status !== "active" || goal.autoContinue === false) {
    appendLedger(ctx.cwd, "stale_continuation_rearm_skipped", { via, reason: "goal-not-actionable" });
    return false;
  }
  const wasInterrupted = Boolean(goal.interruptedAt);
  if (wasInterrupted) updateGoal({ interruptedAt: undefined, interruptedReason: undefined }, ctx);
  appendLedger(ctx.cwd, "stale_continuation_rearmed", {
    goalId: goal.id,
    via,
    clearedInterrupt: wasInterrupted,
  });
  postRestoreGraceTurns = 2;
  return true;
}

/** v0.34.16: lifecycle handoff replaces terminal keystroke injection. A
 * stale extension cannot call pi, so recovery must cross the lifecycle
 * boundary: session_shutdown records durable resume debt, clears every timer
 * that could retain the old context, and session_start consumes the debt from
 * a fresh context. */
const SESSION_HANDOFF_FILE = "session-handoff.json";
const SESSION_HANDOFF_VERSION = 1;
const SESSION_HANDOFF_FRESH_MS = 300_000;
interface SessionHandoffRecord {
  version: typeof SESSION_HANDOFF_VERSION;
  pid: number;
  at: string;
  reason: string;
  generation: number;
  ownerSessionId: string;
}
function sessionHandoffPath(cwd: string): string {
  return path.join(piGlaDir(cwd), SESSION_HANDOFF_FILE);
}
function writeSessionHandoff(ctx: ExtensionContext, reason: string): boolean {
  // A stored completion claim is a lifecycle owner even though it is not a
  // normal supervisor. Keep a handoff record for it after we release the
  // MAIN-side audit wait; the successor may then apply its normal recovery
  // policy without treating the old detached worker as live.
  if (!isSupervising() && !(state.goal?.pendingCompletion && isCompletionAuditRecoveryPending(state.goal))) return false;
  // A user quit is an explicit stop, not a replacement boundary. Do not
  // leave debt that could silently resume the work on a later startup;
  // global autoResume may still apply by its own explicit policy.
  if (reason.trim().toLowerCase() === "quit") {
    try { fs.rmSync(sessionHandoffPath(ctx.cwd), { force: true }); } catch { /* advisory cleanup */ }
    discardPendingListOperations(ctx.cwd, "quit");
    appendLedger(ctx.cwd, "session_handoff_suppressed", { reason });
    return false;
  }
  try {
    if (stateRootPending()) return false;
    fs.mkdirSync(piGlaDir(ctx.cwd), { recursive: true });
    const handoff: SessionHandoffRecord = {
      version: SESSION_HANDOFF_VERSION,
      pid: process.pid,
      at: new Date().toISOString(),
      reason,
      generation: sessionGeneration,
      ownerSessionId: sessionManagerId(ctx),
    };
    fs.writeFileSync(sessionHandoffPath(ctx.cwd), JSON.stringify(handoff));
    appendLedger(ctx.cwd, "session_handoff_pending", { reason, pid: process.pid, generation: sessionGeneration });
    return true;
  } catch {
    appendLedger(ctx.cwd, "session_handoff_write_failed", { reason });
    return false;
  }
}
function consumeSessionHandoff(
  cwd: string,
  expectedGeneration: number | null,
  expectedOwnerSessionId: string | null,
): boolean {
  try {
    const p = sessionHandoffPath(cwd);
    if (!fs.existsSync(p)) return false;
    const raw = fs.readFileSync(p, "utf-8");
    // Consume before validation: a stale, foreign, malformed, or mismatched
    // handoff must never be retried by a later session as if it were fresh.
    fs.unlinkSync(p);
    const data = JSON.parse(raw) as Partial<SessionHandoffRecord>;
    const at = Date.parse(data.at ?? "");
    const fresh = !Number.isNaN(at) && Date.now() - at < SESSION_HANDOFF_FRESH_MS;
    const matches = data.version === SESSION_HANDOFF_VERSION
      && data.pid === process.pid
      && data.reason?.trim().toLowerCase() !== "quit"
      && typeof data.generation === "number"
      && Number.isFinite(data.generation)
      && expectedGeneration !== null
      && data.generation === expectedGeneration
      && typeof data.ownerSessionId === "string"
      && expectedOwnerSessionId !== null
      && data.ownerSessionId === expectedOwnerSessionId;
    if (!fresh || !matches) {
      appendLedger(cwd, "session_handoff_rejected", {
        reason: !fresh ? "stale-or-invalid" : "identity-mismatch",
        expectedGeneration,
        actualGeneration: typeof data.generation === "number" ? data.generation : null,
      });
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

// v0.35.x: a mutating `/list` command can arrive after session_shutdown has
// invalidated the old extension handle but before the replacement emits
// session_start. Refusing the command is safe, but telling the user it will
// be handled later is false unless the exact arguments are durably retained.
// Keep a small ordered command journal separate from the lifecycle marker so
// the handoff marker can remain one-shot and identity-fenced.
const PENDING_LIST_OPERATION_FILE = "pending-list-operation.json";
const PENDING_LIST_OPERATION_VERSION = 1;
const MAX_PENDING_LIST_OPERATIONS = 8;
const PENDING_LIST_OPERATION_FRESH_MS = SESSION_HANDOFF_FRESH_MS;
interface PendingListOperationRecord {
  version: typeof PENDING_LIST_OPERATION_VERSION;
  pid: number;
  at: string;
  generation: number;
  ownerSessionId: string;
  operations: string[];
}
function pendingListOperationPath(cwd: string): string {
  return path.join(piGlaDir(cwd), PENDING_LIST_OPERATION_FILE);
}
function queuePendingListOperation(ctx: ExtensionContext, args: string): boolean {
  if (!sessionHandoffPending) return false;
  const operation = args.trim();
  if (!operation || operation.length > 8_000) return false;
  const p = pendingListOperationPath(ctx.cwd);
  // clearSessionOwnedTimers() fences the old generation before the stale
  // command can arrive. The handoff marker was written just before that
  // increment, so bind the deferred operation to the predecessor generation.
  const handoffGeneration = sessionHandoffPending ? Math.max(0, sessionGeneration - 1) : sessionGeneration;
  let operations: string[] = [];
  try {
    const prior = JSON.parse(fs.readFileSync(p, "utf-8")) as Partial<PendingListOperationRecord>;
    const priorAt = Date.parse(prior.at ?? "");
    const sameOwner = prior.version === PENDING_LIST_OPERATION_VERSION
      && prior.pid === process.pid
      && prior.generation === handoffGeneration
      && prior.ownerSessionId === sessionManagerId(ctx)
      && Number.isFinite(priorAt)
      && Date.now() - priorAt < PENDING_LIST_OPERATION_FRESH_MS
      && Array.isArray(prior.operations);
    if (sameOwner) {
      const priorOperations = prior.operations ?? [];
      operations = priorOperations.filter((item): item is string => typeof item === "string" && item.trim().length > 0).slice(0, MAX_PENDING_LIST_OPERATIONS);
    }
  } catch { /* no prior deferred command */ }
  if (operations.length >= MAX_PENDING_LIST_OPERATIONS) {
    appendLedger(ctx.cwd, "list_operation_handoff_queue_full", { count: operations.length });
    return false;
  }
  operations.push(operation);
  const record: PendingListOperationRecord = {
    version: PENDING_LIST_OPERATION_VERSION,
    pid: process.pid,
    at: new Date().toISOString(),
    generation: handoffGeneration,
    ownerSessionId: sessionManagerId(ctx),
    operations,
  };
  try {
    if (stateRootPending()) return false;
    fs.mkdirSync(piGlaDir(ctx.cwd), { recursive: true });
    const tmp = `${p}.tmp-${process.pid}-${Date.now()}`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(record));
      fs.renameSync(tmp, p);
    } finally {
      try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
    }
    appendLedger(ctx.cwd, "list_operation_deferred_for_handoff", { count: operations.length, chars: operation.length });
    return true;
  } catch {
    appendLedger(ctx.cwd, "list_operation_handoff_write_failed", { chars: operation.length });
    return false;
  }
}
function consumePendingListOperations(
  cwd: string,
  expectedGeneration: number | null,
  expectedOwnerSessionId: string | null,
): string[] {
  const p = pendingListOperationPath(cwd);
  try {
    if (!fs.existsSync(p)) return [];
    const raw = fs.readFileSync(p, "utf-8");
    fs.unlinkSync(p);
    const data = JSON.parse(raw) as Partial<PendingListOperationRecord>;
    const at = Date.parse(data.at ?? "");
    const operations = Array.isArray(data.operations)
      ? data.operations.filter((item): item is string => typeof item === "string" && item.trim().length > 0).slice(0, MAX_PENDING_LIST_OPERATIONS)
      : [];
    const valid = data.version === PENDING_LIST_OPERATION_VERSION
      && data.pid === process.pid
      && Number.isFinite(at)
      && Date.now() - at < PENDING_LIST_OPERATION_FRESH_MS
      && (expectedGeneration === null || data.generation === expectedGeneration)
      && (expectedOwnerSessionId === null || data.ownerSessionId === expectedOwnerSessionId)
      && operations.length > 0;
    if (!valid) {
      appendLedger(cwd, "list_operation_handoff_rejected", { expectedGeneration, actualGeneration: data.generation ?? null, count: operations.length });
      return [];
    }
    appendLedger(cwd, "list_operation_handoff_consumed", { count: operations.length });
    return operations;
  } catch {
    try { fs.rmSync(p, { force: true }); } catch { /* best effort */ }
    appendLedger(cwd, "list_operation_handoff_rejected", { reason: "read-or-parse-failed" });
    return [];
  }
}
function discardPendingListOperations(cwd: string, reason: string): void {
  try {
    if (!fs.existsSync(pendingListOperationPath(cwd))) return;
    fs.rmSync(pendingListOperationPath(cwd), { force: true });
    appendLedger(cwd, "list_operation_handoff_discarded", { reason });
  } catch { /* advisory cleanup */ }
}

/** v0.34.14: /reload rebind detector. The extension runs INSIDE pi, so
 * process.pid IS pi's pid: an instance that boots and finds its OWN pid
 * already in the owner file is normally a same-process rebuild, not a cold
 * boot. A non-quit rebind resumes active goals/loops — holding mid-work
 * after an in-place rebuild is pure friction (user directive: keep going
 * unless we must stop; "the list is not continuing" after /reload,
 * hellhunter 2026-08-01). An explicit quit is stamped in the sidecar and
 * does not receive this implicit consent; cold boots (new pid) still honor
 * autoresume=off. Sidecar, not the ledger: read-before-write must be
 * atomic-ish and the ledger is append-only. */
const SESSION_OWNER_FILE = "session-owner.json";
interface SessionOwnerRecord {
  pid?: number;
  at?: string;
  generation?: number;
  ownerSessionId?: string;
  shutdownReason?: string;
  shutdownAt?: string;
}
interface SessionOwnerClaim {
  rebind: boolean;
  generation: number;
  previousGeneration: number | null;
  previousOwnerSessionId: string | null;
  /** v0.34.73: the previous owner shut down cleanly (shutdown record). */
  hadShutdown: boolean;
  /** v0.34.73: the previous owner's pid (null on first boot). */
  previousPid: number | null;
  /** v0.34.73: the raw shutdown reason string ("quit", "reload", ...). */
  previousShutdownReason: string | null;
}
function markSessionOwnerShutdown(cwd: string, reason: string): void {
  try {
    const p = path.join(piGlaDir(cwd), SESSION_OWNER_FILE);
    const owner = JSON.parse(fs.readFileSync(p, "utf-8")) as SessionOwnerRecord;
    if (owner.pid === process.pid) {
      fs.writeFileSync(p, JSON.stringify({ ...owner, shutdownReason: reason, shutdownAt: new Date().toISOString() }));
    }
  } catch { /* advisory sidecar — lifecycle cleanup must not throw */ }
}
function claimSessionOwnerAndDetectRebind(
  cwd: string,
  currentGeneration: number,
  ownerSessionId: string,
): SessionOwnerClaim {
  if (stateRootPending()) {
    return {
      rebind: false,
      generation: currentGeneration,
      previousGeneration: null,
      previousOwnerSessionId: null,
      hadShutdown: false,
      previousPid: null,
      previousShutdownReason: null,
    };
  }
  try {
    const p = path.join(piGlaDir(cwd), SESSION_OWNER_FILE);
    let previous: SessionOwnerRecord = {};
    try {
      previous = JSON.parse(fs.readFileSync(p, "utf-8")) as SessionOwnerRecord;
    } catch { /* absent or corrupt — first boot */ }
    const previousGeneration = typeof previous.generation === "number" && Number.isFinite(previous.generation)
      ? previous.generation
      : null;
    const generation = previousGeneration === null
      ? currentGeneration
      : Math.max(currentGeneration, previousGeneration + 1);
    fs.writeFileSync(p, JSON.stringify({
      pid: process.pid,
      at: new Date().toISOString(),
      generation,
      ownerSessionId,
    } satisfies SessionOwnerRecord));
    const shutdownReason = previous.shutdownReason?.trim().toLowerCase();
    const hadShutdown = typeof shutdownReason === "string" && shutdownReason.length > 0;
    return {
      rebind: previous.pid === process.pid && !hadShutdown,
      generation,
      previousGeneration,
      previousOwnerSessionId: typeof previous.ownerSessionId === "string" ? previous.ownerSessionId : null,
      hadShutdown,
      previousPid: typeof previous.pid === "number" ? previous.pid : null,
      previousShutdownReason: typeof previous.shutdownReason === "string" && previous.shutdownReason.length > 0 ? previous.shutdownReason : null,
    };
  } catch {
    return {
      rebind: false,
      generation: currentGeneration,
      previousGeneration: null,
      previousOwnerSessionId: null,
      hadShutdown: false,
      previousPid: null,
      previousShutdownReason: null,
    };
  }
}

/** v0.34.73 (OPEN-ISSUES 1.12): the id_invalidation ledger event. The old
 * session handle was invalidated (forced rewrite/handoff) and the fresh
 * session carries a new id — record the pair + reason so a repro from
 * active.jsonl history can reconstruct the story. Emitted only when both
 * ids are real and DIFFER (a plain /reload keeps the same session id and
 * emits nothing). The goalId correlation lands when a goal is active. */
function emitIdInvalidation(ctx: ExtensionContext, oldId: string | null, newId: string | null, reason: string, shutdownReason?: string | null): void {
  if (!oldId || !newId || oldId === newId || oldId === "unknown-session" || newId === "unknown-session") return;
  appendLedger(ctx.cwd, "id_invalidation", {
    oldId,
    newId,
    reason,
    ...(typeof shutdownReason === "string" && shutdownReason.length > 0 ? { shutdownReason } : {}),
    ...(state.goal?.status === "active" ? { goalId: state.goal.id } : {}),
    at: nowIso(),
  });
}

// consumeRecoveryResume moved to extensions/goal-recovery.ts (decomposition step 3, v0.34.111).

/** TEST-ONLY hook (tests/harness): the stale flag is process-terminal in
 * production — only a pi restart clears it — so behavioral tests reset it
 * between stale scenarios. Never called by production code. */
export function __testOnlyResetStaleFlag(): void {
  extensionApiStale = false;
  staleContinuationRearmPending = false;
}

/** TEST-ONLY hook (GitHub #4): the last draft dialog rendered through the
 * custom path — the mock never invokes the custom builder, so tests assert
 * the captured title/body/options instead. Cleared to null by the hook
 * itself between assertions (no production caller). */
export function __testOnlyLastConfirmDialog(): { title: string; body: string; options: string[] } | null {
  const last = lastConfirmDialog;
  lastConfirmDialog = null;
  return last;
}

/** TEST-ONLY hook (tests/harness): clears the terminal/stand-down module
 * flags a stale-scenario test file may have latched. Production clears them
 * only on successor-absorb or process restart; bun test shares module state
 * across files, so an ordinary-events test file must be able to run even
 * when an earlier file latched them. Never called by production code. */
export function __testOnlyResetTerminalFlags(): void {
  staleTerminalDone = false;
  staleContinuationRearmPending = false;
  zombieStoodDown = false;
  sessionHandoffPending = false;
}

/** TEST-ONLY hook (tests/harness): set/clear the persisted lastModelRef
 * slot so a test can start from fresh-process semantics (no model observed
 * yet) without firing a session_start. Never called by production code. */
export function __testOnlySetLastModelRef(ref: string | undefined): void {
  state.lastModelRef = ref;
}

/** Test-only: override the session-replacement grace window (null restores
 * the production 60s). A shutdown followed by a NEVER-delivered rebind must
 * still classify as session_shutdown once the grace expires — tests backdate
 * the window instead of waiting 60s. Never called by production code. */
export function __testOnlySetSessionReplacementUntil(ms: number | null): void {
  sessionReplacementUntil = ms ?? 0;
}

/** Test-only: release the claimed session owner so a later test file can
 * drive agent_end with its own sessionManager identity (ownerSession is
 * process-wide module state; behavioral-orchestrator claims it first). */
export function __testOnlyResetOwnerSession(): void {
  ownerSession = null;
  ownerCwd = null;
  deadOwnerSession = null;
  deadOwnerCwd = null;
}

/** Lifecycle regression hook: drive the detached list-audit fan-out from the behavioral
 * harness. The production path passes the immutable cwd + generation from
 * archiveCurrentGoal; this hook uses the current generation so the test can
 * replace the session while the confirmation is suspended. */
export async function __testOnlyRunFanOutListAuditFindings(cwd: string): Promise<void> {
  await fanOutListAuditFindings(cwd, sessionGeneration);
}

function isCtxAlive(ctx: ExtensionContext | null | undefined): boolean {
  if (!ctx) return false;
  try {
    ctx.isIdle();
    return true;
  } catch {
    return false;
  }
}

/** v0.28.1 (S3): side-effect-free staleness probe — getSessionName()
 * routes through pi's assertActive() and throws the stale signature iff
 * pi invalidated this factory handle (session replacement). A positive
 * result is cached in extensionApiStale. */
/** v0.34.62: side-effect-free RAW staleness probe — same shape as
 * probeExtensionApiStale but never caches. The heartbeat debounce needs to
 * count consecutive failures WITHOUT latching on the first transient one
 * (field: hegemon 2026-08-06 — one probe failure parked a live session for
 * 5 hours). */
function probeExtensionApiStaleRaw(): boolean {
  // The ExtensionAPI and ExtensionContext can disagree briefly: a live
  // context does NOT prove that the captured `pi` can still send. In
  // particular, a stale send can latch the API while ctx.isIdle() continues
  // to succeed. Always probe the API itself here or the heartbeat will
  // repeatedly "recover" and immediately fail the next continuation send.
  if (!extensionApi) return false;
  try {
    extensionApi.getSessionName();
  } catch (err) {
    if (isStaleApiError(err)) return true;
  }
  return false;
}

function probeExtensionApiStale(): boolean {
  // A stale ExtensionAPI is terminal for this factory instance. A healthy
  // context probe must not clear this latch: the next send would still use
  // the same captured API and throw again.
  if (extensionApiStale) return true;
  if (probeExtensionApiStaleRaw()) extensionApiStale = true;
  return extensionApiStale;
}

/** v0.34.7: orchestrator-path sendUserMessage that can NEVER crash the
 * process. Darklord 2026-08-01: fanOutListAuditFindings ran on a stale
 * handle (a /reload landed mid-collect), assertActive threw, the floating
 * promise from sync archiveCurrentGoal turned it into an uncaughtException
 * and pi EXITED mid-audit. Probe first, catch anyway, ledger the skip. */
function safeSteerUser(ctx: ExtensionContext, text: string): boolean {
  if (sessionHandoffPending) {
    appendLedger(ctx.cwd, "steer_skipped_handoff", { chars: text.length });
    return false;
  }
  if (probeExtensionApiStale()) {
    appendLedger(ctx.cwd, "steer_skipped_stale", { chars: text.length });
    return false;
  }
  try {
    extensionApi?.sendUserMessage(text, { deliverAs: ctx.isIdle() ? "followUp" : "steer" });
    return true;
  } catch (err) {
    if (isStaleApiError(err)) extensionApiStale = true;
    appendLedger(ctx.cwd, "steer_skipped_stale", { chars: text.length, threw: true });
    return false;
  }
}

/** v0.28.1 (S3): command-entry staleness probe + honest warning. Returns
 * true when the handle is stale — callers must skip send-dependent paths
 * and must NOT claim work started (S3's "created — starting now" lie). */
function warnIfStaleAtEntry(ctx: ExtensionContext, what: string): boolean {
  if (!probeExtensionApiStale()) return false;
  if (sessionHandoffPending) {
    ctx.ui.notify(`glla: this session is handing off to a fresh pi context — ${what} will be handled after session_start.`, "info");
    return true;
  }
  // v0.30.0: a successor may already own this session (e.g. a module
  // re-import) — the user's command belongs to the fresh instance; say so
  // softly instead of claiming the old handle can recover it.
  // v0.32.0: the rebind window means a fresh instance is COMING, not here —
  // the message names that handoff rather than pretending a send landed.
  if (Date.now() < sessionReplacementUntil) {
    ctx.ui.notify(`glla: this session is rebinding after /reload — ${what} will be handled by the refreshed instance; retry in a moment if it doesn't.`, "info");
    return true;
  }
  if (absorbStaleIfSuperseded(ctx)) {
    ctx.ui.notify(`glla: a refreshed instance owns this session — ${what} is handled there; nothing to do.`, "info");
    return true;
  }
  appendLedger(ctx.cwd, "extension_api_stale", { where: `entry probe (${what})` });
  ctx.ui.notify(
    `glla: this session's extension handle is stale (pi session replacement) — ${what} can't send continuations in this process. State is safe in .pi-glla/. Use /new to create a fresh context; its session_start will resume it. If /new does not create one, restart pi normally and restore the saved work.`,
    "warning",
  );
  // Entry probes never mutate the terminal. The only recovery boundary is
  // pi's own session lifecycle; user-present commands keep an honest warning
  // and the durable state remains available to the fresh session.
  return true;
}

/** v0.28.12: draft-class confirm with the auto-accept escape hatch SURFACED.
 * The polis incident: a user sat through a 14-item batch Confirm having
 * already reviewed every item during drafting, never knowing /glla
 * autoaccept=on existed — the Yes/No dialog never mentioned it. Now every
 * draft dialog is a 3-choice select; the ALWAYS choice persists project
 * autoAcceptDrafts=true and accepts. Returns "stale" when the dialog can't
 * render (session replacement) so call sites keep their NOT-a-rejection
 * handling; falls back to the plain confirm if select is unavailable.
 * v0.34.78 (GitHub #4): when the runtime has ctx.ui.custom, the SAME three
 * choices render as a Markdown dialog (objective + contract at full width)
 * instead of the plain-text select; the select path stays as the headless/
 * RPC fallback. */
type DraftChoice = "yes" | "no" | "stale";
// v0.34.78: last draft dialog rendered via the custom path — exposed for
// tests (__testOnlyLastConfirmDialog) since the mock never invokes the
// custom builder.
let lastConfirmDialog: { title: string; body: string; options: string[] } | null = null;
async function confirmDraft(ctx: ExtensionContext, title: string, body: string): Promise<DraftChoice> {
  const ALWAYS = "Yes — and always auto-accept drafts (sets autoAcceptDrafts for this project)";
  const options = ["Yes", ALWAYS, "No"];
  // v0.34.80 (GitHub #4 rework): `custom` is ALWAYS a function in real pi
  // 0.84.1 — RPC mode resolves `undefined` WITHOUT ever invoking the factory
  // (`async custom() { /* Custom UI not supported */ return undefined; }`),
  // so `typeof custom === "function"` alone never fires the headless/RPC
  // fallback and RPC drafts were silently rejected ("no" — the dialog never
  // rendered, the host never answered). Detect unavailability by whether the
  // builder RAN: if `custom()` settles and the factory was never invoked,
  // treat custom as unavailable and fall through to the byte-identical
  // select path (the host-dialog route in RPC mode).
  if (typeof (ctx.ui as { custom?: unknown }).custom === "function") {
    lastConfirmDialog = { title, body, options };
    let factoryInvoked = false;
    try {
      const choice = await ctx.ui.custom<string | undefined>((tui, theme, keybindings, done) => {
        factoryInvoked = true;
        return new ConfirmDraftComponent({ title, body, options }, () => tui.requestRender(), theme as any, keybindings as any, done);
      });
      if (factoryInvoked) {
        if (choice === ALWAYS) {
          saveSettings("project", ctx.cwd, { autoAcceptDrafts: true });
          appendLedger(ctx.cwd, "draft_autoaccept_enabled", { via: title });
          ctx.ui.notify("Draft auto-accept ON for this project — future draft confirms are skipped. Undo in /glla settings: Auto-accept drafts = off.", "info");
          return "yes";
        }
        return choice === "Yes" ? "yes" : "no";
      }
      // real RPC/noOp stub — custom is unavailable in this mode; the
      // select fallback below is the host-dialog path.
      appendLedger(ctx.cwd, "confirm_dialog_fallback_select", { via: "custom-stub" });
    } catch (err) {
      if (isStaleApiError(err)) return "stale";
      // a non-stale custom failure degrades to the legacy select path
    }
  }
  try {
    const choice = await ctx.ui.select(`${title}\n\n${body}`, ["Yes", ALWAYS, "No"]);
    if (choice === ALWAYS) {
      saveSettings("project", ctx.cwd, { autoAcceptDrafts: true });
      appendLedger(ctx.cwd, "draft_autoaccept_enabled", { via: title });
      ctx.ui.notify("Draft auto-accept ON for this project — future draft confirms are skipped. Undo in /glla settings: Auto-accept drafts = off.", "info");
      return "yes";
    }
    return choice === "Yes" ? "yes" : "no";
  } catch (err) {
    if (isStaleApiError(err)) return "stale";
    try {
      return (await ctx.ui.confirm(title, body)) ? "yes" : "no";
    } catch (err2) {
      return isStaleApiError(err2) ? "stale" : "no";
    }
  }
}

// v0.28.14: ONE summary + policy application for stale carryover when NEW
// work activates. pause (default): surface what's waiting, stack nothing
// silently. clear: drop the queue, dismiss the held loop, archive the
// paused goal — honestly, with a ledger trail. resume: legacy silent
// behavior. A new GOAL replacing a paused one archives it in every policy
// (one-active-thing: state.goal holds exactly one goal).
function resolveCarryover(ctx: ExtensionContext, trigger: "goal" | "loop" | "list"): void {
  if (carryoverResolved || !carryoverSnapshot) return;
  carryoverResolved = true;
  const snap = carryoverSnapshot;
  carryoverSnapshot = null;
  const policy = loadSettings(ctx.cwd).carryover ?? "pause";
  if (policy === "resume") return; // legacy silent stacking
  const done: string[] = [];
  const waiting: string[] = [];
  const pausedGoal = state.goal && state.goal.status === "paused" ? state.goal : null;
  // A new goal OR list item replaces the goal slot; a loop leaves it paused.
  if (pausedGoal && (trigger === "goal" || trigger === "list" || policy === "clear")) {
    archiveCurrentGoal(ctx, "aborted", trigger === "loop" ? "carryover cleared" : `replaced by new ${trigger} (carryover)`);
    done.push(`archived paused goal "${displaySlice(snap.pausedGoal ?? pausedGoal.objective, 60)}"`);
  } else if (snap.pausedGoal) {
    waiting.push(`paused goal "${displaySlice(snap.pausedGoal, 60)}" (${workCommand(snap.pausedGoalPolicy, "resume")})`);
  }
  if (snap.listCount > 0 || policy === "clear") {
    if (policy === "clear") {
      // Carryover clear must remove the durable union, not only RAM. The
      // stale-handle /list reader intentionally resurrects queue sidecars.
      const clearedSidecars = clearQueueItemFiles(ctx.cwd);
      replaceState({ ...state, list: [] });
      if (snap.listCount > 0) done.push(`dropped ${snap.listCount} waiting list item(s)`);
      if (clearedSidecars.removed > 0) done.push(`removed ${clearedSidecars.removed} durable queue sidecar(s)`);
      if (clearedSidecars.failed.length > 0) {
        waiting.push(`${clearedSidecars.failed.length} queue sidecar(s) could not be removed — clear is incomplete`);
      }
    } else {
      waiting.push(`${snap.listCount} waiting list item(s) (/list next)`);
    }
  }
  if (snap.heldLoop) {
    if (policy === "clear" && state.loop && !state.loop.active && state.loop.stopReason === HELD_ON_RESTORE) {
      state.loop = { ...state.loop, stopReason: "cleared: carryover" };
      done.push(`dismissed held loop "${displaySlice(snap.heldLoop, 60)}"`);
    } else {
      waiting.push(`held loop "${displaySlice(snap.heldLoop, 60)}" (/loop to resume)`);
    }
  }
  persistState(ctx);
  appendLedger(ctx.cwd, "carryover_resolved", { policy, trigger, cleared: done.length, waiting: waiting.length });
  const summary = [...done.map((d) => `✂ ${d}`), ...waiting.map((w) => `⏸ ${w}`)].join(" · ");
  if (!summary) return;
  ctx.ui.notify(
    policy === "clear"
      ? `Carryover cleared (${trigger}): ${summary}`
      : `Carryover from before this session: ${summary}${waiting.length > 0 ? " — set Carryover = clear in /glla settings to drop these automatically." : ""}`,
    "info",
  );
}

// The most recent ExtensionContext seen from any event or command handler.
// pi replaces sessions (newSession/fork/reload) and stale ctx throws on use,
// so timers must never capture a ctx — they read lastCtx at fire time.
let lastCtx: ExtensionContext | null = null;
// v0.34.16: shutdown sets this before pi invalidates the old context. Any
// timer or late event that reaches the old module must stand down until the
// fresh session_start rebinds it.
let sessionHandoffPending = false;
// v0.34.18: pi's initial `session_start` fires before interactive mode
// renders the selected transcript. A plain `pi` startup is also a fresh,
// empty session; do not let project-scoped autoResume launch work into that
// placeholder before the user has loaded a real session.
let initialSessionLoadPending = false;
const sessionTimeouts = new Set<NodeJS.Timeout>();
// v0.23.8: the session that OWNS the loop (its sessionManager). Subagent
// sessions (pi-subagents binds extensions there too) fire our handlers
// with their own ctx — they must never take over lastCtx (a headless
// subagent ctx would silently kill the heartbeat/wedge machinery).
let ownerSession: unknown = null;
let ownerCwd: string | null = null;
// v0.34.25: clearSessionOwnedTimers nulls ownerSession at the stale terminal,
// erasing the very identity a successor-absorption decision needs. Keep the
// dead owner here so a live file-backed ctx can still be recognized as the
// replacement HOST session (vs an in-memory subagent worker) after the park.
let deadOwnerSession: unknown = null;
let deadOwnerCwd: string | null = null;

function sessionHasConversation(ctx: ExtensionContext): boolean | undefined {
  try {
    const manager = ctx.sessionManager as unknown as {
      buildSessionContext?: () => { messages?: unknown[] };
    };
    if (typeof manager.buildSessionContext !== "function") return undefined;
    return (manager.buildSessionContext().messages?.length ?? 0) > 0;
  } catch {
    // Older pi contexts and test doubles may not expose the session reader;
    // preserve their existing behavior rather than guessing that they are blank.
    return undefined;
  }
}

function isBlankInitialStartup(ctx: ExtensionContext, reason: string): boolean {
  if (reason !== "startup" && reason !== "unknown") return false;
  return sessionHasConversation(ctx) === false;
}

function releaseInitialSessionLoadBarrier(): void {
  initialSessionLoadPending = false;
  // The factory starts the heartbeat, but a future pi/context may not. This
  // is idempotent and makes an explicit /goal resume or /loop start usable.
  startHeartbeat();
}

function ownerProbeLive(): boolean {
  if (!ownerSession || !lastCtx) return false;
  try { lastCtx.isIdle(); return true; } catch { /* owner went stale (session replaced) */ }
  return false;
}

/** v0.34.25: is this ctx a real pi host session (file-backed), not a subagent
 * worker? pi-subagents sessions are SessionManager.inMemory — no session
 * file (pi-subagents agent-runner.ts). A silent host replacement keeps file
 * persistence; an in-memory ctx can only be an ephemeral worker. Fail closed
 * on any probe error. */
function isHostSuccessorCtx(ctx: ExtensionContext): boolean {
  try {
    const sm = ctx.sessionManager as { getSessionFile?: unknown } | null | undefined;
    if (!sm || typeof sm.getSessionFile !== "function") return false;
    return Boolean((sm.getSessionFile as () => string | undefined)());
  } catch {
    return false;
  }
}

/** v0.34.27: a file-backed context is a successor only when it is from the
 * same workspace as the dead owner. The file-backed test separates host
 * sessions from pi-subagents' in-memory workers; the cwd test also prevents
 * a different project/worktree context from claiming this process-wide goal
 * plane. Owner liveness remains fail-closed unless this instance has already
 * declared the old handle terminal. */
function isHostSuccessorContact(ctx: ExtensionContext): boolean {
  const recordedOwner = ownerSession ?? deadOwnerSession;
  if (recordedOwner === null || ctx.sessionManager === recordedOwner) return false;
  if (!isHostSuccessorCtx(ctx)) return false;
  const recordedCwd = ownerSession !== null ? ownerCwd : deadOwnerCwd;
  if (recordedCwd && ctx.cwd !== recordedCwd) return false;
  return staleTerminalDone || !ownerProbeLive();
}

/** v0.34.25: same-host successor absorption. pi can replace the host session
 * WITHOUT delivering session_start (the silent swap around compaction —
 * deathrun/hegemon/pulis sessions parked forever as "host session lost"
 * while the user sat at a live prompt). The replacement session is ALIVE and
 * reaches us through ordinary tool calls and events: a foreign ctx that is
 * file-backed while the recorded owner is provably dead IS the replacement
 * host session. Absorb it as the goal-plane owner, clear the stale-terminal
 * theatre, and resume the interrupted chain with lifecycle-rebind consent
 * semantics (the session never died; there was no load decision to gate).
 * Subagent workers (in-memory) and ambiguous cases (owner still live) keep
 * failing closed; a zombie-stood-down instance never reclaims the plane. */
function tryAbsorbHostSuccessor(ctx: ExtensionContext, via: string): boolean {
  if (zombieStoodDown) return false; // a successor INSTANCE owns owner.json — this instance stands down forever
  if (!isHostSuccessorContact(ctx)) return false;
  // v0.35.58: bind the successor's canonical session directory before the
  // id-invalidation event below can write to the state root.
  setRuntimeSessionDirFromSessionManager(ctx.sessionManager);
  const completionAuditNeedsRecovery = !!state.goal?.pendingCompletion && (
    state.goal.status === "auditing"
    || (state.goal.status === "paused" && (state.goal.pendingCompletion.phase ?? "recovery-pending") === "recovery-pending")
  );
  // v0.34.73 (OPEN-ISSUES 1.12): a live successor absorbed WITHOUT
  // session_start is a silent-swap handoff — record the id pair when the
  // session identity actually changed.
  const absorbedOldId = sessionIdOf(ownerSession ?? deadOwnerSession);
  emitIdInvalidation(ctx, absorbedOldId, sessionIdOf(ctx.sessionManager), "successor_absorption");
  ownerSession = ctx.sessionManager;
  ownerCwd = ctx.cwd;
  deadOwnerSession = null;
  deadOwnerCwd = null;
  lastCtx = ctx;
  extensionApiStale = false;
  staleTerminalDone = false;
  sessionHandoffPending = false;
  sessionGeneration++; // a dead generation's delayed callbacks must not fire into the new owner
  clearDraftingState(); // the old interview belongs to the disposed generation
  appendLedger(ctx.cwd, "session_rebind_via_live_ctx", { via, generation: sessionGeneration });
  let auditRetryStarted = false;
  if (completionAuditNeedsRecovery && state.goal?.status === "auditing") {
    // The old generation's detached worker/result handler is now stale. Do
    // not let its finally block leave completionAuditInFlight latched in the
    // successor; release the MAIN and preserve the exact claim.
    markCompletionAuditRecoveryPending(ctx, `silent-host-successor:${via}`);
  }
  // A validated file-backed successor is already the lifecycle consent needed
  // for the bounded one-shot audit recovery. This closes the old gap where a
  // silent replacement was absorbed but a parked no-verdict claim still
  // waited forever for a manual /goal|/list resume.
  if (
    completionAuditNeedsRecovery
    && state.goal?.status === "paused"
    && state.goal.pendingCompletion?.phase === "recovery-pending"
    && typeof maybeAutoRetryParkedCompletionAudit === "function"
  ) {
    auditRetryStarted = maybeAutoRetryParkedCompletionAudit("host-rebind");
  }
  if (completionAuditNeedsRecovery) {
    ctx.ui.notify(
      auditRetryStarted
        ? "glla: detached completion auditor lost with the old host — no verdict was reached; the live replacement is retrying the stored claim once."
        : `glla: detached completion auditor lost with the old host — no verdict was reached; the MAIN is released. ${activeGoalSurfaceCommand("resume")} retries the stored claim.`,
      auditRetryStarted ? "info" : "warning",
    );
  }
  ctx.ui.notify("glla: pi replaced this session without delivering session_start — absorbed the live replacement as the goal-plane owner (in-memory subagent sessions stay refused).", "info");
  startHeartbeat();
  heartbeatStaleStreak = 0;
  const staleRearmed = consumeStaleContinuationRearm(ctx, via);
  if (staleRearmed) {
    ctx.ui.notify(`glla: fresh host event re-armed ${state.goal?.policy === "list" ? "the list item" : "the goal"} continuation after the stale-handle boundary.`, "info");
  }
  if (state.goal && state.goal.status === "active") {
    const wasInterrupted = Boolean(state.goal.interruptedAt);
    if (wasInterrupted) {
      updateGoal({ interruptedAt: undefined, interruptedReason: undefined }, ctx);
      ctx.ui.notify(`Resuming ${state.goal.policy === "list" ? "list item" : "goal"}: ${displaySlice(state.goal.objective, 70)} — auto-resumed after the silent session swap`, "info");
      postRestoreGraceTurns = 2;
    }
    // A silent successor can contact the extension before any interruptedAt
    // marker was persisted. Never leave an active objective idle merely
    // because the rebind arrived through a non-turn event.
    if (!continuationTimerPending() && !pendingContinuationDispatchRef()) {
      scheduleContinuation(ctx, true);
    }
  }
  refreshUI(ctx);
  return true;
}

/** v0.34.62: spurious-stale self-heal. Field: hegemon 2026-08-06T20:06Z — a
 * single heartbeat probe failure latched extensionApiStale and parked the
 * goal plane ("handing off to a fresh pi context") for ~5 hours while the
 * SAME pi process kept serving commands. pi never replaced the session
 * (compaction emits only session_compact — no session_shutdown, no
 * session_start), so no rebind ever arrived and the only recovery was a
 * restart. When a user command arrives from the SAME sessionManager after
 * the rebind grace expired AND the handle now probes healthy, the park was
 * wrong: un-park, reclaim the plane, and resume the interrupted goal per
 * the autoResume gate (mirroring the session-load restore semantics).
 * Refused when a zombie owns the plane (owner file), when a DIFFERENT
 * session contacts us (successor absorption owns that path), inside the
 * rebind window, or while the fresh probe still throws (genuinely dead —
 * keep the honest park). */
function selfHealStaleSameSession(ctx: ExtensionContext): boolean {
  if (zombieStoodDown) return false; // another instance owns the plane
  const parked = extensionApiStale || sessionHandoffPending || staleTerminalDone;
  if (!parked) return false;
  if (initialSessionLoadPending) return false;
  const recordedOwner = ownerSession ?? deadOwnerSession;
  if (recordedOwner === null || ctx.sessionManager !== recordedOwner) return false;
  if (Date.now() < sessionReplacementUntil) return false; // a successor session_start is expected
  const owner = readOwnerFile(ctx.cwd);
  if (owner && owner.pid === process.pid && typeof owner.instanceId === "string" && owner.instanceId !== instanceId) {
    return false; // a successor module instance owns this cwd — never re-claim
  }
  // Both handles must actually be healthy NOW. A live ExtensionContext does
  // not prove that the captured ExtensionAPI can send; Pi can leave ctx
  // probes answering while the API has already latched stale. Reclaim only
  // when the exact API used by continuation sends also passes its probe.
  if (!isCtxAlive(ctx) || !extensionApi || probeExtensionApiStaleRaw()) return false;
  const was = extensionApiStale ? "extension_api_stale" : sessionHandoffPending ? "session_handoff_pending" : "stale_terminal_done";
  extensionApiStale = false;
  sessionHandoffPending = false;
  staleTerminalDone = false;
  deadOwnerSession = null;
  deadOwnerCwd = null;
  ownerSession = ctx.sessionManager;
  ownerCwd = ctx.cwd;
  lastCtx = ctx;
  sessionGeneration++; // a parked generation's delayed callbacks must not fire into the reclaimed plane
  heartbeatStaleStreak = 0;
  clearDraftingState();
  appendLedger(ctx.cwd, "stale_self_healed", { was, via: "same-session command", generation: sessionGeneration });
  startHeartbeat();
  startUITicker();
  const staleRearmed = consumeStaleContinuationRearm(ctx, "same-session command");
  if (staleRearmed) {
    ctx.ui.notify(`glla: the healthy handle re-armed ${state.goal?.policy === "list" ? "the list item" : "the goal"} continuation after the stale-handle boundary.`, "info");
    if (state.goal?.status === "active" && !continuationTimerPending() && !pendingContinuationDispatchRef()) {
      scheduleContinuation(ctx, true);
    }
  }
  const auditRetryStarted = state.goal?.status === "paused"
    && state.goal.pendingCompletion?.phase === "recovery-pending"
    && typeof maybeAutoRetryParkedCompletionAudit === "function"
    && maybeAutoRetryParkedCompletionAudit("host-rebind");
  if (auditRetryStarted) {
    ctx.ui.notify("glla: the stale handle recovered in place — retrying the stored no-verdict completion audit once.", "info");
  } else if (state.goal && state.goal.status === "active" && state.goal.interruptedAt) {
    // A live context from the same session proves the session was not lost.
    // Clear the spurious interrupt marker so the UI does not show 'host session lost'.
    updateGoal({ interruptedAt: undefined, interruptedReason: undefined }, ctx);
    ctx.ui.notify(
      `Recovered from the stale-handle park — the handle is healthy again. Resuming ${state.goal.policy === "list" ? "list item" : "goal"}: ${displaySlice(state.goal.objective, 70)}`,
      "info",
    );
    postRestoreGraceTurns = 2;
    if (!staleRearmed && !continuationTimerPending() && !pendingContinuationDispatchRef() && state.goal.autoContinue !== false) {
      scheduleContinuation(ctx, true);
    }
  } else {
    ctx.ui.notify("glla: recovered from the stale-handle park — the handle is healthy again; the goal plane is live.", "info");
  }
  refreshUI(ctx);
  return true;
}

function rememberCtx(ctx: ExtensionContext): void {
  // v0.34.62: spurious-stale self-heal BEFORE the stale gates drop the ctx —
  // a same-session command with a healthy handle proves the park was wrong.
  if (selfHealStaleSameSession(ctx)) return;
  // v0.34.25: absorb BEFORE the stale gates drop the ctx — after pi's silent
  // swap, the first sign of life is an ordinary command/event from the
  // replacement session, and every gate below would discard it forever.
  if (tryAbsorbHostSuccessor(ctx, "rememberCtx")) return;
  // Late events from a disposed session must never reclaim lastCtx after the
  // lifecycle handoff has been declared. Only session_start clears these
  // gates and may bind a fresh context.
  if (sessionHandoffPending || staleTerminalDone || zombieStoodDown) return;
  const ownerLive = ownerProbeLive();
  const claim = classifySessionCtx(ownerSession, ownerLive, ctx.sessionManager);
  if (claim === "foreign") return;
  // v0.34.25: with a dead owner the old code rebound to ANY ctx — including
  // an in-memory subagent worker, locking the real host out of its own goal
  // plane. Only a file-backed host successor may claim (absorption above).
  const recordedOwner = ownerSession ?? deadOwnerSession;
  if (recordedOwner && ctx.sessionManager !== recordedOwner && !isHostSuccessorContact(ctx)) return;
  ownerSession = ctx.sessionManager;
  ownerCwd = ctx.cwd;
  lastCtx = ctx;
}

/** True when ctx belongs to a subagent/foreign session, not the loop owner. */
function isForeignCtx(ctx: ExtensionContext): boolean {
  return ownerSession !== null && ctx.sessionManager !== ownerSession;
}

/**
 * Host-owned replacement events are the one exception to the foreign-session
 * guard. A same-process /new, /resume, /fork, or /reload can deliver
 * session_start with a NEW SessionManager and (on the affected pi paths)
 * without a preceding session_shutdown. Treating that event as a subagent
 * leaves the old owner in place forever and discards the only rebind event.
 *
 * pi-subagents creates fresh sessions with the default `startup` event, so
 * keeping `startup` foreign preserves the subagent isolation guard. The
 * previousSessionFile field is an additional host-runtime signal for future
 * replacement reasons.
 */
function isHostLifecycleSessionStart(event: unknown): boolean {
  const candidate = event as { reason?: unknown; previousSessionFile?: unknown } | null;
  const reason = typeof candidate?.reason === "string" ? candidate.reason.trim().toLowerCase() : "";
  return ["new", "resume", "fork", "reload"].includes(reason)
    || typeof candidate?.previousSessionFile === "string";
}

const FOREIGN_SESSION_TOOL_MESSAGE =
  "This tool changes goal/loop/list state, which only the MAIN session owns — you are running in a subagent session. Report back to the main agent; it owns the goal and can call this tool.";

/** Refusal message when a state-mutating tool is called from a subagent session, else null. */
function foreignToolGuard(execCtx: unknown): string | null {
  const c = execCtx as ExtensionContext | undefined;
  if (!c) return null;
  // v0.34.25: absorb FIRST — the first sign of pi's silent session swap is
  // often a TOOL CALL from the live replacement session, and after the stale
  // terminal the recorded owner is nulled (the successor is not even
  // "foreign"). A file-backed host successor rebinds here, never refuses.
  if (tryAbsorbHostSuccessor(c, "tool-call")) return null;
  if (isForeignCtx(c)) return FOREIGN_SESSION_TOOL_MESSAGE;
  // Post-park the owner is nulled; the dead-owner record means only the
  // file-backed successor may act — ephemeral workers stay refused instead of
  // slipping through the null-owner gap (pre-v0.34.25 hole).
  if (!ownerSession && deadOwnerSession && c.sessionManager !== deadOwnerSession && !isHostSuccessorContact(c)) {
    return FOREIGN_SESSION_TOOL_MESSAGE;
  }
  return null;
}

// v0.34.109: `state` singleton moved to goal-state.ts (single owner).
// This module imports it and mutates through replaceState() only.

// Main-session model recovery is separate from detached-auditor retry.
// It can rotate through mainModelFallbacks, while the durable wait protects a
// supervised goal when the active model keeps failing. One timer, one probe,
// no blind resend storm.
let mainModelRecoveryTimer: NodeJS.Timeout | null = null;
let mainModelSwitchInFlight = false;
let mainModelAbortForRecovery = false;
// hourly retry ticker (v0.34.92) — co-resident with the normal retry
// cadence; opt-in via hourlyRetryProbe (default ON). Flags stay owned here;
// goal-recovery.ts observes them through the RecoveryFlags accessor.
let hourlyProbeTimer: NodeJS.Timeout | null = null;
let hourlyProbeFireAt: number | null = null;
let lastMainModelFailure: MainModelFailure | null = null;

// v0.34.92: the old hourly chat prompt was removed. It used to send a
// message at the next hour, but provider wording is not reliable enough for a
// user-facing claim. Recovery now uses a silent :00:30 retry ticker instead.

// Drafting mode: a no-arg loop command starts a clarification turn; the agent
// must call propose_goal_draft / propose_loop_draft, which opens the user's
// Confirm dialog. The target decides where the confirmed contract lands.
let draftingTarget: "goal" | "list" | "loop" | null = null;
// v0.14.0 drafting floor: user replies counted while drafting; the injected
// seed prompt itself arrives as a user message — skip exactly that one.
let draftingUserReplies = 0;
let draftingBlockedProposals = 0; // v0.15.1: stuck-gate escape hatch
let draftingSeedInFlight = false;

/** Drafting is ephemeral session state, not durable goal/list state. A stale
 * seed or an in-flight Confirm must never leave the next MAIN session behind
 * the old interview gate. */


/* Runtime globals: preserve the old monolith lexical links across extracted modules. */
defineGoalRuntimeGlobal("GOAL_EVENT_ENTRY", { get: () => GOAL_EVENT_ENTRY });
defineGoalRuntimeGlobal("extensionApi", { get: () => extensionApi, set: (v) => { extensionApi = v as any; } });
defineGoalRuntimeGlobal("extensionApiStale", { get: () => extensionApiStale, set: (v) => { extensionApiStale = v as any; } });
defineGoalRuntimeGlobal("staleTerminalDone", { get: () => staleTerminalDone, set: (v) => { staleTerminalDone = v as any; } });
defineGoalRuntimeGlobal("sessionGeneration", { get: () => sessionGeneration, set: (v) => { sessionGeneration = v as any; } });
defineGoalRuntimeGlobal("sessionManagerId", { get: () => sessionManagerId });
defineGoalRuntimeGlobal("sessionIdOf", { get: () => sessionIdOf });
defineGoalRuntimeGlobal("classifyIdInvalidationReason", { get: () => classifyIdInvalidationReason });
defineGoalRuntimeGlobal("classifySessionHandleInvalidation", { get: () => classifySessionHandleInvalidation });
defineGoalRuntimeGlobal("sameSessionIdentity", { get: () => sameSessionIdentity });
defineGoalRuntimeGlobal("SESSION_REBIND_GRACE_MS", { get: () => SESSION_REBIND_GRACE_MS });
defineGoalRuntimeGlobal("sessionReplacementUntil", { get: () => sessionReplacementUntil, set: (v) => { sessionReplacementUntil = v as any; } });
defineGoalRuntimeGlobal("instanceStartedAt", { get: () => instanceStartedAt });
defineGoalRuntimeGlobal("instanceId", { get: () => instanceId });
defineGoalRuntimeGlobal("zombieStoodDown", { get: () => zombieStoodDown, set: (v) => { zombieStoodDown = v as any; } });
defineGoalRuntimeGlobal("ownerFilePath", { get: () => ownerFilePath });
defineGoalRuntimeGlobal("writeOwnerFile", { get: () => writeOwnerFile });
defineGoalRuntimeGlobal("readOwnerFile", { get: () => readOwnerFile });
defineGoalRuntimeGlobal("absorbStaleIfSuperseded", { get: () => absorbStaleIfSuperseded });
defineGoalRuntimeGlobal("goStaleTerminal", { get: () => goStaleTerminal });
defineGoalRuntimeGlobal("consumeStaleContinuationRearm", { get: () => consumeStaleContinuationRearm });
defineGoalRuntimeGlobal("SESSION_HANDOFF_FILE", { get: () => SESSION_HANDOFF_FILE });
defineGoalRuntimeGlobal("SESSION_HANDOFF_VERSION", { get: () => SESSION_HANDOFF_VERSION });
defineGoalRuntimeGlobal("SESSION_HANDOFF_FRESH_MS", { get: () => SESSION_HANDOFF_FRESH_MS });
defineGoalRuntimeGlobal("sessionHandoffPath", { get: () => sessionHandoffPath });
defineGoalRuntimeGlobal("writeSessionHandoff", { get: () => writeSessionHandoff });
defineGoalRuntimeGlobal("consumeSessionHandoff", { get: () => consumeSessionHandoff });
defineGoalRuntimeGlobal("queuePendingListOperation", { get: () => queuePendingListOperation });
defineGoalRuntimeGlobal("consumePendingListOperations", { get: () => consumePendingListOperations });
defineGoalRuntimeGlobal("discardPendingListOperations", { get: () => discardPendingListOperations });
defineGoalRuntimeGlobal("SESSION_OWNER_FILE", { get: () => SESSION_OWNER_FILE });
defineGoalRuntimeGlobal("markSessionOwnerShutdown", { get: () => markSessionOwnerShutdown });
defineGoalRuntimeGlobal("claimSessionOwnerAndDetectRebind", { get: () => claimSessionOwnerAndDetectRebind });
defineGoalRuntimeGlobal("emitIdInvalidation", { get: () => emitIdInvalidation });
defineGoalRuntimeGlobal("__testOnlyResetStaleFlag", { get: () => __testOnlyResetStaleFlag });
defineGoalRuntimeGlobal("__testOnlyLastConfirmDialog", { get: () => __testOnlyLastConfirmDialog });
defineGoalRuntimeGlobal("__testOnlyResetTerminalFlags", { get: () => __testOnlyResetTerminalFlags });
defineGoalRuntimeGlobal("__testOnlySetLastModelRef", { get: () => __testOnlySetLastModelRef });
defineGoalRuntimeGlobal("__testOnlySetSessionReplacementUntil", { get: () => __testOnlySetSessionReplacementUntil });
defineGoalRuntimeGlobal("__testOnlyResetOwnerSession", { get: () => __testOnlyResetOwnerSession });
defineGoalRuntimeGlobal("__testOnlyRunFanOutListAuditFindings", { get: () => __testOnlyRunFanOutListAuditFindings });
defineGoalRuntimeGlobal("probeExtensionApiStaleRaw", { get: () => probeExtensionApiStaleRaw });
defineGoalRuntimeGlobal("probeExtensionApiStale", { get: () => probeExtensionApiStale });
defineGoalRuntimeGlobal("safeSteerUser", { get: () => safeSteerUser });
defineGoalRuntimeGlobal("warnIfStaleAtEntry", { get: () => warnIfStaleAtEntry });
defineGoalRuntimeGlobal("lastConfirmDialog", { get: () => lastConfirmDialog, set: (v) => { lastConfirmDialog = v as any; } });
defineGoalRuntimeGlobal("confirmDraft", { get: () => confirmDraft });
defineGoalRuntimeGlobal("resolveCarryover", { get: () => resolveCarryover });
defineGoalRuntimeGlobal("lastCtx", { get: () => lastCtx, set: (v) => { lastCtx = v as any; } });
defineGoalRuntimeGlobal("sessionHandoffPending", { get: () => sessionHandoffPending, set: (v) => { sessionHandoffPending = v as any; } });
defineGoalRuntimeGlobal("initialSessionLoadPending", { get: () => initialSessionLoadPending, set: (v) => { initialSessionLoadPending = v as any; } });
defineGoalRuntimeGlobal("sessionTimeouts", { get: () => sessionTimeouts });
defineGoalRuntimeGlobal("ownerSession", { get: () => ownerSession, set: (v) => { ownerSession = v as any; } });
defineGoalRuntimeGlobal("ownerCwd", { get: () => ownerCwd, set: (v) => { ownerCwd = v as any; } });
defineGoalRuntimeGlobal("deadOwnerSession", { get: () => deadOwnerSession, set: (v) => { deadOwnerSession = v as any; } });
defineGoalRuntimeGlobal("deadOwnerCwd", { get: () => deadOwnerCwd, set: (v) => { deadOwnerCwd = v as any; } });
defineGoalRuntimeGlobal("sessionHasConversation", { get: () => sessionHasConversation });
defineGoalRuntimeGlobal("isBlankInitialStartup", { get: () => isBlankInitialStartup });
defineGoalRuntimeGlobal("releaseInitialSessionLoadBarrier", { get: () => releaseInitialSessionLoadBarrier });
defineGoalRuntimeGlobal("ownerProbeLive", { get: () => ownerProbeLive });
defineGoalRuntimeGlobal("isHostSuccessorCtx", { get: () => isHostSuccessorCtx });
defineGoalRuntimeGlobal("isHostSuccessorContact", { get: () => isHostSuccessorContact });
defineGoalRuntimeGlobal("tryAbsorbHostSuccessor", { get: () => tryAbsorbHostSuccessor });
defineGoalRuntimeGlobal("selfHealStaleSameSession", { get: () => selfHealStaleSameSession });
defineGoalRuntimeGlobal("rememberCtx", { get: () => rememberCtx });
defineGoalRuntimeGlobal("isForeignCtx", { get: () => isForeignCtx });
defineGoalRuntimeGlobal("isHostLifecycleSessionStart", { get: () => isHostLifecycleSessionStart });
defineGoalRuntimeGlobal("FOREIGN_SESSION_TOOL_MESSAGE", { get: () => FOREIGN_SESSION_TOOL_MESSAGE });
defineGoalRuntimeGlobal("foreignToolGuard", { get: () => foreignToolGuard });
defineGoalRuntimeGlobal("mainModelRecoveryTimer", { get: () => mainModelRecoveryTimer, set: (v) => { mainModelRecoveryTimer = v as any; } });
defineGoalRuntimeGlobal("mainModelSwitchInFlight", { get: () => mainModelSwitchInFlight, set: (v) => { mainModelSwitchInFlight = v as any; } });
defineGoalRuntimeGlobal("mainModelAbortForRecovery", { get: () => mainModelAbortForRecovery, set: (v) => { mainModelAbortForRecovery = v as any; } });
defineGoalRuntimeGlobal("hourlyProbeTimer", { get: () => hourlyProbeTimer, set: (v) => { hourlyProbeTimer = v as any; } });
defineGoalRuntimeGlobal("hourlyProbeFireAt", { get: () => hourlyProbeFireAt, set: (v) => { hourlyProbeFireAt = v as any; } });
defineGoalRuntimeGlobal("lastMainModelFailure", { get: () => lastMainModelFailure, set: (v) => { lastMainModelFailure = v as any; } });
defineGoalRuntimeGlobal("draftingTarget", { get: () => draftingTarget, set: (v) => { draftingTarget = v as any; } });
defineGoalRuntimeGlobal("draftingUserReplies", { get: () => draftingUserReplies, set: (v) => { draftingUserReplies = v as any; } });
defineGoalRuntimeGlobal("draftingBlockedProposals", { get: () => draftingBlockedProposals, set: (v) => { draftingBlockedProposals = v as any; } });
defineGoalRuntimeGlobal("draftingSeedInFlight", { get: () => draftingSeedInFlight, set: (v) => { draftingSeedInFlight = v as any; } });
