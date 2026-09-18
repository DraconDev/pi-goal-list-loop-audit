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
  "classifySessionHandleInvalidation",
  "sameSessionIdentity",
  "SESSION_REBIND_GRACE_MS",
  "sessionReplacementUntil",
  "instanceStartedAt",
  "instanceId",
  "zombieStoodDown",
  "ownerFilePath",
  "writeOwnerFile",
  "readOwnerFile",
  "claimProcessOwner",
  "processOwnerDeniedCwd",
  "absorbStaleIfSuperseded",
  "goStaleTerminal",
  "consumeStaleContinuationRearm",
  "SESSION_HANDOFF_FILE",
  "SESSION_HANDOFF_VERSION",
  "SESSION_HANDOFF_FRESH_MS",
  "sessionHandoffPath",
  "writeSessionHandoff",
  "consumeSessionHandoff",
  "queuePendingListOperation",
  "consumePendingListOperations",
  "discardPendingListOperations",
  "SESSION_OWNER_FILE",
  "markSessionOwnerShutdown",
  "claimSessionOwnerAndDetectRebind",
  "emitIdInvalidation",
  "__testOnlyResetStaleFlag",
  "__testOnlyLastConfirmDialog",
  "__testOnlyResetTerminalFlags",
  "__testOnlySetLastModelRef",
  "__testOnlySetSessionReplacementUntil",
  "__testOnlyResetOwnerSession",
  "__testOnlyRunFanOutListAuditFindings",
  "probeExtensionApiStaleRaw",
  "probeExtensionApiStale",
  "safeSteerUser",
  "warnIfStaleAtEntry",
  "lastConfirmDialog",
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
  "sessionHasConversation",
  "isBlankInitialStartup",
  "releaseInitialSessionLoadBarrier",
  "ownerProbeLive",
  "isWorkerSessionCtx",
  "isHostSuccessorCtx",
  "isHostSuccessorContact",
  "tryAbsorbHostSuccessor",
  "selfHealStaleSameSession",
  "rememberCtx",
  "isForeignCtx",
  "isHostLifecycleSessionStart",
  "FOREIGN_SESSION_TOOL_MESSAGE",
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
  "LIVE_STREAM_PROOF_MS",
  "ownsDetachedAudit",
  "detachedAuditContext",
  "publishDetachedAuditProgress",
  "clearDetachedAuditProgress",
  "recentActions",
  "inFlightToolCalls",
  "summarizeToolArg",
  "noteToolCall",
  "noteToolResult",
  "clearToolActivityState",
  "displayActivityFor",
  "refreshUI",
  "scheduleUIRefresh",
  "startUITicker",
  "loopRearmStreak",
  "compactionGraceUntil",
  "compactionInFlightSince",
  "noteCompactionStarted",
  "noteCompactionSettled",
  "lastCompactionAt",
  "CONTEXT_STARVATION_REFUSE_THRESHOLD",
  "CONTEXT_STARVATION_RECENT_WINDOW_MS",
  "contextStarvedStreak",
  "lastContextStarvedAt",
  "noteContextStarvedYield",
  "noteContextPercent",
  "shouldCompactFirstNudge",
  "buildStarvationLadderMessage",
  "COMPACT_FIRST_NUDGE_PERCENT",
  "lastContextPercent",
  "clearContextStarvedStreak",
  "onCompactionLanded",
  "isContextStarvedRefused",
  "__testOnlySetLastCompactionAt",
  "__testOnlyLoadState",
  "__testOnlyRegisterAgentTools",
  "__testOnlyRememberCtx",
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
  "persistenceDegradedNotified",
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
  "newCompletionAuditAttemptId",
  "validateCompletionSummary",
  "beginCompletionAudit",
  "isAuditorTimeoutError",
  "isAuditorNoVerdictInfrastructureError",
  "EAGER_AUDITOR_RETRY_SEC",
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
  "auditorThinkingLevels",
  "resolveAuditorModel",
  "openSettingsUI",
  "promptSettingsMenu",
  "promptModelRef",
  "promptModelRefs",
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
  instanceStartedAt: number;
  instanceId: string;
  zombieStoodDown: boolean;
  processOwnerDeniedCwd: string | null;
  SESSION_HANDOFF_FILE: string;
  SESSION_HANDOFF_VERSION: number;
  SESSION_HANDOFF_FRESH_MS: number;
  SESSION_OWNER_FILE: string;
  lastConfirmDialog: { title: string; body: string; options: string[] } | null;
  lastCtx: ExtensionContext | null;
  sessionHandoffPending: boolean;
  initialSessionLoadPending: boolean;
  sessionTimeouts: Set<NodeJS.Timeout>;
  ownerSession: unknown;
  ownerCwd: string | null;
  deadOwnerSession: unknown;
  deadOwnerCwd: string | null;
  FOREIGN_SESSION_TOOL_MESSAGE: string;
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
  LIVE_STREAM_PROOF_MS: number;
  recentActions: RecentActionDisplay[];
  inFlightToolCalls: Map<string, { name: string; arg?: string; at: number }>;
  loopRearmStreak: number;
  compactionGraceUntil: number;
  compactionInFlightSince: number | null;
  noteCompactionStarted: () => boolean;
  noteCompactionSettled: () => void;
  lastCompactionAt: number;
  CONTEXT_STARVATION_REFUSE_THRESHOLD: number;
  CONTEXT_STARVATION_RECENT_WINDOW_MS: number;
  contextStarvedStreak: number;
  lastContextStarvedAt: number;
  noteContextPercent: (pct: number | null | undefined) => void;
  shouldCompactFirstNudge: (percent: number | null | undefined) => boolean;
  buildStarvationLadderMessage: (input?: { percent?: number | null; streak?: number; recentCompact?: boolean }) => string;
  COMPACT_FIRST_NUDGE_PERCENT: number;
  lastContextPercent: number | null;
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
  persistenceDegradedNotified: boolean;
  EAGER_AUDITOR_RETRY_SEC: number;
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
  var classifySessionHandleInvalidation: GoalRuntimeGlobals["classifySessionHandleInvalidation"];
  var sameSessionIdentity: GoalRuntimeGlobals["sameSessionIdentity"];
  var SESSION_REBIND_GRACE_MS: GoalRuntimeGlobals["SESSION_REBIND_GRACE_MS"];
  var sessionReplacementUntil: GoalRuntimeGlobals["sessionReplacementUntil"];
  var instanceStartedAt: GoalRuntimeGlobals["instanceStartedAt"];
  var instanceId: GoalRuntimeGlobals["instanceId"];
  var zombieStoodDown: GoalRuntimeGlobals["zombieStoodDown"];
  var ownerFilePath: GoalRuntimeGlobals["ownerFilePath"];
  var writeOwnerFile: GoalRuntimeGlobals["writeOwnerFile"];
  var readOwnerFile: GoalRuntimeGlobals["readOwnerFile"];
  var claimProcessOwner: GoalRuntimeGlobals["claimProcessOwner"];
  var processOwnerDeniedCwd: GoalRuntimeGlobals["processOwnerDeniedCwd"];
  var absorbStaleIfSuperseded: GoalRuntimeGlobals["absorbStaleIfSuperseded"];
  var goStaleTerminal: GoalRuntimeGlobals["goStaleTerminal"];
  var consumeStaleContinuationRearm: GoalRuntimeGlobals["consumeStaleContinuationRearm"];
  var SESSION_HANDOFF_FILE: GoalRuntimeGlobals["SESSION_HANDOFF_FILE"];
  var SESSION_HANDOFF_VERSION: GoalRuntimeGlobals["SESSION_HANDOFF_VERSION"];
  var SESSION_HANDOFF_FRESH_MS: GoalRuntimeGlobals["SESSION_HANDOFF_FRESH_MS"];
  var sessionHandoffPath: GoalRuntimeGlobals["sessionHandoffPath"];
  var writeSessionHandoff: GoalRuntimeGlobals["writeSessionHandoff"];
  var consumeSessionHandoff: GoalRuntimeGlobals["consumeSessionHandoff"];
  var queuePendingListOperation: GoalRuntimeGlobals["queuePendingListOperation"];
  var consumePendingListOperations: GoalRuntimeGlobals["consumePendingListOperations"];
  var discardPendingListOperations: GoalRuntimeGlobals["discardPendingListOperations"];
  var SESSION_OWNER_FILE: GoalRuntimeGlobals["SESSION_OWNER_FILE"];
  var markSessionOwnerShutdown: GoalRuntimeGlobals["markSessionOwnerShutdown"];
  var claimSessionOwnerAndDetectRebind: GoalRuntimeGlobals["claimSessionOwnerAndDetectRebind"];
  var emitIdInvalidation: GoalRuntimeGlobals["emitIdInvalidation"];
  var __testOnlyResetStaleFlag: GoalRuntimeGlobals["__testOnlyResetStaleFlag"];
  var __testOnlyLastConfirmDialog: GoalRuntimeGlobals["__testOnlyLastConfirmDialog"];
  var __testOnlyResetTerminalFlags: GoalRuntimeGlobals["__testOnlyResetTerminalFlags"];
  var __testOnlySetLastModelRef: GoalRuntimeGlobals["__testOnlySetLastModelRef"];
  var __testOnlySetSessionReplacementUntil: GoalRuntimeGlobals["__testOnlySetSessionReplacementUntil"];
  var __testOnlyResetOwnerSession: GoalRuntimeGlobals["__testOnlyResetOwnerSession"];
  var __testOnlyRunFanOutListAuditFindings: GoalRuntimeGlobals["__testOnlyRunFanOutListAuditFindings"];
  var probeExtensionApiStaleRaw: GoalRuntimeGlobals["probeExtensionApiStaleRaw"];
  var probeExtensionApiStale: GoalRuntimeGlobals["probeExtensionApiStale"];
  var safeSteerUser: GoalRuntimeGlobals["safeSteerUser"];
  var warnIfStaleAtEntry: GoalRuntimeGlobals["warnIfStaleAtEntry"];
  var lastConfirmDialog: GoalRuntimeGlobals["lastConfirmDialog"];
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
  var sessionHasConversation: GoalRuntimeGlobals["sessionHasConversation"];
  var isBlankInitialStartup: GoalRuntimeGlobals["isBlankInitialStartup"];
  var releaseInitialSessionLoadBarrier: GoalRuntimeGlobals["releaseInitialSessionLoadBarrier"];
  var ownerProbeLive: GoalRuntimeGlobals["ownerProbeLive"];
  var isWorkerSessionCtx: GoalRuntimeGlobals["isWorkerSessionCtx"];
  var isHostSuccessorCtx: GoalRuntimeGlobals["isHostSuccessorCtx"];
  var isHostSuccessorContact: GoalRuntimeGlobals["isHostSuccessorContact"];
  var tryAbsorbHostSuccessor: GoalRuntimeGlobals["tryAbsorbHostSuccessor"];
  var selfHealStaleSameSession: GoalRuntimeGlobals["selfHealStaleSameSession"];
  var rememberCtx: GoalRuntimeGlobals["rememberCtx"];
  var isForeignCtx: GoalRuntimeGlobals["isForeignCtx"];
  var isHostLifecycleSessionStart: GoalRuntimeGlobals["isHostLifecycleSessionStart"];
  var FOREIGN_SESSION_TOOL_MESSAGE: GoalRuntimeGlobals["FOREIGN_SESSION_TOOL_MESSAGE"];
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
  var LIVE_STREAM_PROOF_MS: GoalRuntimeGlobals["LIVE_STREAM_PROOF_MS"];
  var ownsDetachedAudit: GoalRuntimeGlobals["ownsDetachedAudit"];
  var detachedAuditContext: GoalRuntimeGlobals["detachedAuditContext"];
  var publishDetachedAuditProgress: GoalRuntimeGlobals["publishDetachedAuditProgress"];
  var clearDetachedAuditProgress: GoalRuntimeGlobals["clearDetachedAuditProgress"];
  var recentActions: GoalRuntimeGlobals["recentActions"];
  var inFlightToolCalls: GoalRuntimeGlobals["inFlightToolCalls"];
  var summarizeToolArg: GoalRuntimeGlobals["summarizeToolArg"];
  var noteToolCall: GoalRuntimeGlobals["noteToolCall"];
  var noteToolResult: GoalRuntimeGlobals["noteToolResult"];
  var clearToolActivityState: GoalRuntimeGlobals["clearToolActivityState"];
  var displayActivityFor: GoalRuntimeGlobals["displayActivityFor"];
  var refreshUI: GoalRuntimeGlobals["refreshUI"];
  var scheduleUIRefresh: GoalRuntimeGlobals["scheduleUIRefresh"];
  var startUITicker: GoalRuntimeGlobals["startUITicker"];
  var loopRearmStreak: GoalRuntimeGlobals["loopRearmStreak"];
  var compactionGraceUntil: GoalRuntimeGlobals["compactionGraceUntil"];
  var compactionInFlightSince: GoalRuntimeGlobals["compactionInFlightSince"];
  var noteCompactionStarted: GoalRuntimeGlobals["noteCompactionStarted"];
  var noteCompactionSettled: GoalRuntimeGlobals["noteCompactionSettled"];
  var lastCompactionAt: GoalRuntimeGlobals["lastCompactionAt"];
  var CONTEXT_STARVATION_REFUSE_THRESHOLD: GoalRuntimeGlobals["CONTEXT_STARVATION_REFUSE_THRESHOLD"];
  var CONTEXT_STARVATION_RECENT_WINDOW_MS: GoalRuntimeGlobals["CONTEXT_STARVATION_RECENT_WINDOW_MS"];
  var contextStarvedStreak: GoalRuntimeGlobals["contextStarvedStreak"];
  var lastContextStarvedAt: GoalRuntimeGlobals["lastContextStarvedAt"];
  var noteContextStarvedYield: GoalRuntimeGlobals["noteContextStarvedYield"];
  var noteContextPercent: GoalRuntimeGlobals["noteContextPercent"];
  var shouldCompactFirstNudge: GoalRuntimeGlobals["shouldCompactFirstNudge"];
  var buildStarvationLadderMessage: GoalRuntimeGlobals["buildStarvationLadderMessage"];
  var COMPACT_FIRST_NUDGE_PERCENT: GoalRuntimeGlobals["COMPACT_FIRST_NUDGE_PERCENT"];
  var lastContextPercent: GoalRuntimeGlobals["lastContextPercent"];
  var clearContextStarvedStreak: GoalRuntimeGlobals["clearContextStarvedStreak"];
  var onCompactionLanded: GoalRuntimeGlobals["onCompactionLanded"];
  var isContextStarvedRefused: GoalRuntimeGlobals["isContextStarvedRefused"];
  var __testOnlySetLastCompactionAt: GoalRuntimeGlobals["__testOnlySetLastCompactionAt"];
  var __testOnlyLoadState: GoalRuntimeGlobals["__testOnlyLoadState"];
  var __testOnlyRegisterAgentTools: GoalRuntimeGlobals["__testOnlyRegisterAgentTools"];
  var __testOnlyRememberCtx: GoalRuntimeGlobals["__testOnlyRememberCtx"];
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
  var persistenceDegradedNotified: GoalRuntimeGlobals["persistenceDegradedNotified"];
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
  var newCompletionAuditAttemptId: GoalRuntimeGlobals["newCompletionAuditAttemptId"];
  var validateCompletionSummary: GoalRuntimeGlobals["validateCompletionSummary"];
  var beginCompletionAudit: GoalRuntimeGlobals["beginCompletionAudit"];
  var isAuditorTimeoutError: GoalRuntimeGlobals["isAuditorTimeoutError"];
  var isAuditorNoVerdictInfrastructureError: GoalRuntimeGlobals["isAuditorNoVerdictInfrastructureError"];
  var EAGER_AUDITOR_RETRY_SEC: GoalRuntimeGlobals["EAGER_AUDITOR_RETRY_SEC"];
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
  var auditorThinkingLevels: GoalRuntimeGlobals["auditorThinkingLevels"];
  var resolveAuditorModel: GoalRuntimeGlobals["resolveAuditorModel"];
  var openSettingsUI: GoalRuntimeGlobals["openSettingsUI"];
  var promptSettingsMenu: GoalRuntimeGlobals["promptSettingsMenu"];
  var promptModelRef: GoalRuntimeGlobals["promptModelRef"];
  var promptModelRefs: GoalRuntimeGlobals["promptModelRefs"];
  var handleSettingChoice: GoalRuntimeGlobals["handleSettingChoice"];
  var observeModelChange: GoalRuntimeGlobals["observeModelChange"];
  var observeTurnBoundaryModel: GoalRuntimeGlobals["observeTurnBoundaryModel"];
}

export {};
