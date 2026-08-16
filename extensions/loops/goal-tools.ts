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
      archiveCurrentGoal(ctx, "aborted", `replaced by new ${incoming} objective`);
    }
  }
  return "proceed";
}

function registerAgentTools(pi: any): void {
  pi.registerTool(defineTool({
    name: "complete_goal",
    label: "Complete goal",
    description: "Mark the active goal as complete. Queues a detached auditor worker to verify without holding the main pi turn. Use only when the objective is genuinely satisfied.",
    parameters: Type.Object({
      completionSummary: Type.Optional(Type.String({ description: "1-paragraph completion claim" })),
      verificationSummary: Type.Optional(Type.String({ description: "Per-item evidence for the verification contract" })),
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
        // v0.34.87: a paused item IS a goal — the old flat "No active
        // goal." read as if the paused card in the widget were nothing at
        // all (note.md Screenshots 161659/161718: complete_goal answered
        // "No active goal" while the session clearly held a paused item).
        // Name the actual state and the resume verb: surface separation
        // between "no goal" and "goal parked".
        if (state.goal.status === "paused") {
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
            userSeeds: [...(priorProvenance?.userSeeds ?? []), rawNewObjective].slice(-10),
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
          ctx.ui.notify(`Goal archived as aborted — completionSummary indicated the work was ${matchedPhrase}; no new work shipped in this turn.`, "info");
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
      updateGoal({ pendingTasks: undefined, ...(finalSummary ? { completionSummary: finalSummary } : {}) }, ctx);
      const auditGoal = state.goal;
      if (!auditGoal) return staleToolResult();
      const auditGoalId = auditGoal.id;
      const auditAttemptId = completionClaim.attemptId!;
      const settings = loadSettings(ctx.cwd);
      const { model: auditorModel, error: modelError, via, fallbackModels } = resolveAuditorModel(ctx, settings.auditorModel, settings.auditorModelFallback, settings.auditorSameSessionSwap !== false);
      if (modelError) {
        const modelFailureCopy = providerErrorPresentation(modelError, "completion");
        ctx.ui.notify(`Auditor model issue: ${modelFailureCopy.display}. ${modelFailureCopy.action}`, "warning");
        appendLedger(ctx.cwd, "auditor_model_issue", { error: modelFailureCopy.diagnostic, display: modelFailureCopy.display });
      }
      const auditorCandidates: AuditorModelCandidate[] = [{ model: auditorModel, via: via ?? "unset" }, ...(fallbackModels ?? [])];
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
      latestAuditProgress = { label: "queued", lastEventAt: Date.now() };
      refreshUI(ctx);
      void (async () => {
      const runAudit = (candidate: AuditorModelCandidate) =>
        runDetachedGoalCompletionAuditor({
          cwd: ctx.cwd,
          goal: auditGoal,
          completionSummary: finalSummary,
          verificationSummary: p.verificationSummary,
          model: candidate.model,
          thinkingLevel: (settings.auditorThinkingLevel ?? "high") as any, // may be "max" — pi ≥0.83 understands it; the dev-types predate it
          runtime: { attemptId: () => newDetachedAuditJobAttemptId(completionClaim.attemptId!), logicalAttemptId: completionClaim.attemptId!, wallTimeoutMs: AUDITOR_WALL_TIMEOUT_MS },
          onProgress: (progress) => {
            publishDetachedAuditProgress(auditGeneration, auditGoalId, auditAttemptId, progress);
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
      // v0.25.4 (post-audit fix): a retriable infra failure (stream error,
      // auth blip — NOT user abort, NOT missing model) gets ONE automatic
      // retry with backoff before we report "auditor infrastructure error
      // (retried once)". Neither attempt is a verdict on the work.
      const auditStartMs = Date.now();
      let result: Awaited<ReturnType<typeof runAudit>>;
      let retriedOnce = false;
      let fallbackUsed = false;
      try {
        ({ result, retriedOnce, fallbackUsed } = await runDetachedCompletionWithFallback(auditorCandidates, runAudit, {
          shouldRetry: () => detachedAuditContext(auditGeneration, auditGoalId, auditAttemptId) !== null,
          onRetry: (candidate: AuditorModelCandidate, err: string) => {
            const current = detachedAuditContext(auditGeneration, auditGoalId, auditAttemptId);
            if (!current) return;
            const failureCopy = providerErrorPresentation(err, "completion");
            latestAuditProgress = { label: `${failureCopy.display} — retrying once`, lastEventAt: Date.now() };
            refreshUI(current);
            appendLedger(current.cwd, "audit_infra_retry", { goalId: auditGoalId, model: auditorCandidateLabel(candidate), error: failureCopy.diagnostic.slice(0, 200), diagnostic: failureCopy.diagnostic });
          },
          onFallback: (from: AuditorModelCandidate, to: AuditorModelCandidate, err: string) => {
            const current = detachedAuditContext(auditGeneration, auditGoalId, auditAttemptId);
            if (!current) return;
            appendLedger(current.cwd, "auditor_runtime_model_fallback", { goalId: auditGoalId, from: auditorCandidateLabel(from), to: auditorCandidateLabel(to), error: err.slice(0, 200) });
            current.ui.notify(`Detached auditor failed on ${auditorCandidateLabel(from)} — retrying with ${auditorCandidateLabel(to)}. This is infrastructure, not a verdict.`, "warning");
          },
        }));
      } finally {
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
      if (state.goal.pendingCompletion?.attemptId !== auditAttemptId) {
        return staleToolResult();
      }
      ctx = auditContextAfterRun;
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
        history.push({
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
        } as any);
        // Cap history — 39 infra errors taught us unbounded growth is real.
        if (history.length > 20) history.splice(0, history.length - 20);
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
          updateGoal({ auditHistory: history, pendingCompletion: undefined }, ctx);
          archiveCurrentGoal(ctx, "complete", "completed without audit (user choice after Esc)");
          return { content: [{ type: "text", text: "Goal marked complete without audit (user choice)." }], details: {} };
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
        const recapSrc = state.goal.completionSummary?.trim()
          ? state.goal.completionSummary.replace(/\s+/g, " ")
          : state.goal.objective;
        const recap = displaySlice(recapSrc, 110);
        archiveCurrentGoal(ctx, "complete", `auditor ${result.model} approved`);
        ctx.ui.notify(`✓ done: ${recap} — auditor ${result.model} approved.`, "info");
        notifyExternal(ctx, `Goal complete (auditor approved): ${displaySlice(recapSrc, 120)}`);
        return { content: [{ type: "text", text: `Goal approved by auditor ${result.model}.` }], details: {} };
      }

      // IMPOSSIBLE (v0.24.2, Claude-Code lesson): the auditor's escape hatch
      // for goals that can NEVER be satisfied as stated. Not a disapproval —
      // continuing would burn tokens on a provably unwinnable objective.
      // Bounded and surfaced: the goal pauses and the user decides.
      if (result.impossible) {
        const reason = result.impossibleReason || "(no reason given)";
        // v0.25.0 (contract item 23): under aggressiveMode, a PARTIAL
        // impossible (some items can't ship) keeps the loop going — the
        // agent narrows to the remainder. A FULL impossible still pauses:
        // auto-resuming a provably unwinnable objective just burns tokens.
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
        updateGoal({
          status: "paused",
          auditHistory: history,
          pendingCompletion: undefined,
          pauseKind: "decision",
          pauseOptions: [`Tweak the objective — ${activeGoalSurfaceCommand("tweak")} <new text>`, `Cancel the goal (${activeGoalSurfaceCommand("cancel")})`],
          pauseRecommended: 1,
          pauseReason: `auditor verdict: IMPOSSIBLE — ${reason}`,
          pauseSuggestedAction: `The auditor says this goal can never be satisfied as stated. ${activeGoalSurfaceCommand("tweak")} the objective (or ${activeGoalSurfaceCommand("cancel")}), then ${activeGoalSurfaceCommand("resume")}.`,
        }, ctx);
        ctx.ui.notify(`Auditor: goal IMPOSSIBLE — ${reason}. Goal paused; ${activeGoalSurfaceCommand("tweak")} or ${activeGoalSurfaceCommand("cancel")}, then ${activeGoalSurfaceCommand("resume")}.`, "warning");
        maybeDecisionPopup(ctx);
        appendLedger(ctx.cwd, "goal_paused", { reason: `auditor impossible: ${reason}` });
        notifyExternal(ctx, `Goal paused (auditor: impossible): ${reason.slice(0, 120)}`);
        return {
          content: [{
            type: "text",
            text: `The auditor's verdict is IMPOSSIBLE: ${reason}\n\nThis is not a disapproval — the auditor says the objective can never be satisfied as stated. The goal is now PAUSED. Do not call complete_goal again. Report the verdict to the user and suggest ${activeGoalSurfaceCommand("tweak")} (narrow or correct the objective) or ${activeGoalSurfaceCommand("cancel")}.`,
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
        if (isAuditorNoVerdictInfrastructureError(result.error, result.infrastructureClass)) {
          const failureCopy = providerErrorPresentation(result.error, "completion");
          const recoveryEpisodeKey = completionClaim.recoveryEpisodeKey ?? `${completionClaim.at}:${failureCopy.fingerprint}`;
          let pending: PendingCompletion = {
            ...completionClaim,
            phase: "recovery-pending",
            recoveryAt: nowIso(),
            recoveryReason: result.error.startsWith("Auditor exceeded")
              ? "wall-timeout"
              : result.error.startsWith("Auditor stalled")
                ? "inactivity-timeout"
                : "auditor-no-verdict",
            providerErrorDiagnostic: failureCopy.diagnostic,
            recoveryEpisodeKey,
            recoveryNoticeKeys: completionClaim.recoveryNoticeKeys ?? [],
            automaticRecoveryAttempted: completionClaim.automaticRecoveryAttempted ?? false,
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
        // v0.34.51: ANY infrastructure failure enters the durable bounded
        // retry plan — error text is not trusted to pick one failure family,
        // so
        // "still failing" pauses with the same uniform retry schedule.
        if (result.error && !result.disapproved) {
          const failureCopy = providerErrorPresentation(result.error, "completion");
          const recoveryEpisodeKey = completionClaim.recoveryEpisodeKey ?? `${completionClaim.at}:${failureCopy.fingerprint}`;
          const plan = auditorRetryPlan(completionClaim);
          const pending = {
            ...completionClaim,
            phase: "retry-waiting" as const,
            recoveryAt: undefined,
            recoveryReason: undefined,
            recoveryRetryAt: undefined,
            providerErrorDiagnostic: failureCopy.diagnostic,
            recoveryEpisodeKey,
            recoveryNoticeKeys: completionClaim.recoveryNoticeKeys ?? [],
            retryAttempts: plan.attempt,
            retryFirstAt: plan.firstAt,
            retryUntil: plan.autoRetryUntil,
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
              updateGoal({ status: "active", pauseKind: undefined, pauseResumeAt: undefined, pauseReason: undefined, pauseSuggestedAction: undefined }, fresh);
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
        // v0.34.51: the durable bounded retry plan above owns ALL infra
        // failures now (timeouts keep their own branch). The old 3-strike
        // "auditor model is likely broken" stop is gone: "keep retrying"
        // until the plan's horizon, then the blocked pause asks the user.
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
      const trailingDisapprovals = countTrailingDisapprovals(history);
      if (auditCap > 0 && trailingDisapprovals >= auditCap) {
        // v0.25.0 (contract item 22): aggressiveMode turns the cap into a
        // TODO list and keeps going — the objections become pendingTasks
        // rendered into every continuation until addressed. OFF preserves
        // the pause (contract item 24 test 2).
        if (effectiveCap.aggressiveMode) {
          const pendingTasks = extractPendingTasks(safeAuditOutput, 5);
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
        const recoveryEpisodeKey = completionClaim.recoveryEpisodeKey ?? `${completionClaim.at}:${failureCopy.fingerprint}`;
        let pending: PendingCompletion = {
          ...completionClaim,
          phase: "recovery-pending",
          recoveryAt: nowIso(),
          recoveryReason: "auditor-infrastructure",
          providerErrorDiagnostic: failureCopy.diagnostic,
          recoveryEpisodeKey,
          recoveryNoticeKeys: completionClaim.recoveryNoticeKeys ?? [],
          automaticRecoveryAttempted: completionClaim.automaticRecoveryAttempted ?? false,
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
    name: "pause_goal",
    label: "Pause goal",
    description: "Pause the active goal with a reason and suggested action. Use when blocked on user input or unable to make progress. When the user must CHOOSE between options, pass kind=\"decision\" with the options list (recommended = 1-based index of the best one) — decision pauses render as a prominent DECISION NEEDED card. Time-gated waits (retry at a specific time) use kind=\"wait\" with resumeAt (ISO). Operational failures use kind=\"error\". VOCABULARY (v0.28.24): decision options and reasons must reference REAL commands only — /goal resume, /goal cancel, /goal tweak \"<new text>\", /list remove N, /list next, /list resume, /loop stop, /loop resume. These all act on the ACTIVE goal/item: there is NO /goal drop and NO command takes a goal id. Never show goal ids to the user — name the thing ('the active goal', 'list item \"<short name>\"'); ids are internal plumbing the user cannot act on.",
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
      if (!state.goal) return { content: [{ type: "text", text: "No active goal." }], details: {} };
      // A late model/tool call from the previous turn must not overwrite a
      // paused or auditing lifecycle. That race made a genuine stop look
      // repeatable and could erase an in-flight detached-auditor state.
      if (state.goal.status !== "active") {
        return { content: [{ type: "text", text: `Goal is already ${state.goal.status}; pause request ignored.` }], details: {} };
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
        droppedImpossible = true;
        const impossible = state.goal;
        appendLedger(ctx.cwd, "list_item_impossible", {
          itemId: impossible.id,
          reason: p.reason,
          objective: impossible.objective,
        });
        // The item was already taken out of the queue at activation — the
        // drop records the decision; the queue advances past it below.
        appendLedger(ctx.cwd, "list_item_auto_dropped", {
          itemId: impossible.id,
          objective: impossible.objective,
          reason: "blocked with no resume path",
        });
        const droppedLabel = displaySlice(impossible.objective, 60);
        const remaining = listQueue().length;
        if (remaining > 0 && !isLoopActive()) {
          const advanced = activateNextListItem(ctx);
          ctx.ui.notify(
            advanced
              ? `List item auto-dropped as impossible (blocked with no resume path): ${droppedLabel} — advancing to the next item (${remaining} remaining).`
              : `List item auto-dropped as impossible (blocked with no resume path): ${droppedLabel} — could not auto-advance (${remaining} remaining).`,
            "warning",
          );
        } else if (remaining === 0) {
          ctx.ui.notify(`List item auto-dropped as impossible (blocked with no resume path): ${droppedLabel} — the list is now empty; add more with /list add.`, "warning");
        } else {
          ctx.ui.notify(`List item auto-dropped as impossible (blocked with no resume path): ${droppedLabel} — a running loop holds the surface; the item stays dropped.`, "warning");
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
            `Pause scheduled for ~${hours}h. If the objective no longer matches your intent, run ${activeGoalSurfaceCommand("tweak")} to replace it now; otherwise ${activeGoalSurfaceCommand("resume")} continues automatically when the wait ends.`,
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
      return {
        content: [{
          type: "text",
          text: droppedImpossible
            ? "The list item was auto-dropped as impossible (blocked with no resume path) — the list moved on instead of stopping."
            : `Goal paused. ${activeGoalSurfaceCommand("resume")} to continue.`,
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
    async execute(_id, params, _signal, _onUpdate, execCtx) {
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
    async execute(_id, params, _signal, _onUpdate, execCtx) {
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
      resolveCarryover(liveCtx, "goal"); // v0.28.14: surface/clear stale leftovers
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
        const extracted = parseListItemDeclaration(full);
        const item = {
          id: newGoalId(),
          objective: extracted.objective,
          ...(extracted.agentRole ? { agentRole: extracted.agentRole } : {}),
          verificationContract: extracted.verificationContract || undefined,
          ...(extracted.parallelSafe === undefined ? {} : { parallelSafe: extracted.parallelSafe }),
          addedAt: nowIso(),
        };
        // v0.34.61: disk-first — same invariant as addSingleItem. The list
        // draft path was the second-missed place: previously the in-memory
        // state mutated without a sidecar, so a torn-rename or post-mutation
        // crash could drop the drafted item.
        writeQueueItemFile(liveCtx.cwd, item);
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
    description: "During loop drafting (/loop with no args), propose the loop configuration. The orchestrator test-runs the measure command ONCE and shows the user real output + parsed number in a Confirm dialog. A measure producing no number is auto-rejected. Omit measureCmd (or pass \"none\") for a metricless spec loop — no plateau stop; ends only at bounds or /loop stop.",
    parameters: Type.Object({
      target: Type.String({ description: "What to improve, concretely" }),
      measureCmd: Type.Optional(Type.String({ description: 'Shell command that prints ONE number representing progress — or the literal "none" for a metricless spec loop' })),
      direction: Type.Optional(Type.Union([Type.Literal("min"), Type.Literal("max")], { description: "min = lower is better, max = higher is better (omit for a metricless loop)" })),
      window: Type.Optional(Type.Number({ description: "Plateau stop after N non-improving iterations (default 5)" })),
      max: Type.Optional(Type.Number({ description: "Iteration cap (default 50)" })),
      time: Type.Optional(Type.Number({ description: "Arbitrary bound: stop after this many hours" })),
      tokens: Type.Optional(Type.Number({ description: "Arbitrary bound: stop after this many tokens (input+output)" })),
      branch: Type.Optional(Type.Boolean({ description: "branch=true: scratch-branch mode (clean git tree required)" })),
    }),
    async execute(_id, params, _signal, _onUpdate, execCtx) {
      const foreign3 = foreignToolGuard(execCtx);
      if (foreign3) return { content: [{ type: "text", text: foreign3 }], details: {} };
      const p = params as { target: string; measureCmd?: string; direction?: "min" | "max"; window?: number; max?: number; time?: number; tokens?: number; branch?: boolean };
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
          const result = await extensionApi.exec("bash", ["-c", p.measureCmd!], { cwd: liveCtx.cwd });
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
            ? `Target: ${sanitizeDisplayText(p.target.trim())}\n\nMeasure: NONE — metricless spec loop. There is NO plateau stop: the loop ends only at ${max > 0 ? `${max} iterations` : "NO iteration cap"}${typeof p.time === "number" && p.time > 0 ? ` · Time bound: ${p.time}h` : ""}${typeof p.tokens === "number" && p.tokens > 0 ? ` · Token bound: ${p.tokens.toLocaleString()}` : ""} · /loop stop.${p.branch ? "\nbranch mode: scratch branch, every iteration committed (clean tree required)" : ""}\n\nEvery iteration must make ONE real, inspectable change — cosmetic churn is the known failure mode (doorknob-polishing). Start it?`
            : `Target: ${sanitizeDisplayText(p.target.trim())}\n\nMeasure: ${sanitizeDisplayText(p.measureCmd ?? "")}\nTest-run output: ${sanitizeDisplayText(rawOutput).slice(0, 200)}\nParsed number: ${parsed} (${p.direction === "min" ? "lower is better" : "higher is better"})\n\nPlateau stop: ${window} non-improving iterations · Cap: ${max > 0 ? `${max} iterations` : "none (unbounded)"}${typeof p.time === "number" && p.time > 0 ? ` · Time bound: ${p.time}h` : ""}${typeof p.tokens === "number" && p.tokens > 0 ? ` · Token bound: ${p.tokens.toLocaleString()}` : ""}${p.branch ? "\nbranch mode: scratch branch (clean tree required)" : ""}\n\nThe loop never completes — it runs until one of these bounds, plateau, or /loop stop. Start it?`,
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
    description: "While a loop is ACTIVE, propose refining the loop's spec — sharpen the target and/or change the measure command — when the current spec no longer captures 'better'. The user confirms; on a measure change the orchestrator test-runs the new command and re-baselines. Never edit the measure command or its inputs directly — that is gaming the metric.",
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
      if (!loop?.active) {
        return { content: [{ type: "text", text: "No active loop to refine. propose_loop_refine is only valid while a loop is running." }], details: {} };
      }
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
          const result = await extensionApi.exec("bash", ["-c", newMeasure], { cwd: liveCtx.cwd });
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
          `Rationale: ${sanitizeDisplayText(p.rationale)}\n\nTarget:\n  old: ${displaySlice(loop.target, 120)}\n  new: ${displaySlice(newTarget, 120)}\n\nMeasure:\n  old: ${sanitizeDisplayText(loop.measureCmd ?? "none")}\n  new: ${sanitizeDisplayText(newMeasure)}${newMeasure !== loop.measureCmd ? `\n  test-run: ${sanitizeDisplayText(testOutput).slice(0, 120)} → ${newBaseline}` : ""}${specChange ? `\n\nSpec file (${sanitizeDisplayText(loop.specFile ?? "")}:\n  ${p.specText?.trim() ? `REPLACE with ${p.specText!.trim().length} chars` : ""}${p.specText?.trim() && p.specAppend?.trim() ? " + " : ""}${p.specAppend?.trim() ? `APPEND: ${sanitizeDisplayText(p.specAppend!.trim()).slice(0, 120)}` : ""}` : ""}\n\nThe loop keeps running against the refined spec (iteration ${loop.iteration} so far). Apply?`,
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
          appendLedger(liveCtx.cwd, "spec_updated", { via: "refine", iteration: loop.iteration, replaced: Boolean(p.specText?.trim()), appended: Boolean(p.specAppend?.trim()) });
        } catch (e) {
          return { content: [{ type: "text", text: `Spec file write failed: ${String(e).slice(0, 200)}. The target/measure refinement was applied; re-propose the spec change.` }], details: {} };
        }
      }
      persistState(liveCtx);
      appendLedger(liveCtx.cwd, "loop_refined", { iteration: loop.iteration, newTarget, newMeasureCmd: newMeasure, newBaseline, specChanged: specChange || undefined });
      liveCtx.ui.notify(`Loop spec refined at iteration ${loop.iteration}.${newBaseline !== null ? ` New baseline: ${newBaseline}.` : ""}${specChange ? " Spec file updated." : ""}`, "info");
      return { content: [{ type: "text", text: "Refinement confirmed and applied. Continue improving against the NEW spec — one small change per turn." }], details: {} };
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
      const n = Math.floor(p.n);
      if (!Number.isInteger(n) || n < 1) {
        return { content: [{ type: "text", text: "n must be a positive integer (1-based position)." }], details: {} };
      }
      const targetItem = listQueue()[n - 1];
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
      if (!activateNextListItem(liveCtx, n, { explicit: true })) {
        return { content: [{ type: "text", text: listQueue().length === 0 ? "List is empty." : `No item #${n} (list has ${listQueue().length} items).` }], details: {} };
      }
      return { content: [{ type: "text", text: `Item #${n} activated. Work it normally; call complete_goal when done.` }], details: {} };
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
          deleteQueueItemFile(liveCtx.cwd, srcId);
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
 * primary auditor model from `/glla` settings, optional fallback pin, then
 * the pi
 * session model as the final candidate. Runtime failures advance through the
 * same list in `runDetachedCompletionWithFallback`; the plugin never silently
 * invents a provider or falls back into the parent in-process session.
 *
 * If the session model's provider is extension-registered, the detached
 * extension-less worker may not be able to auth it; that failure remains a
 * loud, bounded infrastructure result with the exact model-fix guidance.
 */
/** v0.31.3: the auditor model chain — pinned primary, pinned fallback,
 * session model LAST (user design 2026-07-31: "it can be the primary auditor
 * and the session model is always the last; we can have a fallback auditor
 * too" + "if the session model is the same as the auditor we auto fallback").
 * Two explicit pins and a cascade — no preference tables, no strategy
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
