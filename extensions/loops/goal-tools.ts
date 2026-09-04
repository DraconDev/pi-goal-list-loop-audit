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
  assignQueueOrder,
  visibleListPosition,
  visibleListPositions,
  providerErrorPresentation,
  sanitizeProviderAuditReport,
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
  computeListDepth,
  formatAuditLog,
  formatGoalAuditHistory,
  readAuditLog,
  bumpGoalRevision,
  captureGoalRevision,
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
  deleteQueueItemFileResult,
  missingGllaTools,
  claimedMissingGllaTool,
  PI_TOOL_NOT_FOUND_QUOTE,
  runPersistStep,
  isPersistenceDegraded,
  lastPersistenceFailure,
  modelSwitch,
  isForbiddenModel,
isGoalRevisionCurrent,
  appendAuditVerdict,
  nextHourlyPromptMs,
  nextHourlyProbeMs,
  type ModelSwitchRecord,
  type ListItem,
  type DurableDeferRecommendationInput,
  type DurableChoice,
  type DurableChoiceRecord,
  buildDurableChoiceRecord,
  normalizeDurableDeferRecommendationInput,
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
  auditorCandidateRefs,
  auditorResultFailureClass,
  isAuditorCursorPersistenceFailure,
  normalizeAuditorInfrastructureResult,
  cancelDetachedGoalCompletionAuditor,
  escalatedAuditorTimeout,
  newDetachedAuditJobAttemptId,
  runDetachedGoalCompletionAuditor,
  DEFAULT_AUDITOR_STALL_MS,
  DEFAULT_AUDITOR_TOOL_TIMEOUT_MS,
  type AuditorFallbackAttemptInfo,
  type AuditorFallbackExhaustionInfo,
  type AuditorProgress,
} from "../goal-loop-auditor-process.js";
import {
  extractMechanicalCheckCommands,
  runMechanicalPreAuditChecks,
} from "../goal-loop-shield.js";
import {
  REPETITION,
  isActuallyStuck,
  loopInterventionDirective,
  continueVariant,
  textFingerprint,
  pushCapped as pushRepetitionCapped,
} from "../goal-loop-repetition.js";
import { buildStatusText, buildWidgetLines, type AuditDisplayProgress } from "../goal-loop-display.js";
import { buildApprovalChatLines, compactCompletionSummary, compactTerminalCompletionSummary, resolveCompletionSummary, terminalHumanBrief, withoutStaleNext } from "../completion-summary.js";
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
  isRefinableStoppedLoopReason,
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
  hydrateListQueueFromDisk,
  cmdGoal,
  cmdList,
  cmdReview,
  updateWholeObjectiveFromConflict,
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
import { chooseObjectiveConflict, liveObjectives, type ObjectiveKind } from "../goal-objective-conflict.js";
import { assessSuspiciousObjective } from "../faulty-objective-recovery.js";

type AuditorModelCandidate = any;
type PendingCompletion = any;
type DraftActivationConflictResult = "proceed" | "updated" | "cancelled";

async function resolveDraftActivationConflict(ctx: ExtensionContext, incoming: ObjectiveKind, objective: string): Promise<DraftActivationConflictResult> {
  const current = liveObjectives(state);
  if (current.length === 0) return "proceed";
  const choice = await chooseObjectiveConflict(ctx, incoming, objective, current);
  if (choice === "cancel") {
    ctx.ui.notify(`New ${incoming} objective cancelled; the current objective is unchanged.`, "info");
    return "cancelled";
  }
  if (choice === "update") {
    const one = current[0];
    let updated = false;
    if (one?.kind === "goal" && incoming === "goal" && one.status === "active") {
      updated = await updateWholeObjectiveFromConflict(ctx, objective, "goal");
    } else if (one?.kind === "list" && incoming === "list") {
      updated = await updateWholeObjectiveFromConflict(ctx, objective, "list");
    } else if (one?.kind === "loop" && incoming === "loop") {
      await cmdLoop(`refine ${objective}`, ctx);
      updated = true;
    } else {
      ctx.ui.notify("Update selected, but this cross-mode start has no safe in-place edit. No replacement was started.", "info");
    }
    return updated ? "updated" : "cancelled";
  }
  for (const item of current) {
    if (item.kind === "loop" && isLoopActive()) await cmdLoop("stop", ctx);
    else if (item.kind !== "loop" && state.goal && ["active", "paused", "auditing"].includes(state.goal.status)) {
      const replacedGoal = state.goal;
      const stopReason = `replaced by new ${incoming} objective`;
      const recap = compactTerminalCompletionSummary({
        goal: replacedGoal,
        status: "aborted",
        stopReason,
        archivePath: path.relative(ctx.cwd, archivedGoalPath(ctx.cwd, replacedGoal.id)) || archivedGoalPath(ctx.cwd, replacedGoal.id),
      });
      if (!archiveCurrentGoal(ctx, "aborted", stopReason)) return "cancelled";
      ctx.ui.notify(`Previous ${replacedGoal.policy === "list" ? "list item" : "goal"} was replaced by the new ${incoming} objective.\nRecap: ${recap}`, "info");
      notifyExternal(ctx, `${replacedGoal.policy === "list" ? "List item" : "Goal"} replaced by new ${incoming} objective: ${recap}`);
    }
  }
  return "proceed";
}

async function verifyTaskMilestone(
  ctx: ExtensionContext,
  verificationContract?: string,
  signal?: AbortSignal,
): Promise<{ failedCommand?: string; output?: string; exitCode?: number } | null> {
  if (!verificationContract?.trim()) return null;
  const result = await runMechanicalPreAuditChecks(
    ctx.cwd,
    extractMechanicalCheckCommands(verificationContract),
    undefined,
    signal,
  );
  return result.passed ? null : result;
}

/** Build the bounded recommendation facts that the production UI projects.
 * The explicit tool choice is itself the current judgment; optional fields
 * let the agent name the durable action and preserve the exact prior defer
 * alternatives instead of making refreshUI infer them from prose. */
function durableDeferFactsForGoal(
  goal: Goal,
  choice: DurableChoiceRecord,
  input: {
    durableFix?: string;
    deferRecommendations?: string[];
    durableBlocked?: boolean;
  },
): DurableDeferRecommendationInput {
  const prior = goal.durableDeferRecommendation;
  const deferRecommendations = input.deferRecommendations ?? [
    ...(prior?.deferRecommendations ?? []),
    ...(choice.choice === "deferred" ? [choice.reason] : []),
  ];
  return normalizeDurableDeferRecommendationInput({
    durableFix: input.durableFix?.trim() || prior?.durableFix?.trim() || goal.objective,
    deferRecommendations,
    // A deferred judgment is an explicit assertion that the durable action is
    // blocked for this turn; callers can still pass false when the UI is
    // recording three historical defers while recommending the safe durable
    // action now.
    durableBlocked: input.durableBlocked ?? choice.choice === "deferred",
  });
}

function registerAgentTools(pi: any): void {
  pi.registerTool(defineTool({
    name: "complete_goal",
    label: "Complete goal",
    description: "Mark the active goal as complete. Queues a detached auditor worker to verify without holding the main pi turn. Use only when the objective is genuinely satisfied.",
    parameters: Type.Object({
      // v0.34.136: completionSummary adopts the six-label recap from
      // audit/COMPLETION-SUMMARY-POLICY-2026-08-19.md (Outcome / Changed
      // / Evidence / Tests / Unresolved / Next). Every label is present
      // even when its value is `none`; the durable archive preserves all six
      // lines verbatim. Incomplete input gets a recorded-facts-only fallback
      // at terminalization; the display/widget projection does NOT fabricate
      // an auditor verdict.
      completionSummary: Type.Optional(Type.String({
        description:
          "Six-label recap — one line per label, every label required (use `none` when empty): " +
          "Outcome: <what was delivered> · Changed: <files/behavior/decision> · Evidence: <key commit/report/result> · " +
          "Tests: <bounded commands + pass/fail, or `not run — <reason>`> · Unresolved: <remaining risk, or `none`> · " +
          "Next: <one follow-up hint, or `none`>. " +
          "See audit/COMPLETION-SUMMARY-POLICY-2026-08-19.md and docs/DESIGN-long-running-supervision.md. Free-form prose is allowed but discouraged; incomplete input receives a recorded-facts-only fallback at terminalization.",
      })),
      verificationSummary: Type.Optional(Type.String({
        description:
          "Per-item evidence for the verification contract. " +
          "Stays independent of completionSummary: the detached auditor receives both fields separately " +
          "and cross-checks the verification claim against real artifacts (see audit/COMPLETION-SUMMARY-POLICY-2026-08-19.md).",
      })),
      newObjective: Type.Optional(Type.String({ description: "v0.25.0 (contract item 15): when the work has legitimately shifted, pass the new objective here — it atomically replaces the goal objective AND the audit proceeds against the NEW objective in this same call. Do not use to dodge a legitimate disapproval; the auditor sees the change." })),
    }),
    async execute(_id, params, signal, _onUpdate, execCtx) {
      const foreign0 = foreignToolGuard(execCtx);
      if (foreign0) return { content: [{ type: "text", text: foreign0 }], details: {} };
      const toolCtx = currentToolContext(execCtx);
      if (!toolCtx) return staleToolResult();
      let ctx: ExtensionContext = toolCtx;
      const auditGeneration = sessionGeneration;
      if (!state.goal) return { content: [{ type: "text", text: "No active goal." }], details: {} };
      if (state.goal.status !== "active") {
        if (state.goal.status === "paused") {
          // v0.34.87: a paused item IS a goal — the old flat "No active
          // goal." read as if the paused card in the widget were nothing at
          // all (note.md Screenshots 161659/161718: complete_goal answered
          // "No active goal" while the session clearly held a paused item).
          // Name the actual state and the resume verb: surface separation
          // between "no goal" and "goal parked".
          const isList = state.goal.policy === "list";
          const resume = activeGoalSurfaceCommand("resume");
          return { content: [{ type: "text", text: `No active goal — the ${isList ? "list item" : "goal"} is paused; ${resume} reactivates it (complete_goal only runs on an active item).` }], details: {} };
        }
        return { content: [{ type: "text", text: `No active goal — it is ${state.goal.status}.` }], details: {} };
      }
      const p = params as { completionSummary?: string; verificationSummary?: string; newObjective?: string };
      if (state.goal.repairTarget) {
        return {
          content: [{ type: "text", text: `This repair card cannot be completed yet. Redraft the original target as a confirmed task list with propose_task_list (include objective: ${state.goal.repairTarget.objective.slice(0, 180)}), then continue the real work.` }],
          details: {},
        };
      }
      // v0.25.0 (contract item 15): atomic objective update + audit in one
      // call — the objective-drift disapprove loop (ship shifted work →
      // auditor disapproves the ORIGINAL objective) ends here. Ledgered so
      // the shift is auditable.
      if (p.newObjective?.trim()) {
        const oldObjective = state.goal.objective;
        const rawNewObjective = p.newObjective.trim();
        const { objective: cleanObj, verificationContract } = extractVerificationContract(rawNewObjective);
        const priorProvenance = state.goal.objectiveProvenance;
        // v0.34.61: contract-scoped revision bump — one of exactly two
        // sites (the other: cmdTweak). persistState no longer bumps, so
        // the settle writes of THIS call keep the audited revision stable.
        state.goal = bumpGoalRevision(state.goal);
        updateGoal({
          objective: cleanObj,
          ...(verificationContract ? { verificationContract } : {}),
          objectiveProvenance: {
            originalObjective: priorProvenance?.originalObjective ?? oldObjective,
            ...(priorProvenance?.originalContract ? { originalContract: priorProvenance.originalContract } : {}),
            // v0.35.36 (audit finding): rawNewObjective is AGENT-authored —
            // the agent wrote this text inside complete_goal. Appending it
            // to userSeeds let the v0.35.31 seed trust treat report garbage
            // as explicit user prose (createdVia stays "user" from
            // creation), laundering agent objectives past the
            // suspicious-objective fence. userSeeds stays strictly
            // human-confirmed text: the creation arg, /goal tweak (Confirm
            // dialog), repair-redraft (task-list confirm). The pivot itself
            // remains auditable via the goal_tweaked ledger entry AND the
            // isolated auditor reviewing the NEW contract in this same call.
            ...(priorProvenance?.userSeeds?.length ? { userSeeds: priorProvenance.userSeeds } : {}),
          },
        }, ctx);
        appendLedger(ctx.cwd, "goal_tweaked", { via: "complete_goal.newObjective", from: oldObjective.slice(0, 200), to: cleanObj.slice(0, 200) });
        ctx.ui.notify(`Objective updated (complete_goal newObjective): ${cleanObj.slice(0, 80)}`, "info");
      }
      // v0.34.60 (steal #3): revision-bound audit validity — an approval
      // from an older contract must not be cited against the current one.
      // The gate compares the goal's CURRENT revision against the revision
      // the LAST audit in history ran at: a contract change since that
      // audit (/goal tweak, or any objective mutation) invalidates the
      // prior verdict, and the claim is refused until the current contract
      // gets its own audit. Two escapes: (1) the claim itself carries the
      // contract change (newObjective above) — its audit covers the NEW
      // contract in this same call, so the gate skips; (2) /goal verify
      // audits the current state explicitly, after which the latest
      // audited revision matches and complete_goal proceeds. Legacy
      // history entries without a revision field pass unchanged.
      const lastAudited = state.goal.auditHistory?.[state.goal.auditHistory.length - 1];
      const currentRevision = state.goal.revision ?? 0;
      if (!(p.newObjective?.trim() ?? "") && lastAudited && typeof lastAudited.revision === "number" && lastAudited.revision !== currentRevision) {
        appendLedger(ctx.cwd, "complete_goal_revision_rejected", {
          goalId: state.goal.id,
          currentRevision,
          auditedRevision: lastAudited.revision,
          auditedAt: lastAudited.at,
          objective: state.goal.objective.slice(0, 200),
        });
        return {
          content: [{
            type: "text",
            text: `complete_goal REJECTED — revision mismatch: the goal's contract changed since its last audit (audited at revision ${lastAudited.revision}, now revision ${currentRevision}). An approval from the old contract cannot be cited against the new one. Run ${activeGoalRoot()} verify to audit the current contract, then call complete_goal again.`,
          }],
          details: {},
        };
      }
      // v0.34.20/v0.34.21: persist the completion claim AND an explicit
      // running-attempt record BEFORE the isolated auditor starts. If session
      // replacement lands during the audit, a fresh session can immediately
      // distinguish the interrupted claim from an active run and retry the
      // exact claim without allowing the old generation to archive anything.
      // v0.34.96: detect "already shipped" / "verified vX covers this"
      // phrasing in the completionSummary — the agent is signaling that
      // the work was done in a prior version, not this turn. There is
      // nothing for the auditor to verify (the goal's contract items may
      // still be met, but not BY THIS turn's work); routing to status
      // "aborted" with stopReason "already shipped in vX" gives the
      // user a truthful terminal state ("no new work shipped in this
      // turn") instead of a misleading "complete" with a recap that
      // names a version, not this turn. Field evidence: Screenshot
      // 080536 — a v0.34.74 recap ended in `✓ complete` while saying
      // "v0.34.74 already…", the two states contradicted each other.
      const summaryText = (p.completionSummary ?? "").toLowerCase();
      const alreadyShippedMatch = summaryText.match(/(?:already\s+shipped|verified\s+v\d+\.\d+\.\d+\s+covers\s+this|no\s+new\s+work\s+shipped)/);
      // v0.34.128 (field 2026-08-11, dracon-platform): a VERSION-LESS
      // "already shipped" claim is not corroborated — a restored session
      // can hallucinate it from the OLD conversation's tail (a different,
      // already-completed goal) and abort a finding that still needs work,
      // silently dropping it from the queue. Version-less claims therefore
      // route to the NORMAL completion audit (labeled already_shipped) so
      // the auditor verifies the work exists in the tree: a true claim is
      // approved into a truthful complete; a false claim is disapproved
      // and the finding stays queued. Only version-bearing claims ("already
      // shipped in vX.Y.Z", "verified vX.Y.Z covers this") keep the
      // v0.34.96 abort — the named version is the corroboration.
      let versionlessAlreadyShipped: string | undefined;
      if (alreadyShippedMatch) {
        const matchedPhrase = alreadyShippedMatch[0];
        // Bind the version to the shipped/verified claim instead of taking
        // the first version-looking token in the whole recap. A dependency
        // bump or changelog quote can legitimately precede the claim.
        const matchedVersion =
          summaryText.match(/\b(?:already\s+shipped|no\s+new\s+work\s+shipped)\b\s*(?:(?:in|as|under|with|for)\s+)?[(:—–-]?\s*(v\d+\.\d+\.\d+)\b/)?.[1]
          ?? summaryText.match(/\b(v\d+\.\d+\.\d+)\s+(?:(?:was|is|has\s+been|had\s+been)\s+)?already\s+shipped\b/)?.[1]
          ?? summaryText.match(/\b(?:verified|confirmed)\s+(v\d+\.\d+\.\d+)\s+(?:already\s+)?covers?\s+this\b/)?.[1];
        if (matchedVersion) {
          const stopReason = `already_shipped:${matchedVersion}`;
          // Fence the claim before any persistence. The normal audit path
          // uses this same guard; without it a stale completion call can
          // mutate a replaced goal or overwrite an archive that already won.
          const alreadyShippedGoalId = state.goal?.id;
          if (!guardGoalBeforeContinuation(ctx, "already-shipped-archive", alreadyShippedGoalId)) {
            return staleToolResult();
          }
          // Archive the terminal snapshot directly. Do not first persist a
          // terminal stopReason on an active goal: a crash in that gap leaves
          // a live slot that looks resumable but is already claimed closed.
          const recap = compactTerminalCompletionSummary({
            goal: state.goal,
            status: "aborted",
            stopReason,
            archivePath: path.relative(ctx.cwd, archivedGoalPath(ctx.cwd, alreadyShippedGoalId)) || archivedGoalPath(ctx.cwd, alreadyShippedGoalId),
          }, p.completionSummary?.trim());
          const archived = archiveCurrentGoal(ctx, "aborted", stopReason, {
            completionSummary: p.completionSummary?.trim(),
            pendingTasks: undefined,
          });
          if (!archived) {
            return {
              content: [{
                type: "text",
                text: "complete_goal could not archive the already-shipped claim safely — the goal remains active. Fix persistence or resolve the archive fence, then retry.",
              }],
              details: {},
            };
          }
          appendLedger(ctx.cwd, "complete_goal_already_shipped", {
            goalId: alreadyShippedGoalId,
            stopReason,
            matchedPhrase,
            matchedVersion,
            routedToAudit: false,
            recap: p.completionSummary?.slice(0, 300),
          });
          ctx.ui.notify(`Goal archived as aborted — completionSummary indicated the work was ${matchedPhrase}; no new work shipped in this turn.\nRecap: ${recap}`, "info");
          return {
            content: [{
              type: "text",
              text: `complete_goal routed to status=aborted — completionSummary matched "${matchedPhrase}" (${matchedVersion}). The work was already shipped in a prior version; this turn shipped no new code. Use this status to differentiate "completed" from "verified-already-shipped".`,
            }],
            details: {},
          };
        }
        // Version-less: record the label and fall through to the normal
        // completion audit below (auditor verifies the work exists).
        versionlessAlreadyShipped = matchedPhrase;
        appendLedger(ctx.cwd, "complete_goal_already_shipped", {
          goalId: state.goal?.id,
          matchedPhrase,
          matchedVersion: null,
          routedToAudit: true,
          recap: p.completionSummary?.slice(0, 300),
        });
        ctx.ui.notify(`completionSummary says "${matchedPhrase}" with no version named — routing to the NORMAL audit so the auditor verifies the work exists in the tree.`, "info");
      }
      // v0.34.104 ([Image-#1] 2026-08-08 10:29 dracon-platform): the
      // completionSummary said "29/28 pass, 0 fail" — more tests passing
      // than exist in the suite is nonsensical and the agent shipped it
      // verbatim. Catch obvious arithmetic impossibilities at capture time
      // (X/Y pass with X > Y), ledger the discrepancy for forensics, and
      // append a note so the recap carries the warning forward — the
      // auditor's job is to verify the claim, but the claim should at
      // least be self-consistent.
      //
      // v0.34.119: canonicalize BEFORE beginCompletionAudit. Previously the
      // archive got the amended warning, but pendingCompletion and the
      // detached auditor received raw p.completionSummary. A retry after a
      // session replacement therefore lost the only warning the user/auditor
      // needed to see.
      const validated = p.completionSummary?.trim() ? validateCompletionSummary(p.completionSummary, ctx) : p.completionSummary;
      const validatedSummary = validated?.trim() || undefined;
      // v0.34.128: carry the version-less already-shipped label INTO the
      // audited recap (mirrors validateCompletionSummary's NOTE amendment)
      // so the auditor sees this is a verify-in-tree claim, not a
      // this-turn-shipped claim.
      const finalSummary = versionlessAlreadyShipped && validatedSummary
        ? `${validatedSummary} — NOTE: version-less "${versionlessAlreadyShipped}" claim — the auditor must verify the work exists in the tree (commit hash or current code) before approving.`
        : validatedSummary;
      if (!guardGoalBeforeContinuation(ctx, "completion-audit-dispatch", state.goal?.id)) {
        return staleToolResult();
      }
      const completionClaim = beginCompletionAudit(ctx, {
        completionSummary: finalSummary,
        verificationSummary: p.verificationSummary,
        at: nowIso(),
      }, "complete-goal");
      if (!completionClaim) {
        return {
          content: [{ type: "text", text: "Completion claim was not persisted; no auditor was launched. Fix .pi-glla storage and retry complete_goal." }],
          details: {},
        };
      }
      updateGoal({ pendingTasks: undefined, ...(finalSummary ? { completionSummary: finalSummary } : {}) }, ctx);
      const auditGoal = state.goal;
      if (!auditGoal) return staleToolResult();
      const auditGoalId = auditGoal.id;
      const auditAttemptId = completionClaim.attemptId!;
      const settings = loadSettings(ctx.cwd);
      // v0.37.0: configurable + adaptive timeouts — same schedule as the
      // stored-claim retry path. A fresh claim starts at escalation 0.
      const auditorToolBaseMs =
        settings.auditorToolTimeoutMs ?? DEFAULT_AUDITOR_TOOL_TIMEOUT_MS;
      const auditorStallBaseMs =
        settings.auditorStallMs ?? DEFAULT_AUDITOR_STALL_MS;
      let dispatchTimeouts = {
        toolTimeoutMs: escalatedAuditorTimeout(
          auditorToolBaseMs,
          completionClaim.timeoutEscalation ?? 0,
        ),
        stallMs: escalatedAuditorTimeout(
          auditorStallBaseMs,
          completionClaim.timeoutEscalation ?? 0,
        ),
      };
      const { model: auditorModel, error: modelError, via, fallbackModels } = resolveAuditorModel(ctx, settings.auditorModel, settings.auditorModelFallbacks, settings.auditorSameSessionSwap !== false);
      if (modelError) {
        const modelFailureCopy = providerErrorPresentation(modelError, "completion");
        ctx.ui.notify(`Auditor model issue: ${modelFailureCopy.display}. ${modelFailureCopy.action}`, "warning");
        appendLedger(ctx.cwd, "auditor_model_issue", { error: modelFailureCopy.diagnostic, display: modelFailureCopy.display });
      }
      const auditorCandidates: AuditorModelCandidate[] = [{ model: auditorModel, via: via ?? "unset" }, ...(fallbackModels ?? [])];
      const configuredAuditorRefs = auditorCandidateRefs(auditorCandidates);
      const persistedAuditorAttemptedRefs = (completionClaim.auditorAttemptedRefs ?? [])
        .filter((ref: string) => configuredAuditorRefs.some((candidateRef) => candidateRef.toLowerCase() === ref.toLowerCase()))
        .slice(0, MAX_AUDITOR_CANDIDATE_REFS);
      const persistedAuditorCandidateRef = completionClaim.auditorCandidateRef
        && configuredAuditorRefs.some((ref) => ref.toLowerCase() === completionClaim.auditorCandidateRef!.toLowerCase())
        ? completionClaim.auditorCandidateRef
        : undefined;
      const persistedAuditorRetryCandidateRef = completionClaim.auditorRetryCandidateRef
        && configuredAuditorRefs.some((ref) => ref.toLowerCase() === completionClaim.auditorRetryCandidateRef!.toLowerCase())
        ? completionClaim.auditorRetryCandidateRef
        : undefined;
      // v0.34.90: no redundant chat notify here — pi's own complete_goal
      // response already says the claim persisted and the detached auditor
      // is queued; a second "Auditor queued" message is chat spam (never
      // spam the chat — one notification per state transition). The widget
      // and status line surface auditor: queued/running/live as it moves.
      // The detached worker must not keep complete_goal's pi turn open. The
      // rest of this callback deliberately runs after the tool has returned;
      // every state/UI access below rebinds through the generation guard.
      completionAuditInFlight = true;
      completionAuditGeneration = auditGeneration;
      latestAuditProgress = {
        label: "queued",
        model: modelRef(auditorModel),
        via: via ?? "unset",
        lastEventAt: Date.now(),
      };
      refreshUI(ctx, true);
      void (async () => {
      // v0.38.3: live-inspection session path, captured from worker progress
      // BEFORE the post-audit clear — the approval notify uses it to point
      // the user at the kept resumable session.
      let inspectionSessionPath: string | undefined;
      const runAudit = (candidate: AuditorModelCandidate) => {
        latestAuditProgress = {
          ...(latestAuditProgress ?? {}),
          model: modelRef(candidate.model),
          via: candidate.via,
        };
        refreshUI(ctx);
        // v0.37.0: the worker gets the SAME budgets via env so its own
        // per-tool timer and inactivity brake agree with the parent
        // watchdogs instead of racing them at different values.
        const { toolTimeoutMs, stallMs } = dispatchTimeouts;
        return runDetachedGoalCompletionAuditor({
          cwd: ctx.cwd,
          goal: auditGoal,
          completionSummary: finalSummary,
          verificationSummary: p.verificationSummary,
          model: candidate.model,
          // Unset follows the parent session dial, matching the Auditor
          // settings row; max is the safe detached default when a headless
          // context does not expose a thinking level.
          thinkingLevel: (settings.auditorThinkingLevel ?? ctx.thinkingLevel ?? "max") as any, // pi ≥0.83 understands max; dev-types predate it
          allowedExtensions: settings.auditorAllowedExtensions,
          // v0.38.3: opt-in live inspection — persist the auditor's pi as a
          // resumable session pinned inside the job dir (off = --no-session).
          inspection: settings.auditorInspection === true,
          // The host tool's AbortSignal is the explicit user-stop boundary
          // for the detached audit. It lets the Esc escape hatch settle the
          // worker before offering the user the without-audit choice.
          signal,
          runtime: {
            attemptId: () => newDetachedAuditJobAttemptId(completionClaim.attemptId!),
            logicalAttemptId: completionClaim.attemptId!,
            // v0.37.0: escalated budgets — per-tool ceiling, silence/
            // no-progress window, and first-event window all derive from the
            // same escalated pair.
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
            publishDetachedAuditProgress(auditGeneration, auditGoalId, auditAttemptId, { ...progress, toolTimeoutMs });
          },
          // v0.34.57: the parent-side heartbeat-without-progress watchdog
          // fired — persist the auditor_stalled ledger event so the recovery
          // path can distinguish "wedged worker" from other timeouts.
          onStalled: (info) => {
            const current = detachedAuditContext(auditGeneration, auditGoalId, auditAttemptId);
            if (!current) return;
            appendLedger(current.cwd, "auditor_stalled", { goalId: auditGoalId, attemptId: auditAttemptId, ...info });
          },
        });
      };
      // v0.25.4 (post-audit fix): a retriable infra failure (stream error,
      // auth blip — NOT user abort, NOT missing model) gets ONE automatic
      // retry with backoff before we report "auditor infrastructure error
      // (retried once)". Neither attempt is a verdict on the work.
      const auditStartMs = Date.now();
      let result: Awaited<ReturnType<typeof runAudit>>;
      let retriedOnce = false;
      let fallbackUsed = false;
      // v0.35.7: Deterministic Fast-Fail Pre-Audit — if mechanical contract checks fail,
      // fail with raw output rather than burning an LLM audit pass. The check
      // runner is asynchronous and process-group bounded, so it cannot block
      // the main pi event loop or strand descendants on timeout.
      try {
        const mechanicalCmds = extractMechanicalCheckCommands(auditGoal.verificationContract ?? "");
        const mechanicalResult = await runMechanicalPreAuditChecks(ctx.cwd, mechanicalCmds, undefined, signal);
        if (!mechanicalResult.passed) {
        result = {
          approved: false,
          disapproved: true,
          impossible: false,
          output: `<disapproved/>\n\nDeterministic Pre-Audit Fast-Fail: Mechanical contract check failed: \`${mechanicalResult.failedCommand}\` (exit code ${mechanicalResult.exitCode})\n\n<evidence>\n${mechanicalResult.output}\n</evidence>`,
          model: "deterministic-pre-audit",
          regressionShieldPassed: true,
          goalRevision: captureGoalRevision(auditGoal) ?? undefined,
        };
        } else {
          ({ result, retriedOnce, fallbackUsed } = await runDetachedCompletionWithFallback(auditorCandidates, runAudit, {
            shouldRetry: () => detachedAuditContext(auditGeneration, auditGoalId, auditAttemptId) !== null,
            forbiddenRefs: settings.forbiddenModels,
            retryBaseMinutes: settings.mainModelRetryMinutes,
            onSelection: (event: { scope: { kind: string }; fromRef?: string; toRef?: string; reason: string }) => appendLedger(ctx.cwd, "model_fallback_select", { scope: "auditor", fromRef: event.fromRef, toRef: event.toRef, reason: event.reason }),
            resumeCandidateRef: persistedAuditorCandidateRef,
            attemptedRefs: persistedAuditorAttemptedRefs,
            retryCandidateRef: persistedAuditorRetryCandidateRef,
            retryAttemptStarted: !!completionClaim.auditorRetryAttemptStartedAt,
            retryFailureClass: completionClaim.auditorFailureClass,
            onAttempt: (_candidate: AuditorModelCandidate, info: AuditorFallbackAttemptInfo) => {
              const current = detachedAuditContext(auditGeneration, auditGoalId, auditAttemptId);
              if (!current) return false;
              // v0.37.0: this launch's budgets come from the persisted index
              // BEFORE incrementing; the increment persists through the same
              // cursor write, so the NEXT launch reads the doubled budgets.
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
              const persisted = updateGoal({
                pendingCompletion: {
                  ...(state.goal?.pendingCompletion ?? completionClaim),
                  timeoutEscalation: priorEscalation + 1,
                  auditorCandidateRefs: info.candidateRefs.slice(0, MAX_AUDITOR_CANDIDATE_REFS),
                  auditorCandidateRef: info.candidateRef,
                  auditorAttemptedRefs: info.attemptedRefs.slice(0, MAX_AUDITOR_CANDIDATE_REFS),
                  auditorFailureCount: info.failureCount,
                  auditorRetryAttemptStartedAt: info.attempt === 2 ? new Date().toISOString() : undefined,
                  ...(info.failureCount === 0 ? {
                    auditorRetryCandidateRef: undefined,
                    auditorFailureClass: undefined,
                    auditorFailureAt: undefined,
                  } : {}),
                },
              }, current);
              return persisted;
            },
            onRetry: (candidate: AuditorModelCandidate, err: string, info?: AuditorFallbackAttemptInfo) => {
              const current = detachedAuditContext(auditGeneration, auditGoalId, auditAttemptId);
              if (!current || !info) return false;
              const failureCopy = providerErrorPresentation(err, "completion");
              const persisted = updateGoal({
                pendingCompletion: {
                  ...(state.goal?.pendingCompletion ?? completionClaim),
                  auditorCandidateRefs: info.candidateRefs.slice(0, MAX_AUDITOR_CANDIDATE_REFS),
                  auditorCandidateRef: info.candidateRef,
                  auditorRetryCandidateRef: info.candidateRef,
                  auditorRetryAttemptStartedAt: undefined,
                  auditorAttemptedRefs: info.attemptedRefs.slice(0, MAX_AUDITOR_CANDIDATE_REFS),
                  auditorFailureCount: 1,
                  auditorFailureClass: info.failureClass ?? "provider",
                  auditorFailureAt: new Date().toISOString(),
                },
              }, current);
              if (!persisted) return false;
              latestAuditProgress = {
                ...(latestAuditProgress ?? {}),
                model: modelRef(candidate.model),
                via: candidate.via,
                label: `${failureCopy.display} — retrying once`,
                lastEventAt: Date.now(),
              };
              refreshUI(current, true);
              appendLedger(current.cwd, "audit_infra_retry", {
                goalId: auditGoalId,
                model: auditorCandidateLabel(candidate),
                error: failureCopy.diagnostic.slice(0, 200),
                diagnostic: failureCopy.diagnostic,
                display: failureCopy.display,
                candidateRef: info.candidateRef,
                failureClass: info.failureClass ?? "provider",
              });
              return true;
            },
            onCandidateExhausted: (candidate: AuditorModelCandidate, err: string, info: AuditorFallbackExhaustionInfo) => {
              const current = detachedAuditContext(auditGeneration, auditGoalId, auditAttemptId);
              if (!current) return false;
              const next = info.nextCandidateRef;
              const persisted = updateGoal({
                pendingCompletion: {
                  ...(state.goal?.pendingCompletion ?? completionClaim),
                  auditorCandidateRefs: info.candidateRefs.slice(0, MAX_AUDITOR_CANDIDATE_REFS),
                  auditorCandidateRef: next,
                  auditorRetryCandidateRef: undefined,
                  auditorRetryAttemptStartedAt: undefined,
                  auditorAttemptedRefs: info.attemptedRefs.slice(0, MAX_AUDITOR_CANDIDATE_REFS),
                  auditorFailureCount: next ? 0 : 2,
                  auditorFailureClass: info.failureClass,
                  auditorFallbackExhausted: next ? undefined : true,
                  auditorFailureAt: new Date().toISOString(),
                },
              }, current);
              if (!persisted) return false;
              const failureCopy = providerErrorPresentation(err, "completion");
              appendLedger(current.cwd, "auditor_candidate_exhausted", {
                goalId: auditGoalId,
                model: auditorCandidateLabel(candidate),
                candidateRef: info.candidateRef,
                nextCandidateRef: next,
                candidateRefs: info.candidateRefs.slice(0, MAX_AUDITOR_CANDIDATE_REFS),
                attemptedRefs: info.attemptedRefs.slice(0, MAX_AUDITOR_CANDIDATE_REFS),
                failureClass: info.failureClass,
                error: failureCopy.diagnostic.slice(0, 200),
                diagnostic: failureCopy.diagnostic,
                display: failureCopy.display,
                fallbackExhausted: !next,
              });
              return true;
            },
            onFallback: (from: AuditorModelCandidate, to: AuditorModelCandidate, err: string) => {
              const current = detachedAuditContext(auditGeneration, auditGoalId, auditAttemptId);
              if (!current) return;
              appendLedger(current.cwd, "auditor_runtime_model_fallback", { goalId: auditGoalId, from: auditorCandidateLabel(from), to: auditorCandidateLabel(to), error: err.slice(0, 200) });
              current.ui.notify(`Detached auditor failed on ${auditorCandidateLabel(from)} — retrying with ${auditorCandidateLabel(to)}. This is infrastructure, not a verdict.`, "warning");
            },
          }));
        }
      } catch (err) {
        const recoveryCtx = freshCtxForGeneration(auditGeneration);
        const current = state.goal;
        if (!current || current.id !== auditGoalId || current.pendingCompletion?.attemptId !== auditAttemptId) {
          return staleToolResult();
        }
        const failureCopy = providerErrorPresentation(err instanceof Error ? err.message : String(err), "completion");
        if (!recoveryCtx) {
          // The retained tool context is stale after a generation handoff.
          // Park through the durable cwd-only path so an exception cannot
          // strand a running claim merely because the normal apply context
          // is unavailable.
          parkCompletionAuditRecovery(ctx.cwd, `auditor run exception: ${failureCopy.diagnostic}`, {
            auditorFallbackExhausted: true,
            auditorFailureClass: "transport",
            auditorFailureAt: new Date().toISOString(),
          });
          return staleToolResult();
        }
        const currentClaim = current.pendingCompletion ?? completionClaim;
        const pending: PendingCompletion = {
          ...currentClaim,
          phase: "recovery-pending",
          recoveryAt: nowIso(),
          recoveryRetryAt: undefined,
          recoveryReason: "auditor-run-exception",
          providerErrorDiagnostic: failureCopy.diagnostic,
          auditorFallbackExhausted: true,
          auditorFailureAt: new Date().toISOString(),
        };
        updateGoal({
          status: "paused",
          pendingCompletion: pending,
          providerErrorDiagnostic: failureCopy.diagnostic,
          pauseKind: "error",
          pauseResumeAt: undefined,
          pauseReason: `completion auditor crashed before a result — ${failureCopy.display}`,
          pauseSuggestedAction: `The completion claim is stored; fix the auditor/session issue, then ${activeGoalSurfaceCommand("resume")} to start a fresh bounded attempt.`,
        }, recoveryCtx);
        appendLedger(recoveryCtx.cwd, "audit_recovery_exception", {
          goalId: auditGoalId,
          attemptId: auditAttemptId,
          diagnostic: failureCopy.diagnostic,
          display: failureCopy.display,
          recoveryReason: "auditor-run-exception",
        });
        recoveryCtx.ui.notify(`Completion auditor failed before producing a result (infrastructure, not a verdict). The claim remains stored; fix the issue, then ${activeGoalSurfaceCommand("resume")}.`, "warning");
        return {
          content: [{ type: "text", text: `The completion auditor failed before producing a result (infrastructure, not a verdict). The claim remains stored; fix the issue, then ${activeGoalSurfaceCommand("resume")} to retry it.` }],
          details: {},
        };
      } finally {
        // Deterministic pre-audit failures take the same cleanup path as a
        // detached worker. Otherwise the in-flight latch survives forever
        // and recovery/status surfaces claim an auditor is still running.
        if (ownsDetachedAudit(auditGeneration, auditGoalId, auditAttemptId)) {
          clearDetachedAuditProgress(auditGeneration, auditGoalId, auditAttemptId);
          completionAuditInFlight = false;
          completionAuditGeneration = null;
        }
      }
      const auditContextAfterRun = freshCtxForGeneration(auditGeneration);
      if (!auditContextAfterRun || !state.goal || state.goal.id !== auditGoalId) {
        clearDetachedAuditProgress(auditGeneration, auditGoalId, auditAttemptId);
        return staleToolResult();
      }
      result = normalizeAuditorInfrastructureResult(result);
      if (state.goal.pendingCompletion?.attemptId !== auditAttemptId) {
        return staleToolResult();
      }
      ctx = auditContextAfterRun;
      // Candidate cursor callbacks update the same durable claim while the
      // worker is running. Use the refreshed record below so recovery cannot
      // overwrite the cursor with the pre-launch snapshot.
      const durableCompletionClaim = state.goal.pendingCompletion ?? completionClaim;
      if (result.goalRevision && !isGoalRevisionCurrent(result.goalRevision, state.goal)) {
        appendLedger(ctx.cwd, "stale_revision_refused", {
          goalId: auditGoalId,
          captured: result.goalRevision,
          current: { goalId: state.goal.id, revision: state.goal.revision ?? 0 },
          attemptId: auditAttemptId,
          approvedClaimed: result.approved,
          disapprovedClaimed: result.disapproved,
          error: result.error?.slice?.(0, 200),
        });
        ctx.ui.notify(
          `Stale auditor verdict REFUSED: goal ${auditGoalId} revision is ${state.goal.revision ?? 0} but the auditor captured ${result.goalRevision.revision}. The goal moved on during the audit — its verdict was not applied. Run /goal verify again to audit the current state.`,
          "warning",
        );
        updateGoal({ status: "active", pendingCompletion: undefined }, ctx);
        scheduleContinuation(ctx, true);
        return {
          content: [{ type: "text", text: "The auditor result was refused because the goal contract changed while the audit was running. The stale claim was discarded; run /goal verify again for the current contract." }],
          details: {},
        };
      }
      const auditDurationMs = Date.now() - auditStartMs;
      latestAuditProgress = null;
      // Audit history: record REAL verdicts only — a non-empty report is the
      // evidence the auditor actually inspected something. Empty-report runs
      // (abort, auth failure, no model) are surfaced via pauseReason, not
      // logged as disapprovals.
      const auditorRan = result.output.trim().length > 0;
      // v0.28.5 (E2): a REAL auditor run clears the infra-error streak.
      // v0.34.14: …but only a CLEAN one. A STALLED run returns the partial
      // output it streamed before the abort — non-empty, so auditorRan is
      // true — while result.error still marks it an infrastructure failure.
      // Clearing the streak on those meant the 3-strike breaker at :3874
      // NEVER engaged: pully 2026-08-01 looped 10-min stall cycles for 4h
      // (the auditor hung on an ssh/sudo verification every attempt).
      if (auditorRan && !result.error && (state.goal.auditInfraStreak ?? 0) > 0) updateGoal({ auditInfraStreak: undefined }, ctx);
      const history = state.goal.auditHistory ?? [];
      if (auditorRan) {
        // v0.25.4: strip think-block leakage (MiniMax-M3 `</think>`
        // fragments + reasoning spillover) before anything stores or
        // displays the report.
        const cleanOutput = stripThinkBlocks(result.output);
        result.output = cleanOutput;
        // Shared push path (same scope transitions as the detached site:
        // new disapproval retires older live rounds, clean approval clears).
        // The 20-cap lives inside the helper — 39 infra errors taught us
        // unbounded growth is real.
        appendAuditVerdict(history, {
          at: nowIso(),
          approved: result.approved,
          disapproved: result.disapproved,
          impossible: result.impossible,
          impossibleReason: result.impossibleReason,
          model: result.model,
          thinkingLevel: result.thinkingLevel,
          report: cleanOutput,
          error: result.error,
          regressionShieldPassed: result.regressionShieldPassed,
          regressionShieldMissing: result.regressionShieldMissing,
          // v0.34.60 (steal #3): the revision the worker audited.
          revision: result.goalRevision?.revision ?? state.goal.revision ?? 0,
          durationMs: auditDurationMs,
        });
        // v0.25.4: durable append-only audit log — survives state-snapshot
        // rotation; the review surface for "where are we weak".
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
        appendAuditLog(ctx.cwd, {
          at: nowIso(),
          goalId: state.goal.id,
          objective: state.goal.objective.slice(0, 200),
          verdict,
          model: result.model,
          thinkingLevel: result.thinkingLevel ?? "(default)",
          report: cleanOutput,
          impossibleReason: result.impossibleReason,
          error: result.error,
          durationMs: auditDurationMs,
          retriedOnce,
          fallbackUsed,
        } as AuditLogEntry);
      }

      // Escape hatch: the user aborted the audit (Esc). Offer the explicit
      // choice — complete WITHOUT audit, or keep working. (pi-goal-x parity.)
      if (result.error === "Auditor aborted.") {
        updateGoal({ status: "active", auditHistory: history, pendingCompletion: undefined, pauseReason: "audit aborted by user (Esc)" }, ctx);
        const abortConfirmCtx = freshCtxForGeneration(auditGeneration);
        if (!abortConfirmCtx) return staleToolResult();
        ctx = abortConfirmCtx;
        let completeAnyway = false;
        try {
          completeAnyway = await ctx.ui.confirm(
            "Audit aborted",
            "You aborted the auditor (Escape).\n\nYes = mark the goal COMPLETE WITHOUT AUDIT (you take responsibility for verification).\nNo = continue working; the auditor will verify on the next complete_goal.",
          );
        } catch {
          completeAnyway = false;
        }
        const afterAbortConfirmCtx = freshCtxForGeneration(auditGeneration);
        if (!afterAbortConfirmCtx) return staleToolResult();
        ctx = afterAbortConfirmCtx;
        if (completeAnyway) {
          if (!updateGoal({ auditHistory: history, pendingCompletion: undefined }, ctx)) {
            return {
              content: [{ type: "text", text: "The audit was aborted, but the completion claim could not be updated safely. The goal remains active; fix persistence and retry." }],
              details: {},
            };
          }
          const terminalGoal = state.goal;
          if (!terminalGoal) return staleToolResult();
          const terminalReason = "completed without audit (user choice after Esc)";
          const recap = compactTerminalCompletionSummary({
            goal: terminalGoal,
            status: "complete",
            stopReason: terminalReason,
            archivePath: path.relative(ctx.cwd, archivedGoalPath(ctx.cwd, terminalGoal.id)) || archivedGoalPath(ctx.cwd, terminalGoal.id),
          });
          if (!archiveCurrentGoal(ctx, "complete", terminalReason)) {
            return {
              content: [{ type: "text", text: "The audit was aborted, but the terminal archive could not be persisted. The goal remains active; fix persistence and retry." }],
              details: {},
            };
          }
          const brief = terminalHumanBrief({
            goal: terminalGoal,
            status: "complete",
            stopReason: terminalReason,
            archivePath: path.relative(ctx.cwd, archivedGoalPath(ctx.cwd, terminalGoal.id)) || archivedGoalPath(ctx.cwd, terminalGoal.id),
          });
          // v0.38.20: the command output keeps the informing details (stale
          // `Next:` stripped); the chat notify is outcome + approval +
          // record pointer like every other approval path.
          const briefBlock = [...withoutStaleNext(brief.details), `— completed without audit (your choice).`].join("\n");
          ctx.ui.notify(buildApprovalChatLines({
            outcome: brief.outcome,
            details: brief.details,
            approval: `— completed without audit (your choice).`,
            record: `— record: ${path.relative(ctx.cwd, archivedGoalPath(ctx.cwd, terminalGoal.id)) || archivedGoalPath(ctx.cwd, terminalGoal.id)}`,
          }).join("\n"), "info");
          notifyExternal(ctx, `Goal complete without audit (user choice): ${recap}`);
          return { content: [{ type: "text", text: `Goal marked complete without audit (user choice).\n\n${briefBlock}` }], details: {} };
        }
        scheduleContinuation(ctx, true);
        return {
          content: [{ type: "text", text: "Audit aborted; continuing. Call complete_goal again when ready — the auditor will re-run." }],
          details: {},
        };
      }

      if (result.approved && result.regressionShieldPassed !== false) {
        updateGoal({ auditHistory: history, pendingCompletion: undefined }, ctx);
        // v0.34.91: the end-of-goal voice carries the recap (what happened)
        // on EVERY approve path — fresh complete_goal approval + provider retry
        // approve + manual-verify approve. Captured BEFORE archive (it
        // mutates state.goal). The widget card and the external notify both
        // already use the recap; the chat notify was the lone surface still
        // saying "auditor approved" — pure process, no information
        // (Screenshot_20260808_012905/013220/013515).
        const terminalReason = `auditor ${result.model} approved`;
        const recap = compactTerminalCompletionSummary({
          goal: state.goal,
          status: "complete",
          stopReason: terminalReason,
          archivePath: path.relative(ctx.cwd, archivedGoalPath(ctx.cwd, state.goal.id)) || archivedGoalPath(ctx.cwd, state.goal.id),
        }, state.goal.completionSummary);
        // Computed pre-archive: archiveCurrentGoal clears state.goal.
        const brief = terminalHumanBrief({
          goal: state.goal,
          status: "complete",
          stopReason: terminalReason,
          archivePath: path.relative(ctx.cwd, archivedGoalPath(ctx.cwd, state.goal.id)) || archivedGoalPath(ctx.cwd, state.goal.id),
        }, state.goal.completionSummary);
        // v0.38.20: captured pre-archive — archiveCurrentGoal clears
        // state.goal, so the record pointer must be computed here.
        const manualArchiveRecord = `— record: ${path.relative(ctx.cwd, archivedGoalPath(ctx.cwd, state.goal.id)) || archivedGoalPath(ctx.cwd, state.goal.id)}`;
        const archived = archiveCurrentGoal(ctx, "complete", terminalReason);
        if (!archived) {
          // The archive helper preserves the live objective and emits the
          // persistence warning. Stop here: an approved verdict is not a
          // terminal success until the archive and state transition land.
          updateGoal({
            status: "paused",
            pendingCompletion: undefined,
            pauseKind: "blocked",
            pauseReason: "completion approved but terminal archive persistence failed",
            pauseSuggestedAction: `Fix .pi-glla disk access or resolve the archive fence, then ${activeGoalSurfaceCommand("resume")} and call complete_goal again.`,
          }, ctx);
          appendLedger(ctx.cwd, "goal_archive_failed_after_approval", { goalId: state.goal?.id, origin: "manual-verify", model: result.model });
          return { content: [{ type: "text", text: "The auditor approved, but the terminal archive could not be persisted. The goal is paused; fix persistence, resume, and retry complete_goal." }], details: {} };
        }
        // v0.38.20: same approval voice as the detached path — the stale
        // pre-verdict `Next:` never reaches the chat.
        // PR #43: append the kept inspection-session pointer when present.
        ctx.ui.notify([...buildApprovalChatLines({
          outcome: brief.outcome,
          details: brief.details,
          approval: `— auditor ${result.model} approved.`,
          record: manualArchiveRecord,
        }),
          ...(inspectionSessionPath
            ? [`Auditor session kept for review: pi --session ${inspectionSessionPath} (or pi --fork ${inspectionSessionPath}).`]
            : []),
        ].join("\n"), "info");
        notifyExternal(ctx, `Goal complete (auditor approved): ${recap}`);
        return { content: [{ type: "text", text: `Goal approved by auditor ${result.model}.` }], details: {} };
      }

      // IMPOSSIBLE (v0.24.2, Claude-Code lesson): the auditor's escape hatch
      // for goals that can NEVER be satisfied as stated. Not a disapproval —
      // continuing would burn tokens on a provably unwinnable objective.
      // Full impossible verdicts are terminal facts: archive them as aborted
      // through the same fence as every other terminal outcome. Only a
      // PARTIAL verdict in aggressive mode remains active for narrowing.
      if (result.impossible) {
        const reason = result.impossibleReason || "(no reason given)";
        // v0.25.0 (contract item 23): under aggressiveMode, a PARTIAL
        // impossible (some items can't ship) keeps the loop going — the
        // agent narrows to the remainder. A FULL impossible is
        // terminalized as aborted; auto-resuming a provably unwinnable
        // objective would only burn tokens.
        const effectiveImp = resolveEffectiveAggressiveSettings(loadSettings(ctx.cwd));
        if (effectiveImp.aggressiveMode && classifyImpossibleReason(reason) === "partial") {
          updateGoal({
            status: "active",
            auditHistory: history,
            pendingCompletion: undefined,
            pauseReason: `auditor verdict: IMPOSSIBLE (partial) — ${reason}`,
            pauseSuggestedAction: `Narrow the objective past the impossible part (complete_goal newObjective or ${activeGoalSurfaceCommand("tweak")}) and continue`,
          }, ctx);
          ctx.ui.notify(`Auditor: part of the goal is IMPOSSIBLE — ${reason.slice(0, 100)}. aggressiveMode: narrowing and continuing.`, "warning");
          appendLedger(ctx.cwd, "impossible_partial_continue", { reason: reason.slice(0, 200) });
          scheduleContinuation(ctx, true);
          return {
            content: [{
              type: "text",
              text: `The auditor says PART of this goal can never be satisfied: ${reason}\n\naggressiveMode is ON, so the goal stays ACTIVE. Do NOT keep attempting the impossible part. Narrow the objective to the remaining shippable items — pass newObjective to complete_goal at completion time (or pause_goal proposing ${activeGoalSurfaceCommand("tweak")} if the narrowing needs the user's call) — and continue working the rest now.`,
            }],
            details: {},
          };
        }
        // Conservative mode preserves the historical decision pause for a
        // PARTIAL impossible verdict: the user must choose how to narrow it.
        // Only a full impossible objective is terminalized automatically.
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
          }, ctx);
          ctx.ui.notify(`Auditor: part of the goal is IMPOSSIBLE — ${reason.slice(0, 140)}. Goal paused for an explicit narrowing decision.`, "warning");
          maybeDecisionPopup(ctx);
          appendLedger(ctx.cwd, "impossible_partial_paused", { reason: reason.slice(0, 240) });
          notifyExternal(ctx, `Goal paused (auditor: partial impossible): ${reason.slice(0, 120)}`);
          return {
            content: [{
              type: "text",
              text: `The auditor says PART of this goal can never be satisfied: ${reason}\n\nThe goal is PAUSED for an explicit narrowing decision. Use ${activeGoalSurfaceCommand("tweak")} to remove the impossible part (or ${activeGoalSurfaceCommand("cancel")}), then ${activeGoalSurfaceCommand("resume")}.`,
            }],
            details: {},
          };
        }
        const terminalReason = `auditor impossible: ${reason}`;
        const terminal = terminalizeImpossibleGoal(ctx, terminalReason, history);
        if (!terminal.archived) {
          // A persistence/archive failure is the only reason a full
          // impossible verdict remains parked. Keep the verdict durable and
          // make the recovery action explicit; never claim terminalization.
          updateGoal({
            status: "paused",
            auditHistory: history,
            pendingCompletion: undefined,
            pauseKind: "blocked",
            pauseReason: `auditor verdict: IMPOSSIBLE, but terminal archive failed — ${reason}`,
            pauseSuggestedAction: `Fix .pi-glla storage, then ${activeGoalSurfaceCommand("resume")} and retry the terminal archive.`,
          }, ctx);
          appendLedger(ctx.cwd, "goal_archive_failed_after_impossible", { reason: reason.slice(0, 240) });
          return {
            content: [{
              type: "text",
              text: `The auditor's verdict is IMPOSSIBLE, but GLLA could not persist the terminal archive. The verdict is preserved and the goal is paused; fix storage, then ${activeGoalSurfaceCommand("resume")} to retry.`,
            }],
            details: {},
          };
        }
        const recapSource = terminal.summary.replace(/\s+/g, " ");
        const recap = compactCompletionSummary(terminal.summary);
        ctx.ui.notify(`Goal archived as aborted — auditor marked it IMPOSSIBLE: ${reason.slice(0, 180)}.\nRecap: ${recap}`, "warning");
        appendLedger(ctx.cwd, "goal_impossible_terminalized", { reason: reason.slice(0, 240), recap: recapSource.slice(0, 600) });
        notifyExternal(ctx, `Goal archived as aborted (auditor impossible): ${recap}`);
        return {
          content: [{
            type: "text",
            text: `The auditor's verdict is IMPOSSIBLE: ${reason}\n\nThe objective was terminalized as aborted with a durable six-label recap:\n${terminal.summary}`,
          }],
          details: {},
        };
      }

      // THREE-WAY SPLIT (v0.9.9): infrastructure failure is NOT a verdict.
      // The wild-caught case: 6 silent "disapprovals" that were really a dead
      // auditor model. The agent must be able to tell the difference.
      if (result.error && !result.disapproved && result.regressionShieldPassed !== false) {
        // Watchdog timeouts are infrastructure failures, but retain the exact
        // completion claim so /goal resume can retry the isolated auditor
        // directly. A timeout is not a verdict and must not be fed back into
        // the normal agent continuation path.
        const cursorPersistenceFailed = isAuditorCursorPersistenceFailure(result.error);
        if (result.fallbackExhausted || cursorPersistenceFailed) {
          // The configured candidate chain is finite. Exhaustion and cursor
          // persistence failures are hard parked states, not invitations to
          // schedule another automatic cycle that would repeat a provider
          // call after restart.
          const failureCopy = providerErrorPresentation(result.error, "completion");
          const recoveryEpisodeKey = durableCompletionClaim.recoveryEpisodeKey ?? `${durableCompletionClaim.at}:${failureCopy.fingerprint}`;
          const pending: PendingCompletion = {
            ...durableCompletionClaim,
            phase: "recovery-pending",
            recoveryAt: nowIso(),
            recoveryRetryAt: undefined,
            recoveryReason: cursorPersistenceFailed ? "auditor-cursor-persistence-failed" : "auditor-fallback-exhausted",
            providerErrorDiagnostic: failureCopy.diagnostic,
            recoveryEpisodeKey,
            recoveryNoticeKeys: durableCompletionClaim.recoveryNoticeKeys ?? [],
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
          }, ctx);
          appendLedger(ctx.cwd, cursorPersistenceFailed ? "auditor_recovery_cursor_persistence_failed" : "auditor_fallback_exhausted", {
            goalId: auditGoalId,
            attemptId: durableCompletionClaim.attemptId,
            failureClass: auditorResultFailureClass(result),
            diagnostic: failureCopy.diagnostic,
            display: failureCopy.display,
            recoveryEpisodeKey,
          });
          if (notifyParked) {
            ctx.ui.notify(
              cursorPersistenceFailed
                ? `Auditor recovery stopped because its durable cursor could not be saved. The completion claim remains stored; ${activeGoalSurfaceCommand("resume")} retries it explicitly.`
                : `Auditor fallback candidates are exhausted. The completion claim remains stored with no verifier verdict; inspect the provider setup, then ${activeGoalSurfaceCommand("resume")}.`,
              "warning",
            );
          }
          return {
            content: [{
              type: "text",
              text: cursorPersistenceFailed
                ? `Auditor recovery stopped because its durable cursor could not be saved. The completion claim remains stored; ${activeGoalSurfaceCommand("resume")} retries it explicitly.`
                : `Auditor fallback candidates are exhausted. The completion claim remains stored with no verifier verdict; inspect the provider setup, then ${activeGoalSurfaceCommand("resume")}.`,
            }],
            details: {},
          };
        }
        if (isAuditorNoVerdictInfrastructureError(result.error, result.infrastructureClass)) {
          const failureCopy = providerErrorPresentation(result.error, "completion");
          const recoveryEpisodeKey = durableCompletionClaim.recoveryEpisodeKey ?? `${durableCompletionClaim.at}:${failureCopy.fingerprint}`;
          let pending: PendingCompletion = {
            ...durableCompletionClaim,
            phase: "recovery-pending",
            recoveryAt: nowIso(),
            recoveryReason: result.error.startsWith("Auditor exceeded")
              ? "wall-timeout"
              : result.error.startsWith("Auditor stalled")
                ? "inactivity-timeout"
                : "auditor-no-verdict",
            providerErrorDiagnostic: failureCopy.diagnostic,
            recoveryEpisodeKey,
            recoveryNoticeKeys: durableCompletionClaim.recoveryNoticeKeys ?? [],
            automaticRecoveryAttempted: durableCompletionClaim.automaticRecoveryAttempted ?? false,
            auditorFailureClass: auditorResultFailureClass(result),
            auditorFailureAt: new Date().toISOString(),
          };
          if (typeof scheduleParkedCompletionAuditRecovery === "function") {
            pending = scheduleParkedCompletionAuditRecovery(ctx, pending, pending.recoveryReason ?? "auditor-timeout");
          }
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
              ? `One bounded auditor retry is scheduled in ${fmtRetryDelay(Math.max(1, (Date.parse(pending.recoveryRetryAt) - Date.now()) / 1000))}; ${activeGoalSurfaceCommand("resume")} retries immediately.`
              : `The claim is stored. Check long-running verification commands, then ${activeGoalSurfaceCommand("resume")} to retry the isolated auditor.`,
          }, ctx);
          appendLedger(ctx.cwd,
            result.error.startsWith("Auditor exceeded")
              ? "audit_wall_timeout"
              : result.error.startsWith("Auditor stalled")
                ? "audit_inactivity_timeout"
                : "audit_no_verdict_infrastructure",
            { goalId: auditGoalId, attemptId: auditAttemptId, error: failureCopy.diagnostic.slice(0, 240), diagnostic: failureCopy.diagnostic, recoveryEpisodeKey },
          );
          if (notifyTimeout) {
            ctx.ui.notify(
              timeoutInfrastructure
                ? `Completion auditor timed out (infrastructure, not a verdict). The stored claim is safe; fix the command/model and ${activeGoalSurfaceCommand("resume")} to retry it.`
                : `Completion auditor stopped before a verdict (infrastructure, not a judgment). The stored claim is safe; fix the auditor/session issue and ${activeGoalSurfaceCommand("resume")} to retry it.`,
              "warning",
            );
          }
          return {
            content: [{ type: "text", text: timeoutInfrastructure
              ? `The completion auditor timed out (infrastructure, not a verdict). The stored claim is safe; fix the command/model and ${activeGoalSurfaceCommand("resume")} to retry it.`
              : `The completion auditor stopped before a verdict (infrastructure, not a judgment). The stored claim is safe; fix the auditor/session issue and ${activeGoalSurfaceCommand("resume")} to retry it.` }],
            details: {},
          };
        }
        // v0.34.51/v0.36.0: ANY infrastructure failure enters the durable
        // retry plan — error text is not trusted to pick one failure family.
        // Conservative mode keeps its horizon; aggressive mode keeps the
        // same per-attempt schedule without a wall-clock episode expiry.
        if (result.error && !result.disapproved) {
          const failureCopy = providerErrorPresentation(result.error, "completion");
          const recoveryEpisodeKey = durableCompletionClaim.recoveryEpisodeKey ?? `${durableCompletionClaim.at}:${failureCopy.fingerprint}`;
          const aggressive = resolveEffectiveAggressiveSettings(loadSettings(ctx.cwd)).aggressiveMode;
          const plan = auditorRetryPlan(durableCompletionClaim, undefined, undefined, aggressive);
          const pending = {
            ...durableCompletionClaim,
            phase: "retry-waiting" as const,
            recoveryAt: undefined,
            recoveryReason: undefined,
            recoveryRetryAt: undefined,
            providerErrorDiagnostic: failureCopy.diagnostic,
            recoveryEpisodeKey,
            recoveryNoticeKeys: durableCompletionClaim.recoveryNoticeKeys ?? [],
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
              auditInfraStreak: undefined,
              pendingCompletion: pending,
              providerErrorDiagnostic: failureCopy.diagnostic,
              recoveryEpisodeKey,
              recoveryNoticeKeys: pending.recoveryNoticeKeys,
              pauseKind: "blocked",
              pauseResumeAt: undefined,
              pauseReason: `auditor retry: automatic retry horizon reached (${plan.attempt} attempts)`,
              pauseSuggestedAction: `The completion claim is stored, but automatic auditor retries are stopped. Check the auditor/model setup, then ${activeGoalSurfaceCommand("resume")} to start a fresh bounded window.`,
            }, ctx);
            appendLedger(ctx.cwd, "auditor_retry_capped", { streak: plan.attempt, autoRetryUntil: plan.autoRetryUntil, requestedSec: plan.requestedSec, diagnostic: failureCopy.diagnostic, recoveryEpisodeKey });
            if (notifyCapped) ctx.ui.notify(`Automatic auditor retries stopped after ${plan.attempt} bounded attempts — the claim stays stored; check the provider, then ${activeGoalSurfaceCommand("resume")}.`, "warning");
            return {
              content: [{ type: "text", text: `The auditor hit an infrastructure wall (NOT a verdict). Automatic probes stopped after ${plan.attempt} bounded attempts; the exact completion claim is stored. Check the provider, then ${activeGoalSurfaceCommand("resume")}.` }],
              details: {},
            };
          }
          const notifyRetry = claimRecoveryNotice(pending, `${recoveryEpisodeKey}:retry-wait`);
          updateGoal({
            status: "paused",
            auditHistory: history,
            auditInfraStreak: undefined, // durable retry owns the wait — infra streak broken
            // v0.28.26: store the claim — the retry re-runs the auditor
            // DIRECTLY with it (no agent turn to confuse).
            pendingCompletion: pending,
            providerErrorDiagnostic: failureCopy.diagnostic,
            recoveryEpisodeKey,
            recoveryNoticeKeys: pending.recoveryNoticeKeys,
            pauseKind: "wait",
            pauseResumeAt: new Date(Date.now() + plan.retryAfterSec * 1000).toISOString(),
            pauseReason: `auditor retry: ${failureCopy.display}`,
            pauseSuggestedAction: `Auto-retry in ${fmtRetryDelay(plan.retryAfterSec)} — or ${activeGoalSurfaceCommand("resume")} to retry now`,
          }, ctx);
          appendLedger(ctx.cwd, "goal_paused", { reason: `auditor retry: retry in ${plan.retryAfterSec}s (uniform schedule)`, attempt: plan.attempt, autoRetryUntil: plan.autoRetryUntil, diagnostic: failureCopy.diagnostic, recoveryEpisodeKey });
          scheduleProviderRetryForSession(ctx, plan.retryAfterSec, result.error, (fresh: ExtensionContext) => {
            // Re-check: only auto-resume if STILL paused for the retry
            // reason (a user /goal pause during the window is not stomped).
            if (state.goal && state.goal.status === "paused" && (state.goal.pauseReason ?? "").startsWith("auditor retry:")) {
              // v0.28.26: a stored claim retries the AUDITOR directly — the
              // agent is not needed to re-submit an unchanged claim, and
              // re-engaging it produced hallucinated-closure loops.
              if (state.goal.pendingCompletion) {
                void retryStoredCompletionAudit();
                return;
              }
              updateGoal({ status: "active", pauseKind: undefined, pauseResumeAt: undefined, pauseReason: undefined, pauseSuggestedAction: undefined, autoResumedAt: new Date().toISOString(), autoResumedEvent: "auditor provider retry elapsed" }, fresh);
              appendLedger(fresh.cwd, "goal_resumed", { via: "provider-retry" });
              if (resolveEffectiveAggressiveSettings(loadSettings(fresh.cwd)).aggressiveMode) {
                fresh.ui.notify("Auto-resume fired (event: auditor provider retry elapsed). Continue working.", "info");
              }
              scheduleContinuation(fresh, true);
            }
          }, undefined, {
            episodeKey: recoveryEpisodeKey,
            noticeKey: `${recoveryEpisodeKey}:retry-wait`,
            suppressNotice: !notifyRetry,
          });
          return {
            content: [{
              type: "text",
            text: `The auditor hit an infrastructure error (NOT a verdict): ${failureCopy.display}. The goal is PAUSED with an automatic retry scheduled in ${fmtRetryDelay(plan.retryAfterSec)} (uniform retry schedule). Your completion claim was not evaluated; do not change your deliverable for this. ${activeGoalSurfaceCommand("resume")} retries immediately. ${failureCopy.action}`,
            }],
            details: {},
          };
        }
        // v0.34.51/v0.36.0: the durable retry plan above owns ALL infra
        // failures now (timeouts keep their own branch). The old 3-strike
        // "auditor model is likely broken" stop is gone; aggressive mode
        // continues until a state-based stop, while conservative mode keeps
        // its bounded horizon.
      }

      // Shield-blocked approval (v0.22.6): the auditor APPROVED but the
      // regression shield found contract items the evidence never
      // referenced. NOT a verdict on the work — the next audit is told
      // exactly what to quote. (The hegemon case: three genuine approvals
      // shield-blocked on vocabulary mismatches read as a "parser bug".)
      if (result.regressionShieldPassed === false) {
        const missing = result.regressionShieldMissing ?? [];
        const detail = missing.length > 0
          ? `the report's evidence never referenced these contract items:\n${missing.map((i) => `- ${i}`).join("\n")}`
          : "the report did not include a valid <evidence> block";
        updateGoal({
          status: "active",
          auditHistory: history,
          pendingCompletion: undefined,
          pauseReason: "regression shield: auditor approved, but the evidence contract was not satisfied",
          pauseSuggestedAction: "call complete_goal again — the next auditor run is told exactly which evidence the shield requires",
        }, ctx);
        ctx.ui.notify(
          `Regression shield blocked completion: the auditor approved, but ${detail}.\n\nCall complete_goal again; the next audit will be told to quote raw evidence for each item.`,
          "warning",
        );
        scheduleContinuation(ctx, true);
        return {
          content: [{
            type: "text",
            text: `The auditor APPROVED, but the orchestrator's regression shield blocked completion: ${detail}.\n\nThis is NOT a verdict on your work — do not change your deliverable for this. Call complete_goal again; the next audit is explicitly told to quote raw evidence for each of these items.`,
          }],
          details: {},
        };
      }

      const noContractHint = state.goal.verificationContract?.trim()
        ? ""
        : `\n\nNote: this goal has no verification contract, so the auditor inferred done-criteria from the objective text. For sharper verdicts, ${activeGoalSurfaceCommand("tweak")} the objective to add a 'Done when: ...' clause.`;
      // v0.24.2 (Claude-Code lesson — their stop-hook blocks cap at 8): a
      // goal the auditor can NEVER approve used to re-continue forever.
      // auditCap consecutive disapprovals → pause + notify, bounded and
      // surfaced like every other stop in this stack.
      const effectiveCap = resolveEffectiveAggressiveSettings(settings);
      const auditCap = effectiveCap.auditCap;
      const configuredFeedbackChars = settings.auditFeedbackChars;
      const auditFeedbackChars = Number.isInteger(configuredFeedbackChars) && configuredFeedbackChars! >= 0
        ? configuredFeedbackChars!
        : DEFAULT_AUDIT_FEEDBACK_CHARS;
      const safeAuditOutput = sanitizeProviderAuditReport(result.output);
      const auditFeedback = auditFeedbackExcerpt(safeAuditOutput, auditFeedbackChars);
      const auditFeedbackIsFull = auditFeedbackChars === 0 || safeAuditOutput.length <= auditFeedbackChars;
      const auditFeedbackLabel = auditFeedbackIsFull
        ? "full report"
        : `last ${auditFeedbackChars} chars (Required-fixes tail)`;
      const auditFeedbackTruncationHint = auditFeedbackIsFull
        ? ""
        : `\n\nReport truncated at the configured limit. ${activeGoalStatusCommand()} shows the full report; change Audit feedback chars in /glla settings (0 = full report).`; 
      const durableObjections = result.disapproved && effectiveCap.aggressiveMode
        ? (() => {
          const extracted = extractPendingTasks(safeAuditOutput, 5);
          return extracted.length > 0
            ? extracted
            : [`Review the latest auditor disapproval in ${activeGoalStatusCommand()}.`];
        })()
        : [];
      if (result.disapproved && effectiveCap.aggressiveMode) {
        // v0.36.0: every ordinary disapproval becomes the current durable
        // TODO projection, not only the post-cap case. Replacing (rather than
        // appending) the bounded list makes repeated identical reports
        // idempotent while the full report remains in auditHistory.
        appendLedger(ctx.cwd, "audit_objections_todo", {
          goalId: auditGoalId,
          attemptId: auditAttemptId,
          pendingTasks: durableObjections,
          source: "auditor-disapproval",
        });
      }
      const trailingDisapprovals = countTrailingDisapprovals(history);
      const repeatedNoProgress = countTrailingRepeatedDisapprovals(history);
      if (result.disapproved && effectiveCap.aggressiveMode && repeatedNoProgress >= MAX_REPEATED_AUDIT_NO_PROGRESS) {
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
        }, ctx);
        appendLedger(ctx.cwd, "audit_no_progress_stop", {
          goalId: auditGoalId,
          attemptId: auditAttemptId,
          repeated: repeatedNoProgress,
          pendingTasks: durableObjections,
          reason: stopReason,
        });
        ctx.ui.notify(`Auditor automation paused: ${stopReason}. The objection is preserved as TODOs; inspect it before ${activeGoalSurfaceCommand("resume")}.`, "warning");
        maybeDecisionPopup(ctx);
        return {
          content: [{ type: "text", text: `Automatic auditor work paused on a state-based no-progress signal: ${stopReason}. The latest objections are durable TODOs. Investigate the report, then ${activeGoalSurfaceCommand("resume")} or ${activeGoalSurfaceCommand("tweak")} the objective.` }],
          details: {},
        };
      }
      if (auditCap > 0 && trailingDisapprovals >= auditCap) {
        // v0.25.0 (contract item 22): aggressiveMode turns the cap into a
        // TODO list and keeps going — the objections become pendingTasks
        // rendered into every continuation until addressed. OFF preserves
        // the pause (contract item 24 test 2).
        if (effectiveCap.aggressiveMode) {
          const pendingTasks = durableObjections;
          updateGoal({
            status: "active",
            auditHistory: history,
            pendingCompletion: undefined,
            pendingTasks,
            pauseReason: `auditor disapproved ${trailingDisapprovals}× consecutively (cap ${auditCap}) — aggressiveMode: continuing with TODOs`,
          }, ctx);
          const todoBlock = pendingTasks.length > 0
            ? pendingTasks.map((t, i) => ` ${i + 1}. ${t}`).join("\n")
            : " (no discrete objections extracted — re-read the latest report in ${activeGoalStatusCommand()})";
          ctx.ui.notify(`Auditor disapproved ${trailingDisapprovals}× (cap). Treating as TODOs:\n${todoBlock}`, "warning");
          appendLedger(ctx.cwd, "audit_cap_keep_going", { trailingDisapprovals, auditCap, pendingTasks });
          scheduleContinuation(ctx, true);
          return {
            content: [{
              type: "text",
              text: `The auditor has disapproved ${trailingDisapprovals} times in a row (cap ${auditCap}), but aggressiveMode is ON — the goal stays ACTIVE and the objections are now your TODO list:\n${todoBlock}\n\nLatest report (${auditFeedbackLabel}):\n${auditFeedback}\n\nWork the TODOs in order. If the auditor is WRONG about an objection, follow WHEN THE AUDITOR DISAPPROVES: investigate, quote its objection, compare against what you shipped, and present the user YOUR ASSESSMENT. If the objective itself has drifted, pass newObjective to complete_goal.`,
            }],
            details: {},
          };
        }
        updateGoal({
          status: "paused",
          auditHistory: history,
          pendingCompletion: undefined,
          pauseKind: "decision",
          pauseOptions: [`Fix the disapproval gap, then continue (${activeGoalSurfaceCommand("resume")})`, `Tweak the objective — ${activeGoalSurfaceCommand("tweak")} <new text>`, `Cancel the goal (${activeGoalSurfaceCommand("cancel")})`],
          pauseRecommended: 1,
          pauseReason: `auditor disapproved ${trailingDisapprovals}× consecutively (cap ${auditCap})`,
          pauseSuggestedAction: `Read the audit history (${activeGoalStatusCommand()}), fix the actual gap or ${activeGoalSurfaceCommand("tweak")} the objective, then ${activeGoalSurfaceCommand("resume")}. Raise Audit cap in /glla settings.`,
        }, ctx);
        ctx.ui.notify(`${goalNoun()} paused: auditor disapproved ${trailingDisapprovals}× consecutively (cap ${auditCap}). ${activeGoalStatusCommand()} for the reports; ${activeGoalSurfaceCommand("resume")} to continue.`, "warning");
          maybeDecisionPopup(ctx);
        appendLedger(ctx.cwd, "goal_paused", { reason: `disapproval cap: ${trailingDisapprovals} consecutive (cap ${auditCap})` });
        notifyExternal(ctx, `Goal paused: ${trailingDisapprovals} consecutive auditor disapprovals`);
        return {
          content: [{
            type: "text",
            text: `The auditor has now disapproved ${trailingDisapprovals} times in a row (cap ${auditCap}). The goal is PAUSED — continuing to re-attempt without addressing the pattern wastes tokens.\n\nBefore asking the user, INVESTIGATE:\n1. Read the audit history (the auditor's previous reports — ${activeGoalStatusCommand()} shows them; state.goal.auditHistory holds them).\n2. Identify the SPECIFIC objections — quote them.\n3. Compare against what you actually shipped (commits, diffs, test output, screenshots).\n4. Form a clear opinion: is the auditor right, wrong, or partially right?\n5. Present the user YOUR ASSESSMENT with quoted objections and shipped evidence — not a generic menu of options.\n\nLatest report (${auditFeedbackLabel}):\n${auditFeedback}\n\nDo not call complete_goal again until the pattern is addressed. ${activeGoalSurfaceCommand("resume")} resumes; ${activeGoalSurfaceCommand("tweak")} fixes a drifted objective.`,
          }],
          details: {},
        };
      }
      updateGoal({
        status: "active",
        auditHistory: history,
        pendingCompletion: undefined,
        pendingTasks: effectiveCap.aggressiveMode ? durableObjections : undefined,
        pauseReason: "auditor disapproved",
        pauseSuggestedAction: "Inspect auditor feedback and fix the actual gap before calling complete_goal again",
      }, ctx);
      // The returned tool text reaches the executor only if a continuation
      // turn starts. Surface a bounded report directly as well, so a missing
      // turn-start acknowledgement cannot turn a real disapproval into an
      // apparently empty red card.
      const userFeedback = auditFeedbackExcerpt(safeAuditOutput, 1200)
        .replace(/<\/?(?:approved|disapproved|impossible)\s*\/?>/gi, "")
        .trim()
        || "(no actionable feedback returned; use /glla audits full to inspect the raw report)";
      ctx.ui.notify(`Auditor disapproved. Report excerpt:\n${userFeedback}`, "warning");
      scheduleContinuation(ctx, true);
      return {
        content: [{
          type: "text",
          text: `Auditor disapproved. Report (${auditFeedbackLabel}):\n${auditFeedback}${auditFeedbackTruncationHint}${noContractHint}`,
        }],
        details: {},
      };
      })().catch((error) => {
        const current = freshCtxForGeneration(auditGeneration);
        if (!current || !state.goal || state.goal.id !== auditGoalId || state.goal.pendingCompletion?.attemptId !== auditAttemptId) return;
        const failureCopy = providerErrorPresentation(error instanceof Error ? error.message : String(error), "completion");
        const durableCompletionClaim = state.goal.pendingCompletion ?? completionClaim;
        const recoveryEpisodeKey = durableCompletionClaim.recoveryEpisodeKey ?? `${durableCompletionClaim.at}:${failureCopy.fingerprint}`;
        let pending: PendingCompletion = {
          ...durableCompletionClaim,
          phase: "recovery-pending",
          recoveryAt: nowIso(),
          recoveryReason: "auditor-infrastructure",
          providerErrorDiagnostic: failureCopy.diagnostic,
          recoveryEpisodeKey,
          recoveryNoticeKeys: durableCompletionClaim.recoveryNoticeKeys ?? [],
          automaticRecoveryAttempted: durableCompletionClaim.automaticRecoveryAttempted ?? false,
          auditorFailureClass: auditorResultFailureClass({
            approved: false,
            disapproved: false,
            output: "",
            model: "",
            error: failureCopy.diagnostic,
          }),
          auditorFailureAt: new Date().toISOString(),
        };
        if (typeof scheduleParkedCompletionAuditRecovery === "function") {
          pending = scheduleParkedCompletionAuditRecovery(current, pending, "auditor-infrastructure");
        }
        const notifyFailure = claimRecoveryNotice(pending, `${recoveryEpisodeKey}:infrastructure`);
        updateGoal({
          status: "paused",
          pendingCompletion: pending,
          providerErrorDiagnostic: failureCopy.diagnostic,
          recoveryEpisodeKey,
          recoveryNoticeKeys: pending.recoveryNoticeKeys,
          pauseKind: pending.recoveryRetryAt ? "wait" : "error",
          pauseResumeAt: pending.recoveryRetryAt,
          pauseReason: "completion auditor infrastructure failure — no verdict was produced",
          pauseSuggestedAction: pending.recoveryRetryAt
            ? `One bounded auditor retry is scheduled in ${fmtRetryDelay(Math.max(1, (Date.parse(pending.recoveryRetryAt) - Date.now()) / 1000))}; ${activeGoalSurfaceCommand("resume")} retries immediately.`
            : `Fix the auditor worker/model, then ${activeGoalSurfaceCommand("resume")} to retry the stored claim.`,
        }, current);
        appendLedger(current.cwd, "audit_infra_waiting", { goalId: auditGoalId, attemptId: auditAttemptId, error: failureCopy.diagnostic.slice(0, 240), diagnostic: failureCopy.diagnostic, recoveryEpisodeKey });
        if (notifyFailure) current.ui.notify(`Completion auditor worker failed to settle (infrastructure, not a verdict). The stored claim is safe; ${activeGoalSurfaceCommand("resume")} retries it.`, "warning");
      });
      return {
        content: [{ type: "text", text: `Completion claim persisted; detached auditor queued (model: ${via ?? "setting"}). The verdict will be applied asynchronously.` }],
        details: {},
      };
    },
  }));

  pi.registerTool(defineTool({
    name: "record_goal_judgment",
    label: "Record judgment",
    description: "Record the explicit durable-vs-defer implementation choice in the ledger without pausing the goal. Use choice=inline when implementing the maintainable root-cause fix now. Use choice=deferred only when that fix is genuinely unsafe, impossible, or currently blocked; include the reason and, when applicable, the durable follow-up. Do not use this to defer an obvious durable fix.",
    parameters: Type.Object({
      choice: Type.Union([Type.Literal("inline"), Type.Literal("deferred")], { description: "Whether the durable fix is being implemented now or intentionally deferred" }),
      reason: Type.String({ maxLength: 500, description: "Concise reason for the durable-vs-defer choice" }),
      followUp: Type.Optional(Type.String({ maxLength: 500, description: "For a deferred choice, the bounded durable follow-up" })),
      durableFix: Type.Optional(Type.String({ maxLength: 500, description: "The maintainable root-cause action to show in the goal card" })),
      deferRecommendations: Type.Optional(Type.Array(Type.String({ maxLength: 500 }), { maxItems: 8, description: "Earlier bounded workaround/defer recommendations to retain as UI evidence" })),
      durableBlocked: Type.Optional(Type.Boolean({ description: "True only when the durable action is unsafe, impossible, or blocked for this turn" })),
    }),
    async execute(_id, params, signal, _onUpdate, execCtx) {
      const foreignJudgment = foreignToolGuard(execCtx);
      if (foreignJudgment) return { content: [{ type: "text", text: foreignJudgment }], details: {} };
      const ctx = currentToolContext(execCtx);
      if (!ctx) return staleToolResult();
      if (!state.goal) return { content: [{ type: "text", text: "No active goal." }], details: {} };
      if (state.goal.status !== "active") {
        return { content: [{ type: "text", text: `Goal is already ${state.goal.status}; judgment was not recorded.` }], details: {} };
      }
      const p = params as {
        choice: DurableChoice;
        reason: string;
        followUp?: string;
        durableFix?: string;
        deferRecommendations?: string[];
        durableBlocked?: boolean;
      };
      const record = buildDurableChoiceRecord(p.choice, p.reason, p.followUp);
      if (!record.reason) {
        return { content: [{ type: "text", text: "A non-empty reason is required to record a durable-vs-defer judgment." }], details: {} };
      }
      if (record.choice === "deferred" && !record.followUp) {
        return { content: [{ type: "text", text: "A deferred judgment also requires a durable follow-up." }], details: {} };
      }
      const goal = state.goal;
      const durableDeferRecommendation = durableDeferFactsForGoal(goal, record, p);
      const landed = appendLedger(ctx.cwd, "durable_defer_choice", {
        goalId: goal.id,
        ...record,
        durableDeferRecommendation,
      });
      if (!landed) {
        return { content: [{ type: "text", text: "The durable-vs-defer judgment could not be persisted; no choice was recorded." }], details: {} };
      }
      if (!updateGoal({ durableDeferRecommendation }, ctx)) {
        return {
          content: [{ type: "text", text: `Recorded durable-vs-defer judgment: ${record.choice}, but its UI recommendation projection could not be persisted.` }],
          details: {},
        };
      }
      // The same production refresh path used by lifecycle events must repaint
      // the card immediately; the next session also recovers the projection
      // from the state ledger through Goal.durableDeferRecommendation.
      refreshUI(ctx, true);
      return {
        content: [{ type: "text", text: `Recorded durable-vs-defer judgment: ${record.choice}.` }],
        details: {},
      };
    },
  }));

  pi.registerTool(defineTool({
    name: "pause_goal",
    label: "Pause goal",
    description: "Pause the active goal with a reason and suggested action. Use when blocked on user input or unable to make progress. Pausing ABORTS the current turn immediately — after this call, stop; never keep working. When the user must CHOOSE between options, pass kind=\"decision\" with the options list (recommended = 1-based index of the best one) — decision pauses render as a prominent DECISION NEEDED card and pop a picker for the user. Time-gated waits (retry at a specific time) use kind=\"wait\" with resumeAt (ISO). Operational failures use kind=\"error\". VOCABULARY (v0.28.24): decision options and reasons must reference REAL commands only — /goal resume, /goal cancel, /goal tweak \"<new text>\", /list remove N, /list next, /list resume, /loop stop, /loop resume. These all act on the ACTIVE goal/item: there is NO /goal drop and NO command takes a goal id. Never show goal ids to the user — name the thing ('the active goal', 'list item \"<short name>\"'); ids are internal plumbing the user cannot act on.",
    parameters: Type.Object({
      reason: Type.String({ description: "Why the work is paused" }),
      suggestedAction: Type.Optional(Type.String({ description: "What the user should do next" })),
      kind: Type.Optional(Type.Union([Type.Literal("decision"), Type.Literal("error"), Type.Literal("wait"), Type.Literal("blocked")], { description: "Pause class: decision (user picks an option), error (operational failure), wait (time-gated), blocked (generic)" })),
      options: Type.Optional(Type.Array(Type.String(), { description: "For kind=decision: the options the user picks between (one line each)" })),
      recommended: Type.Optional(Type.Number({ description: "For kind=decision: 1-based index of the recommended option" })),
      resumeAt: Type.Optional(Type.String({ description: "For kind=wait: ISO time the pause lifts (countdown is shown)" })),
    }),
    async execute(_id, params, _signal, _onUpdate, execCtx) {
      const foreign1 = foreignToolGuard(execCtx);
      if (foreign1) return { content: [{ type: "text", text: foreign1 }], details: {} };
      const ctx = currentToolContext(execCtx);
      if (!ctx) return staleToolResult();
      const p = params as { reason: string; suggestedAction?: string; kind?: "decision" | "error" | "wait" | "blocked"; options?: string[]; recommended?: number; resumeAt?: string };
      // v0.35.15: a model that passes options but forgets kind="decision"
      // still gets the decision card — a non-empty options array IS the
      // decision intent; silently dropping it left the user with no picker.
      if (!p.kind && p.options && p.options.length > 0) p.kind = "decision";
      if (!state.goal) return { content: [{ type: "text", text: "No active goal." }], details: {} };
      // A late model/tool call from the previous turn must not overwrite a
      // paused or auditing lifecycle. That race made a genuine stop look
      // repeatable and could erase an in-flight detached-auditor state.
      if (state.goal.status !== "active") {
        return { content: [{ type: "text", text: `Goal is already ${state.goal.status}; pause request ignored.` }], details: {} };
      }
      // v0.38.15: anti-confabulation — a pause whose blocker is "this
      // session has no <glla tool>" is refused when the tool path provably
      // works: this very pause_goal call dispatched through the same
      // registration batch (complete_goal registers first in that batch),
      // so the tool IS callable — the model is misreading its tool list
      // (field: new-tab 2026-09-04, 5×-compacted session, zero tool errors
      // in transcript or ledger). The model is told to call it now; a
      // quoted pi `Tool X not found` error is genuine-outage evidence and
      // the pause is accepted.
      const missingClaim = claimedMissingGllaTool(p.reason ?? "");
      if (missingClaim && !PI_TOOL_NOT_FOUND_QUOTE.test(p.reason ?? "")) {
        appendLedger(ctx.cwd, "pause_refused_tool_present", { goalId: state.goal.id, tool: missingClaim });
        return { content: [{ type: "text", text: `Not paused: \`${missingClaim}\` is registered in this session — this pause_goal call just dispatched through the same registration batch, so the tool path works. If \`${missingClaim}\` is missing from your visible tool list, that is a client-side gap: call \`${missingClaim}\` now${missingClaim === "complete_goal" ? " with your six-label recap and verification summary" : ""}. If pi itself answers with a \`Tool ${missingClaim} not found\` error, call pause_goal again quoting that exact error and the pause will be accepted.` }], details: {} };
      }
      const pauseCopy = providerErrorPresentation(p.reason, "recovery");
      const safePauseReason = pauseCopy.sensitive ? pauseCopy.display : p.reason;
      const safePauseAction = p.suggestedAction ? sanitizeProviderDisplayText(p.suggestedAction) : p.suggestedAction;
      updateGoal({
        status: "paused",
        pauseReason: safePauseReason,
        pauseSuggestedAction: safePauseAction,
        pauseKind: p.kind,
        pauseOptions: p.kind === "decision" && p.options && p.options.length > 0 ? p.options : undefined,
        pauseRecommended: p.kind === "decision" && p.recommended && p.recommended >= 1 ? Math.floor(p.recommended) : undefined,
        pauseResumeAt: p.kind === "wait" && p.resumeAt ? p.resumeAt : undefined,
      }, ctx);
      if (p.kind === "decision" && p.options && p.options.length > 0) maybeDecisionPopup(ctx);
      // v0.27.1: surface the FULL pause contract — reason AND suggested
      // action. Before, the action only appeared in /goal status and the
      // widget truncated both at ~60 chars, so decision-pauses ("choose a
      // or b") reached the user as an unreadable fragment.
      ctx.ui.notify(`${goalNoun()} paused: ${safePauseReason}${safePauseAction ? `\n\n→ ${safePauseAction}` : ""}`, "info");
      notifyExternal(ctx, `${goalNoun()} paused: ${(safePauseAction ? `${safePauseReason} → ${safePauseAction}` : safePauseReason).slice(0, 200)}`);
      // v0.34.70 — impossible list items auto-drop (note.md 2026-08-07:
      // "auto drop impossible ones i think or auto adjust instead of stopping").
      // DEFINED IMPOSSIBLE STATE: a /list item paused as kind="blocked" with
      // NO resume path (no non-empty suggestedAction) — the pause itself
      // declares "blocked forever, no way forward". Every internal blocked
      // pause (restore hold, audit retries, abort wall, …) carries a
      // suggestedAction, so only an agent-authored blocked pause that offers
      // no way forward reaches this branch. The list then DROPS the item
      // (ledgered, both the detection and the drop) and ADVANCES to the next
      // item instead of stopping on it.
      let droppedImpossible = false;
      if (
        state.goal.policy === "list"
        && p.kind === "blocked"
        && !(p.suggestedAction && p.suggestedAction.trim())
      ) {
        const impossible = state.goal;
        appendLedger(ctx.cwd, "list_item_impossible", {
          itemId: impossible.id,
          reason: p.reason,
          objective: impossible.objective,
        });
        // The item was already taken out of the queue at activation. First
        // pass it through the central archive fence so the drop cannot leave
        // a resumable paused goal without a durable six-label recap.
        const terminal = terminalizeImpossibleGoal(ctx, "auto-dropped: blocked with no resume path");
        if (terminal.archived) {
          droppedImpossible = true;
          appendLedger(ctx.cwd, "list_item_auto_dropped", {
            itemId: impossible.id,
            objective: impossible.objective,
            reason: "blocked with no resume path",
          });
          const droppedLabel = displaySlice(impossible.objective, 60);
          const recap = compactCompletionSummary(terminal.summary);
          const remaining = listQueue().length;
          let message: string;
          if (remaining > 0 && !isLoopActive()) {
            const advanced = activateNextListItem(ctx);
            message = advanced
              ? `List item auto-dropped as impossible (blocked with no resume path): ${droppedLabel} — advancing to the next item (${remaining} remaining).`
              : `List item auto-dropped as impossible (blocked with no resume path): ${droppedLabel} — could not auto-advance (${remaining} remaining).`;
          } else if (remaining === 0) {
            message = `List item auto-dropped as impossible (blocked with no resume path): ${droppedLabel} — the list is now empty; add more with /list add.`;
          } else {
            message = `List item auto-dropped as impossible (blocked with no resume path): ${droppedLabel} — a running loop holds the surface; the item stays dropped.`;
          }
          ctx.ui.notify(`${message}\nRecap: ${recap}`, "warning");
          notifyExternal(ctx, `List item auto-dropped as impossible: ${recap}`);
        } else {
          appendLedger(ctx.cwd, "list_item_auto_drop_failed", {
            itemId: impossible.id,
            reason: "terminal archive failed",
          });
        }
      }
      // v0.34.98: paused-without-draft / decision surface. When the
      // pause is kind="wait" or "blocked" AND resumeAt is > 6h away,
      // the user is effectively locked out of progress for the entire
      // workday. Field evidence: Screenshot_20260808_080402 hellhunter
      // paused kind="wait" resumeAt=2026-08-08T02:00:00Z — the user
      // couldn't unblock without re-issuing the same objective later.
      // The fix: surface a tweak prompt at pause time so the user can
      // pivot right now, instead of remembering the long wait later.
      // A one-shot notify + an interactive input dialog offer the
      // user the choice to tweak the objective, cancel the pause, or
      // wait as planned. No auto-apply — the user keeps full control.
      const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
      const kind = p.kind ?? "blocked";
      const resumeAtMs = p.resumeAt ? Date.parse(p.resumeAt) : Number.NaN;
      const longWait = (kind === "wait" || kind === "blocked") && Number.isFinite(resumeAtMs) && (resumeAtMs - Date.now()) > SIX_HOURS_MS;
      if (longWait) {
        try {
          const hours = Math.round((resumeAtMs - Date.now()) / (60 * 60 * 1000));
          ctx.ui.notify(
            `Pause scheduled for ~${hours}h. If the objective no longer matches your intent, run ${activeGoalSurfaceCommand("tweak")} to replace it now; otherwise the wait auto-continues shortly after its resume time (heartbeat backstop), and ${activeGoalSurfaceCommand("resume")} resumes immediately.`,
            "info",
          );
          appendLedger(ctx.cwd, "pause_long_wait_offer_tweak", {
            goalId: state.goal?.id,
            kind,
            resumeAt: p.resumeAt,
            hours,
          });
        } catch {
          /* best-effort */
        }
      }
      // v0.35.15: a pause ENDS the turn. Before this fix the tool result was
      // just text — pi kept the same turn running, the model kept working
      // past its own pause ("the agent moves on"), and the deferred decision
      // picker lost the race: the user was never shown the options. Abort
      // (the same mechanism /goal cancel and the zero-stream watchdog use)
      // so the session actually stops on an idle surface where the decision
      // picker can own the screen. The impossible-drop advance is the one
      // exception: the queue already moved to the next item and its
      // continuation owns this turn — aborting would kill the hand-off.
      if (!droppedImpossible) {
        try {
          ctx.abort();
          appendLedger(ctx.cwd, "pause_goal_aborted_turn", { goalId: state.goal?.id, kind: p.kind ?? "blocked" });
        } catch (abortError) {
          appendLedger(ctx.cwd, "pause_goal_abort_failed", { goalId: state.goal?.id, error: abortError instanceof Error ? abortError.message : String(abortError) });
        }
      }
      return {
        content: [{
          type: "text",
          text: droppedImpossible
            ? "The list item was auto-dropped as impossible (blocked with no resume path) — the list moved on instead of stopping."
            : `Goal paused. The turn ends here — do NOT continue working. ${activeGoalSurfaceCommand("resume")} to continue.`,
        }],
        details: {},
      };
    },
  }));

  pi.registerTool(defineTool({
    name: "complete_task",
    label: "Complete task",
    description: "Mark a task in the active goal's task list as complete (does not stop the turn).",    parameters: Type.Object({
      id: Type.String({ description: "Task id to complete" }),
    }),
    async execute(_id, params, signal, _onUpdate, execCtx) {
      const foreign7 = foreignToolGuard(execCtx);
      if (foreign7) return { content: [{ type: "text", text: foreign7 }], details: {} };
      const ctx = currentToolContext(execCtx);
      if (!ctx) return staleToolResult();
      const p = params as { id: string };
      if (!state.goal || !state.goal.taskList) {
        return { content: [{ type: "text", text: "No task list in this goal." }], details: {} };
      }
      const tl = state.goal.taskList;
      const queue: any[] = [...tl.tasks];
      while (queue.length > 0) {
        const t = queue.shift();
        if (t.id === p.id && t.status !== "complete") {
          const checkRes = await verifyTaskMilestone(ctx, t.verificationContract, signal);
          if (checkRes) {
            return {
              content: [{
                type: "text",
                text: `Task ${p.id} milestone verification FAILED for command \`${checkRes.failedCommand}\` (exit code ${checkRes.exitCode}):\n\n${checkRes.output}\n\nTask ${p.id} remains in_progress. Fix the failure before marking complete.`,
              }],
              details: {},
            };
          }
          t.status = "complete";
          updateGoal({ taskList: tl }, ctx);
          return { content: [{ type: "text", text: `Task ${p.id} marked complete.` }], details: {} };
        }
        if (t.subtasks) queue.push(...t.subtasks);
      }
      return { content: [{ type: "text", text: `Task ${p.id} not found.` }], details: {} };
    },
  }));

  pi.registerTool(defineTool({
    name: "update_task_status",
    label: "Update task status",
    description: "Update a task's status (pending/in_progress/complete).",
    parameters: Type.Object({
      id: Type.String(),
      status: Type.Union([Type.Literal("pending"), Type.Literal("in_progress"), Type.Literal("complete")]),
    }),
    async execute(_id, params, signal, _onUpdate, execCtx) {
      const foreign8 = foreignToolGuard(execCtx);
      if (foreign8) return { content: [{ type: "text", text: foreign8 }], details: {} };
      const ctx = currentToolContext(execCtx);
      if (!ctx) return staleToolResult();
      const p = params as { id: string; status: "pending" | "in_progress" | "complete" };
      if (!state.goal || !state.goal.taskList) {
        return { content: [{ type: "text", text: "No task list in this goal." }], details: {} };
      }
      const tl = state.goal.taskList;
      const queue: any[] = [...tl.tasks];
      while (queue.length > 0) {
        const t = queue.shift();
        if (t.id === p.id) {
          if (p.status === "complete") {
            const checkRes = await verifyTaskMilestone(ctx, t.verificationContract, signal);
            if (checkRes) {
              return {
                content: [{
                  type: "text",
                  text: `Task ${p.id} milestone verification FAILED for command \`${checkRes.failedCommand}\` (exit code ${checkRes.exitCode}):\n\n${checkRes.output}\n\nTask ${p.id} remains ${t.status}. Fix the failure before marking complete.`,
                }],
                details: {},
              };
            }
          }
          t.status = p.status;
          updateGoal({ taskList: tl }, ctx);
          return { content: [{ type: "text", text: `Task ${p.id} → ${p.status}` }], details: {} };
        }
        if (t.subtasks) queue.push(...t.subtasks);
      }
      return { content: [{ type: "text", text: `Task ${p.id} not found.` }], details: {} };
    },
  }));

  pi.registerTool(defineTool({
    name: "propose_goal_draft",
    label: "Propose goal draft",
    description: "During goal drafting (/goal with no args), propose the clarified goal contract. Opens the user's Confirm dialog — nothing activates until they confirm. BLOCKED until the user has replied to at least one of your interview questions.",
    parameters: Type.Object({
      objective: Type.String({ description: "The clarified, concrete objective (single item) or a summary when items[] is used" }),
      verificationContract: Type.Optional(Type.String({ description: "Checkable done-criteria (commands, file states, test outcomes)" })),
      items: Type.Optional(Type.Array(Type.String(), { description: "LIST drafting only: many objectives at once (e.g. 'queue these 50 things'). Each becomes a list item; per-item 'Done when:' clauses are honored." })),
    }),
    async execute(_id, params, _signal, _onUpdate, execCtx) {
      const foreign2 = foreignToolGuard(execCtx);
      if (foreign2) return { content: [{ type: "text", text: foreign2 }], details: {} };
      const p = params as { objective: string; verificationContract?: string; items?: string[] };
      let liveCtx = currentToolContext(execCtx);
      if (!liveCtx) return staleToolResult();
      if (draftingTarget !== "goal" && draftingTarget !== "list") {
        return {
          content: [{ type: "text", text: "Not in goal drafting mode. The user starts drafting with /goal or /list add (no args), or activates directly with /goal <objective>." }],
          details: {},
        };
      }
      const draftGeneration = sessionGeneration;
      const staleDraftEntry = draftingTarget === "list"
        ? warnIfStaleAtEntry(liveCtx, "list drafting")
        : warnIfStaleAtEntry(liveCtx, "goal drafting");
      if (staleDraftEntry) {
        clearDraftingState();
        return { content: [{ type: "text", text: DRAFT_SESSION_INTERRUPTED_MESSAGE }], details: {} };
      }
      // v0.35.0: drafting may proceed while another objective is live;
      // activation is gated after the user confirms, when the conflict
      // dialog can offer update / replace / cancel without discarding work.
      // v0.14.0: the interview floor — no Confirm until the user replied.
      // v0.23.8: Auto-accept drafts = on in /glla settings skips the floor
      // AND the Confirm —
      // the seed carries the intent (unattended rigs). Default off.
      const autoAccept = loadSettings(liveCtx.cwd).autoAcceptDrafts === true;
      if (!autoAccept) {
        if (draftingUserReplies === 0) draftingBlockedProposals++;
        const block = draftProposalBlock(draftingUserReplies, draftingBlockedProposals);
        if (block) {
          return { content: [{ type: "text", text: block }], details: {} };
        }
      }
      // Multi-item drafts are LIST-only: a goal is single by definition.
      if (p.items && p.items.length > 0 && draftingTarget !== "list") {
        return {
          content: [{ type: "text", text: "items[] is only valid in /list drafting — a goal is a single objective. Propose one objective, or ask the user to switch to /list." }],
          details: {},
        };
      }
      // Multi-item list draft: one Confirm for the whole batch.
      if (p.items && p.items.length > 0) {
        // v0.23.7: show ALL items in full — the user approves the whole
        // batch; hidden items would be approved blind.
        const preview = p.items.map((t, i) => `  ${i + 1}. ${t}`).join("\n");
        const batchActivates = !state.goal || state.goal.status === "complete" || state.goal.status === "aborted";
        let batchConfirmed = false;
        if (autoAccept) {
          batchConfirmed = true;
          liveCtx.ui.notify(`List batch auto-accepted (Auto-accept drafts = on in /glla settings): ${p.items.length} items${batchActivates ? " — item 1 ACTIVATES now" : ""}.`, "info");
          appendLedger(liveCtx.cwd, "draft_autoaccepted", { kind: "batch", count: p.items.length });
        } else {
          const c = await confirmDraft(
            liveCtx,
            "Confirm list batch",
            `${p.items.length} items:\n${preview}${batchActivates ? "\n\n(List is empty — confirming ACTIVATES item 1 immediately as the active goal.)" : ""}`,
          );
          const afterConfirm = freshCtxForGeneration(draftGeneration);
          if (!afterConfirm) {
            clearDraftingState();
            return { content: [{ type: "text", text: DRAFT_SESSION_INTERRUPTED_MESSAGE }], details: {} };
          }
          liveCtx = afterConfirm;
          if (c === "stale") {
            // v0.28.1 (T1): a stale dialog is NOT a rejection — nothing was
            // refused; the dialog simply can't render in a doomed process.
            clearDraftingState();
            extensionApiStale = true;
            appendLedger(liveCtx.cwd, "extension_api_stale", { where: "batch confirm" });
            return { content: [{ type: "text", text: "The Confirm dialog could not render: pi invalidated this session's extension handle (session replacement). This is NOT a rejection — do NOT refine or re-propose. Wait for a fresh session_start, then re-run the drafting flow." }], details: {} };
          }
          batchConfirmed = c === "yes";
        }
        if (!batchConfirmed) {
          return {
            content: [{ type: "text", text: "Batch rejected by the user. Ask what to change, refine the item list, and propose again." }],
            details: {},
          };
        }
        if (batchActivates) {
          const conflict = await resolveDraftActivationConflict(liveCtx, "list", p.items.join("; "));
          if (conflict !== "proceed") {
            draftingTarget = null;
            // v0.35.44: restore the session model like every other exit — a
            // bare null used to strand the drafter model after the refusal.
            await ((globalThis as any).restoreDrafterModel?.() ?? Promise.resolve());
            return {
              content: [{ type: "text", text: conflict === "updated" ? "Whole list objective updated; the batch was not activated." : "List activation was not started; the current objective was preserved." }],
              details: {},
            };
          }
        }
        draftingTarget = null;
        await ((globalThis as any).restoreDrafterModel?.() ?? Promise.resolve());
        const wasIdle = !state.goal || state.goal.status === "complete" || state.goal.status === "aborted";
        const n = enqueueItems(liveCtx, p.items, "drafted batch");
        if (wasIdle) {
          return { content: [{ type: "text", text: `${n} items confirmed; first activated (list was empty). Begin work now.` }], details: {} };
        }
        return { content: [{ type: "text", text: `${n} items confirmed and added to the list (${listQueue().length} waiting).` }], details: {} };
      }
      const normContract = p.verificationContract?.trim() ? normalizeDraftContract(p.verificationContract) : "";
      const checkCount = normContract ? draftContractItemCount(normContract) : 0;
      const contractBlock = normContract
        ? `\n\nDone when${checkCount > 0 ? ` — ${checkCount} check${checkCount === 1 ? "" : "s"}` : ""}:\n${normContract}`
        : "\n\n(No verification contract — the auditor will infer done-criteria from the objective. Consider adding one.)";
      // v0.22.6: a list draft that will activate immediately must SAY so in
      // the Confirm dialog — "I started a list and ended up with a running
      // goal" was a real surprise. Title + trailing note name the outcome.
      const isListDraft = draftingTarget === "list";
      const willActivate = isListDraft && (!state.goal || state.goal.status === "complete" || state.goal.status === "aborted");
      const activationNote = isListDraft
        ? willActivate
          ? "\n\n(List is empty — confirming ACTIVATES this immediately as the active goal. Reject if you only wanted to add it, not start it.)"
          : "\n\n(Goes into the list, waiting behind the active goal.)"
        : "";
      let confirmed = false;
      if (autoAccept) {
        confirmed = true;
        liveCtx.ui.notify(`Draft auto-accepted (Auto-accept drafts = on in /glla settings)${willActivate ? " — ACTIVATING now" : ""}: ${displaySlice(p.objective.trim(), 90)}`, "info");
        appendLedger(liveCtx.cwd, "draft_autoaccepted", { kind: isListDraft ? "list" : "goal", objective: p.objective.trim().slice(0, 200) });
      } else {
        const c = await confirmDraft(liveCtx, isListDraft ? "Confirm list item" : "Confirm goal", `${sanitizeDisplayText(p.objective.trim())}${sanitizeDisplayText(contractBlock)}${activationNote}`);
        const afterConfirm = freshCtxForGeneration(draftGeneration);
        if (!afterConfirm) {
          clearDraftingState();
          return { content: [{ type: "text", text: DRAFT_SESSION_INTERRUPTED_MESSAGE }], details: {} };
        }
        liveCtx = afterConfirm;
        if (c === "stale") {
          // v0.28.1 (T1): a stale dialog is NOT "Draft rejected by the user".
          clearDraftingState();
          extensionApiStale = true;
          appendLedger(liveCtx.cwd, "extension_api_stale", { where: "draft confirm" });
          return { content: [{ type: "text", text: "The Confirm dialog could not render: pi invalidated this session's extension handle (session replacement). This is NOT a rejection — do NOT refine or re-propose. Wait for a fresh session_start, then re-run the drafting flow." }], details: {} };
        }
        confirmed = c === "yes";
      }
      if (!confirmed) {
        return {
          content: [{ type: "text", text: "Draft rejected by the user. Ask what to change, refine, and propose again. Do not repeat the identical draft." }],
          details: {},
        };
      }
      // v0.29.1: zombie-twin guard — a draft (auto-accepted OR confirmed)
      // whose objective duplicates a goal COMPLETED in the last 24h is
      // re-creating finished work. The Confirm dialog never said it was a
      // duplicate, so the gate belongs here. Junk-runner field case: the
      // just-approved INFRA-NEW-18 close re-drafted itself 3 minutes later.
      if (recentlyCompletedObjectives(liveCtx.cwd).has(normalizeObjective(p.objective.trim()))) {
        draftingTarget = null;
        // v0.35.44: restore the session model like every other exit — a
        // bare null used to strand the drafter model after the rejection.
        await ((globalThis as any).restoreDrafterModel?.() ?? Promise.resolve());
        appendLedger(liveCtx.cwd, "draft_duplicate_skipped", { kind: isListDraft ? "list" : "goal", objective: p.objective.trim().slice(0, 200) });
        liveCtx.ui.notify(`Draft REJECTED (zombie-twin guard): this objective matches a goal completed in the last 24h. Tell the user the work is already done.`, "warning");
        return {
          content: [{ type: "text", text: "This draft duplicates a goal that was COMPLETED within the last 24 hours (normalized objective match). Do NOT re-propose the same work. Report to the user that the objective is already done (see /glla audits or the archive) and ask what genuinely new work to take on instead." }],
          details: {},
        };
      }
      const confirmedTarget = draftingTarget;
      draftingTarget = null;
      await ((globalThis as any).restoreDrafterModel?.() ?? Promise.resolve());
      const full = p.objective.trim() + (normContract ? `\nDone when:\n${normContract}` : "");
      // The user has just confirmed this activation; release the blank-start
      // barrier before the direct goal path schedules its first continuation.
      releaseInitialSessionLoadBarrier();
      if (!resolveCarryover(liveCtx, "goal")) {
        return {
          content: [{ type: "text", text: "The previous carryover goal could not be archived safely; no new objective was started. Fix persistence and retry." }],
          details: {},
        };
      } // v0.28.14: surface/clear stale leftovers
      // List drafting: the confirmed contract goes into the QUEUE, not active.
      if (confirmedTarget === "list") {
        if (willActivate) {
          const conflict = await resolveDraftActivationConflict(liveCtx, "list", p.objective.trim());
          if (conflict !== "proceed") {
            return {
              content: [{ type: "text", text: conflict === "updated" ? "Whole list objective updated; the draft was not activated." : "List activation was not started; the current objective was preserved." }],
              details: {},
            };
          }
        }
        hydrateListQueueFromDisk(liveCtx);
        const extracted = parseListItemDeclaration(full);
        const item = assignQueueOrder([{
          id: newGoalId(),
          objective: extracted.objective,
          ...(extracted.agentRole ? { agentRole: extracted.agentRole } : {}),
          verificationContract: extracted.verificationContract || undefined,
          ...(extracted.parallelSafe === undefined ? {} : { parallelSafe: extracted.parallelSafe }),
          addedAt: nowIso(),
        }], listQueue())[0]!;
        // v0.34.61: disk-first — same invariant as addSingleItem. The list
        // draft path was the second-missed place: previously the in-memory
        // state mutated without a sidecar, so a torn-rename or post-mutation
        // crash could drop the drafted item.
        const written = writeQueueItemFile(liveCtx.cwd, item);
        if (written.failed) {
          return { content: [{ type: "text", text: "The list draft could not be persisted; no in-memory queue mutation was applied. Fix disk access and retry." }], details: {} };
        }
        replaceState({ ...state, list: [...listQueue(), item] });
        persistState(liveCtx);
        appendLedger(liveCtx.cwd, "list_added", { id: item.id, objective: item.objective, drafted: true });
        if (!state.goal || state.goal.status === "complete" || state.goal.status === "aborted") {
          // v0.29.4: an auto-accepted draft STARTS — autoAcceptDrafts is the
          // pre-consent (the user asked for the draft in-session). The
          // 0.28.28 autoResume hold is lifted: that setting now gates ONLY
          // launch-time restore. The 0.29.1 zombie-twin guard already
          // refused duplicates of just-completed work upstream.
          activateNextListItem(liveCtx);
          return { content: [{ type: "text", text: "Confirmed and activated (list was empty). Begin work now." }], details: {} };
        }
        return { content: [{ type: "text", text: `Confirmed and added to the list (${listQueue().length} waiting). It activates when the current goal completes.` }], details: {} };
      }
      const goalConflict = await resolveDraftActivationConflict(liveCtx, "goal", p.objective.trim());
      if (goalConflict !== "proceed") {
        return {
          content: [{ type: "text", text: goalConflict === "updated" ? "Whole goal objective updated; the draft was not activated." : "Goal activation was not started; the current objective was preserved." }],
          details: {},
        };
      }
      const goal = createGoal(full, liveCtx);
      if (!setGoal(goal, liveCtx, autoAccept ? "draft-autoaccepted" : "draft-confirmed")) {
        return { content: [{ type: "text", text: "Goal activation was not persisted; the current objective remains open." }], details: {} };
      }
      // v0.29.4: auto-accepted drafts START (autoAcceptDrafts is the
      // pre-consent — the user asked for the draft in-session). autoResume
      // no longer gates draft starts; it gates ONLY launch-time restore of
      // persisted state ("load it but not auto start it"). Zombie twins of
      // just-completed work are refused upstream (0.29.1).
      iterationCounter = 0;
      consecutiveErrorIterations = 0;
      consecutiveAbortIterations = 0;
      scheduleContinuation(liveCtx, true);
      return {
        content: [{ type: "text", text: `Goal confirmed and activated (id ${goal.id}). Begin work now; call complete_goal only when the objective is genuinely satisfied.` }],
        details: {},
      };
    },
  }));

  pi.registerTool(defineTool({
    name: "propose_loop_draft",
    label: "Propose loop draft",
    description: "During loop drafting (/loop with no args), propose the loop configuration. The orchestrator test-runs the measure command ONCE and shows the user real output + parsed number in a Confirm dialog. A measure producing no number is auto-rejected. Omit measureCmd (or pass \"none\") for a metricless spec loop — no plateau stop; ends only at bounds or /loop stop. An optional cadence is the minimum seconds between automatic wakes after successful iterations.",
    parameters: Type.Object({
      target: Type.String({ description: "What to improve, concretely" }),
      measureCmd: Type.Optional(Type.String({ description: 'Shell command that prints ONE number representing progress — or the literal "none" for a metricless spec loop' })),
      direction: Type.Optional(Type.Union([Type.Literal("min"), Type.Literal("max")], { description: "min = lower is better, max = higher is better (omit for a metricless loop)" })),
      window: Type.Optional(Type.Number({ description: "Plateau stop after N non-improving iterations (default 5)" })),
      max: Type.Optional(Type.Number({ description: "Iteration cap (default 50)" })),
      time: Type.Optional(Type.Number({ description: "Arbitrary bound: stop after this many hours" })),
      tokens: Type.Optional(Type.Number({ description: "Arbitrary bound: stop after this many tokens (input+output)" })),
      cadence: Type.Optional(Type.Number({ description: "Minimum seconds between automatic wakes after successful iterations (opt-in; explicit starts/resumes are urgent)" })),
      branch: Type.Optional(Type.Boolean({ description: "branch=true: scratch-branch mode (clean git tree required)" })),
    }),
    async execute(_id, params, _signal, _onUpdate, execCtx) {
      const foreign3 = foreignToolGuard(execCtx);
      if (foreign3) return { content: [{ type: "text", text: foreign3 }], details: {} };
      const p = params as { target: string; measureCmd?: string; direction?: "min" | "max"; window?: number; max?: number; time?: number; tokens?: number; cadence?: number; branch?: boolean };
      const liveCtx = currentToolContext(execCtx);
      if (!liveCtx) return staleToolResult();
      if (warnIfStaleAtEntry(liveCtx, "loop drafting")) {
        clearDraftingState();
        return { content: [{ type: "text", text: DRAFT_SESSION_INTERRUPTED_MESSAGE }], details: {} };
      }
      if (draftingTarget !== "loop") {
        return {
          content: [{ type: "text", text: "You cannot start or draft a loop — only the user can, from the slash bar (the Confirm is the product). Do NOT write draft files or wait for the user to say 'start' in chat; that dead-ends. Instead hand the user the exact command: /loop start \"<target>\" (bare = infinite metricless; add measure=\"<cmd>\" direction=min|max for a metric loop), or /loop respec to reconcile against the root spec, or /loop with no args to draft interactively." }],
          details: {},
        };
      }
      // v0.35.0: the proposal may be shaped while another objective is
      // live; the activation path asks update / replace / cancel after the
      // user confirms the loop spec.
      // v0.14.0: the interview floor — no Confirm until the user replied.
      if (draftingUserReplies === 0) draftingBlockedProposals++;
      const loopBlock = draftProposalBlock(draftingUserReplies, draftingBlockedProposals);
      if (loopBlock) {
        return { content: [{ type: "text", text: loopBlock }], details: {} };
      }
      if (!p.target?.trim()) {
        return { content: [{ type: "text", text: "target is required." }], details: {} };
      }
      // v0.23.0: measureCmd omitted or "none" → metricless spec loop.
      const metricless = !p.measureCmd?.trim() || p.measureCmd.trim().toLowerCase() === "none";
      if (!metricless && p.direction !== "min" && p.direction !== "max") {
        return { content: [{ type: "text", text: 'direction=min|max is required for a measured loop (omit measureCmd or pass "none" for a metricless spec loop).' }], details: {} };
      }
      // THE TEST-RUN: orchestrator runs the proposed measure once. The user
      // sees the real number before a single iteration burns tokens.
      // (Metricless loops skip this — there is no measure to test-run.)
      let rawOutput = "";
      let parsed: number | null = null;
      if (!metricless && extensionApi) {
        try {
          const result = await extensionApi.exec("bash", ["-c", p.measureCmd!], { cwd: liveCtx.cwd, timeout: MEASURE_TIMEOUT_MS });
          rawOutput = String((result as any)?.stdout ?? "").trim();
          parsed = parseMetric(rawOutput);
        } catch (err) {
          rawOutput = `(measure command failed: ${err instanceof Error ? err.message : String(err)})`;
        }
      }
      if (!metricless && parsed === null) {
        return {
          content: [{
            type: "text",
            text: `Measure test-run produced NO number — proposal auto-rejected.\nCommand: ${p.measureCmd}\nOutput: ${rawOutput.slice(0, 300) || "(empty)"}\nFix the command so it prints exactly one number, sanity-check it against the repo, and propose again.`,
          }],
          details: {},
        };
      }
      const window = p.window && p.window > 0 ? Math.floor(p.window) : 5;
      const cadenceMs = typeof p.cadence === "number" && Number.isFinite(p.cadence) && p.cadence > 0
        ? Math.min(Math.round(p.cadence * 1_000), 24 * 60 * 60_000)
        : undefined;
      // v0.23.0: explicit max=0 = truly unbounded (no iteration cap).
      // v0.23.8: metricless + no explicit max = UNBOUNDED here too — the
      // drafter path was still defaulting to 50 after v0.23.6 flipped the
      // CLI default.
      const max = p.max !== undefined && Number.isFinite(p.max) && p.max >= 0 ? Math.floor(p.max) : metricless ? 0 : 50;
      const autoAccept = loadSettings(liveCtx.cwd).autoAcceptDrafts === true;
      let confirmed = false;
      if (autoAccept) {
        confirmed = true;
        liveCtx.ui.notify(`Loop draft auto-accepted (Auto-accept drafts = on in /glla settings): ${displaySlice(p.target.trim(), 90)}`, "info");
        appendLedger(liveCtx.cwd, "draft_autoaccepted", { kind: "loop", target: p.target.trim().slice(0, 200), metricless });
      } else {
        try {
          const c = await confirmDraft(
          liveCtx,
          "Confirm loop",
          metricless
            ? `Target: ${sanitizeDisplayText(p.target.trim())}\n\nMeasure: NONE — metricless spec loop. There is NO plateau stop: the loop ends only at ${max > 0 ? `${max} iterations` : "NO iteration cap"}${typeof p.time === "number" && p.time > 0 ? ` · Time bound: ${p.time}h` : ""}${typeof p.tokens === "number" && p.tokens > 0 ? ` · Token bound: ${p.tokens.toLocaleString()}` : ""}${cadenceMs ? ` · Cadence: ≥ ${Math.ceil(cadenceMs / 1_000)}s` : ""} · /loop stop.${p.branch ? "\nbranch mode: scratch branch, every iteration committed (clean tree required)" : ""}\n\nEvery iteration must make ONE real, inspectable change — cosmetic churn is the known failure mode (doorknob-polishing). Start it?`
            : `Target: ${sanitizeDisplayText(p.target.trim())}\n\nMeasure: ${sanitizeDisplayText(p.measureCmd ?? "")}\nTest-run output: ${sanitizeDisplayText(rawOutput).slice(0, 200)}\nParsed number: ${parsed} (${p.direction === "min" ? "lower is better" : "higher is better"})\n\nPlateau stop: ${window} non-improving iterations · Cap: ${max > 0 ? `${max} iterations` : "none (unbounded)"}${typeof p.time === "number" && p.time > 0 ? ` · Time bound: ${p.time}h` : ""}${typeof p.tokens === "number" && p.tokens > 0 ? ` · Token bound: ${p.tokens.toLocaleString()}` : ""}${cadenceMs ? ` · Cadence: ≥ ${Math.ceil(cadenceMs / 1_000)}s` : ""}${p.branch ? "\nbranch mode: scratch branch (clean tree required)" : ""}\n\nThe loop never completes — it runs until one of these bounds, plateau, or /loop stop. Start it?`,
          );
          confirmed = c === "yes";
        } catch {
          confirmed = false;
        }
      }
      if (!confirmed) {
        return {
          content: [{ type: "text", text: "Loop draft rejected by the user. Ask what to change — target, metric, direction, or window/max — and propose again." }],
          details: {},
        };
      }
      draftingTarget = null;
      await ((globalThis as any).restoreDrafterModel?.() ?? Promise.resolve());
      const started = await startLoopFromConfig(liveCtx, {
        target: p.target.trim(),
        measureCmd: metricless ? "" : p.measureCmd!.trim(),
        direction: metricless ? undefined : p.direction,
        plateauWindow: window,
        maxIterations: max,
        timeLimitHours: typeof p.time === "number" && Number.isFinite(p.time) && p.time > 0 ? p.time : undefined,
        tokenBudget: typeof p.tokens === "number" && Number.isFinite(p.tokens) && p.tokens > 0 ? Math.floor(p.tokens) : undefined,
        minimumIterationIntervalMs: cadenceMs,
        branch: p.branch === true,
      });
      if (!started) {
        return { content: [{ type: "text", text: "Loop could not start (see the warning above — likely a git/dirty-tree issue with branch mode)." }], details: {} };
      }
      return {
        content: [{ type: "text", text: metricless ? "Loop confirmed and started (metricless — no plateau). Make ONE real, inspectable change per turn." : `Loop confirmed and started. Baseline ${parsed}. Make ONE small change per turn to move the metric ${p.direction === "min" ? "down" : "up"}.` }],
        details: {},
      };
    },
  }));

  pi.registerTool(defineTool({
    name: "propose_loop_refine",
    label: "Propose loop spec refinement",
    description: "While a loop is active or safely stopped by a recoverable bound/failure, propose refining its spec — sharpen the target and/or change the measure command — when the current spec no longer captures 'better'. The user confirms; on a measure change the orchestrator test-runs the new command and re-baselines. Never edit the measure command or its inputs directly — that is gaming the metric.",
    parameters: Type.Object({
      target: Type.Optional(Type.String({ description: "The sharpened target text (omit to keep the current target)" })),
      measureCmd: Type.Optional(Type.String({ description: "The new measure command printing ONE number (omit to keep the current metric)" })),
      specText: Type.Optional(Type.String({ description: "v0.33.2: full replacement text for the loop's spec file (respec loops only) — the orchestrator owns the write on user confirm" })),
      specAppend: Type.Optional(Type.String({ description: "v0.33.2: lines to append to the loop's spec file (respec loops only)" })),
      rationale: Type.String({ description: "Why the current spec no longer captures 'better' — shown to the user in the Confirm dialog" }),
    }),
    async execute(_id, params, _signal, _onUpdate, execCtx) {
      const foreign4 = foreignToolGuard(execCtx);
      if (foreign4) return { content: [{ type: "text", text: foreign4 }], details: {} };
      const p = params as { target?: string; measureCmd?: string; specText?: string; specAppend?: string; rationale: string };
      const liveCtx = currentToolContext(execCtx);
      if (!liveCtx) return staleToolResult();
      const loop = state.loop;
      const stoppedRefinable = !!loop && !loop.active && isRefinableStoppedLoopReason(loop.stopReason);
      if (!loop || (!loop.active && !stoppedRefinable)) {
        return { content: [{ type: "text", text: "No refinable loop is available. propose_loop_refine applies while a loop is running or after a recoverable bound/failure stop; clean max-iteration and user-finished loops require /loop start." }], details: {} };
      }
      const wasActive = loop.active;
      const newTarget = p.target?.trim() || loop.target;
      const newMeasure = p.measureCmd?.trim() || loop.measureCmd || "";
      // v0.23.0: a metricless loop can't be refined into a measured one
      // (no direction, no baseline semantics) — stop and restart instead.
      if (!loop.measureCmd && p.measureCmd?.trim()) {
        return { content: [{ type: "text", text: "This loop is metricless — refining it into a measured loop isn't supported. /loop stop, then /loop start with a metric." }], details: {} };
      }
      const specChange = (p.specText?.trim() || p.specAppend?.trim()) ? true : false;
      if (specChange && !loop.specFile) {
        return { content: [{ type: "text", text: "This loop has no spec file (specText/specAppend apply to /loop respec loops). Refine the target instead." }], details: {} };
      }
      if (newTarget === loop.target && newMeasure === loop.measureCmd && !specChange) {
        return { content: [{ type: "text", text: "Refinement proposed no changes — provide a new target, a new measureCmd, a spec change, or any combination." }], details: {} };
      }
      // Measure change → orchestrator test-runs the new command first.
      let newBaseline: number | null = null;
      let testOutput = "";
      if (newMeasure !== loop.measureCmd) {
        if (!extensionApi) return { content: [{ type: "text", text: "No extension API available." }], details: {} };
        try {
          const result = await extensionApi.exec("bash", ["-c", newMeasure], { cwd: liveCtx.cwd, timeout: MEASURE_TIMEOUT_MS });
          testOutput = String((result as any)?.stdout ?? "");
        } catch (e) {
          return { content: [{ type: "text", text: `New measure command failed to run: ${String(e).slice(0, 200)}` }], details: {} };
        }
        newBaseline = parseMetric(testOutput);
        if (newBaseline === null) {
          return {
            content: [{ type: "text", text: `New measure produced NO number — refinement auto-rejected.\nCommand: ${newMeasure}\nOutput: ${testOutput.slice(0, 300) || "(empty)"}\nFix it and propose again.` }],
            details: {},
          };
        }
      }
      let confirmed = false;
      if (loadSettings(liveCtx.cwd).autoAcceptDrafts === true) {
        confirmed = true;
        liveCtx.ui.notify("Loop spec refinement auto-accepted (Auto-accept drafts = on in /glla settings).", "info");
        appendLedger(liveCtx.cwd, "draft_autoaccepted", { kind: "loop-refine" });
      } else {
        try {
          confirmed = (await confirmDraft(
            liveCtx,
            "Confirm loop spec refinement",
          `Rationale: ${sanitizeDisplayText(p.rationale)}\n\nTarget:\n  old: ${displaySlice(loop.target, 120)}\n  new: ${displaySlice(newTarget, 120)}\n\nMeasure:\n  old: ${sanitizeDisplayText(loop.measureCmd ?? "none")}\n  new: ${sanitizeDisplayText(newMeasure)}${newMeasure !== loop.measureCmd ? `\n  test-run: ${sanitizeDisplayText(testOutput).slice(0, 120)} → ${newBaseline}` : ""}${specChange ? `\n\nSpec file (${sanitizeDisplayText(loop.specFile ?? "")}:\n  ${p.specText?.trim() ? `REPLACE with ${p.specText!.trim().length} chars` : ""}${p.specText?.trim() && p.specAppend?.trim() ? " + " : ""}${p.specAppend?.trim() ? `APPEND: ${sanitizeDisplayText(p.specAppend!.trim()).slice(0, 120)}` : ""}` : ""}\n\nThe loop ${wasActive ? "keeps running" : "stays stopped until /loop resume"} against the refined spec (iteration ${loop.iteration} so far). Apply?`,
          )) === "yes";
        } catch {
          confirmed = false;
        }
      }
      if (!confirmed) {
        return { content: [{ type: "text", text: "Refinement rejected by the user. The loop continues against the current spec — keep improving the metric as defined." }], details: {} };
      }
      applyRefinement(loop, {
        at: nowIso(),
        iteration: loop.iteration,
        oldTarget: loop.target,
        newTarget,
        oldMeasureCmd: loop.measureCmd ?? "",
        newMeasureCmd: newMeasure,
      }, newBaseline);
      // v0.33.2: the orchestrator owns the spec write (honesty stays
      // inspectable — the agent never edits the spec it's judged against
      // outside a confirmed refine).
      if (specChange && loop.specFile) {
        try {
          if (p.specText?.trim()) fs.writeFileSync(loop.specFile, p.specText.trim() + "\n");
          if (p.specAppend?.trim()) fs.appendFileSync(loop.specFile, (p.specText?.trim() ? "" : "\n") + p.specAppend.trim() + "\n");
          loop.specHash = specFileHash(loop.specFile) ?? undefined;
          // v0.35.43 (audit finding): re-baseline checkbox progress too —
          // otherwise the next tick sees checked > specChecked against the
          // OLD file's count and ledgers spec_item_progress attributed to
          // the agent's iteration: unearned progress feeding the stuck gate.
          loop.specChecked = countCheckedSpecItems(loop.specFile) ?? undefined;
          appendLedger(liveCtx.cwd, "spec_updated", { via: "refine", iteration: loop.iteration, replaced: Boolean(p.specText?.trim()), appended: Boolean(p.specAppend?.trim()) });
        } catch (e) {
          return { content: [{ type: "text", text: `Spec file write failed: ${String(e).slice(0, 200)}. The target/measure refinement was applied; re-propose the spec change.` }], details: {} };
        }
      }
      persistState(liveCtx);
      appendLedger(liveCtx.cwd, "loop_refined", { iteration: loop.iteration, newTarget, newMeasureCmd: newMeasure, newBaseline, specChanged: specChange || undefined });
      liveCtx.ui.notify(`Loop spec refined at iteration ${loop.iteration}.${newBaseline !== null ? ` New baseline: ${newBaseline}.` : ""}${specChange ? " Spec file updated." : ""}${wasActive ? "" : " Run /loop resume to continue with the preserved history."}`, "info");
      return { content: [{ type: "text", text: wasActive
        ? "Refinement confirmed and applied. Continue improving against the NEW spec — one small change per turn."
        : "Refinement confirmed and applied to the stopped loop. Run /loop resume to continue with the preserved history." }], details: {} };
    },
  }));

  pi.registerTool(defineTool({
    name: "list_add",
    label: "Add to list",
    description: "Add one or many objectives to the /list list (loop 2). Use when the user asks to add work — 'add these to my list', 'queue these 10 things', 'put this on the backlog'. The list is a POOL, not a FIFO: order is the default, not the law — any item can be activated next. Each item becomes an audited goal; per-item 'Done when:' clauses are honored. The first item activates automatically when nothing is running. The list is UNBOUNDED — hundreds of small items are fine; propose them all.",
    parameters: Type.Object({
      items: Type.Array(Type.String(), { description: "Objectives to add — no count limit; large plans belong in ONE call." }),
    }),
    async execute(_id, params, _signal, _onUpdate, execCtx) {
      const foreign5 = foreignToolGuard(execCtx);
      if (foreign5) return { content: [{ type: "text", text: foreign5 }], details: {} };
      const p = params as { items: string[] };
      const liveCtx = currentToolContext(execCtx);
      if (!liveCtx) return staleToolResult();
      if (listMutationBlocked(draftingTarget)) {
        return { content: [{ type: "text", text: LIST_DRAFTING_BLOCK_MESSAGE }], details: {} };
      }
      if (!Array.isArray(p.items) || p.items.length === 0) {
        return { content: [{ type: "text", text: "No items given." }], details: {} };
      }
      const clean = p.items.map((t) => t.trim()).filter((t) => t.length > 0);
      const wasIdle = !state.goal || state.goal.status === "complete" || state.goal.status === "aborted";
      const n = enqueueItems(liveCtx, clean, "agent list_add");
      return {
        content: [{
          type: "text",
          text: wasIdle
            ? `${n} item(s) added; the first is now active. Work it normally and call complete_goal when done — the next item activates automatically.`
            : `${n} item(s) queued (${listQueue().length} waiting behind the active goal).`,
        }],
        details: {},
      };
    },
  }));

  pi.registerTool(defineTool({
    name: "list_activate",
    label: "Activate list item",
    description: "Activate a specific item from the /list queue by position (1-based). Order is the default, not the law: use this when a different item should be worked next (e.g. you want to research item 5 while item 1 waits). Aborts the currently active goal if one is running.",
    parameters: Type.Object({
      n: Type.Number({ description: "1-based position in the queue (1 = head)" }),
    }),
    async execute(_id, params, _signal, _onUpdate, execCtx) {
      const foreign6 = foreignToolGuard(execCtx);
      if (foreign6) return { content: [{ type: "text", text: foreign6 }], details: {} };
      const p = params as { n: number };
      const liveCtx = currentToolContext(execCtx);
      if (!liveCtx) return staleToolResult();
      if (listMutationBlocked(draftingTarget)) {
        return { content: [{ type: "text", text: LIST_DRAFTING_BLOCK_MESSAGE }], details: {} };
      }
      const position = visibleListPosition(listQueue(), p.n);
      if (!position) {
        return { content: [{ type: "text", text: "n must be a visible list position such as 1, 2, or 1.1 for a child item." }], details: {} };
      }
      const targetItem = position.item;
      const rawIndex = position.flatIndex + 1;
      if (targetItem) {
        const incomingWholeList = targetItem.objective + (targetItem.verificationContract ? `\nDone when:\n${targetItem.verificationContract}` : "");
        const conflict = await resolveDraftActivationConflict(liveCtx, "list", incomingWholeList);
        if (conflict !== "proceed") {
          return {
            content: [{ type: "text", text: conflict === "updated" ? "Whole list objective updated; the requested item was not separately activated." : "List activation was cancelled; the current objective was preserved." }],
            details: {},
          };
        }
      }
      if (!activateNextListItem(liveCtx, rawIndex, { explicit: true, displayLabel: position.label })) {
        return { content: [{ type: "text", text: listQueue().length === 0 ? "List is empty." : `No visible item #${position.label} (list has ${visibleListPositions(listQueue()).length} visible items).` }], details: {} };
      }
      return { content: [{ type: "text", text: `Item #${position.label} activated. Work it normally; call complete_goal when done.` }], details: {} };
    },
  }));

  pi.registerTool(defineTool({
    name: "list_status",
    label: "List status",
    description: "Show the active or last terminal list item and the /list list (loop 2) as text: what's running, what's waiting.",
    parameters: Type.Object({}),
    async execute() {
      const lines: string[] = [];
      if (state.goal) {
        const terminal = state.goal.status === "complete" || state.goal.status === "aborted";
        lines.push(`${terminal ? "Last" : "Active"} [${state.goal.policy}] (${statusLabel(state.goal.status)}): ${sanitizeDisplayText(state.goal.objective)}`);
        if (state.goal.repairTarget) {
          lines.push(`Replan target (preserved): ${sanitizeDisplayText(state.goal.repairTarget.objective)}`);
        }
      } else {
        lines.push("Active: (none)");
      }
      const queue = listQueue();
      if (queue.length === 0) {
        lines.push("List: empty.");
      } else {
        lines.push(`List (${queue.length}):`);
        // v0.34.81 (LIGHT parent/child): see /list show — groups render
        // with [group: N open] and children as 1.1/1.2 sub-numbers.
        let flat = 0;
        let omitted = 0;
        for (const item of queue) {
          if (item.parentId) continue;
          if (flat >= 20) { omitted++; continue; }
          const children = queue.filter((c: any) => c.parentId === item.id);
          const open = groupOpenChildren(item.id);
          flat++;
          const labels: string[] = [];
          if (item.parallelSafe) labels.push("parallel");
          if (open > 0) labels.push(`group: ${open} open`);
          const tag = labels.length ? ` [${labels.join(", ")}]` : "";
          lines.push(`${flat}. ${sanitizeDisplayText(item.objective)}${tag}`);
          if (item.repairTarget) {
            lines.push(`   ↳ REPLAN TARGET: ${sanitizeDisplayText(item.repairTarget.objective)}`);
          }
          children.forEach((c: any, ci: number) =>
            lines.push(`   ${flat}.${ci + 1} ${sanitizeDisplayText(c.objective)}${c.parallelSafe ? " [parallel]" : ""}`),
          );
        }
        if (omitted > 0) lines.push(`… and ${omitted} more top-level item(s)`);
      }
      if (state.loop) {
        lines.push(`Loop: ${state.loop.active ? "active" : "stopped"} — ${sanitizeDisplayText(state.loop.target)} (best ${state.loop.bestValue ?? "n/a"}, iteration ${state.loop.iteration})`);
      }
      return { content: [{ type: "text", text: lines.join("\n") }], details: {} };
    },
  }));

  pi.registerTool(defineTool({
    name: "propose_task_list",
    label: "Propose task list",
    description: "Propose a task breakdown for the active goal. During a repair/replan card, include the concrete objective being redrafted. Opens the user's Confirm dialog. Limits: 20 top-level tasks, 5 subtasks per task.",
    parameters: Type.Object({
      objective: Type.Optional(Type.String({ description: "Required for a repair/replan card: the concrete original target being restored." })),
      tasks: Type.Array(Type.Object({
        title: Type.String(),
        agentRole: Type.Optional(Type.Literal("designer", { description: "Route this task through the read-only Designer subagent before implementation." })),
        verificationContract: Type.Optional(Type.String({ description: "Optional verification gate command for this milestone before it can be marked complete." })),
        subtasks: Type.Optional(Type.Array(Type.String())),
      })),
    }),
    async execute(_id, params, _signal, _onUpdate, execCtx) {
      const foreign9 = foreignToolGuard(execCtx);
      if (foreign9) return { content: [{ type: "text", text: foreign9 }], details: {} };
      if (!state.goal || state.goal.status !== "active") {
        return { content: [{ type: "text", text: "No active goal to break down." }], details: {} };
      }
      if (state.goal.taskList && state.goal.taskList.tasks.length > 0 && !state.goal.repairTarget) {
        return { content: [{ type: "text", text: "A task list already exists. Use update_task_status / complete_task to work it." }], details: {} };
      }
      const p = params as { objective?: string; tasks: TaskProposal[] };
      const liveCtx = currentToolContext(execCtx);
      if (!liveCtx) return staleToolResult();
      const repairTarget = state.goal.repairTarget;
      const redraftedObjective = p.objective?.trim() ?? "";
      if (repairTarget) {
        if (!redraftedObjective) {
          return { content: [{ type: "text", text: "This is a repair/replan card. Include a concrete `objective` in propose_task_list so the original target is not lost." }], details: {} };
        }
        const assessment = assessSuspiciousObjective(redraftedObjective, repairTarget.verificationContract);
        if (assessment.suspicious) {
          return { content: [{ type: "text", text: `The replacement objective is still too weak (${assessment.reasons.join(", ")}). Redraft it as a concrete target, not reviewer instructions.` }], details: {} };
        }
      }
      const invalid = validateTaskProposal(p.tasks);
      if (invalid) {
        return { content: [{ type: "text", text: invalid }], details: {} };
      }
      const preview = `${redraftedObjective ? `Objective: ${redraftedObjective}\n\n` : ""}${p.tasks.map((t, i) => {
        const subs = (t.subtasks ?? []).map((s, j) => `   ${i + 1}.${j + 1} ${s}`).join("\n");
        return `${i + 1}. ${t.title}${t.agentRole ? ` [${t.agentRole}]` : ""}` + (subs ? `\n${subs}` : "");
      }).join("\n")}`;
      const autoAcceptTasks = loadSettings(liveCtx.cwd).autoAcceptDrafts === true;
      let confirmed = false;
      if (autoAcceptTasks) {
        confirmed = true;
        liveCtx.ui.notify(`Task list auto-accepted (Auto-accept drafts = on in /glla settings): ${p.tasks.length} tasks.`, "info");
        appendLedger(liveCtx.cwd, "draft_autoaccepted", { kind: "tasks", count: p.tasks.length });
      } else {
        try {
          confirmed = (await confirmDraft(liveCtx, "Confirm task list", preview)) === "yes";
        } catch {
          confirmed = false;
        }
      }
      if (!confirmed) {
        return { content: [{ type: "text", text: "Task list rejected by the user. Adjust and propose again." }], details: {} };
      }
      const taskList = buildTaskList(p.tasks);
      if (repairTarget) {
        const prior = state.goal;
        const parsed = extractVerificationContract(redraftedObjective);
        updateGoal({
          objective: parsed.objective,
          ...(parsed.verificationContract ? { verificationContract: parsed.verificationContract } : repairTarget.verificationContract ? { verificationContract: repairTarget.verificationContract } : {}),
          taskList,
          repairTarget: undefined,
          objectiveProvenance: {
            originalObjective: repairTarget.objective,
            ...(repairTarget.verificationContract ? { originalContract: repairTarget.verificationContract } : {}),
            userSeeds: [...(prior.objectiveProvenance?.userSeeds ?? []), redraftedObjective].slice(-10),
          },
        }, liveCtx);
        appendLedger(liveCtx.cwd, "faulty_objective_replanned", {
          goalId: prior.id,
          targetId: repairTarget.id,
          objective: parsed.objective,
          reasons: repairTarget.reasons,
          taskCount: taskList.tasks.length,
        });
        liveCtx.ui.notify(`Repair target restored and task list accepted: ${parsed.objective.slice(0, 120)}`, "info");
        // v0.35.5: the source fragment that triggered this repair card is
        // resolved by the user-confirmed redraft. Consume it from the queue
        // (in-memory list + disk sidecar) so it cannot re-spawn a fresh
        // repair incarnation after this goal is archived. Without this,
        // every repair-card completion resurrected the same fragment forever
        // (uuy2pz -> 4yi9kq -> ... in the 2026-08-16 DECIDE-fragment loop).
        // Guard: only consume when the queued item is still the original
        // fragment — if the user edited the item meanwhile, their edit wins.
        const srcId = repairTarget.id;
        const queuedSrc = listQueue().find((q: NonNullable<State["list"]>[number]) => q.id === srcId);
        if (queuedSrc && queuedSrc.objective === repairTarget.objective && !queuedSrc.repairTarget) {
          const deletedSource = deleteQueueItemFileResult(liveCtx.cwd, srcId);
          if (deletedSource.failed) {
            appendLedger(liveCtx.cwd, "faulty_objective_source_consume_failed", { targetId: srcId, path: deletedSource.path });
            liveCtx.ui.notify("The repaired source item remains queued because its durable sidecar could not be removed. Fix disk access and retry the repair completion.", "warning");
            return {
              content: [{ type: "text", text: "Repair accepted, but the original source item was kept queued because its durable sidecar could not be removed." }],
              details: {},
            };
          }
          replaceState({ ...state, list: listQueue().filter((q: NonNullable<State["list"]>[number]) => q.id !== srcId) });
          persistState(liveCtx);
          appendLedger(liveCtx.cwd, "faulty_objective_source_consumed", {
            targetId: srcId,
            objective: repairTarget.objective,
          });
        }
      } else {
        updateGoal({ taskList }, liveCtx);
      }
      const subCount = taskList.tasks.reduce((n, t) => n + (t.subtasks?.length ?? 0), 0);
      return {
        content: [{ type: "text", text: `Task list set: ${taskList.tasks.length} tasks, ${subCount} subtasks. Track progress with complete_task / update_task_status.` }],
        details: {},
      };
    },
  }));
}

// =================================================================
// Settings (auditor model, thinking level)
// =================================================================

/**
 * Session thinking level with a "high" floor (v0.8.5): the auditor follows
 * the thinking level the user selected in pi; if none is set, audits run at
 * "high" — the auditor is the verification gate, depth beats speed there.
 */
/**
 * Resolve the ordered auditor model candidates. The user controls the pins:
 * primary auditor model from `/glla` settings, ordered fallback models, then
 * the pi session model as the final candidate. Runtime failures advance through the
 * same list in `runDetachedCompletionWithFallback`; the plugin never silently
 * invents a provider or falls back into the parent in-process session.
 *
 * If the session model's provider is extension-registered, the detached
 * extension-less worker may not be able to auth it; that failure remains a
 * loud, bounded infrastructure result with the exact model-fix guidance.
 */
/** v0.31.3: the auditor model chain — pinned primary, ordered fallbacks,
 * session model LAST (user design 2026-07-31: "it can be the primary auditor
 * and the session model is always the last; we can have fallback auditors
 * too" + "if the session model is the same as the auditor we auto fallback").
 * Explicit pins and a cascade — no preference tables, no strategy
 * resolution (the v0.31.2 diverse-strategy machinery cost more complexity than it
 * bought; it lasted one version). Every hop is LOUD (ledger + notify): the
 * v0.9.12 no-SILENT-substitution law.
 */
/** v0.31.8: the auditor thinking options are derived from the PICKED
 * model, not a hardcoded list — same rule as pi's own thinking selector
 * (pi-ai getSupportedThinkingLevels): non-reasoning models expose only
 * "off"; xhigh/max exist only when the model maps them (thinkingLevelMap).
 * Replicated inline so the extension's older pi-ai dev-types don't matter —
 * the fields are read at runtime from the user's installed pi. */


/* Runtime globals: preserve the old monolith lexical links across extracted modules. */
defineGoalRuntimeGlobal("registerAgentTools", { get: () => registerAgentTools });
