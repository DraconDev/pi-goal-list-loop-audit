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
  providerErrorPresentation,
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
  MAX_MAIN_MODEL_FALLBACKS,
  modelRef,
  normalizeModelRefs,
  normalizeMainModelFallbackRefs,
} from "../main-model-recovery.js";
import {
  globalSettingsPath,
  loadGlobalSettings,
  loadSettings,
  projectSettingsPath,
  saveSettings as persistSettings,
  settingsProvenance,
  type Settings,
} from "../goal-settings.js";
import { ModelSelector } from "../model-selector.js";

let settingsEditContext: ExtensionContext | null = null;

/** Recheck session admission immediately before every settings write. The
 * editor itself awaits user input, so a replacement can happen after the
 * menu-entry probe but before the selected value is saved.
 *
 * Normal menu rows edit the effective setting. A project value therefore must
 * be written back to the project file; otherwise a global write is hidden by
 * the still-effective project override and the UI appears not to save. The
 * explicit project path remains available for toolOverrides/postaudit, while
 * global-only keys never acquire a project destination because provenance
 * filters them out in goal-settings.ts.
 */
function saveSettings(scope: "global" | "project", cwd: string, patch: Partial<Settings>): void {
  const probe = (globalThis as any).warnIfStaleAtEntry as ((ctx: ExtensionContext, what: string) => boolean) | undefined;
  if (settingsEditContext && typeof probe === "function" && probe(settingsEditContext, "settings save")) return;
  if (scope === "project") {
    persistSettings(scope, cwd, patch);
    return;
  }

  const provenance = settingsProvenance(cwd);
  const globalPatch: Record<string, unknown> = {};
  const projectPatch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    const destination = provenance[key as keyof Settings]?.source === "project"
      ? projectPatch
      : globalPatch;
    destination[key] = value;
  }
  if (Object.keys(projectPatch).length > 0) persistSettings("project", cwd, projectPatch as Partial<Settings>);
  if (Object.keys(globalPatch).length > 0) persistSettings("global", cwd, globalPatch as Partial<Settings>);
}

/** Parse the unsigned integer syntax used by the numeric settings editors.
 * Number.parseInt("15minutes", 10) silently accepted malformed input; a
 * settings editor must either save the complete value or reject it. */
function parseSettingsInteger(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  const value = Number(trimmed);
  return Number.isSafeInteger(value) ? value : undefined;
}

/**
 * v0.37.0: parse a millisecond-valued setting as either a plain integer of ms or a compact duration with an
 * s/m/h suffix ("90s", "15m", "1h"). Returns undefined for anything unparseable.
 */
export function parseSettingsDurationMs(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (/^\d+$/.test(trimmed)) return Number.isSafeInteger(Number(trimmed)) ? Number(trimmed) : undefined;
  const match = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h)$/.exec(trimmed);
  if (!match) return undefined;
  const mult = match[2] === "ms" ? 1 : match[2] === "s" ? 1_000 : match[2] === "m" ? 60_000 : 3_600_000;
  const ms = Math.round(Number(match[1]) * mult);
  return Number.isFinite(ms) && ms > 0 ? ms : undefined;
}
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
  AUDIT_JOB_CLEANUP_MIN_AGE_MS,
  DEFAULT_AUDITOR_STALL_MS,
  DEFAULT_AUDITOR_TOOL_TIMEOUT_MS,
  MAX_AUDIT_JOB_RETENTION_MS,
  MAX_AUDITOR_STALL_MS,
  MAX_AUDITOR_TOOL_TIMEOUT_MS,
  MIN_AUDITOR_STALL_MS,
  MIN_AUDITOR_TOOL_TIMEOUT_MS,
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
  OVERRIDABLE_AGENT_TYPES,
  resolveEffectiveSubagentModel,
  syncSubagentModelOverrides,
  type SubagentModelStrategy,
} from "../goal-loop-subagents.js";
import type { SubagentDisplayRichness } from "../goal-settings.js";
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
import {
  MultiModelPickerComponent,
  type MultiModelPickerResult,
} from "../multi-model-picker.js";
import { consumeRecoveryResume } from "../goal-recovery.js"; // decomposition step 3 (v0.34.111)
import {
  discoverAuditorExtensions,
  normalizeAuditorAllowedExtensions,
} from "../auditor-extensions.js";
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
  cancelHourlyProbe,
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
  MAX_ZOMBIE_RETRY_ATTEMPTS,
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

type AuditorModelCandidate = { ref?: string; model: any; via: string };

function auditorThinkingLevels(model: any): string[] {
  const ALL = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
  if (!model?.reasoning) return ["off"];
  const map = model.thinkingLevelMap as Record<string, string | null> | undefined;
  return ALL.filter((level) => {
    const mapped = map?.[level];
    if (mapped === null) return false;
    if (level === "xhigh" || level === "max") return mapped !== undefined;
    return true;
  });
}

type ConfiguredThinkingLevel = NonNullable<Settings["auditorThinkingLevel"]>;

/** Resolve the model returned by the shared model picker. Keeping this in the
 * settings layer means every role can derive its thinking menu from the model
 * the user actually selected, including the session-model row. */
function resolvePickedModel(
  ctx: ExtensionContext,
  pick: { kind: "session" } | { kind: "ref"; ref: string },
): any | undefined {
  if (pick.kind === "session") return ctx.model as any;
  if (!pick.ref || !ctx.modelRegistry) return undefined;
  const slash = pick.ref.indexOf("/");
  try {
    if (slash > 0) return ctx.modelRegistry.find(pick.ref.slice(0, slash), pick.ref.slice(slash + 1)) as any;
    return ctx.modelRegistry.getAvailable().find((m: any) => m.id === pick.ref || m.name === pick.ref) as any;
  } catch {
    return undefined;
  }
}

function thinkingChoiceOptions(levels: string[], current: string | undefined): string[] {
  return levels.map((lv) => `${lv} — ${THINKING_DESCR[lv] ?? ""}${lv === current ? " (current)" : ""}`);
}

function menuThinkingLevelsByRef(ctx: ExtensionContext): Record<string, readonly string[]> {
  const out: Record<string, readonly string[]> = {};
  try {
    for (const model of ctx.modelRegistry?.getAvailable?.() ?? []) {
      const ref = modelRef(model);
      if (ref) out[ref.toLowerCase()] = auditorThinkingLevels(model);
    }
  } catch {
    // The interactive menu still renders refs and requested thinking when a
    // legacy/headless registry cannot enumerate model metadata.
  }
  return out;
}

const DRAFTER_INHERIT_THINKING = "session — inherit current session level (default)";

function drafterThinkingChoiceOptions(
  levels: string[],
  current: string | undefined,
  inheritCurrent: boolean,
): string[] {
  return [
    `${DRAFTER_INHERIT_THINKING}${inheritCurrent ? " (current)" : ""}`,
    ...thinkingChoiceOptions(levels, current),
  ];
}

/** Token-cost ladder shared by the auditor-model flow and the standalone
 * Auditor thinking row (v0.34.127). */
const THINKING_DESCR: Record<string, string> = {
  off: "no reasoning",
  minimal: "~1k tokens",
  low: "~2k tokens",
  medium: "~8k tokens",
  high: "deep reasoning",
  xhigh: "~32k tokens",
  max: "maximum reasoning",
};

export function resolveAuditorModel(
  ctx: ExtensionContext,
  ref?: string,
  fallbackRefs?: string | readonly string[],
  sameSessionSwap = true,
): { model: any; error?: string; via?: string; fallbackModels?: AuditorModelCandidate[] } {
  const sessionModel = ctx.model as any;
  const currentRef = modelRef(sessionModel);
  const tryRef = (trimmed: string): { model?: any; reason?: string } => {
    const slash = trimmed.indexOf("/");
    if (slash > 0) {
      const provider = trimmed.slice(0, slash);
      const model = ctx.modelRegistry.find(provider, trimmed.slice(slash + 1));
      if (!model) return { reason: "model not found" };
      // An unkeyed provider is unavailable to the detached worker even when
      // the registry knows the model. Keep this check at the resolver edge;
      // runtime failures are handled by the shared retry walker.
      if (!ctx.modelRegistry.hasConfiguredAuth(model)) return { reason: `no configured auth for ${provider}` };
      return { model };
    }
    const matches = ctx.modelRegistry.getAvailable().filter((m: any) => m.id === trimmed || m.name === trimmed);
    const model = matches.find((candidate: any) => ctx.modelRegistry.hasConfiguredAuth(candidate));
    return model ? { model } : { reason: "no available model matching" };
  };
  const configuredFallbackRefs = typeof fallbackRefs === "string"
    ? (fallbackRefs.trim() ? [fallbackRefs.trim()] : [])
    : fallbackRefs ?? [];
  // The ten-ref bound applies to the fallback setting itself, not to the
  // primary plus its fallbacks. Keep all ten alternatives when a primary is
  // pinned, while still deduplicating a primary that was also typed into the
  // fallback list.
  const primaryRef = normalizeModelRefs(ref)[0];
  const normalizedFallbackRefs = normalizeMainModelFallbackRefs(configuredFallbackRefs);
  const configuredRefs = [
    ...(primaryRef ? [primaryRef] : []),
    ...normalizedFallbackRefs.filter((candidate) => candidate.toLowerCase() !== primaryRef?.toLowerCase()),
  ];
  const settings = loadSettings(ctx.cwd);
  const forbidden = (candidate: string): boolean => isForbiddenModel(candidate, settings.forbiddenModels);
  const selector = new ModelSelector({
    getChain: () => configuredRefs,
    resolve: (candidate) => tryRef(candidate).model,
    isForbidden: forbidden,
    record: (event) => {
      appendLedger(ctx.cwd, "model_fallback_select", {
        scope: "auditor",
        fromRef: event.fromRef,
        toRef: event.toRef,
        reason: event.reason,
      });
      if (event.reason === "forbidden" && event.toRef) {
        appendLedger(ctx.cwd, "auditor_model_fallback", { configured: event.toRef, reason: "forbidden" });
        return;
      }
      if (event.reason !== "unregistered" || !event.toRef) return;
      const reason = tryRef(event.toRef).reason ?? "model unavailable";
      appendLedger(ctx.cwd, "auditor_model_fallback", { configured: event.toRef, reason });
      const display = providerErrorPresentation(reason, "completion").display;
      ctx.ui.notify(`Auditor model "${event.toRef}" is unavailable (${display}) — trying the next fallback model. Fix via /glla → Auditor model.`, "warning");
    },
  });
  const candidates: AuditorModelCandidate[] = [];
  const attempted: string[] = [];
  const seenModels = new Set<string>();
  // A typed primary may be a bare model id while ModelSelector's current
  // model ref is provider-qualified. Match through the registry so the
  // same-session swap gate remains correct for both forms.
  const selectorCurrentRef = currentRef
    ? configuredRefs.find((candidate) => modelRef(tryRef(candidate).model)?.toLowerCase() === currentRef.toLowerCase()) ?? currentRef
    : undefined;
  const primaryMatchesSession = !!primaryRef
    && !!currentRef
    && (primaryRef.toLowerCase() === currentRef.toLowerCase()
      || modelRef(tryRef(primaryRef).model)?.toLowerCase() === currentRef.toLowerCase());
  const addCandidate = (candidateRef: string, model: any, via: string): void => {
    const key = modelRef(model)?.toLowerCase() ?? candidateRef.toLowerCase();
    if (seenModels.has(key)) return;
    seenModels.add(key);
    candidates.push({ ref: candidateRef, model, via });
  };
  // Unlike main recovery, the auditor may deliberately use the session model
  // when same-model swapping is disabled. Seed that configured primary before
  // asking the selector to walk the remaining chain.
  if (
    !sameSessionSwap
    && primaryRef
    && currentRef
    && primaryMatchesSession
    && !forbidden(primaryRef)
    && sessionModel
  ) {
    addCandidate(primaryRef, sessionModel, "setting");
    attempted.push(primaryRef);
  }
  for (;;) {
    const selected = selector.selectNextValid(
      { kind: "auditor" },
      sameSessionSwap ? selectorCurrentRef : undefined,
      attempted,
    );
    for (const visited of selector.lastVisitedRefs) {
      if (!attempted.some((entry) => entry.toLowerCase() === visited.toLowerCase())) attempted.push(visited);
    }
    if (!("model" in selected) || typeof selected.ref !== "string") break;
    const via = primaryRef && selected.ref.toLowerCase() === primaryRef.toLowerCase() ? "setting" : "fallback-pin";
    addCandidate(selected.ref, selected.model, via);
    if (!attempted.some((entry) => entry.toLowerCase() === selected.ref.toLowerCase())) attempted.push(selected.ref);
  }
  if (sessionModel && currentRef) addCandidate(currentRef, sessionModel, candidates.length > 0 ? "session-fallback" : "session");

  const currentPinned = sameSessionSwap && primaryMatchesSession ? primaryRef : undefined;
  if (currentPinned && currentRef) {
    const replacement = candidates.find((candidate) => candidate.via === "fallback-pin" && candidate.ref?.toLowerCase() !== currentRef.toLowerCase());
    appendLedger(ctx.cwd, "auditor_model_same_as_session", { model: currentRef, fallback: replacement?.ref ?? null });
    if (replacement?.ref) {
      ctx.ui.notify(`Session model IS the pinned auditor (${currentRef}) — auditor auto-swapped to ${replacement.ref} so the verifier differs.`, "info");
    } else {
      ctx.ui.notify(`The session model IS the pinned auditor (${currentRef}) — select a different /glla → Auditor fallback model so the verifier can differ.`, "warning");
    }
  }
  if (candidates.length > 0) {
    const first = candidates[0]!;
    if (first.via === "session-fallback") {
      appendLedger(ctx.cwd, "auditor_model_fallback", { configured: configuredRefs.join(" → ") || "(none)", reason: "all pins exhausted" });
      ctx.ui.notify("All pinned auditor models are unavailable — falling back to the session model. Fix via /glla → Auditor model.", "warning");
    }
    return { model: first.model, via: first.via, fallbackModels: candidates.slice(1) };
  }
  return { model: undefined, error: "no session model and no auditorModel configured — set one with /glla → Auditor model" };
}

// Model selection is explicit and bounded: primary pin → ordered fallback
// models → session model. A resolved primary can still fail after launch, so
// the completion path walks the same ordered candidates after one same-model
// retry; every candidate remains a detached extension-less audit. There is
// no in-process fallback into the parent session and no silent tier ranking.

/**
 * The /glla interactive settings UI (v0.8.0): a menu loop over pi's dialog
 * primitives. Pick a setting → edit it → saved to its effective scope → back to the menu.
 * Done/Esc exits. Settings are edited here; `/glla <action>` is reserved for
 * operational commands such as status, resume, stats, and audits.
 */
/**
 * v0.28.0: open the /glla settings menu as a TUI table (top tabs row +
 * 4-column body: KEY | VALUE | SOURCE | DESCRIPTION). Loops until the user
 * exits (Esc / undefined from confirm or cancel) or until a handler returns.
 *
 * The dispatcher (handleSettingChoice, below) takes a stable id and calls the
 * per-key editor (input/select/confirm dialog) used by the pick. The prior
 * v0.27.0 dispatcher used `choice.startsWith(label)` strings; the new id-based
 * switch is contract-equal in behavior and unit-testable via
 * extensions/settings-menu.ts.
 */
async function openSettingsUI(ctx: ExtensionContext, initialSection?: SettingsSectionId): Promise<void> {
  for (;;) {
    const settings = loadSettings(ctx.cwd);
    const prov = settingsProvenance(ctx.cwd);
    // Keep the interactive Effective resolution row aligned with headless
    // `/glla list`: inherit-parent must name the real session model rather
    // than collapsing to the generic "session model" placeholder.
    const session = ctx.model as any;
    const sessionModel = session?.provider && session?.id ? `${session.provider}/${session.id}` : undefined;
    const rows = buildSettingsRows(settings, prov, {
      sessionModel,
      sessionThinkingLevel: ctx.thinkingLevel ?? "off",
      thinkingLevelsByRef: menuThinkingLevelsByRef(ctx),
    });
    const id = await promptSettingsMenu(ctx, rows, initialSection);
    // The section is only an entry-point hint; after the first render the
    // table owns navigation and keeps all grouped settings available.
    initialSection = undefined;
    if (!id) return;
    const probe = (globalThis as any).warnIfStaleAtEntry as ((ctx: ExtensionContext, what: string) => boolean) | undefined;
    if (typeof probe === "function" && probe(ctx, "settings edit")) return;
    try {
      await handleSettingChoice(id, ctx);
    } catch (err) {
      // Keep the menu alive so the user can retry, but never make a failed
      // settings write look like a successful edit. Match the loud-save
      // behavior of the postaudit editor below.
      ctx.ui.notify(
        `glla setting "${id}" NOT saved: ${err instanceof Error ? err.message : String(err)} — check ${globalSettingsPath()} permissions.`,
        "warning",
      );
    }
  }
}

/**
 * Show the table-rendered settings menu and return the user's pick id (or
 * undefined for cancel). Wraps `ctx.ui.custom` so openSettingsUI stays a thin
 * loop. Falls back to a select-based legacy menu when the runtime has no
 * `ctx.ui.custom` (the `ctx.hasUI` guard already protects this path elsewhere;
 * this is a second-line defense for headless custom-only shards).
 */
async function promptSettingsMenu(
  ctx: ExtensionContext,
  rows: SettingsRow[],
  initialSection?: SettingsSectionId,
): Promise<string | undefined> {
  const title = `pi-goal-list-loop-audit settings — global: ${globalSettingsPath()}`;
  // v0.34.80: `custom` is a function in EVERY pi 0.84.1 mode — RPC/noOp
  // resolve `undefined` without invoking the builder. Detect availability by
  // whether the factory RAN; a settled stub falls through to the flat-row
  // select (the host-dialog path in RPC mode).
  if (typeof (ctx.ui as { custom?: unknown }).custom === "function") {
    let factoryInvoked = false;
    try {
      const v = await ctx.ui.custom<string | undefined>((tui, theme, keybindings, done) => {
        factoryInvoked = true;
        return new SettingsMenuComponent({ rows, title, initialSection }, () => tui.requestRender(), theme, keybindings, done);
      });
      if (factoryInvoked) return v;
      appendLedger(ctx.cwd, "settings_menu_fallback_select", { via: "custom-stub" });
    } catch {
      // a non-stale custom failure degrades to the legacy select path
    }
  }
  // Headless / no custom shard — fall back to the legacy flat-row select
  // for any environment that lacks the new primitive. This is rare and
  // effectively an emergency hatch; the new UI is the supported path.
  const flat = rows.map((r) => `[${r.section}] ${r.label} — ${r.valueText} [${r.sourceText.replace(/^\[|\]$/g, "")}] — ${r.description}`);
  flat.push("Done");
  const v = await ctx.ui.select(title, flat);
  if (!v || v === "Done") return undefined;
  // v0.34.25: resolve by the full constructed prefix (section + label),
  // not a bare startsWith(label) — a label-prefix collision used to be
  // able to open the wrong editor silently.
  return rows.find((r) => v.startsWith(`[${r.section}] ${r.label} —`))?.id;
}

/**
 * v0.28.0: per-key dispatch for the settings menu. The id comes from
 * `buildSettingsRows` (e.g. "autoResume", "auditorModel", "subagentModelOverrides.scout").
 * Same handlers as v0.27.0's if/else chain — only the trigger changed from
 * `startsWith(label)` strings to stable ids.
 */
// v0.28.7 (T4): exported for the behavioral settings-editor tests
// (tests/settings-editors.test.ts drives each editor class end-to-end).
/**
 * v0.29.17: /model-style fuzzy picker for model-valued settings. Builds the
 * item list from the registry (configured-auth providers only — a pick
 * from this list can never be a dead provider) and hosts the picker via
 * ctx.ui.custom. Falls back to the typed input when the runtime has no
 * custom shard (headless) — typing stays the emergency hatch there.
 * Returns { kind: "session" } to clear the override, { kind: "ref" } with
 * provider/id, or undefined for cancel.
 */
async function promptModelRef(
  ctx: ExtensionContext,
  title: string,
  emptyLabel: string,
  // v0.35.24 (note.md Next #1): auditor-slot parity with the main agent
  // selector — forbidden-models policy filters BOTH the picker list and the
  // typed escape hatch. Without it the user could pin a model the resolver
  // would silently skip at audit time (auditor_model_fallback reason:
  // "forbidden"), a dead-end selection the main selector never offers.
  opts: { excludeRefs?: readonly string[] } = {},
): Promise<{ kind: "session" } | { kind: "ref"; ref: string } | undefined> {
  const exclude = opts.excludeRefs ?? [];
  const validateTypedRef = (ref: string): { kind: "session" } | { kind: "ref"; ref: string } | undefined => {
    if (exclude.length > 0 && isForbiddenModel(ref, exclude)) {
      ctx.ui.notify(`"${ref}" matches your forbidden-models policy — the picker refuses it. Adjust /glla → Forbidden models first.`, "warning");
      return undefined;
    }
    return { kind: "ref", ref };
  };
  const inputFallback = async (): Promise<{ kind: "session" } | { kind: "ref"; ref: string } | undefined> => {
    const v = await ctx.ui.input(title, "provider/model-id — empty keeps the default");
    if (v === undefined) return undefined;
    return v.trim() ? validateTypedRef(v.trim()) : { kind: "session" };
  };
  if (typeof (ctx.ui as { custom?: unknown }).custom !== "function" || !ctx.modelRegistry) {
    return inputFallback();
  }
  const sessionModel = ctx.model as any;
  const sessionLabel = sessionModel ? `${sessionModel.provider}/${sessionModel.id}` : "pi session model";
  const models = ctx.modelRegistry
    .getAvailable()
    .filter((m: any) => ctx.modelRegistry.hasConfiguredAuth(m));
  const items = buildModelPickItems(models, sessionLabel, { excludeRefs: exclude });
  let factoryInvoked = false;
  const pick = await ctx.ui.custom<ModelPickItem | undefined>((tui, theme, keybindings, done) => {
    factoryInvoked = true;
    return new ModelPickerComponent({ title, items }, () => tui.requestRender(), theme, keybindings, done);
  });
  // RPC/no-op hosts expose custom() but never invoke the factory. Use the
  // typed escape hatch there; an invoked factory returning undefined is Esc.
  if (!pick && !factoryInvoked) return inputFallback();
  if (!pick) return undefined;
  if (pick.kind === "session") return { kind: "session" };
  if (pick.kind === "model" && pick.ref) return { kind: "ref", ref: pick.ref };
  // manual escape hatch — typed provider/model, validated like before
  const v = await ctx.ui.input(title, emptyLabel);
  if (v === undefined) return undefined;
  return v.trim() ? validateTypedRef(v.trim()) : { kind: "session" };
}

/** Multi-select counterpart to promptModelRef: returns an ordered string[] of
 * provider/model refs (selection order = toggle order), or undefined on Esc.
 * Falls back to a free-form comma-separated input when ctx.ui.custom /
 * ctx.modelRegistry are unavailable (headless tests).
 *
 * v0.34.118: `opts.excludeRefs` filters out a set of refs from the picker
 * (typical use: when picking fallback agents, exclude the user's forbidden
 * models; when picking forbidden models, exclude every configured fallback
 * agent — the two lists are mutually exclusive by design). Configured refs are kept at the top of
 * the picker so their order is visible; an unavailable or policy-blocked ref
 * is rendered with its reason and can be removed explicitly. */
async function promptModelRefs(
  ctx: ExtensionContext,
  title: string,
  initialRefs: string[],
  opts: { excludeRefs?: string[]; maxSelections?: number; currentRef?: string } = {},
): Promise<string[] | undefined> {
  const exclude = opts.excludeRefs ?? [];
  const maxSelections = opts.maxSelections;
  const normalizeSelection = (value: unknown): string[] => {
    const refs = normalizeModelRefs(value);
    const seen = new Set<string>();
    const unique = refs.filter((ref) => {
      const key = maxSelections === MAX_MAIN_MODEL_FALLBACKS ? ref.toLowerCase() : ref;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    const currentKey = opts.currentRef?.trim().toLowerCase();
    return unique.filter((ref) => !isForbiddenModel(ref, exclude) && ref.toLowerCase() !== currentKey);
  };
  const inputFallback = async (): Promise<string[] | undefined> => {
    const v = await ctx.ui.input(title, initialRefs.length ? initialRefs.join(",") : "provider/model-a,provider/model-b");
    if (v === undefined) return undefined;
    // Enforce the same mutual exclusion in headless/free-form mode as in
    // the TUI picker; a typed forbidden ref must not sneak into a backup
    // chain (and a typed backup must not be added to forbiddenModels).
    const typedRefs = normalizeModelRefs(v);
    const policyBlocked = typedRefs.filter((ref) => isForbiddenModel(ref, exclude));
    if (typedRefs.length > 0 && policyBlocked.length === typedRefs.length) {
      ctx.ui.notify(`Not saved because policy excludes: ${policyBlocked.join(", ")}`, "warning");
      return undefined;
    }
    const refs = normalizeSelection(v);
    if (policyBlocked.length > 0) {
      ctx.ui.notify(`Not saved because policy excludes: ${policyBlocked.join(", ")}`, "warning");
    }
    if (maxSelections !== undefined && refs.length > maxSelections) {
      ctx.ui.notify(`Only the first ${maxSelections} fallback agents are kept; the remaining selections were refused.`, "warning");
      return refs.slice(0, maxSelections);
    }
    return refs;
  };
  if (typeof (ctx.ui as { custom?: unknown }).custom !== "function" || !ctx.modelRegistry) {
    return inputFallback();
  }
  const sessionModel = ctx.model as any;
  const sessionLabel = sessionModel ? `${sessionModel.provider}/${sessionModel.id}` : "pi session model";
  const models = ctx.modelRegistry
    .getAvailable()
    .filter((m: any) => ctx.modelRegistry.hasConfiguredAuth(m));
  const items = buildModelPickItems(models, sessionLabel, {
    excludeRefs: [...exclude],
    preserveRefs: initialRefs,
    // Ordered backup/forbidden lists contain refs, not overrides; showing
    // session/manual rows here was confusing because MultiModelPicker treats
    // both as no-op rows. Keep those rows for single-value ModelPicker only.
    includeSessionRow: false,
    includeManualRow: false,
  });
  let factoryInvoked = false;
  const pick = await ctx.ui.custom<MultiModelPickerResult>((tui, theme, keybindings, done) => {
    factoryInvoked = true;
    return new MultiModelPickerComponent({ title, items, initialSelected: initialRefs, currentRef: opts.currentRef, maxSelections }, () => tui.requestRender(), theme, keybindings, done);
  });
  // pi's RPC/no-op UI exposes custom() but resolves undefined without
  // invoking the factory. Treat that as headless, not as an Esc cancellation;
  // an invoked factory returning undefined is a genuine user cancel.
  if (pick === undefined && !factoryInvoked) return inputFallback();
  if (pick === undefined) return undefined;
  // The picker keeps its legacy string[] result by default, but its optional
  // inherit row returns a structured selection so inheritance is never
  // mistaken for a provider/model ref at this boundary.
  const pickedRefs = Array.isArray(pick) ? pick : pick.refs;
  const normalizedPick = normalizeSelection(pickedRefs);
  const omitted = pickedRefs.filter((ref) => !normalizedPick.some((kept) => kept.toLowerCase() === ref.toLowerCase()));
  const omittedCurrent: string[] = opts.currentRef
    ? omitted.filter((ref) => ref.toLowerCase() === opts.currentRef!.toLowerCase())
    : [];
  const omittedPolicy = omitted.filter((ref) => !omittedCurrent.some((current: string) => current.toLowerCase() === ref.toLowerCase()));
  if (omittedCurrent.length) {
    ctx.ui.notify(`Current session model is slot 0 and was not saved as a backup: ${omittedCurrent.join(", ")}`, "info");
  }
  if (omittedPolicy.length > 0) {
    ctx.ui.notify(`Not saved because policy excludes: ${omittedPolicy.join(", ")}`, "warning");
  }
  return normalizedPick;
}

/** Parse a tool-override value: numbers, booleans, JSON objects/arrays, else
 * string. Local mirror of goal-commands' parseToolOverrideValue — a direct
 * import would make goal-settings-ui → goal-commands → goal-settings-ui a
 * circular pair, so the tiny parser stays duplicated by design. */
function parseToolOverrideValueLocal(s: string): unknown {
  const trimmed = s.trim();
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed === "null") return null;
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try { return JSON.parse(trimmed); } catch { /* fall through */ }
  }
  return trimmed;
}

export async function handleSettingChoice(id: string, ctx: ExtensionContext): Promise<void> {
  settingsEditContext = ctx;
  // Current pi-subagents roles are data-driven. Keep this dispatch in front
  // of the switch so adding a built-in role does not require another hard-coded
  // case label here.
  if (id.startsWith("subagentModelOverrides.")) {
    const agentType = id.slice("subagentModelOverrides.".length);
    if (OVERRIDABLE_AGENT_TYPES.includes(agentType)) {
      const pick = await promptModelRef(ctx, `Model pin for ${agentType} subagents`, "provider/model-id e.g. minimax/MiniMax-M3 — always wins over strategy; empty = follow strategy");
      if (pick === undefined) return;
      const current = loadSettings(ctx.cwd).subagentModelOverrides ?? {};
      const next = { ...current };
      if (pick.kind === "ref") next[agentType] = pick.ref;
      else delete next[agentType];
      saveSettings("global", ctx.cwd, { subagentModelOverrides: Object.keys(next).length > 0 ? next : undefined });
      ctx.ui.notify(`${agentType} model pin saved — applies to NEW pi sessions.`, "info");
      return;
    }
  }
  if (id.startsWith("subagentFallbacks:")) {
    const agentType = id.slice("subagentFallbacks:".length);
    if (OVERRIDABLE_AGENT_TYPES.includes(agentType)) {
      const settings = loadSettings(ctx.cwd);
      const current = settings.subagentFallbacks?.[agentType] ?? [];
      const refs = await promptModelRefs(ctx, `${agentType} fallback chain — ordered, up to ${MAX_MAIN_MODEL_FALLBACKS} (space to toggle, tab = order mode with ↑/↓, enter to confirm); forbidden models hidden`, current, { excludeRefs: normalizeModelRefs(settings.forbiddenModels), maxSelections: MAX_MAIN_MODEL_FALLBACKS });
      if (refs === undefined) return;
      const next = { ...(settings.subagentFallbacks ?? {}) };
      if (refs.length > 0) next[agentType] = refs;
      else delete next[agentType];
      saveSettings("global", ctx.cwd, { subagentFallbacks: Object.keys(next).length > 0 ? next : undefined });
      ctx.ui.notify(refs.length ? `${agentType} fallback chain saved: ${refs.join(" → ")} — applies to NEW pi sessions.` : `${agentType} fallback chain cleared — falls through to the legacy pin / strategy.`, "info");
      return;
    }
  }
  switch (id) {
    case "stateRoot": {
      const v = await ctx.ui.select("State root — where durable glla state lives", [
        "workingDir — <cwd>/.pi-glla (default)",
        "sessionDir — top-level Pi session directory (opt-in)",
      ]);
      if (v) saveSettings("global", ctx.cwd, { stateRoot: v.startsWith("sessionDir") ? "sessionDir" : "workingDir" });
      return;
    }
    case "autoResume": {
      const v = await ctx.ui.select("Auto-resume on session start — a LOADED session waits for an explicit resume; on reload/fork the machinery still rebinds so work never strands", [
        "default — hold on load, rebind on reload/fork",
        "on — auto-resume on EVERY session start (unattended rigs)",
        "off — never auto-resume; explicit resume only",
      ]);
      if (v) saveSettings("global", ctx.cwd, { autoResume: v.startsWith("on") ? true : v.startsWith("off") ? false : undefined });
      return;
    }
    case "carryover": {
      const v = await ctx.ui.select("Carryover — a NEW goal/loop meets stale paused work from a previous session", [
        "pause — one summary; archive the stale goal, keep the list + held loop (default)",
        "clear — also drop the stale queue and dismiss the held loop",
        "resume — legacy silent stacking, no summary",
      ]);
      if (v) saveSettings("global", ctx.cwd, { carryover: v.startsWith("clear") ? "clear" : v.startsWith("resume") ? "resume" : undefined });
      return;
    }
    case "autoAcceptDrafts": {
      const v = await ctx.ui.select("Auto-accept goal/loop drafts", [
        "off — the Confirm dialog gates every draft",
        "on — drafts activate immediately, no Confirm (unattended rigs)",
      ]);
      if (v) saveSettings("global", ctx.cwd, { autoAcceptDrafts: v.startsWith("on") ? true : undefined });
      return;
    }
    case "decisionPopup": {
      const v = await ctx.ui.select("Decision popup — what a decision-class pause does", [
        "on — a decision pause opens the picker; the widget card is the Escape fallback",
        `off — widget card only; ${activeGoalSurfaceCommand("decide")} opens the picker on demand`,
      ]);
      if (v) saveSettings("global", ctx.cwd, { decisionPopup: v.startsWith("off") ? false : undefined });
      return;
    }
    case "aggressiveMode": {
      const v = await ctx.ui.select("Aggressive mode — ON by default: autoResume, audit cap 10, stuck max 10, wedge alerts off, provider retries, cap objections become a TODO list (explicit per-key settings still win)", [
        "off — conservative override: pause at the audit cap, show wedge alerts, require resume",
        "on — keep-going default; the goal does not park at the audit cap",
      ]);
      if (v) {
        saveSettings("global", ctx.cwd, { aggressiveMode: v.startsWith("on") });
        ctx.ui.notify(`Aggressive mode ${v.startsWith("on") ? "ON — goals keep going past the audit cap; objections become TODOs" : "off"}.`, "info");
      }
      return;
    }
    case "visionAssist": {
      const v = await ctx.ui.select("Vision assist — prefer the current model's native image capability; external providers are optional (preapproval gate: forbiddenModels)", [
        "on — continuation prompts carry native-first VISION-ASSIST guidance; no vision-only model switch (default)",
        "off — no vision guidance injected; the forbiddenModels gate still blocks forbidden switches",
      ]);
      if (v) {
        saveSettings("global", ctx.cwd, { visionAssist: v.startsWith("off") ? false : undefined });
        ctx.ui.notify(v.startsWith("off") ? "Vision assist OFF — no native-vision guidance; the model-switch gate still stands." : "Vision assist ON — native vision first; external providers require confirmation and vision-only switches stay off.", "info");
      }
      return;
    }
    case "mainAgent": {
      ctx.ui.notify("The current main agent and thinking level are controlled by pi's regular model/thinking selectors. The fallback chain is configured in this tab.", "info");
      return;
    }
    case "mainModelFallbacks": {
      const current = normalizeMainModelFallbackRefs(loadGlobalSettings().mainModelFallbacks);
      // v0.34.118: forbidden models cannot be valid fallback agents, so hide
      // them. The policy may be project-scoped even though this chain is
      // global-only; use the effective policy the runtime will enforce.
      const forbidden = normalizeModelRefs(loadSettings(ctx.cwd).forbiddenModels);
      const refs = await promptModelRefs(
        ctx,
        `Main agent fallback models — try order is current → fallback 1 → fallback 2 … (space add/remove, tab order mode with ↑/↓, enter save); forbidden models are skipped`,
        current,
        { excludeRefs: forbidden, maxSelections: MAX_MAIN_MODEL_FALLBACKS, currentRef: modelRef(ctx.model) },
      );
      if (refs === undefined) return;
      saveSettings("global", ctx.cwd, { mainModelFallbacks: refs.length ? refs : undefined });
      if (!refs.length && state.mainModelRecovery) {
        const recovery = state.mainModelRecovery;
        const current = recovery.active ?? recovery.primary;
        state.mainModelRecovery = {
          ...recovery,
          active: current,
          attempted: [current],
          skipped: [],
          pendingModelSwitch: undefined,
          resumeCurrent: undefined,
        };
        clearMainModelRecoveryTimer();
        persistState(ctx);
      }
      ctx.ui.notify(refs.length ? `Main agent fallback models saved in order: ${refs.join(" → ")}` : "Main agent fallback models cleared — any pending fallback switch was cancelled and recovery will probe the current model.", "info");
      return;
    }
    case "auditorSilent": {
      const v = await ctx.ui.select("Silent auditor stream — how the auditor's report text renders in the widget while the detached worker streams", [
        "on — final-only: the text appears once the verdict lands, never word-by-word (default)",
        "off — live tail: show the streamed report lines as they arrive",
      ]);
      if (v) {
        saveSettings("global", ctx.cwd, { auditorSilent: v.startsWith("off") ? false : undefined });
        ctx.ui.notify(v.startsWith("off") ? "Auditor stream LIVE — report lines show as they stream." : "Auditor stream SILENT — final text at the verdict.", "info");
      }
      return;
    }
    case "auditorProgressSignals": {
      const v = await ctx.ui.select("Auditor progress signals — intermediate evidence shown during silent audits (phase label + report byte-counter)", [
        "on — phase label (reading source… / writing report…) + report byte-counter (default)",
        "off — plain timer-only card, no intermediate signals",
      ]);
      if (v) {
        saveSettings("global", ctx.cwd, { auditorProgressSignals: v.startsWith("off") ? false : undefined });
        ctx.ui.notify(v.startsWith("off") ? "Auditor progress signals OFF — silent card shows only the timer." : "Auditor progress signals ON — phase + byte-counter visible during audits.", "info");
      }
      return;
    }
    case "auditorToolTimeoutMs":
    case "auditorStallMs": {
      // v0.37.0: millisecond-valued auditor watchdog budgets (plain ms or s/m/h duration strings).
      const isTool = id === "auditorToolTimeoutMs";
      const def = isTool ? DEFAULT_AUDITOR_TOOL_TIMEOUT_MS : DEFAULT_AUDITOR_STALL_MS;
      const min = isTool ? MIN_AUDITOR_TOOL_TIMEOUT_MS : MIN_AUDITOR_STALL_MS;
      const max = isTool ? MAX_AUDITOR_TOOL_TIMEOUT_MS : MAX_AUDITOR_STALL_MS;
      const s = loadSettings(ctx.cwd);
      const current = typeof s[id] === "number" ? s[id] : def;
      const input = await ctx.ui.input(
        `${isTool ? "Per-tool timeout" : "No-progress stall window"} in ms (or s/m/h, e.g. 300000 / 10m; empty = default ${def / 60000}m)`,
        `current: ${current} ms`,
      );
      if (input === undefined) return;
      const t = input.trim();
      if (t === "") {
        saveSettings("global", ctx.cwd, { [id]: undefined });
        ctx.ui.notify(`Cleared: ${id} (default ${def / 60000}m).`);
      } else {
        const ms = parseSettingsDurationMs(t);
        if (ms !== undefined && ms >= min && ms <= max) {
          saveSettings("global", ctx.cwd, { [id]: ms });
          ctx.ui.notify(`Saved ${id} = ${ms} ms.`);
        } else {
          ctx.ui.notify(`Rejected: enter ${min}-${max} ms (e.g. 15m). Allowed range: ${min / 60000}m-${max / 60000}m.`);
        }
      }
      return;
    }
    case "auditJobRetentionMs": {
      // v0.38.3: retention is a review window for finished audit logs, not
      // a watchdog budget — 0 is legal (reap proven-dead dirs immediately).
      const s = loadSettings(ctx.cwd);
      const current = typeof s.auditJobRetentionMs === "number" ? s.auditJobRetentionMs : AUDIT_JOB_CLEANUP_MIN_AGE_MS;
      const input = await ctx.ui.input(
        `Audit job retention in ms (or s/m/h, e.g. 900000 / 15m / 2h; empty = default ${AUDIT_JOB_CLEANUP_MIN_AGE_MS / 60000}m)`,
        `current: ${current} ms`,
      );
      if (input === undefined) return;
      const t = input.trim();
      if (t === "") {
        saveSettings("global", ctx.cwd, { auditJobRetentionMs: undefined });
        ctx.ui.notify(`Cleared: auditJobRetentionMs (default ${AUDIT_JOB_CLEANUP_MIN_AGE_MS / 60000}m).`);
      } else {
        const ms = parseSettingsDurationMs(t);
        if (ms !== undefined && ms >= 0 && ms <= MAX_AUDIT_JOB_RETENTION_MS) {
          saveSettings("global", ctx.cwd, { auditJobRetentionMs: ms });
          ctx.ui.notify(`Saved auditJobRetentionMs = ${ms} ms.`);
        } else {
          ctx.ui.notify(`Rejected: enter 0-${MAX_AUDIT_JOB_RETENTION_MS} ms (e.g. 15m). Allowed range: 0-${MAX_AUDIT_JOB_RETENTION_MS / 60000}m.`);
        }
      }
      return;
    }
    case "auditorInspection": {
      // v0.38.3: opt-in live inspection — the auditor's pi becomes a normal
      // persistent session you can tail -f or resume. Off = original --no-session.
      const v = await ctx.ui.select("Auditor inspection session — persist the auditor's pi as a resumable session for live tail -f / post-audit attach", [
        "off — the original --no-session spawn (default)",
        "on — --session <jobDir>/session.jsonl: tail -f it live, resume it after the audit",
      ]);
      if (v) {
        const on = v.startsWith("on");
        saveSettings("global", ctx.cwd, { auditorInspection: on ? true : undefined });
        ctx.ui.notify(on ? "Auditor inspection ON — audits now persist a resumable session."
          : "Auditor inspection OFF — back to the original --no-session spawn.", "info");
      }
      return;
    }
    case "hourlyRetryProbe": {
      const v = await ctx.ui.select("Hourly main-model retry — an extra blind :00:30 attempt while recovery is parked (the normal retry ladder is separate)", [
        "on — fire an extra probe at :00:30 every hour while parked (default)",
        "off — rely on the configured retry ladder only",
      ]);
      if (v) {
        const off = v.startsWith("off");
        saveSettings("global", ctx.cwd, { hourlyRetryProbe: off ? false : undefined });
        if (off) cancelHourlyProbe();
        else if (state.mainModelRecovery && !state.mainModelRecovery.manualResumeRequired) scheduleHourlyProbe(ctx);
        ctx.ui.notify(off ? "Hourly main recovery probe OFF — only the configured retry ladder will run." : "Hourly main recovery probe ON — extra :00:30 probe while parked.", "info");
      }
      return;
    }
    case "mainModelFailback": {
      const v = await ctx.ui.select("Primary failback — what happens after a fallback turn succeeds", [
        "auto — periodically probe the preferred primary and fail back when it works (default)",
        "sticky — stay on the fallback until a manual model selection",
      ]);
      if (v) {
        const sticky = v.startsWith("sticky");
        saveSettings("global", ctx.cwd, { mainModelFailback: sticky ? "sticky" : undefined });
        if (sticky && state.mainModelRecovery && (state.mainModelRecovery.primaryProbeAt || state.mainModelRecovery.primaryProbeInFlight)) {
          clearMainModelRecoveryTimer();
          state.mainModelRecovery = undefined;
          persistState(ctx);
        } else if (!sticky && state.mainModelRecovery?.primaryProbeAt) {
          scheduleMainModelRecoveryTimer(ctx, Math.max(0, Date.parse(state.mainModelRecovery.primaryProbeAt) - Date.now()));
        }
        ctx.ui.notify(sticky ? "Primary failback STICKY — the current fallback stays selected until you switch manually." : "Primary failback AUTO — a healthy fallback will periodically test the preferred primary.", "info");
      }
      return;
    }
    case "mainModelPrimaryProbeMinutes": {
      const v = await ctx.ui.input("Preferred-primary failback probe cadence", "positive integer minutes; empty = default 15");
      if (v !== undefined) {
        const raw = v.trim();
        const n = parseSettingsInteger(raw);
        if (n !== undefined && n > 0) saveSettings("global", ctx.cwd, { mainModelPrimaryProbeMinutes: n });
        else if (!raw) saveSettings("global", ctx.cwd, { mainModelPrimaryProbeMinutes: undefined });
        else ctx.ui.notify(`primary probe minutes must be a positive integer, got: ${v}`, "warning");
      }
      return;
    }
    case "drafterModel": {
      const pick = await promptModelRef(ctx, "Drafter agent — temporary agent for drafting only", "provider/model-id — empty keeps the current session model");
      if (pick === undefined) return;
      const pickedModel = resolvePickedModel(ctx, pick);
      const currentThinking = loadSettings(ctx.cwd).drafterThinkingLevel;
      const levels = auditorThinkingLevels(pickedModel);
      let pickedThinking: ConfiguredThinkingLevel | undefined;
      let inheritThinking = false;
      if (levels.length <= 1) {
        ctx.ui.notify(`Drafter agent: ${pick.kind === "session" ? "session model (override cleared)" : pick.ref} — this model exposes no thinking levels (drafting runs with thinking off).`, "info");
      } else {
        const inherited = ctx.thinkingLevel ?? "high";
        const preferred = currentThinking ?? inherited;
        const thinking = await ctx.ui.select(
          "Drafter thinking — TEMPORARY DRAFTING AGENT ONLY (your session thinking is restored afterward)",
          drafterThinkingChoiceOptions(
            levels,
            levels.includes(preferred) ? preferred : levels.includes("high") ? "high" : levels[levels.length - 1],
            currentThinking === undefined,
          ),
        );
        if (thinking?.startsWith("session —")) inheritThinking = true;
        else if (thinking) pickedThinking = thinking.split(" ")[0] as ConfiguredThinkingLevel;
      }
      saveSettings("global", ctx.cwd, {
        drafterModel: pick.kind === "session" ? undefined : pick.ref,
        ...(inheritThinking ? { drafterThinkingLevel: undefined } : pickedThinking ? { drafterThinkingLevel: pickedThinking } : {}),
      });
      ctx.ui.notify(
        `Drafter agent: ${pick.kind === "session" ? "session model (override cleared)" : pick.ref}${inheritThinking ? " · thinking inherited from the session" : pickedThinking ? ` · thinking ${pickedThinking}` : ""} — main and auditor agents are unchanged.`,
        "info",
      );
      return;
    }
    case "drafterModelFallbacks": {
      const global = loadGlobalSettings();
      const current = normalizeMainModelFallbackRefs(global.drafterModelFallbacks);
      const refs = await promptModelRefs(
        ctx,
        `Drafter fallback models (up to ${MAX_MAIN_MODEL_FALLBACKS}) — ordered; the session model is the last resort; forbidden models are hidden`,
        current,
        { excludeRefs: normalizeModelRefs(loadSettings(ctx.cwd).forbiddenModels), maxSelections: MAX_MAIN_MODEL_FALLBACKS, currentRef: modelRef(ctx.model) },
      );
      if (refs === undefined) return;
      saveSettings("global", ctx.cwd, { drafterModelFallbacks: refs.length ? refs : undefined });
      ctx.ui.notify(refs.length ? `Drafter fallback models saved: ${refs.join(" → ")}.` : "Drafter fallback models cleared — the session model remains the last resort.", "info");
      return;
    }
    case "compactorModel": {
      const pick = await promptModelRef(ctx, "Compactor agent — emergency handoff brief only", "provider/model-id — empty keeps registry plan B (verified free big-context model)");
      if (pick === undefined) return;
      saveSettings("global", ctx.cwd, { compactorModel: pick.kind === "session" ? undefined : pick.ref });
      ctx.ui.notify(
        pick.kind === "session"
          ? "Compactor agent: registry plan B (the session model can never be the compactor — it is the stuck one)."
          : `Compactor agent: ${pick.ref} — main, drafter, and auditor agents are unchanged.`,
        "info",
      );
      return;
    }
    case "compactorModelFallbacks": {
      const global = loadGlobalSettings();
      const current = normalizeMainModelFallbackRefs(global.compactorModelFallbacks);
      const refs = await promptModelRefs(
        ctx,
        `Compactor fallback models (up to ${MAX_MAIN_MODEL_FALLBACKS}) — ordered; then registry plan B; the session model is never used`,
        current,
        { excludeRefs: normalizeModelRefs(loadSettings(ctx.cwd).forbiddenModels), maxSelections: MAX_MAIN_MODEL_FALLBACKS, currentRef: modelRef(ctx.model) },
      );
      if (refs === undefined) return;
      saveSettings("global", ctx.cwd, { compactorModelFallbacks: refs.length ? refs : undefined });
      ctx.ui.notify(refs.length ? `Compactor fallback models saved: ${refs.join(" → ")}.` : "Compactor fallback models cleared — registry plan B remains.", "info");
      return;
    }
    case "forbiddenModels": {
      const settings = loadSettings(ctx.cwd);
      const current = normalizeModelRefs(settings.forbiddenModels);
      // A configured fallback cannot simultaneously be forbidden. Use the
      // effective settings so project-scoped chains are protected too, and
      // cover every role that has a fallback chain (not just main/subagents).
      const fallbackRefs = [
        ...normalizeMainModelFallbackRefs(settings.mainModelFallbacks),
        ...normalizeMainModelFallbackRefs(settings.drafterModelFallbacks),
        ...normalizeMainModelFallbackRefs(settings.compactorModelFallbacks),
        ...(settings.compactorModel?.trim() ? [settings.compactorModel.trim()] : []),
        ...normalizeMainModelFallbackRefs(settings.auditorModelFallbacks),
        ...Object.values(settings.subagentFallbacks ?? {}).flatMap((chain) => normalizeModelRefs(chain)),
      ];
      const refs = await promptModelRefs(
        ctx,
        "Forbidden model patterns — case-insensitive provider/id substrings; recovery always skips matches (space to toggle, tab = order mode with ↑/↓, enter to confirm)",
        current,
        { excludeRefs: fallbackRefs },
      );
      if (refs === undefined) return;
      saveSettings("global", ctx.cwd, { forbiddenModels: refs });
      ctx.ui.notify(refs.length ? `Forbidden models saved: ${refs.join(", ")}` : "Forbidden models cleared — every model is allowed (policy gate off).", "info");
      return;
    }
    case "blockForbiddenModelSwitches": {
      const v = await ctx.ui.select("Block forbidden model switches — revert a forbidden selection to the previous model", [
        "on — forbidden selections are reverted to the previous model (default)",
        "off — the switch stands; the forbidden_model_switch ledger entry still records the violation",
      ]);
      if (v) saveSettings("global", ctx.cwd, { blockForbiddenModelSwitches: v.startsWith("off") ? false : undefined });
      return;
    }
    case "mainModelRetryMinutes": {
      const v = await ctx.ui.input("Main recovery base wait", "positive integer minutes; empty = default 15 (then doubles per attempt, capped at 5h)");
      if (v !== undefined) {
        const raw = v.trim();
        const n = parseSettingsInteger(raw);
        if (n !== undefined && n > 0) saveSettings("global", ctx.cwd, { mainModelRetryMinutes: n });
        else if (!raw) saveSettings("global", ctx.cwd, { mainModelRetryMinutes: undefined });
        else ctx.ui.notify(`main model retry minutes must be a positive integer, got: ${v}`, "warning");
      }
      return;
    }
    case "auditorModel": {
      // v0.35.24 (note.md Next #1): parity with the main agent selector —
      // the auditor picker filters forbidden models out of the list AND
      // refuses typed policy matches, so a pin saved here is one the
      // resolver will actually honor.
      const pick = await promptModelRef(ctx, "Auditor model override", "provider/model-id — empty keeps the pi session model", { excludeRefs: loadSettings(ctx.cwd).forbiddenModels });
      if (pick === undefined) return;
      saveSettings("global", ctx.cwd, { auditorModel: pick.kind === "session" ? undefined : pick.ref });
      // v0.31.4: thinking is chosen WITH the model (user: "we are setting
      // the thinking when we select the model now or we should") — there is
      // no standalone thinking row to forget about. Esc keeps the level.
      // v0.31.7: the select must be UNMISTAKABLY the auditor's — the user
      // Esc'd through it because it read like pi's own (general) thinking
      // dialog, and nothing was ever saved.
      // v0.31.8: the options come from the PICKED MODEL's info (user: "we
      // are not using the model information cause it has no max") — a model
      // that maps xhigh/max offers them; a non-reasoning model is told, not asked.
      let pickedModel: any = pick.kind === "session" ? (ctx.model as any) : undefined;
      if (pick.kind === "ref" && pick.ref) {
        const parts = pick.ref.split("/");
        try {
          pickedModel = parts.length === 2 ? (ctx.modelRegistry?.find?.(parts[0]!, parts[1]!) as any) : (ctx.modelRegistry?.getAvailable?.().filter((m: any) => m.id === pick.ref)[0] as any);
        } catch { pickedModel = undefined; } // levels fall back to the full ladder below
      }
      const curThinking = loadSettings(ctx.cwd).auditorThinkingLevel;
      const inheritedThinking = ctx.thinkingLevel ?? "max";
      const levels = auditorThinkingLevels(pickedModel);
      if (levels.length <= 1) {
        ctx.ui.notify(`Auditor model: ${pick.kind === "session" ? "session model (override cleared)" : pick.ref} — this model exposes no thinking levels (auditor runs with thinking off).`, "info");
        return;
      }
      const t = await ctx.ui.select(
        "Auditor thinking — DETACHED auditor worker ONLY (your session model's thinking is untouched)",
        levels.map((lv) => `${lv} — ${THINKING_DESCR[lv] ?? ""}${lv === (curThinking ?? inheritedThinking) ? " (current)" : ""}`),
      );
      if (t) saveSettings("global", ctx.cwd, { auditorThinkingLevel: t.split(" ")[0] as Settings["auditorThinkingLevel"] });
      ctx.ui.notify(`Auditor model: ${pick.kind === "session" ? "session model (override cleared)" : pick.ref}${t ? ` · thinking ${t.split(" ")[0]}` : ""}`, "info");
      return;
    }
    case "auditorModelFallbacks": {
      const settings = loadGlobalSettings();
      const current = normalizeMainModelFallbackRefs(settings.auditorModelFallbacks);
      const configuredPrimary = settings.auditorModel?.trim();
      // auditorModel also accepts a bare model id. Canonicalize it before
      // passing currentRef to the multi-picker so the selected primary is
      // disabled even when it was saved without its provider prefix.
      const primaryModel = configuredPrimary
        ? resolvePickedModel(ctx, { kind: "ref", ref: configuredPrimary })
        : ctx.model as any;
      const primaryRef = modelRef(primaryModel) ?? configuredPrimary ?? modelRef(ctx.model);
      const forbidden = normalizeModelRefs(loadSettings(ctx.cwd).forbiddenModels);
      const refs = await promptModelRefs(
        ctx,
        `Auditor fallback models — try order is auditor primary → fallback 1 → fallback 2 … (space add/remove, tab order mode with ↑/↓, enter save); forbidden models are skipped`,
        current,
        { excludeRefs: forbidden, maxSelections: MAX_MAIN_MODEL_FALLBACKS, currentRef: primaryRef },
      );
      if (refs === undefined) return;
      saveSettings("global", ctx.cwd, { auditorModelFallbacks: refs.length ? refs : undefined });
      ctx.ui.notify(
        refs.length
          ? `Auditor fallback models saved in order: ${refs.join(" → ")}`
          : "Auditor fallback models cleared — the session model remains the last resort.",
        "info",
      );
      return;
    }
    case "auditorAllowedExtensions": {
      // v0.36.0 (GitHub issue: extension-based model providers in the
      // detached auditor). The picker lists every extension a normal pi
      // session would load, RESOLVED to concrete install paths (raw npm:/git:
      // specs are not directly loadable by the detached worker — see
      // extensions/auditor-extensions.ts); selected paths ride the auditor
      // request and the worker passes them as `pi --extension <path>` under
      // the still intact --no-extensions discovery off switch.
      const currentExts = normalizeAuditorAllowedExtensions(loadSettings(ctx.cwd).auditorAllowedExtensions);
      const discovered = discoverAuditorExtensions(os.homedir(), ctx.cwd);
      const discoveredSpecs = new Set(discovered.map((entry) => entry.spec));
      const extItems: ModelPickItem[] = [
        ...discovered.map((entry) => ({
          kind: "model" as const,
          ref: entry.spec,
          label: `${entry.label} · ${entry.source}`,
          searchText: `${entry.spec} ${entry.label} ${entry.source}`,
        })),
        // Saved specs that discovery can no longer see (removed package,
        // another machine's home) still render so the user can deselect
        // them instead of a silently immortal settings entry.
        ...currentExts.filter((spec) => !discoveredSpecs.has(spec)).map((spec) => ({
          kind: "model" as const,
          ref: spec,
          label: `${spec} · saved, not discovered here`,
          searchText: spec,
        })),
      ];
      const extInputFallback = async (): Promise<string[] | undefined> => {
        const v = await ctx.ui.input(
          "Auditor allowed extensions — comma-separated pi extension specs",
          currentExts.length ? currentExts.join(",") : "npm:package-name or /path/to/extension",
        );
        if (v === undefined) return undefined;
        return normalizeAuditorAllowedExtensions(v.split(","));
      };
      let extFactoryInvoked = false;
      const extPick = extItems.length
        ? await ctx.ui.custom<MultiModelPickerResult>((tui, theme, keybindings, done) => {
          extFactoryInvoked = true;
          return new MultiModelPickerComponent(
            {
              title: "Auditor allowed extensions — space toggles, enter confirms; empty = fully isolated auditor (default)",
              items: extItems,
              initialSelected: currentExts,
              unorderedSet: true,
            },
            () => tui.requestRender(),
            theme,
            keybindings,
            done,
          );
        })
        : undefined;
      let pickedExts: string[] | undefined;
      if (extPick === undefined && !extFactoryInvoked) pickedExts = await extInputFallback();
      else if (extPick === undefined) pickedExts = undefined;
      else pickedExts = Array.isArray(extPick) ? extPick : extPick.refs;
      if (pickedExts === undefined) return;
      const normalizedExts = normalizeAuditorAllowedExtensions(pickedExts);
      saveSettings("global", ctx.cwd, { auditorAllowedExtensions: normalizedExts.length ? normalizedExts : undefined });
      ctx.ui.notify(
        normalizedExts.length
          ? `Auditor allowed extensions saved: ${normalizedExts.length} enabled.`
          : "Auditor allowed extensions cleared — the detached auditor runs extension-less again (default).",
        "info",
      );
      return;
    }
    case "auditorSameSessionSwap": {
      const v = await ctx.ui.select("Same-model swap — when the pinned auditor IS the session model, walk the ordered fallback chain (a same-family model shares the executor's blind spots)", [
        "on — the verifier differs from the executor (default)",
        "off — same-model audits stand; isolation + evidence contract still apply",
      ]);
      if (v) saveSettings("global", ctx.cwd, { auditorSameSessionSwap: v.startsWith("off") ? false : undefined });
      return;
    }
    case "auditCap": {
      const current = loadSettings(ctx.cwd);
      const defaultCap = resolveEffectiveAggressiveSettings({ ...current, auditCap: undefined }).auditCap;
      const v = await ctx.ui.input("Consecutive auditor disapprovals before the goal pauses", `non-negative integer; 0 = unlimited, empty = current default ${defaultCap}`);
      if (v !== undefined) {
        const raw = v.trim();
        const n = parseSettingsInteger(raw);
        if (n !== undefined && n >= 0) saveSettings("global", ctx.cwd, { auditCap: n });
        else if (!raw) saveSettings("global", ctx.cwd, { auditCap: undefined });
        else ctx.ui.notify(`Not a non-negative integer: ${v}`, "warning");
      }
      return;
    }
    case "auditFeedbackChars": {
      const v = await ctx.ui.input("Auditor feedback returned to the executor (characters)", "non-negative integer cap; 0 or empty = full report (default)");
      if (v !== undefined) {
        const raw = v.trim();
        const n = Number(raw);
        if (/^\d+$/.test(raw) && Number.isSafeInteger(n)) saveSettings("global", ctx.cwd, { auditFeedbackChars: n });
        else if (!v.trim()) saveSettings("global", ctx.cwd, { auditFeedbackChars: undefined });
        else ctx.ui.notify(`Not a non-negative integer: ${v}`, "warning");
      }
      return;
    }
    case "wedgeAlertMinutes": {
      const current = loadSettings(ctx.cwd);
      const defaultWedge = resolveEffectiveAggressiveSettings({ ...current, wedgeAlertMinutes: undefined }).wedgeAlertMinutes;
      const v = await ctx.ui.input("Wedge alert threshold (minutes)", `non-negative integer; 0 = off, empty = current default ${defaultWedge}`);
      if (v !== undefined) {
        const raw = v.trim();
        const n = parseSettingsInteger(raw);
        if (n !== undefined && n >= 0) saveSettings("global", ctx.cwd, { wedgeAlertMinutes: n });
        else if (!raw) saveSettings("global", ctx.cwd, { wedgeAlertMinutes: undefined });
        else ctx.ui.notify(`Not a non-negative integer: ${v}`, "warning");
      }
      return;
    }
    case "subagentHangEscalationMinutes": {
      const v = await ctx.ui.input("Subagent hang action threshold (minutes)", "0 = warning/telemetry only; positive integer >= 5; empty = default 30");
      if (v !== undefined) {
        const raw = v.trim();
        const n = parseSettingsInteger(raw);
        if (n !== undefined && n === 0) saveSettings("global", ctx.cwd, { subagentHangEscalationMinutes: 0 });
        else if (n !== undefined && n >= 5) saveSettings("global", ctx.cwd, { subagentHangEscalationMinutes: n });
        else if (!raw) saveSettings("global", ctx.cwd, { subagentHangEscalationMinutes: undefined });
        else ctx.ui.notify(`Subagent hang action must be 0 or an integer >= 5 minutes: ${v}`, "warning");
      }
      return;
    }
    case "stuckMaxInterventions": {
      const current = loadSettings(ctx.cwd);
      const defaultStuck = resolveEffectiveAggressiveSettings({ ...current, stuckMaxInterventions: undefined }).stuckMaxInterventions;
      const v = await ctx.ui.input("Consecutive stuck interventions before a loop stops", `positive integer; empty = current default ${defaultStuck}`);
      if (v !== undefined) {
        const raw = v.trim();
        const n = parseSettingsInteger(raw);
        if (n !== undefined && n > 0) saveSettings("global", ctx.cwd, { stuckMaxInterventions: n });
        else if (!raw) saveSettings("global", ctx.cwd, { stuckMaxInterventions: undefined });
        else ctx.ui.notify(`Not a positive integer: ${v}`, "warning");
      }
      return;
    }
    case "stallEscalationRefires": {
      const v = await ctx.ui.input("Heartbeat refires without a turn before the goal pauses / loop stops", "non-negative integer; 0 = never escalate, empty = default 5");
      if (v !== undefined) {
        const raw = v.trim();
        const n = parseSettingsInteger(raw);
        if (n !== undefined && n >= 0) saveSettings("global", ctx.cwd, { stallEscalationRefires: n });
        else if (!raw) saveSettings("global", ctx.cwd, { stallEscalationRefires: undefined });
        else ctx.ui.notify(`Not a non-negative integer: ${v}`, "warning");
      }
      return;
    }
    case "zombieRetryMaxAttempts": {
      const v = await ctx.ui.input("Automatic retries after a busy zero-stream abort", "integer from 0 to 10; 0 = manual resume only; empty = default 3");
      if (v !== undefined) {
        const raw = v.trim();
        const n = parseSettingsInteger(raw);
        if (n !== undefined && n >= 0 && n <= MAX_ZOMBIE_RETRY_ATTEMPTS) {
          saveSettings("global", ctx.cwd, { zombieRetryMaxAttempts: n });
        } else if (!raw) {
          saveSettings("global", ctx.cwd, { zombieRetryMaxAttempts: undefined });
        } else {
          ctx.ui.notify(`Automatic retry count must be an integer from 0 to ${MAX_ZOMBIE_RETRY_ATTEMPTS}: ${v}`, "warning");
        }
      }
      return;
    }
    case "stallShortWords": {
      const v = await ctx.ui.input("Stall short words threshold", "non-negative integer; 0 = off, empty = default 15");
      if (v !== undefined) {
        const raw = v.trim();
        const n = parseSettingsInteger(raw);
        if (n !== undefined && n >= 0) saveSettings("global", ctx.cwd, { stallShortWords: n });
        else if (!raw) saveSettings("global", ctx.cwd, { stallShortWords: undefined });
        else ctx.ui.notify(`Not a non-negative integer: ${v}`, "warning");
      }
      return;
    }
    case "stallSimilarityThreshold": {
      const v = await ctx.ui.input("Stall similarity threshold (0..1)", "decimal between 0 and 1; empty = default 0.6");
      if (v !== undefined) {
        const n = Number(v.trim());
        if (Number.isFinite(n) && n >= 0 && n <= 1) saveSettings("global", ctx.cwd, { stallSimilarityThreshold: n });
        else if (!v.trim()) saveSettings("global", ctx.cwd, { stallSimilarityThreshold: undefined });
        else ctx.ui.notify(`Not a decimal between 0 and 1: ${v}`, "warning");
      }
      return;
    }
    case "subagentModelStrategy": {
      const v = await ctx.ui.select("Subagent model (pi-subagents default agents)", [
      "inherit-parent — share your session model (recommended)",
      "agent-default — use each upstream pi-subagents role default",
      ]);
      if (v) {
        const strategy: SubagentModelStrategy = v.startsWith("agent-default") ? "agent-default" : "inherit-parent";
        saveSettings("global", ctx.cwd, { subagentModelStrategy: strategy });
        ctx.ui.notify("Subagent model strategy saved — applies to NEW pi sessions (pi-subagents registers agents at session start).", "info");
      }
      return;
    }
    case "subagentDisplayRichness": {
      const v = await ctx.ui.select("Subagent display richness (ambient worker UI)", [
      "rich — worker rows + task linkage (recommended)",
      "compact — the count line only",
      "quiet — hung/aborting workers only (HUNG is never silent)",
      ]);
      if (v) {
        const richness: SubagentDisplayRichness = v.startsWith("compact") ? "compact" : v.startsWith("quiet") ? "quiet" : "rich";
        saveSettings("global", ctx.cwd, { subagentDisplayRichness: richness });
        ctx.ui.notify(`Subagent display richness saved (${richness}) — applies on the next UI refresh.`, "info");
      }
      return;
    }
    case "subagentResolved":
      // Read-only (effective resolution row) — no editor; row just shows the
      // current effective subagent models. Treat as no-op.
      return;
    case "notifyCmd": {
      const v = await ctx.ui.input("Notify command — the event message is passed as $1", "custom command · empty = auto-detect (notify-send/osascript) · 'off' = silent");
      if (v !== undefined) saveSettings("global", ctx.cwd, { notifyCmd: v.trim() || undefined });
      return;
    }
    case "tokenLimit": {
      const v = await ctx.ui.input("Per-goal token budget", "non-negative integer; 0 or empty = off (no cap)");
      if (v !== undefined) {
        const raw = v.trim();
        const n = parseSettingsInteger(raw);
        if (n !== undefined && n >= 0) saveSettings("global", ctx.cwd, { tokenLimit: n });
        else if (!raw) saveSettings("global", ctx.cwd, { tokenLimit: undefined });
        else ctx.ui.notify(`Not a non-negative integer: ${v}`, "warning");
      }
      return;
    }
    case "toolOverrides": {
      const current = loadSettings(ctx.cwd).toolOverrides ?? {};
      const describe = (o: NonNullable<Settings["toolOverrides"]>) =>
        `allow: ${o.allow?.length ? o.allow.join(", ") : "(none)"} · hide: ${o.hide?.length ? o.hide.join(", ") : "(none)"} · config: ${Object.keys(o.perToolConfig ?? {}).length ? `${Object.keys(o.perToolConfig!).length} tool(s)` : "(none)"}`;
      const action = await ctx.ui.select(`Tool overrides — PROJECT scope (this project only) — ${describe(current)}`, [
        "list — show current allow / hide / perToolConfig",
        "allow — force a tool visible despite an external modlist",
        "hide — force a tool hidden despite the session",
        "unallow — remove a forced-visible override",
        "unhide — remove a forced-hidden override",
        "set — write a per-tool config knob (key=value)",
        "unset — remove a per-tool config knob",
      ]);
      if (!action) return;
      const verb = action.split(" ")[0]!.toLowerCase();
      if (verb === "list") {
        ctx.ui.notify(`toolOverrides (project):\n${describe(current)}`, "info");
        return;
      }
      const toolName = await ctx.ui.input(`Tool name (${verb})`, "e.g. bash, complete_goal — empty cancels");
      if (toolName === undefined || !toolName.trim()) return;
      const tool = toolName.trim();
      const apply = (patch: Partial<NonNullable<Settings["toolOverrides"]>>) =>
        saveSettings("project", ctx.cwd, { toolOverrides: { ...current, ...patch } });
      if (verb === "allow" || verb === "hide") {
        if (verb === "allow") {
          const list = current.allow ?? [];
          if (!list.includes(tool)) apply({ allow: [...list, tool] });
        } else {
          const list = current.hide ?? [];
          if (!list.includes(tool)) apply({ hide: [...list, tool] });
        }
        ctx.ui.notify(`"${tool}" is now ${verb === "allow" ? "always visible" : "always hidden"} (project override saved).`, "info");
        return;
      }
      if (verb === "unallow" || verb === "unhide") {
        if (verb === "unallow") apply({ allow: (current.allow ?? []).filter((t: string) => t !== tool) });
        else apply({ hide: (current.hide ?? []).filter((t: string) => t !== tool) });
        ctx.ui.notify(`"${tool}" ${verb.slice(2)} override removed — the session decides again.`, "info");
        return;
      }
      const kv = await ctx.ui.input(
        `Config ${verb} — ${verb === "set" ? "key=value" : "key"}`,
        verb === "set" ? "e.g. timeout=60, stream=true — empty cancels" : "e.g. timeout — empty cancels",
      );
      if (kv === undefined || !kv.trim()) return;
      const cfg = { ...(current.perToolConfig ?? {}) };
      const toolCfg = { ...(cfg[tool] ?? {}) };
      if (verb === "set") {
        const eq = kv.indexOf("=");
        if (eq < 0) {
          ctx.ui.notify(`set needs key=value: got "${kv}"`, "warning");
          return;
        }
        toolCfg[kv.slice(0, eq)] = parseToolOverrideValueLocal(kv.slice(eq + 1));
      } else {
        delete toolCfg[kv.trim()];
      }
      cfg[tool] = toolCfg;
      apply({ perToolConfig: cfg });
      ctx.ui.notify(`"${tool}" config ${verb === "set" ? "saved" : "removed"} (project override).`, "info");
      return;
    }
    case "postaudit":
      await cmdReviewerSettings(ctx);
      return;
    default:
      // Unknown id — keep the menu looping. Surface a soft warning so the
      // user knows a row existed but had no handler (better than silently
      // swallowing it).
      ctx.ui.notify(`/glla: unknown setting id "${id}" — please report this.`, "warning");
      return;
  }
}

/** v0.26.0: /review <archived-goal-id> — manual reviewer invocation. */
function observeModelChange(ctx: ExtensionContext, from: string | undefined, to: string | undefined, reason: string, source: string | undefined): boolean {
  if (!from || !to || from === to) return false;
  const settings = loadSettings(ctx.cwd);
  const forbidden = isForbiddenModel(to, settings.forbiddenModels);
  const at = Date.now();
  const blocked = forbidden && settings.blockForbiddenModelSwitches !== false && reason !== "turn-boundary" && !mainModelSwitchInFlight;
  if (forbidden) {
    // The switch either stands (blocked: false) or was reverted (blocked:
    // true) — one event tells the whole story; a model_switch entry would
    // falsely claim the forbidden model took over.
    appendLedger(ctx.cwd, "forbidden_model_switch", {
      ...modelSwitch(from, to, reason, at),
      ...(source ? { source } : {}),
      blocked,
    });
    // Vision-assist evidence for the too-eager-switch symptom. With vision
    // assist on, record the native-first routing alternative. Advisory, not
    // a claim about the switch's motive; external providers are optional.
    if (settings.visionAssist !== false) {
      const vr = routeVisionCheck({ targetModelRef: to, forbiddenModels: settings.forbiddenModels });
      appendLedger(ctx.cwd, "vision_assist", {
        ...visionAssistLedger(vr, { targetModelRef: to }),
        reason: "forbidden_model_switch",
      });
    }
  } else {
    appendLedger(ctx.cwd, "model_switch", {
      ...modelSwitch(from, to, reason, at),
      ...(source ? { source } : {}),
    });
  }
  state.lastModelRef = to;
  persistState(ctx);
  return blocked;
}

/** v0.34.57: turn-boundary model observation — the session is about to run
 * a turn on a different model than last observed. The first observation in
 * a process just baselines (no ledger entry); a change baselines AND
 * records drift that arrived without a model_select event (a fresh pi
 * launch with a changed default model fires none). */
function observeTurnBoundaryModel(ctx: ExtensionContext): void {
  const current = modelRef(ctx.model);
  if (!current) return;
  const last = state.lastModelRef;
  if (last && last !== current) {
    observeModelChange(ctx, last, current, "turn-boundary", undefined);
  } else if (!last) {
    state.lastModelRef = current;
    persistState(ctx);
  }
}


/* Runtime globals: preserve the old monolith lexical links across extracted modules. */
defineGoalRuntimeGlobal("auditorThinkingLevels", { get: () => auditorThinkingLevels });
defineGoalRuntimeGlobal("resolveAuditorModel", { get: () => resolveAuditorModel });
defineGoalRuntimeGlobal("openSettingsUI", { get: () => openSettingsUI });
defineGoalRuntimeGlobal("promptSettingsMenu", { get: () => promptSettingsMenu });
defineGoalRuntimeGlobal("promptModelRef", { get: () => promptModelRef });
defineGoalRuntimeGlobal("promptModelRefs", { get: () => promptModelRefs });
defineGoalRuntimeGlobal("handleSettingChoice", { get: () => handleSettingChoice });
defineGoalRuntimeGlobal("observeModelChange", { get: () => observeModelChange });
defineGoalRuntimeGlobal("observeTurnBoundaryModel", { get: () => observeTurnBoundaryModel });
