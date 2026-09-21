/**
 * Compatibility bridge for the decomposed goal runtime.
 *
 * The extracted modules still share a few monolith-era names through
 * `globalThis`. Keep that boundary explicit: every registration name lives in
 * one checked registry, every ambient declaration points at the registry's
 * value type, and the small legacy callable escape hatch is isolated here.
 * New state should be passed through a dependency interface instead of adding
 * another ambient slot.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AuditDisplayProgress, RecentActionDisplay } from "../goal-loop-display.js";
import type { Goal, Policy, State } from "../goal-loop-core.js";
import type { MainModelFailure } from "../main-model-recovery.js";

export const GOAL_RUNTIME_GLOBAL_NAMES = [
  "GOAL_EVENT_ENTRY",
  "extensionApi",
  "extensionApiStale",
  "staleTerminalDone",
  "sessionGeneration",
  "sessionManagerId",
  "sessionIdOf",
  "classifyIdInvalidationReason",
  "sameSessionIdentity",
  "SESSION_REBIND_GRACE_MS",
  "sessionReplacementUntil",
  "instanceId",
  "zombieStoodDown",
  "writeOwnerFile",
  "readOwnerFile",
  "claimProcessOwner",
  "processOwnerDeniedCwd",
  "absorbStaleIfSuperseded",
  "goStaleTerminal",
  "consumeStaleContinuationRearm",
  "sessionHandoffPath",
  "writeSessionHandoff",
  "consumeSessionHandoff",
  "queuePendingListOperation",
  "consumePendingListOperations",
  "discardPendingListOperations",
  "markSessionOwnerShutdown",
  "claimSessionOwnerAndDetectRebind",
  "emitIdInvalidation",
  "probeExtensionApiStaleRaw",
  "probeExtensionApiStale",
  "safeSteerUser",
  "warnIfStaleAtEntry",
  "confirmDraft",
  "resolveCarryover",
  "lastCtx",
  "sessionHandoffPending",
  "initialSessionLoadPending",
  "sessionTimeouts",
  "ownerSession",
  "ownerCwd",
  "deadOwnerSession",
  "deadOwnerCwd",
  "isBlankInitialStartup",
  "releaseInitialSessionLoadBarrier",
  "isWorkerSessionCtx",
  "isHostSuccessorCtx",
  "isHostSuccessorContact",
  "tryAbsorbHostSuccessor",
  "selfHealStaleSameSession",
  "rememberCtx",
  "isForeignCtx",
  "isHostLifecycleSessionStart",
  "foreignToolGuard",
  "mainModelRecoveryTimer",
  "mainModelSwitchInFlight",
  "mainModelAbortForRecovery",
  "hourlyProbeTimer",
  "hourlyProbeFireAt",
  "lastMainModelFailure",
  "draftingTarget",
  "draftingUserReplies",
  "draftingBlockedProposals",
  "draftingSeedInFlight",
  "restoreDrafterModel",
  "handleDrafterModelFailure",
  "clearDraftingState",
  "DRAFT_SESSION_INTERRUPTED_MESSAGE",
  "countedTokenMessages",
  "countedLoopTokenMessages",
  "lastActivityAt",
  "lastStreamActivityAt",
  "streamActivityObserved",
  "heartbeatNudges",
  "postRestoreGraceTurns",
  "consecutiveStalls",
  "carryoverSnapshot",
  "carryoverResolved",
  "completionAuditInFlight",
  "completionAuditGeneration",
  "completionAuditRecoveryArmed",
  "heartbeatTimer",
  "CONTINUATION_UNANSWERED_MS",
  "CONTINUATION_UNANSWERED_THROTTLE_MS",
  "EAGER_CONTINUATION_SETTLE_MS",
  "LIST_COMPLETION_SETTLE_MS",
  "postCompletionSettleUntil",
  "LOOP_MAX_CONSECUTIVE_ERRORS",
  "LOOP_MAX_CONSECUTIVE_ABORTS",
  "lastRealActivityAt",
  "noteActivity",
  "isSupervising",
  "latestAuditProgress",
  "uiTicker",
  "ownsDetachedAudit",
  "detachedAuditContext",
  "publishDetachedAuditProgress",
  "clearDetachedAuditProgress",
  "inFlightToolCalls",
  "noteToolCall",
  "noteToolResult",
  "clearToolActivityState",
  "refreshUI",
  "scheduleUIRefresh",
  "startUITicker",
  "loopRearmStreak",
  "compactionGraceUntil",
  "compactionInFlightSince",
  "noteCompactionStarted",
  "noteCompactionSettled",
  "lastCompactionAt",
  "contextStarvedStreak",
  "lastContextStarvedAt",
  "noteContextStarvedYield",
  "noteContextPercent",
  "shouldCompactFirstNudge",
  "buildStarvationLadderMessage",
  "onCompactionLanded",
  "isContextStarvedRefused",
  "postCompactResumeOwed",
  "postCompactResyncPending",
  "COMPACTION_GRACE_MS",
  "ERROR_RETRY_LADDER_MS",
  "loopRearmSince",
  "loopRearmMilestone",
  "escalateStallNow",
  "heartbeatStaleStreak",
  "iterationCounter",
  "toolCallsThisTurn",
  "consecutiveErrorIterations",
  "consecutiveAbortIterations",
  "abortedStandDown",
  "scheduleSessionTimeout",
  "clearSessionOwnedTimers",
  "isActionableGoal",
  "freshCtx",
  "freshCtxForGeneration",
  "scheduleProviderRetryForSession",
  "handleMainModelAgentEnd",
  "createGoal",
  "persistState",
  "shortObj",
  "displaySlice",
  "goalNoun",
  "activeGoalCommand",
  "activeGoalRoot",
  "activeGoalSurfaceCommand",
  "activeGoalStatusCommand",
  "recoverySurfaceCommand",
  "notifyPersistenceState",
  "setGoal",
  "updateGoal",
  "autoArbitrateStackedState",
  "fanOutListAuditFindings",
  "archiveCurrentGoal",
  "terminalizeImpossibleGoal",
  "clearDetachedAuditRuntime",
  "validateCompletionSummary",
  "beginCompletionAudit",
  "isAuditorNoVerdictInfrastructureError",
  "fmtRetryDelay",
  "auditorRetryPlan",
  "auditorCandidateLabel",
  "runDetachedCompletionWithFallback",
  "retryStoredCompletionAudit",
  "maybeAutoRetryParkedCompletionAudit",
  "scheduleParkedCompletionAuditRecovery",
  "fireReviewer",
  "listQueue",
  "groupOpenChildren",
  "activateNextListItem",
  "queueRepairAheadOfListItem",
  "startDrafting",
  "healGoalPolicy",
  "notifyExternal",
  "staleToolResult",
  "currentToolContext",
  "registerAgentTools",
  "resolveAuditorModel",
  "openSettingsUI",
  "handleSettingChoice",
  "observeModelChange",
  "observeTurnBoundaryModel",
] as const;

export type GoalRuntimeGlobalName = typeof GOAL_RUNTIME_GLOBAL_NAMES[number];

/** One intentionally broad type remains for the old cross-module call graph.
 * It is isolated here so new globals cannot silently become `any`; the high
 * risk state below is typed explicitly and the bridge can be retired by
 * replacing the remaining function slots with dependency interfaces. */
type GoalRuntimeFunction = (...args: any[]) => any;

interface GoalRuntimeDataTypes {
  GOAL_EVENT_ENTRY: string;
  extensionApi: ExtensionAPI | null;
  extensionApiStale: boolean;
  staleTerminalDone: boolean;
  sessionGeneration: number;
  SESSION_REBIND_GRACE_MS: number;
  sessionReplacementUntil: number;
  instanceId: string;
  zombieStoodDown: boolean;
  processOwnerDeniedCwd: string | null;
  lastCtx: ExtensionContext | null;
  sessionHandoffPending: boolean;
  initialSessionLoadPending: boolean;
  sessionTimeouts: Set<NodeJS.Timeout>;
  ownerSession: unknown;
  ownerCwd: string | null;
  deadOwnerSession: unknown;
  deadOwnerCwd: string | null;
  mainModelRecoveryTimer: NodeJS.Timeout | null;
  mainModelSwitchInFlight: boolean;
  mainModelAbortForRecovery: boolean;
  hourlyProbeTimer: NodeJS.Timeout | null;
  hourlyProbeFireAt: number | null;
  lastMainModelFailure: MainModelFailure | null;
  draftingTarget: "goal" | "list" | "loop" | null;
  draftingUserReplies: number;
  draftingBlockedProposals: number;
  draftingSeedInFlight: boolean;
  DRAFT_SESSION_INTERRUPTED_MESSAGE: string;
  countedTokenMessages: Set<string>;
  countedLoopTokenMessages: Set<string>;
  lastActivityAt: number;
  lastStreamActivityAt: number;
  streamActivityObserved: boolean;
  heartbeatNudges: number;
  postRestoreGraceTurns: number;
  consecutiveStalls: number;
  carryoverSnapshot: { pausedGoal?: string; pausedGoalPolicy?: Policy; listCount: number; heldLoop?: string } | null;
  carryoverResolved: boolean;
  completionAuditInFlight: boolean;
  completionAuditGeneration: number | null;
  completionAuditRecoveryArmed: boolean;
  heartbeatTimer: NodeJS.Timeout | null;
  CONTINUATION_UNANSWERED_MS: number;
  CONTINUATION_UNANSWERED_THROTTLE_MS: number;
  EAGER_CONTINUATION_SETTLE_MS: number;
  LIST_COMPLETION_SETTLE_MS: number;
  postCompletionSettleUntil: number;
  LOOP_MAX_CONSECUTIVE_ERRORS: number;
  LOOP_MAX_CONSECUTIVE_ABORTS: number;
  lastRealActivityAt: number;
  latestAuditProgress: AuditDisplayProgress | null;
  uiTicker: NodeJS.Timeout | null;
  inFlightToolCalls: Map<string, { name: string; arg?: string; at: number }>;
  loopRearmStreak: number;
  compactionGraceUntil: number;
  compactionInFlightSince: number | null;
  noteCompactionStarted: () => boolean;
  noteCompactionSettled: () => void;
  lastCompactionAt: number;
  contextStarvedStreak: number;
  lastContextStarvedAt: number;
  noteContextPercent: (pct: number | null | undefined) => void;
  shouldCompactFirstNudge: (percent: number | null | undefined) => boolean;
  buildStarvationLadderMessage: (input?: { percent?: number | null; streak?: number; recentCompact?: boolean }) => string;
  postCompactResumeOwed: boolean;
  postCompactResyncPending: boolean;
  COMPACTION_GRACE_MS: number;
  ERROR_RETRY_LADDER_MS: readonly number[];
  loopRearmSince: number;
  loopRearmMilestone: number;
  heartbeatStaleStreak: number;
  iterationCounter: number;
  toolCallsThisTurn: number;
  consecutiveErrorIterations: number;
  consecutiveAbortIterations: number;
  abortedStandDown: boolean;
}

type UntypedRuntimeNames = Exclude<GoalRuntimeGlobalName, keyof GoalRuntimeDataTypes>;
export type GoalRuntimeGlobals = GoalRuntimeDataTypes & {
  [Name in UntypedRuntimeNames]: GoalRuntimeFunction;
};

// This fails at compile time if a future data field is added to the typed
// interface without entering the registry. Function slots are the remainder
// of the same registry, so every ambient global is covered exactly once.
type RuntimeDataCoverage = Exclude<keyof GoalRuntimeDataTypes, GoalRuntimeGlobalName> extends never ? true : never;
const RUNTIME_DATA_COVERAGE: RuntimeDataCoverage = true;
void RUNTIME_DATA_COVERAGE;

export type GoalRuntimeDescriptor<Name extends GoalRuntimeGlobalName> = Omit<PropertyDescriptor, "get" | "set"> & {
  get?: () => GoalRuntimeGlobals[Name];
  set?: (value: GoalRuntimeGlobals[Name]) => void;
};

// Audit 2026-09-06: overwrite detection. Last-write-wins stays the
// semantics (a module re-execution must replace stale closures), but every
// registration is counted on a globalThis-held map so a copy-paste double
// registration is observable — the contract test asserts single
// registration per process. The map lives on globalThis (not module
// state) so even a full module re-execution cannot reset the evidence.
const REGISTRATION_COUNTS_KEY = "__gllaRuntimeGlobalRegistrationCounts";
function registrationCounts(): Map<string, number> {
  const holder = globalThis as Record<string, unknown>;
  let counts = holder[REGISTRATION_COUNTS_KEY] as Map<string, number> | undefined;
  if (!counts) {
    counts = new Map<string, number>();
    holder[REGISTRATION_COUNTS_KEY] = counts;
  }
  return counts;
}

export function defineGoalRuntimeGlobal<Name extends GoalRuntimeGlobalName>(
  name: Name,
  descriptor: GoalRuntimeDescriptor<Name>,
): void {
  const counts = registrationCounts();
  counts.set(name, (counts.get(name) ?? 0) + 1);
  Object.defineProperty(globalThis, name, { configurable: true, ...descriptor });
}

/** Test-only: how many times each runtime global was registered this process. */
export function goalRuntimeGlobalRegistrationCounts(): ReadonlyMap<string, number> {
  return registrationCounts();
}

declare global {
  var GOAL_EVENT_ENTRY: GoalRuntimeGlobals["GOAL_EVENT_ENTRY"];
  var extensionApi: GoalRuntimeGlobals["extensionApi"];
  var extensionApiStale: GoalRuntimeGlobals["extensionApiStale"];
  var staleTerminalDone: GoalRuntimeGlobals["staleTerminalDone"];
  var sessionGeneration: GoalRuntimeGlobals["sessionGeneration"];
  var sessionManagerId: GoalRuntimeGlobals["sessionManagerId"];
  var sessionIdOf: GoalRuntimeGlobals["sessionIdOf"];
  var classifyIdInvalidationReason: GoalRuntimeGlobals["classifyIdInvalidationReason"];
  var sameSessionIdentity: GoalRuntimeGlobals["sameSessionIdentity"];
  var SESSION_REBIND_GRACE_MS: GoalRuntimeGlobals["SESSION_REBIND_GRACE_MS"];
  var sessionReplacementUntil: GoalRuntimeGlobals["sessionReplacementUntil"];
  var instanceId: GoalRuntimeGlobals["instanceId"];
  var zombieStoodDown: GoalRuntimeGlobals["zombieStoodDown"];
  var writeOwnerFile: GoalRuntimeGlobals["writeOwnerFile"];
  var readOwnerFile: GoalRuntimeGlobals["readOwnerFile"];
  var claimProcessOwner: GoalRuntimeGlobals["claimProcessOwner"];
  var processOwnerDeniedCwd: GoalRuntimeGlobals["processOwnerDeniedCwd"];
  var absorbStaleIfSuperseded: GoalRuntimeGlobals["absorbStaleIfSuperseded"];
  var goStaleTerminal: GoalRuntimeGlobals["goStaleTerminal"];
  var consumeStaleContinuationRearm: GoalRuntimeGlobals["consumeStaleContinuationRearm"];
  var sessionHandoffPath: GoalRuntimeGlobals["sessionHandoffPath"];
  var writeSessionHandoff: GoalRuntimeGlobals["writeSessionHandoff"];
  var consumeSessionHandoff: GoalRuntimeGlobals["consumeSessionHandoff"];
  var queuePendingListOperation: GoalRuntimeGlobals["queuePendingListOperation"];
  var consumePendingListOperations: GoalRuntimeGlobals["consumePendingListOperations"];
  var discardPendingListOperations: GoalRuntimeGlobals["discardPendingListOperations"];
  var markSessionOwnerShutdown: GoalRuntimeGlobals["markSessionOwnerShutdown"];
  var claimSessionOwnerAndDetectRebind: GoalRuntimeGlobals["claimSessionOwnerAndDetectRebind"];
  var emitIdInvalidation: GoalRuntimeGlobals["emitIdInvalidation"];
  var probeExtensionApiStaleRaw: GoalRuntimeGlobals["probeExtensionApiStaleRaw"];
  var probeExtensionApiStale: GoalRuntimeGlobals["probeExtensionApiStale"];
  var safeSteerUser: GoalRuntimeGlobals["safeSteerUser"];
  var warnIfStaleAtEntry: GoalRuntimeGlobals["warnIfStaleAtEntry"];
  var confirmDraft: GoalRuntimeGlobals["confirmDraft"];
  var resolveCarryover: GoalRuntimeGlobals["resolveCarryover"];
  var lastCtx: GoalRuntimeGlobals["lastCtx"];
  var sessionHandoffPending: GoalRuntimeGlobals["sessionHandoffPending"];
  var initialSessionLoadPending: GoalRuntimeGlobals["initialSessionLoadPending"];
  var sessionTimeouts: GoalRuntimeGlobals["sessionTimeouts"];
  var ownerSession: GoalRuntimeGlobals["ownerSession"];
  var ownerCwd: GoalRuntimeGlobals["ownerCwd"];
  var deadOwnerSession: GoalRuntimeGlobals["deadOwnerSession"];
  var deadOwnerCwd: GoalRuntimeGlobals["deadOwnerCwd"];
  var isBlankInitialStartup: GoalRuntimeGlobals["isBlankInitialStartup"];
  var releaseInitialSessionLoadBarrier: GoalRuntimeGlobals["releaseInitialSessionLoadBarrier"];
  var isWorkerSessionCtx: GoalRuntimeGlobals["isWorkerSessionCtx"];
  var isHostSuccessorCtx: GoalRuntimeGlobals["isHostSuccessorCtx"];
  var isHostSuccessorContact: GoalRuntimeGlobals["isHostSuccessorContact"];
  var tryAbsorbHostSuccessor: GoalRuntimeGlobals["tryAbsorbHostSuccessor"];
  var selfHealStaleSameSession: GoalRuntimeGlobals["selfHealStaleSameSession"];
  var rememberCtx: GoalRuntimeGlobals["rememberCtx"];
  var isForeignCtx: GoalRuntimeGlobals["isForeignCtx"];
  var isHostLifecycleSessionStart: GoalRuntimeGlobals["isHostLifecycleSessionStart"];
  var foreignToolGuard: GoalRuntimeGlobals["foreignToolGuard"];
  var mainModelRecoveryTimer: GoalRuntimeGlobals["mainModelRecoveryTimer"];
  var mainModelSwitchInFlight: GoalRuntimeGlobals["mainModelSwitchInFlight"];
  var mainModelAbortForRecovery: GoalRuntimeGlobals["mainModelAbortForRecovery"];
  var hourlyProbeTimer: GoalRuntimeGlobals["hourlyProbeTimer"];
  var hourlyProbeFireAt: GoalRuntimeGlobals["hourlyProbeFireAt"];
  var lastMainModelFailure: GoalRuntimeGlobals["lastMainModelFailure"];
  var draftingTarget: GoalRuntimeGlobals["draftingTarget"];
  var draftingUserReplies: GoalRuntimeGlobals["draftingUserReplies"];
  var draftingBlockedProposals: GoalRuntimeGlobals["draftingBlockedProposals"];
  var draftingSeedInFlight: GoalRuntimeGlobals["draftingSeedInFlight"];
  var restoreDrafterModel: GoalRuntimeGlobals["restoreDrafterModel"];
  var handleDrafterModelFailure: GoalRuntimeGlobals["handleDrafterModelFailure"];
  var clearDraftingState: GoalRuntimeGlobals["clearDraftingState"];
  var DRAFT_SESSION_INTERRUPTED_MESSAGE: GoalRuntimeGlobals["DRAFT_SESSION_INTERRUPTED_MESSAGE"];
  var countedTokenMessages: GoalRuntimeGlobals["countedTokenMessages"];
  var countedLoopTokenMessages: GoalRuntimeGlobals["countedLoopTokenMessages"];
  var lastActivityAt: GoalRuntimeGlobals["lastActivityAt"];
  var lastStreamActivityAt: GoalRuntimeGlobals["lastStreamActivityAt"];
  var streamActivityObserved: GoalRuntimeGlobals["streamActivityObserved"];
  var heartbeatNudges: GoalRuntimeGlobals["heartbeatNudges"];
  var postRestoreGraceTurns: GoalRuntimeGlobals["postRestoreGraceTurns"];
  var consecutiveStalls: GoalRuntimeGlobals["consecutiveStalls"];
  var carryoverSnapshot: GoalRuntimeGlobals["carryoverSnapshot"];
  var carryoverResolved: GoalRuntimeGlobals["carryoverResolved"];
  var completionAuditInFlight: GoalRuntimeGlobals["completionAuditInFlight"];
  var completionAuditGeneration: GoalRuntimeGlobals["completionAuditGeneration"];
  var completionAuditRecoveryArmed: GoalRuntimeGlobals["completionAuditRecoveryArmed"];
  var heartbeatTimer: GoalRuntimeGlobals["heartbeatTimer"];
  var CONTINUATION_UNANSWERED_MS: GoalRuntimeGlobals["CONTINUATION_UNANSWERED_MS"];
  var CONTINUATION_UNANSWERED_THROTTLE_MS: GoalRuntimeGlobals["CONTINUATION_UNANSWERED_THROTTLE_MS"];
  var EAGER_CONTINUATION_SETTLE_MS: GoalRuntimeGlobals["EAGER_CONTINUATION_SETTLE_MS"];
  var LIST_COMPLETION_SETTLE_MS: GoalRuntimeGlobals["LIST_COMPLETION_SETTLE_MS"];
  var postCompletionSettleUntil: GoalRuntimeGlobals["postCompletionSettleUntil"];
  var LOOP_MAX_CONSECUTIVE_ERRORS: GoalRuntimeGlobals["LOOP_MAX_CONSECUTIVE_ERRORS"];
  var LOOP_MAX_CONSECUTIVE_ABORTS: GoalRuntimeGlobals["LOOP_MAX_CONSECUTIVE_ABORTS"];
  var lastRealActivityAt: GoalRuntimeGlobals["lastRealActivityAt"];
  var noteActivity: GoalRuntimeGlobals["noteActivity"];
  var isSupervising: GoalRuntimeGlobals["isSupervising"];
  var latestAuditProgress: GoalRuntimeGlobals["latestAuditProgress"];
  var uiTicker: GoalRuntimeGlobals["uiTicker"];
  var ownsDetachedAudit: GoalRuntimeGlobals["ownsDetachedAudit"];
  var detachedAuditContext: GoalRuntimeGlobals["detachedAuditContext"];
  var publishDetachedAuditProgress: GoalRuntimeGlobals["publishDetachedAuditProgress"];
  var clearDetachedAuditProgress: GoalRuntimeGlobals["clearDetachedAuditProgress"];
  var inFlightToolCalls: GoalRuntimeGlobals["inFlightToolCalls"];
  var noteToolCall: GoalRuntimeGlobals["noteToolCall"];
  var noteToolResult: GoalRuntimeGlobals["noteToolResult"];
  var clearToolActivityState: GoalRuntimeGlobals["clearToolActivityState"];
  var refreshUI: GoalRuntimeGlobals["refreshUI"];
  var scheduleUIRefresh: GoalRuntimeGlobals["scheduleUIRefresh"];
  var startUITicker: GoalRuntimeGlobals["startUITicker"];
  var loopRearmStreak: GoalRuntimeGlobals["loopRearmStreak"];
  var compactionGraceUntil: GoalRuntimeGlobals["compactionGraceUntil"];
  var compactionInFlightSince: GoalRuntimeGlobals["compactionInFlightSince"];
  var noteCompactionStarted: GoalRuntimeGlobals["noteCompactionStarted"];
  var noteCompactionSettled: GoalRuntimeGlobals["noteCompactionSettled"];
  var lastCompactionAt: GoalRuntimeGlobals["lastCompactionAt"];
  var contextStarvedStreak: GoalRuntimeGlobals["contextStarvedStreak"];
  var lastContextStarvedAt: GoalRuntimeGlobals["lastContextStarvedAt"];
  var noteContextStarvedYield: GoalRuntimeGlobals["noteContextStarvedYield"];
  var noteContextPercent: GoalRuntimeGlobals["noteContextPercent"];
  var shouldCompactFirstNudge: GoalRuntimeGlobals["shouldCompactFirstNudge"];
  var buildStarvationLadderMessage: GoalRuntimeGlobals["buildStarvationLadderMessage"];
  var onCompactionLanded: GoalRuntimeGlobals["onCompactionLanded"];
  var isContextStarvedRefused: GoalRuntimeGlobals["isContextStarvedRefused"];
  var postCompactResumeOwed: GoalRuntimeGlobals["postCompactResumeOwed"];
  var postCompactResyncPending: GoalRuntimeGlobals["postCompactResyncPending"];
  var COMPACTION_GRACE_MS: GoalRuntimeGlobals["COMPACTION_GRACE_MS"];
  var ERROR_RETRY_LADDER_MS: GoalRuntimeGlobals["ERROR_RETRY_LADDER_MS"];
  var loopRearmSince: GoalRuntimeGlobals["loopRearmSince"];
  var loopRearmMilestone: GoalRuntimeGlobals["loopRearmMilestone"];
  var escalateStallNow: GoalRuntimeGlobals["escalateStallNow"];
  var heartbeatStaleStreak: GoalRuntimeGlobals["heartbeatStaleStreak"];
  var iterationCounter: GoalRuntimeGlobals["iterationCounter"];
  var toolCallsThisTurn: GoalRuntimeGlobals["toolCallsThisTurn"];
  var consecutiveErrorIterations: GoalRuntimeGlobals["consecutiveErrorIterations"];
  var consecutiveAbortIterations: GoalRuntimeGlobals["consecutiveAbortIterations"];
  var abortedStandDown: GoalRuntimeGlobals["abortedStandDown"];
  var scheduleSessionTimeout: GoalRuntimeGlobals["scheduleSessionTimeout"];
  var clearSessionOwnedTimers: GoalRuntimeGlobals["clearSessionOwnedTimers"];
  var isActionableGoal: GoalRuntimeGlobals["isActionableGoal"];
  var freshCtx: GoalRuntimeGlobals["freshCtx"];
  var freshCtxForGeneration: GoalRuntimeGlobals["freshCtxForGeneration"];
  var scheduleProviderRetryForSession: GoalRuntimeGlobals["scheduleProviderRetryForSession"];
  var handleMainModelAgentEnd: GoalRuntimeGlobals["handleMainModelAgentEnd"];
  var createGoal: GoalRuntimeGlobals["createGoal"];
  var persistState: GoalRuntimeGlobals["persistState"];
  var shortObj: GoalRuntimeGlobals["shortObj"];
  var displaySlice: GoalRuntimeGlobals["displaySlice"];
  var goalNoun: GoalRuntimeGlobals["goalNoun"];
  var activeGoalCommand: GoalRuntimeGlobals["activeGoalCommand"];
  var activeGoalRoot: GoalRuntimeGlobals["activeGoalRoot"];
  var activeGoalSurfaceCommand: GoalRuntimeGlobals["activeGoalSurfaceCommand"];
  var activeGoalStatusCommand: GoalRuntimeGlobals["activeGoalStatusCommand"];
  var recoverySurfaceCommand: GoalRuntimeGlobals["recoverySurfaceCommand"];
  var notifyPersistenceState: GoalRuntimeGlobals["notifyPersistenceState"];
  var setGoal: GoalRuntimeGlobals["setGoal"];
  var updateGoal: GoalRuntimeGlobals["updateGoal"];
  var autoArbitrateStackedState: GoalRuntimeGlobals["autoArbitrateStackedState"];
  var fanOutListAuditFindings: GoalRuntimeGlobals["fanOutListAuditFindings"];
  var archiveCurrentGoal: GoalRuntimeGlobals["archiveCurrentGoal"];
  var terminalizeImpossibleGoal: GoalRuntimeGlobals["terminalizeImpossibleGoal"];
  var clearDetachedAuditRuntime: GoalRuntimeGlobals["clearDetachedAuditRuntime"];
  var validateCompletionSummary: GoalRuntimeGlobals["validateCompletionSummary"];
  var beginCompletionAudit: GoalRuntimeGlobals["beginCompletionAudit"];
  var isAuditorNoVerdictInfrastructureError: GoalRuntimeGlobals["isAuditorNoVerdictInfrastructureError"];
  var fmtRetryDelay: GoalRuntimeGlobals["fmtRetryDelay"];
  var auditorRetryPlan: GoalRuntimeGlobals["auditorRetryPlan"];
  var auditorCandidateLabel: GoalRuntimeGlobals["auditorCandidateLabel"];
  var runDetachedCompletionWithFallback: GoalRuntimeGlobals["runDetachedCompletionWithFallback"];
  var retryStoredCompletionAudit: GoalRuntimeGlobals["retryStoredCompletionAudit"];
  var maybeAutoRetryParkedCompletionAudit: GoalRuntimeGlobals["maybeAutoRetryParkedCompletionAudit"];
  var scheduleParkedCompletionAuditRecovery: GoalRuntimeGlobals["scheduleParkedCompletionAuditRecovery"];
  var fireReviewer: GoalRuntimeGlobals["fireReviewer"];
  var listQueue: GoalRuntimeGlobals["listQueue"];
  var groupOpenChildren: GoalRuntimeGlobals["groupOpenChildren"];
  var activateNextListItem: GoalRuntimeGlobals["activateNextListItem"];
  var queueRepairAheadOfListItem: GoalRuntimeGlobals["queueRepairAheadOfListItem"];
  var startDrafting: GoalRuntimeGlobals["startDrafting"];
  var healGoalPolicy: GoalRuntimeGlobals["healGoalPolicy"];
  var notifyExternal: GoalRuntimeGlobals["notifyExternal"];
  var staleToolResult: GoalRuntimeGlobals["staleToolResult"];
  var currentToolContext: GoalRuntimeGlobals["currentToolContext"];
  var registerAgentTools: GoalRuntimeGlobals["registerAgentTools"];
  var resolveAuditorModel: GoalRuntimeGlobals["resolveAuditorModel"];
  var openSettingsUI: GoalRuntimeGlobals["openSettingsUI"];
  var handleSettingChoice: GoalRuntimeGlobals["handleSettingChoice"];
  var observeModelChange: GoalRuntimeGlobals["observeModelChange"];
  var observeTurnBoundaryModel: GoalRuntimeGlobals["observeTurnBoundaryModel"];
}

export {};
