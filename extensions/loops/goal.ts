/**
 * pi-goal-list-loop-audit — v0.34.114 real installer
 * extensions/loops/goal.ts
 *
 * Decomposition step 6: this file is the public activation/wiring surface.
 * Runtime concerns live in named sibling modules under extensions/loops/.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import "./goal-runtime-globals.js";
import "./goal-session.js";
import "./goal-ui.js";
import "./goal-orchestrator.js";
import "./goal-auditor-hooks.js";
import "./goal-list-queue.js";
import "./goal-tools.js";
import "./goal-settings-ui.js";
import { registerActionReminderRenderer } from "../action-reminder.js";
import { abortZombieRun, enqueueFaultRepairTask, registerGoalRuntime, resetLengthExhaustionEpisodes, __testOnlyResetLengthExhaustionEpisodes, __testOnlyResetZombieAutoRetry } from "./goal-activation.js";
// v0.38.88: members of the __testOnlyResetProcessState composite.
import { __testOnlyResetOwnerSession, __testOnlyResetStaleFlag, __testOnlyResetTerminalFlags, __testOnlyResetOwnershipRecheck } from "./goal-session.js";
import { __testOnlyResetStarvationGate, __testOnlyResetToolActivity, __testOnlyResetAuditorQuietWatch } from "./goal-ui.js";
import { __testOnlyResetAuditorSurface } from "./goal-auditor-surface.js";
import { __testOnlyResetAuditorRecoveryRuntime } from "./goal-auditor-hooks.js";
import { __testOnlyResetOverdueWaitBackstop, __testOnlyResetZombieRunWatchdog, __testOnlyClearSubagentHangProbes } from "../goal-heartbeat.js";
import { __testOnlyResetCompactor } from "../goal-compactor.js";
import { __testOnlyResetOwnerHeartbeat, __testOnlyResetStandDownNotice } from "../state-root-owner.js";

import {
  createGoalContinuation,
  scheduleContinuation,
  sendContinuation,
  dispatchAccepted,
  dispatchFailed,
  dispatchPrepare,
  releaseContinuationDispatchStandDown,
  clearContinuationTimer,
  accountSendRearm,
  sendRearmDelayMs,
  armQueueStuckProbe,
  buildPostCompactResync,
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
  resetContinuationDispatchState,
  type ContinuationFlags,
  type ContinuationDeps,
} from "../goal-continuation.js";
export { __testOnlySetContinuationStartTimeout, __testOnlySetContinuationRetryBackoff } from "../goal-continuation.js";

import {
  clearMainModelRecoveryTimer,
  createGoalRecovery,
  isCompletionAuditRecoveryPending,
  mainModelRecoveryActive,
  manuallyResumeMainModelRecovery,
  markCompletionAuditRecoveryPending,
  parkCompletionAuditRecovery,
  probeMainModelRecovery,
  type RecoveryDeps,
  type RecoveryFlags,
} from "../goal-recovery.js";
import { createGoalHeartbeat, getSubagentAgentsSnapshot, type HeartbeatDeps, type HeartbeatFlags } from "../goal-heartbeat.js";
import { createGoalCommands, type CommandDeps, type CommandFlags } from "../goal-commands.js";
import { clearLoopTimer, createGoalLoop, type LoopDeps, type LoopFlags } from "../goal-loop.js";

export {
  classifyIdInvalidationReason,
  classifySessionHandleInvalidation,
  __testOnlyResetStaleFlag,
  __testOnlyLastConfirmDialog,
  __testOnlyResetTerminalFlags,
  __testOnlySetLastModelRef,
  __testOnlySetSessionReplacementUntil,
  __testOnlyResetOwnerSession,
  __testOnlyRunFanOutListAuditFindings,
} from "./goal-session.js";
export { __testOnlySetLastCompactionAt, __testOnlyResetStarvationGate, __testOnlyLoadState, __testOnlyRegisterAgentTools, __testOnlyRememberCtx, __testOnlyDisplayActivityFor, __testOnlyResetToolActivity, __testOnlySetLastRealActivityAt, __testOnlySetLastActivityAt, __testOnlySetCompactionInFlight, __testOnlyPostCompactDebt, __testOnlyResetPostCompactDebt, noteCompactionStarted, noteCompactionSettled, isCompactionInFlight } from "./goal-ui.js";
export { auditorRetryPlan, runDetachedCompletionWithFallback, __testOnlySetAuditorRecoveryRetryDelay, __testOnlyResetAuditorRecoveryRuntime, type AuditorModelCandidate } from "./goal-auditor-hooks.js";
export { handleSettingChoice } from "./goal-settings-ui.js";

/* ------------------------------------------------------------------ */
/* Decomposition step 2: the command surface and loop machinery moved  */
/* to goal-commands.ts / goal-loop.ts. They receive everything through */
/* deps accessors; the flags below remain owned here (invariant #3).   */
/* ------------------------------------------------------------------ */

const commandFlags: CommandFlags = {
  get draftingTarget() { return draftingTarget; },
  set draftingTarget(v) { draftingTarget = v; },
  get completionAuditInFlight() { return completionAuditInFlight; },
  set completionAuditInFlight(v) { completionAuditInFlight = v; },
  get completionAuditRecoveryArmed() { return completionAuditRecoveryArmed; },
  set completionAuditRecoveryArmed(v) { completionAuditRecoveryArmed = v; },
  get consecutiveAbortIterations() { return consecutiveAbortIterations; },
  set consecutiveAbortIterations(v) { consecutiveAbortIterations = v; },
  get consecutiveErrorIterations() { return consecutiveErrorIterations; },
  set consecutiveErrorIterations(v) { consecutiveErrorIterations = v; },
  get continuationDispatchStoodDown() { return continuationDispatchStoodDownRef(); },
  set continuationDispatchStoodDown(v) { setContinuationDispatchStoodDownRef(v); },
  get extensionApi() { return extensionApi; },
  set extensionApi(v) { extensionApi = v; },
  get iterationCounter() { return iterationCounter; },
  set iterationCounter(v) { iterationCounter = v; },
  get latestAuditProgress() { return latestAuditProgress; },
  set latestAuditProgress(v) { latestAuditProgress = v; },
  get mainModelAbortForRecovery() { return mainModelAbortForRecovery; },
  set mainModelAbortForRecovery(v) { mainModelAbortForRecovery = v; },
  get mainModelSwitchInFlight() { return mainModelSwitchInFlight; },
  set mainModelSwitchInFlight(v) { mainModelSwitchInFlight = v; },
  get sessionGeneration() { return sessionGeneration; },
  set sessionGeneration(v) { sessionGeneration = v; },
};

const loopFlags: LoopFlags = {
  get extensionApi() { return extensionApi; },
  set extensionApi(v) { extensionApi = v; },
  get extensionApiStale() { return extensionApiStale; },
  set extensionApiStale(v) { extensionApiStale = v; },
  get sessionGeneration() { return sessionGeneration; },
  set sessionGeneration(v) { sessionGeneration = v; },
  get sessionHandoffPending() { return sessionHandoffPending; },
  set sessionHandoffPending(v) { sessionHandoffPending = v; },
  get initialSessionLoadPending() { return initialSessionLoadPending; },
  set initialSessionLoadPending(v) { initialSessionLoadPending = v; },
  get pendingContinuationDispatch() { return pendingContinuationDispatchRef(); },
  set pendingContinuationDispatch(v) { setPendingContinuationDispatchRef(v); },
  get continuationDispatchStoodDown() { return continuationDispatchStoodDownRef(); },
  set continuationDispatchStoodDown(v) { setContinuationDispatchStoodDownRef(v); },
  get lastContinuationSentAt() { return lastContinuationSentAtRef(); },
  set lastContinuationSentAt(v) { setLastContinuationSentAtRef(v); },
  get lastContinuationSentPayload() { return lastContinuationSentPayloadRef(); },
  set lastContinuationSentPayload(v) { setLastContinuationSentPayloadRef(v); },
  get loopRearmSince() { return loopRearmSince; },
  set loopRearmSince(v) { loopRearmSince = v; },
  get loopRearmStreak() { return loopRearmStreak; },
  set loopRearmStreak(v) { loopRearmStreak = v; },
  get countedLoopTokenMessages() { return countedLoopTokenMessages; },
  set countedLoopTokenMessages(v) { void v; }, // const collection — mutated in place, never reassigned
  get mainModelAbortForRecovery() { return mainModelAbortForRecovery; },
  set mainModelAbortForRecovery(v) { mainModelAbortForRecovery = v; },
  get postCompactResyncPending() { return postCompactResyncPending; },
  set postCompactResyncPending(v) { postCompactResyncPending = v; },
  get staleTerminalDone() { return staleTerminalDone; },
  set staleTerminalDone(v) { staleTerminalDone = v; },
  get zombieStoodDown() { return zombieStoodDown; },
  set zombieStoodDown(v) { zombieStoodDown = v; },
  get compactionInFlightSince() { return compactionInFlightSince; },
};

const commandDeps: CommandDeps = {
  flags: commandFlags,
  listQueue,
  notifyExternal,
  persistState,
  updateGoal,
  setGoal,
  // v0.35.29 (issue #15): /glla agents reads the heartbeat's tracked-subagent
  // snapshot via injection (goal-commands must not import goal-heartbeat).
  agentsSnapshot: () => getSubagentAgentsSnapshot(),
  archiveCurrentGoal,
  healGoalPolicy,
  startDrafting,
  warnIfStaleAtEntry,
  queuePendingListOperation,
  freshCtx,
  freshCtxForGeneration,
  goStaleTerminal,
  groupOpenChildren,
  activateNextListItem,
  clearMainModelRecoveryTimer,
  mainModelRecoveryTimerActive: () => mainModelRecoveryTimer !== null,
  continuationDispatchPending: () => pendingContinuationDispatchRef() !== null,
  resetContinuationDispatchState,
  isCompletionAuditRecoveryPending,
  markCompletionAuditRecoveryPending,
  retryStoredCompletionAudit,
  probeMainModelRecovery,
  releaseContinuationDispatchStandDown,
  releaseInitialSessionLoadBarrier,
  resolveCarryover,
  resetLengthExhaustionEpisodes,
  safeSteerUser,
  scheduleContinuation,
  scheduleSessionTimeout,
  createGoal,
  fireReviewer,
  openSettingsUI,
  manuallyResumeMainModelRecovery,
  activeGoalCommand,
  activeGoalStatusCommand,
  activeGoalSurfaceCommand,
  goalNoun,
  displaySlice,
  shortObj,
};

const loopDeps: LoopDeps = {
  flags: loopFlags,
  GOAL_EVENT_ENTRY,
  accountSendRearm,
  armQueueStuckProbe,
  buildPostCompactResync,
  clearMainModelRecoveryTimer,
  dispatchAccepted,
  dispatchFailed,
  dispatchPrepare,
  displaySlice,
  freshCtx,
  freshCtxForGeneration,
  goStaleTerminal,
  mainModelRecoveryActive,
  manuallyResumeMainModelRecovery,
  notifyExternal,
  persistState,
  archiveCurrentGoal,
  probeExtensionApiStale,
  probeMainModelRecovery,
  releaseContinuationDispatchStandDown,
  releaseInitialSessionLoadBarrier,
  rememberCtx,
  resolveCarryover,
  scheduleSessionTimeout,
  sendContinuation,
  sendRearmDelayMs,
  sessionManagerId,
  warnIfStaleAtEntry,
  startDrafting,
  activeGoalSurfaceCommand,
};


// v0.34.124: epoch of the last main-model-recovery resume (provider failure
// lifted). Set by mainModelRecoverySucceeded (goal-recovery.ts via the
// flags accessor); consumed by the continuation-start watchdog
// (goal-continuation.ts) to grant the post-recovery turn-start grace.
let lastMainModelRecoveryResumeAt = 0;

/** Test-only: simulate a main-model-recovery resume at a controlled epoch
 * without firing the full recovery plumbing. Pass null to clear. */
export function __testOnlySetLastMainModelRecoveryResumeAt(at: number | null): void {
  lastMainModelRecoveryResumeAt = at ?? 0;
}

/** v0.38.88: one composite for every test-only latch reset. bun test shares
 * module state across files in one process; the preload
 * (tests/harness/setup.ts) calls this before EACH file so every file starts
 * from fresh-process latch semantics without hand-picking resets. Each
 * member restores its module's initial values (or clears its timer); none
 * touch persisted state, timers owned by other modules, or `state.goal`
 * (files re-seed/restore that from their own cwd). Never called by
 * production code. */
export function __testOnlyResetProcessState(): void {
  __testOnlyResetOwnerSession();
  __testOnlyResetStaleFlag();
  __testOnlyResetTerminalFlags();
  __testOnlyResetOwnershipRecheck();
  __testOnlyResetStarvationGate();
  __testOnlyResetToolActivity();
  __testOnlyResetAuditorQuietWatch();
  __testOnlyResetAuditorSurface();
  __testOnlyResetAuditorRecoveryRuntime();
  __testOnlyResetLengthExhaustionEpisodes();
  __testOnlyResetZombieAutoRetry();
  __testOnlyResetOverdueWaitBackstop();
  __testOnlyResetZombieRunWatchdog();
  __testOnlyClearSubagentHangProbes();
  __testOnlyResetCompactor();
  __testOnlyResetOwnerHeartbeat();
  __testOnlyResetStandDownNotice();
}

// decomposition step 5 (v0.34.113): the continuation cluster (schedule/send,
// dispatch sidecar, rearm accounting, queue-stuck probe, prompt assembly)
// lives in goal-continuation.js — goal.ts owns the flags, observes them via
// accessors. Timer/dispatch/rearm state stays in goal-continuation.js; goal.ts
// reads it only through the exported ref accessors (invariant #3).
const continuationFlags: ContinuationFlags = {
  get sessionGeneration() { return sessionGeneration; },
  get sessionHandoffPending() { return sessionHandoffPending; },
  get initialSessionLoadPending() { return initialSessionLoadPending; },
  get extensionApiStale() { return extensionApiStale; },
  get staleTerminalDone() { return staleTerminalDone; },
  get zombieStoodDown() { return zombieStoodDown; },
  get extensionApi() { return extensionApi; },
  get postCompletionSettleUntil() { return postCompletionSettleUntil; },
  set postCompletionSettleUntil(v) { postCompletionSettleUntil = v; },
  get postCompactResyncPending() { return postCompactResyncPending; },
  set postCompactResyncPending(v) { postCompactResyncPending = v; },
  get abortedStandDown() { return abortedStandDown; },
  set abortedStandDown(v) { abortedStandDown = v; },
  get lastCompactionAt() { return lastCompactionAt; },
  get lastMainModelRecoveryResumeAt() { return lastMainModelRecoveryResumeAt; },
  set lastMainModelRecoveryResumeAt(v) { lastMainModelRecoveryResumeAt = v; },
  get lastActivityAt() { return lastActivityAt; },
  get lastRealActivityAt() { return lastRealActivityAt; },
  get loopRearmStreak() { return loopRearmStreak; },
  set loopRearmStreak(v) { loopRearmStreak = v; },
  get loopRearmSince() { return loopRearmSince; },
  set loopRearmSince(v) { loopRearmSince = v; },
  get loopRearmMilestone() { return loopRearmMilestone; },
  set loopRearmMilestone(v) { loopRearmMilestone = v; },
  get completionAuditInFlight() { return completionAuditInFlight; },
  get compactionInFlightSince() { return compactionInFlightSince; },
};
const continuationDeps: ContinuationDeps = {
  instanceId,
  GOAL_EVENT_ENTRY,
  LIST_COMPLETION_SETTLE_MS,
  persistState,
  updateGoal,
  refreshUI,
  notifyExternal,
  noteActivity,
  rememberCtx,
  freshCtx,
  freshCtxForGeneration,
  probeExtensionApiStale,
  goStaleTerminal,
  isForeignCtx,
  sessionManagerId,
  isActionableGoal,
  isContextStarvedRefused,
  isSupervising,
  goalNoun,
  activeGoalSurfaceCommand,
  scheduleSessionTimeout,
  enqueueRepairTask: enqueueFaultRepairTask,
};
createGoalContinuation(continuationFlags, continuationDeps);

createGoalLoop(loopDeps);
createGoalCommands(commandDeps);
const recoveryFlags: RecoveryFlags = {
  get completionAuditRecoveryArmed() { return completionAuditRecoveryArmed; },
  set completionAuditRecoveryArmed(v) { completionAuditRecoveryArmed = v; },
  get mainModelRecoveryTimer() { return mainModelRecoveryTimer; },
  set mainModelRecoveryTimer(v) { mainModelRecoveryTimer = v; },
  get mainModelSwitchInFlight() { return mainModelSwitchInFlight; },
  set mainModelSwitchInFlight(v) { mainModelSwitchInFlight = v; },
  get mainModelAbortForRecovery() { return mainModelAbortForRecovery; },
  set mainModelAbortForRecovery(v) { mainModelAbortForRecovery = v; },
  get lastMainModelFailure() { return lastMainModelFailure; },
  set lastMainModelFailure(v) { lastMainModelFailure = v; },
  get hourlyProbeTimer() { return hourlyProbeTimer; },
  set hourlyProbeTimer(v) { hourlyProbeTimer = v; },
  get hourlyProbeFireAt() { return hourlyProbeFireAt; },
  set hourlyProbeFireAt(v) { hourlyProbeFireAt = v; },
  get sessionGeneration() { return sessionGeneration; },
  set sessionGeneration(v) { sessionGeneration = v; },
  get extensionApi() { return extensionApi; },
  set extensionApi(v) { extensionApi = v; },
  get extensionApiStale() { return extensionApiStale; },
  set extensionApiStale(v) { extensionApiStale = v; },
  get continuationDispatchStoodDown() { return continuationDispatchStoodDownRef(); },
  set continuationDispatchStoodDown(v) { setContinuationDispatchStoodDownRef(v); },
  get lastMainModelRecoveryResumeAt() { return lastMainModelRecoveryResumeAt; },
  set lastMainModelRecoveryResumeAt(v) { lastMainModelRecoveryResumeAt = v; },
  get compactionInFlightSince() { return compactionInFlightSince; },
};
const recoveryDeps: RecoveryDeps = {
  activeGoalSurfaceCommand,
  clearDetachedAuditRuntime,
  updateGoal,
  clearContinuationTimer,
  freshCtxForGeneration,
  isSupervising,
  notifyExternal,
  persistState,
  recoverySurfaceCommand,
  scheduleContinuation,
  scheduleSessionTimeout,
};
createGoalRecovery(recoveryFlags, recoveryDeps);

// decomposition step 4 (v0.34.112): heartbeat/watchdog cluster lives in
// goal-heartbeat.js — goal.ts owns the flags, observes them via accessors.
const heartbeatFlags: HeartbeatFlags = {
  get zombieStoodDown() { return zombieStoodDown; },
  set zombieStoodDown(v) { zombieStoodDown = v; },
  get initialSessionLoadPending() { return initialSessionLoadPending; },
  get sessionGeneration() { return sessionGeneration; },
  get lastCtx() { return lastCtx; },
  get extensionApi() { return extensionApi; },
  get extensionApiStale() { return extensionApiStale; },
  set extensionApiStale(v) { extensionApiStale = v; },
  get completionAuditInFlight() { return completionAuditInFlight; },
  get completionAuditRecoveryArmed() { return completionAuditRecoveryArmed; },
  get lastActivityAt() { return lastActivityAt; },
  get staleTerminalDone() { return staleTerminalDone; },
  set staleTerminalDone(v) { staleTerminalDone = v; },
  get sessionHandoffPending() { return sessionHandoffPending; },
  set sessionHandoffPending(v) { sessionHandoffPending = v; },
  get compactionGraceUntil() { return compactionGraceUntil; },
  get continuationDispatchStoodDown() { return continuationDispatchStoodDownRef(); },
  get pendingContinuationDispatch() { return pendingContinuationDispatchRef(); },
  get compactionInFlightSince() { return compactionInFlightSince; },
  get postCompactResumeOwed() { return postCompactResumeOwed; },
  set postCompactResumeOwed(v) { postCompactResumeOwed = v; },
  get postCompactResyncPending() { return postCompactResyncPending; },
  set postCompactResyncPending(v) { postCompactResyncPending = v; },
  get abortedStandDown() { return abortedStandDown; },
  get continuationTimer() { return continuationTimerRef(); },
  get continuationStartTimer() { return continuationStartTimerRef(); },
  get lastStreamActivityAt() { return lastStreamActivityAt; },
  get lastContinuationSentAt() { return lastContinuationSentAtRef(); },
  get lastRealActivityAt() { return lastRealActivityAt; },
  get consecutiveStalls() { return consecutiveStalls; },
  set consecutiveStalls(v) { consecutiveStalls = v; },
  get heartbeatNudges() { return heartbeatNudges; },
  get inFlightToolCalls() { return inFlightToolCalls; },
  get contextStarvedStreak() { return contextStarvedStreak; },
  get lastContextStarvedAt() { return lastContextStarvedAt; },
  get heartbeatTimer() { return heartbeatTimer; },
  set heartbeatTimer(v) { heartbeatTimer = v; },
  get heartbeatStaleStreak() { return heartbeatStaleStreak; },
  set heartbeatStaleStreak(v) { heartbeatStaleStreak = v; },
};
const heartbeatDeps: HeartbeatDeps = {
  absorbStaleIfSuperseded,
  activeGoalSurfaceCommand,
  escalateStallNow,
  freshCtx,
  goStaleTerminal,
  goalNoun,
  isActionableGoal,
  isContextStarvedRefused,
  isSupervising,
  noteActivity,
  notifyExternal,
  probeExtensionApiStaleRaw,
  rememberCtx,
  scheduleContinuation,
  tryAbsorbHostSuccessor,
  updateGoal,
  parkCompletionAuditRecovery,
  continuationUnansweredMs: CONTINUATION_UNANSWERED_MS,
  continuationUnansweredThrottleMs: CONTINUATION_UNANSWERED_THROTTLE_MS,
  abortZombieRun,
};
createGoalHeartbeat(heartbeatFlags, heartbeatDeps);


export default function (pi: ExtensionAPI): void {
  // Factory evaluation can also happen inside pi-subagents child sessions.
  // Registration must not claim the shared host API or start session timers;
  // the admitted host session_start below owns both lifecycle resources.
  registerActionReminderRenderer(pi);
  registerGoalRuntime(pi);
}
