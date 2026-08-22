/**
 * goal-commands.ts — command surface extracted from extensions/loops/goal.ts
 * (decomposition step 2, v0.34.110). Zero behavior change: moved bodies
 * byte-identical except `flags.<name>` accessors. One-way imports; deps
 * arrive via createGoalCommands.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionContext, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { state, replaceState } from "./goal-state.js";
import {
  DEFAULT_TOKEN_LIMIT, Goal, ListItem, Status, appendLedger, archiveDir, archivedGoalPath, bumpGoalRevision, sanitizeProviderDisplayText,
  computeListDepth, clearQueueItemFiles, deleteQueueItemFile, extractVerificationContract, formatAuditLog, formatGoalAuditHistory, formatMainModelRecoveryStatus, queueItemSidecarCount,
  formatListDepth, goalArgsNeedDrafting, ledgerPath, newGoalId, nowIso, parseListImport, parseListItemDeclaration,
  assignQueueOrder, compareQueueItems, readAuditLog, readQueueFromDisk, routeGoalArgs, routeListText, sanitizeDisplayText, sanitizeProviderAuditReport, statusLabel,
  writeQueueItemFile, type ModeCommand, type State, LIST_MUTATING_SUBCOMMANDS, SETTINGS_MUTATING_ACTIONS,
  clearLoadHold,
} from "./goal-loop-core.js";
import { clearDispatchRecord, dispatchRecordExists } from "./goal-loop-dispatch.js";
import type { AuditDisplayProgress } from "./goal-loop-display.js";
import { fmtElapsed } from "./goal-loop-display.js";
import { AUDIT_FINDINGS_REL, HELD_ON_RESTORE, LOOP_AUDIT_MARKER, listAuditCollectTarget, projectAuditTarget } from "./goal-loop-forever.js";
import { ProjectRollup, discoverGllaProjects, filterPremature, formatRollupJson, formatRollupTable, parseLedgerEntries, rollupProject } from "./goal-loop-stats.js";
import { OVERRIDABLE_AGENT_TYPES, resolveEffectiveSubagentModel } from "./goal-loop-subagents.js";
import { Settings, globalSettingsPath, loadSettings, projectSettingsPath, saveSettings, settingsProvenance } from "./goal-settings.js";
import { formatMainModelFallbacks, normalizeMainModelFallbackRefs } from "./main-model-recovery.js";
import { ReviewerConfig, normalizeObjective, resolveReviewerConfig, reviewerMenuOptions } from "./reviewer.js";
import type { SettingsSectionId } from "./settings-menu.js";
import { cmdLoop, clearLoopTimer, finishLoopGit, isLoopActive, scheduleLoopTick } from "./goal-loop.js";
import { chooseObjectiveConflict, liveObjectives } from "./goal-objective-conflict.js";
import { formatGllaVersion } from "./glla-version.js";
import { cancelDetachedGoalCompletionAuditor } from "./goal-loop-auditor-process.js";

export interface CommandFlags {
  get draftingTarget(): "goal" | "list" | "loop" | null; set draftingTarget(v: "goal" | "list" | "loop" | null);
  get completionAuditInFlight(): boolean; set completionAuditInFlight(v: boolean);
  get completionAuditRecoveryArmed(): boolean; set completionAuditRecoveryArmed(v: boolean);
  get consecutiveAbortIterations(): number; set consecutiveAbortIterations(v: number);
  get consecutiveErrorIterations(): number; set consecutiveErrorIterations(v: number);
  get continuationDispatchStoodDown(): boolean; set continuationDispatchStoodDown(v: boolean);
  get extensionApi(): ExtensionAPI | null; set extensionApi(v: ExtensionAPI | null);
  get iterationCounter(): number; set iterationCounter(v: number);
  get latestAuditProgress(): AuditDisplayProgress | null; set latestAuditProgress(v: AuditDisplayProgress | null);
  get mainModelAbortForRecovery(): boolean; set mainModelAbortForRecovery(v: boolean);
  get mainModelSwitchInFlight(): boolean; set mainModelSwitchInFlight(v: boolean);
  get sessionGeneration(): number; set sessionGeneration(v: number);
}

export interface CommandDeps {
  flags: CommandFlags;
  listQueue: () => NonNullable<State["list"]>;
  notifyExternal: (ctx: ExtensionContext, message: string) => void;
  persistState: (ctx: ExtensionContext) => void;
  updateGoal: (patch: Partial<Goal>, ctx: ExtensionContext) => void;
  setGoal: (goal: Goal, ctx: ExtensionContext, via?: string) => boolean;
  archiveCurrentGoal: (ctx: ExtensionContext, status: Status, stopReason?: string) => boolean;
  healGoalPolicy: (ctx: ExtensionContext) => boolean;
  startDrafting: (ctx: ExtensionContext, target: "goal" | "list" | "loop", seed?: string) => Promise<boolean>;
  warnIfStaleAtEntry: (ctx: ExtensionContext, what: string) => boolean;
  queuePendingListOperation: (ctx: ExtensionContext, args: string) => boolean;
  freshCtx: () => ExtensionContext | null;
  freshCtxForGeneration: (generation: number) => ExtensionContext | null;
  goStaleTerminal: (ctx: ExtensionContext, where: string) => void;
  groupOpenChildren: (groupId: string) => number;
  activateNextListItem: (ctx: ExtensionContext, n?: number, opts?: { explicit?: boolean }) => boolean;
  clearMainModelRecoveryTimer: () => void;
  mainModelRecoveryTimerActive: () => boolean;
  continuationDispatchPending: () => boolean;
  resetContinuationDispatchState: (cwd: string) => boolean;
  isCompletionAuditRecoveryPending: (goal: Goal | null | undefined) => boolean;
  markCompletionAuditRecoveryPending: (ctx: ExtensionContext, reason: string) => boolean;
  retryStoredCompletionAudit: (origin?: "complete-goal" | "provider-retry" | "manual" | "session-recovery") => Promise<void>;
  probeMainModelRecovery: (ctx: ExtensionContext) => Promise<void>;
  releaseContinuationDispatchStandDown: () => void;
  releaseInitialSessionLoadBarrier: () => void;
  resolveCarryover: (ctx: ExtensionContext, trigger: "goal" | "loop" | "list") => void;
  safeSteerUser: (ctx: ExtensionContext, text: string) => boolean;
  scheduleContinuation: (ctx: ExtensionContext, force?: boolean, delayMs?: number) => void;
  scheduleSessionTimeout: (callback: () => void, delayMs: number) => NodeJS.Timeout;
  createGoal: (objective: string, ctx: ExtensionContext, policy?: "goal" | "list") => Goal;
  fireReviewer: (ctx: ExtensionContext, source: { kind: "goal" | "list"; goalId: string; objective: string; terminal: string }, opts?: { manual?: boolean; mode?: "off" | "on" | "auto" | "aggressive" }) => void;
  openSettingsUI: (ctx: ExtensionContext, initialSection?: SettingsSectionId) => Promise<void>;
  manuallyResumeMainModelRecovery: (ctx: ExtensionContext) => boolean;
  activeGoalCommand: (command: ModeCommand) => string;
  activeGoalStatusCommand: () => string;
  activeGoalSurfaceCommand: (command: string) => string;
  goalNoun: () => string;
  displaySlice: (s: string, max: number) => string;
  shortObj: (s: string) => string;
}

let deps: CommandDeps;
let flags: CommandFlags;
let listQueue: CommandDeps["listQueue"], notifyExternal: CommandDeps["notifyExternal"], persistState: CommandDeps["persistState"], updateGoal: CommandDeps["updateGoal"], setGoal: CommandDeps["setGoal"],
    archiveCurrentGoal: CommandDeps["archiveCurrentGoal"], healGoalPolicy: CommandDeps["healGoalPolicy"], startDrafting: CommandDeps["startDrafting"], warnIfStaleAtEntry: CommandDeps["warnIfStaleAtEntry"], queuePendingListOperation: CommandDeps["queuePendingListOperation"], freshCtx: CommandDeps["freshCtx"],
    freshCtxForGeneration: CommandDeps["freshCtxForGeneration"], goStaleTerminal: CommandDeps["goStaleTerminal"], groupOpenChildren: CommandDeps["groupOpenChildren"], activateNextListItem: CommandDeps["activateNextListItem"], clearMainModelRecoveryTimer: CommandDeps["clearMainModelRecoveryTimer"], mainModelRecoveryTimerActive: CommandDeps["mainModelRecoveryTimerActive"], continuationDispatchPending: CommandDeps["continuationDispatchPending"], resetContinuationDispatchState: CommandDeps["resetContinuationDispatchState"],
    isCompletionAuditRecoveryPending: CommandDeps["isCompletionAuditRecoveryPending"], markCompletionAuditRecoveryPending: CommandDeps["markCompletionAuditRecoveryPending"], retryStoredCompletionAudit: CommandDeps["retryStoredCompletionAudit"], probeMainModelRecovery: CommandDeps["probeMainModelRecovery"], releaseContinuationDispatchStandDown: CommandDeps["releaseContinuationDispatchStandDown"],
    releaseInitialSessionLoadBarrier: CommandDeps["releaseInitialSessionLoadBarrier"], resolveCarryover: CommandDeps["resolveCarryover"], safeSteerUser: CommandDeps["safeSteerUser"], scheduleContinuation: CommandDeps["scheduleContinuation"], scheduleSessionTimeout: CommandDeps["scheduleSessionTimeout"],
    createGoal: CommandDeps["createGoal"], fireReviewer: CommandDeps["fireReviewer"], openSettingsUI: CommandDeps["openSettingsUI"], manuallyResumeMainModelRecovery: CommandDeps["manuallyResumeMainModelRecovery"], activeGoalCommand: CommandDeps["activeGoalCommand"],
    activeGoalStatusCommand: CommandDeps["activeGoalStatusCommand"], activeGoalSurfaceCommand: CommandDeps["activeGoalSurfaceCommand"], goalNoun: CommandDeps["goalNoun"], displaySlice: CommandDeps["displaySlice"], shortObj: CommandDeps["shortObj"];

export function createGoalCommands(d: CommandDeps): void {
  deps = d; flags = d.flags;
  listQueue = d.listQueue; notifyExternal = d.notifyExternal; persistState = d.persistState; updateGoal = d.updateGoal; setGoal = d.setGoal;
  archiveCurrentGoal = d.archiveCurrentGoal; healGoalPolicy = d.healGoalPolicy; startDrafting = d.startDrafting; warnIfStaleAtEntry = d.warnIfStaleAtEntry; queuePendingListOperation = d.queuePendingListOperation; freshCtx = d.freshCtx;
  freshCtxForGeneration = d.freshCtxForGeneration; goStaleTerminal = d.goStaleTerminal; groupOpenChildren = d.groupOpenChildren; activateNextListItem = d.activateNextListItem; clearMainModelRecoveryTimer = d.clearMainModelRecoveryTimer; mainModelRecoveryTimerActive = d.mainModelRecoveryTimerActive; continuationDispatchPending = d.continuationDispatchPending; resetContinuationDispatchState = d.resetContinuationDispatchState;
  isCompletionAuditRecoveryPending = d.isCompletionAuditRecoveryPending; markCompletionAuditRecoveryPending = d.markCompletionAuditRecoveryPending; retryStoredCompletionAudit = d.retryStoredCompletionAudit; probeMainModelRecovery = d.probeMainModelRecovery; releaseContinuationDispatchStandDown = d.releaseContinuationDispatchStandDown;
  releaseInitialSessionLoadBarrier = d.releaseInitialSessionLoadBarrier; resolveCarryover = d.resolveCarryover; safeSteerUser = d.safeSteerUser; scheduleContinuation = d.scheduleContinuation; scheduleSessionTimeout = d.scheduleSessionTimeout;
  createGoal = d.createGoal; fireReviewer = d.fireReviewer; openSettingsUI = d.openSettingsUI; manuallyResumeMainModelRecovery = d.manuallyResumeMainModelRecovery; activeGoalCommand = d.activeGoalCommand;
  activeGoalStatusCommand = d.activeGoalStatusCommand; activeGoalSurfaceCommand = d.activeGoalSurfaceCommand; goalNoun = d.goalNoun; displaySlice = d.displaySlice; shortObj = d.shortObj;
}

/* Moved bodies (bands b1 + b3 from goal.ts).                          */

async function cmdGoal(args: string, ctx: ExtensionContext): Promise<void> {
  // v0.34.68 (bug 1.7): heal a corrupted mode flag BEFORE any gate branches
  // on state.goal.policy — a silent "disallows until restart" must not
  // refuse /goal drafting or actions.
  healGoalPolicy(ctx);
  const route = routeGoalArgs(args);
  if (route.kind === "sub") {
    if (route.name === "status") return cmdStatus(ctx);
    if (route.name === "pause") return cmdPause(ctx);
    if (route.name === "resume") return cmdResume(ctx);
    if (route.name === "cancel") return cmdCancel(ctx);
    // v0.28.23: re-open the decision picker for a decision pause (the
    // popup auto-opens when the pause lands; this is the on-demand path).
    if (route.name === "decide") {
      const shown = await showDecisionPrompt(ctx);
      if (!shown) ctx.ui.notify("No pending decision — the goal isn't paused on a choice (or no UI).", "info");
      return;
    }
    // v0.29.8: /goal audit [focus] — the ONE-SHOT project audit (user:
    // "/goal audit IS the audit goal — we are not auditing the current
    // goal, that happens automatically"). Fire-and-address: one audit
    // pass, FIX findings fixed autonomously (a bug is not a decision),
    // DECIDE findings presented, untouched. Runs as a normal goal through
    // cmdSet — the isolated auditor verifies the finish line.
    if (route.name === "audit") {
      // v0.31.1: an active audit loop already owns auditing here — the
      // one-shot duplicates it (same stacking confusion as junk-runner).
      if (state.loop?.active && state.loop.target.includes(LOOP_AUDIT_MARKER)) {
        appendLedger(ctx.cwd, "audit_stack_warn", { have: "loop", starting: "goal" });
        ctx.ui.notify(
          "An audit loop is already running here — a one-shot /goal audit duplicates its work. /loop status to see it; /loop stop first if you want the one-shot instead.",
          "warning",
        );
      }
      return cmdSet(projectAuditTarget(route.rest || undefined), ctx, true);
    }
    // v0.28.27 (renamed /goal audit → /goal verify in v0.29.8): run the
    // isolated auditor on the current goal
    // RIGHT NOW, without engaging the agent. The user's "the work looks
    // done — just verify it" handle (and the manual counterpart of the
    // v0.28.26 stored-claim provider retry). Seeds a synthesized claim so an
    // infrastructure failure falls into the same pendingCompletion machinery.
    if (route.name === "verify") {
      if (!state.goal) {
        ctx.ui.notify("No active goal — /goal verify needs a goal to verify.", "warning");
        return;
      }
      if (flags.completionAuditInFlight) {
        ctx.ui.notify("An audit is already running…", "info");
        return;
      }
      updateGoal({
        pendingCompletion: {
          completionSummary: "Manual audit requested by the user via /goal verify (no agent completion claim). Verify the objective against the repo directly.",
          at: nowIso(),
        },
      }, ctx);
      appendLedger(ctx.cwd, "manual_audit_requested", { goalId: state.goal.id });
      void retryStoredCompletionAudit("manual");
      return;
    }
    if (route.name === "tweak") {
      await cmdTweak(route.rest, ctx);
      return;
    }
    if (route.name === "archive") return cmdGoals(ctx);
    // v0.16.0: /goal start <objective> — explicit skip-draft. Activates
    // immediately, no interview, no "Done when:" heuristic. Symmetric
    // with /loop start. The auditor infers the contract from the objective.
    if (route.name === "start") {
      if (!route.rest) {
        ctx.ui.notify("Usage: /goal start <objective> — activates immediately, skipping the drafting interview. (Without start, an objective needs a 'Done when:' clause or it gets drafted first.)", "warning");
        return;
      }
      return cmdSet(route.rest, ctx, true);
    }
  }
  return cmdSet(route.kind === "set" ? route.text : "", ctx);
}

async function resolveGoalStartConflict(ctx: ExtensionContext, objective: string): Promise<boolean> {
  const current = liveObjectives(state);
  if (current.length === 0) return true;
  const choice = await chooseObjectiveConflict(ctx, "goal", objective, current);
  if (choice === "cancel") {
    ctx.ui.notify("New goal cancelled; the current objective is unchanged.", "info");
    return false;
  }
  if (choice === "update") {
    const one = current[0];
    if (one?.kind === "goal" && one.status === "active") {
      await updateWholeObjectiveFromConflict(ctx, objective, "goal");
    } else if (one?.kind === "loop") {
      await cmdLoop(`refine ${objective}`, ctx);
    } else {
      ctx.ui.notify("Update selected, but the current list item has no safe cross-mode in-place edit. No new goal was started.", "info");
    }
    return false;
  }
  // Replacement is explicit. Stop a loop first; setGoal archives a live
  // goal/list item before installing the new one.
  for (const item of current) {
    if (item.kind === "loop" && isLoopActive()) await cmdLoop("stop", ctx);
  }
  return true;
}

// =================================================================
// /goal: bypass drafting, start now (the only entry in v0.1.0)
// =================================================================

async function cmdSet(args: string, ctx: ExtensionContext, skipDraft = false): Promise<void> {
  releaseInitialSessionLoadBarrier();
  // v0.28.1 (S3): probe at the creation entry — no "created — starting now"
  // lie in a doomed process. (The draft path's seed send has its own loud
  // stale handling — E6.)
  const staleEntry = warnIfStaleAtEntry(ctx, "/goal");
  let raw = args.trim();
  // Users naturally quote the objective ("/goal \"do X\""); strip one layer of
  // surrounding matching quotes so they don't leak into the goal text.
  if (raw.length >= 2 && ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'")))) {
    raw = raw.slice(1, -1).trim();
  }
  if (!raw) {
    // A stale MAIN cannot deliver the interview seed. Do not create an
    // orphaned drafting gate after the entry warning has fired.
    if (staleEntry) return;
    await startDrafting(ctx, "goal");
    return;
  }
  // v0.11.0: a contract-less objective gets drafted, not activated raw —
  // the pi-goal-x lesson: arg + Enter is worse than a 5-minute draft.
  // Include an explicit "Done when: …" clause to activate instantly.
  // v0.16.0: /goal start bypasses this by explicit user command.
  if (!skipDraft && goalArgsNeedDrafting(raw)) {
    if (staleEntry) return;
    await startDrafting(ctx, "goal", raw);
    return;
  }
  if (!(await resolveGoalStartConflict(ctx, raw))) return;
  flags.draftingTarget = null; // explicit objective cancels any drafting session
  await ((globalThis as any).restoreDrafterModel?.() ?? Promise.resolve());
  resolveCarryover(ctx, "goal"); // v0.28.14: surface/clear stale leftovers
  const goal = createGoal(raw, ctx);
  if (!setGoal(goal, ctx)) return;
  // Reset counters
  flags.iterationCounter = 0;
  flags.consecutiveErrorIterations = 0;
  flags.consecutiveAbortIterations = 0;
  if (staleEntry) {
    // v0.28.1 (S3): the goal is persisted — mark the interrupt so the next
    // fresh session LOADS it (held by default since v0.28.21), and tell the truth instead of "starting now".
    updateGoal({ interruptedAt: nowIso(), interruptedReason: "created in a stale session" }, ctx);
    ctx.ui.notify(`Goal saved: ${shortObj(goal.objective)} — safe in .pi-glla/, but this stale process can't send continuations. Use /new to create a fresh context; its session_start will resume it. If /new does not create one, restart pi normally, then ${activeGoalSurfaceCommand("resume")} if autoresume is off.`, "warning");
    return;
  }
  ctx.ui.notify(`Goal started: ${shortObj(goal.objective)} — the auditor will verify on completion.`, "info");
  scheduleContinuation(ctx, true);
}

async function cmdStatus(ctx: ExtensionContext): Promise<void> {
  if (!state.goal) {
    const recoveryLines = formatMainModelRecoveryStatus(state.mainModelRecovery, normalizeMainModelFallbackRefs(loadSettings(ctx.cwd).mainModelFallbacks));
    if (recoveryLines.length > 0) {
      ctx.ui.notify(["No active goal.", ...recoveryLines, "Use /goal <objective>, /list show, or /loop status for the owning surface."].join("\n"), "info");
      return;
    }
    ctx.ui.notify("No active goal. Use /goal <objective>.", "info");
    return;
  }
  const g = state.goal;
  const lines = [
    `${statusLabel(g.status)}: ${sanitizeDisplayText(g.objective)}`,
    ...(g.agentRole ? [`Agent role: ${g.agentRole} subagent checkpoint requested`] : []),
    // v0.24.7: name WHERE the work came from — a queue item is not a goal.
    ...(g.policy === "list" ? [`Source: /list queue (${listQueue().length} waiting) — /list to manage`] : []),
    `Auto-continue: ${g.autoContinue ? "on" : "off"}`,
    `Iteration: ${flags.iterationCounter}`,
    `Tokens: ${(g.usage?.tokensUsed ?? 0).toLocaleString()}${(g.usage?.tokensLimit ?? 0) > 0 ? ` / ${(g.usage!.tokensLimit).toLocaleString()}` : " (no cap — set Token limit in /glla settings)"}`, 
    ...formatMainModelRecoveryStatus(state.mainModelRecovery, normalizeMainModelFallbackRefs(loadSettings(ctx.cwd).mainModelFallbacks)),
  ];
  if (g.auditHistory && g.auditHistory.length > 0) {
    lines.push(`Audits: ${g.auditHistory.length} (${g.auditHistory.filter((v) => v.approved).length} approved)`);
  }
  if (g.status === "auditing") {
    lines.push(`Completion audit: ${isCompletionAuditRecoveryPending(g) ? `recovery pending — ${activeGoalSurfaceCommand("resume")} retries the stored claim` : flags.completionAuditInFlight && flags.latestAuditProgress?.label === "queued" ? "detached auditor queued" : flags.completionAuditInFlight ? "detached auditor running" : "awaiting lifecycle recovery"}`);
  }
  if (g.pauseReason) lines.push(`Paused: ${sanitizeProviderDisplayText(g.pauseReason)}`);
  ctx.ui.notify(lines.join("\n"), "info");
}

async function cmdPause(ctx: ExtensionContext): Promise<void> {
  if (!state.goal) return;
  if (state.mainModelRecovery?.kind === "goal") {
    clearMainModelRecoveryTimer();
    state.mainModelRecovery = undefined;
    flags.mainModelAbortForRecovery = false;
  }
  releaseContinuationDispatchStandDown();
  clearDispatchRecord(ctx.cwd);
  const resumeCommand = activeGoalCommand("resume");
  updateGoal({
    status: "paused",
    pauseKind: "blocked",
    pauseReason: "paused by user",
    pauseSuggestedAction: `${resumeCommand} to continue`,
    pauseResumeAt: undefined,
  }, ctx);
  // v0.22.7: name WHAT was paused — a list item resumes through /list.
  if (state.goal.policy === "list") {
    const queued = listQueue().length;
    ctx.ui.notify(`List item "${shortObj(state.goal.objective)}" paused${queued > 0 ? ` (${queued} waiting in the list)` : ""}. ${resumeCommand} to continue.`, "info");
    return;
  }
  ctx.ui.notify(`Goal "${shortObj(state.goal.objective)}" paused. ${resumeCommand} to continue.`, "info");
}

async function cmdResume(ctx: ExtensionContext): Promise<void> {
  releaseInitialSessionLoadBarrier();
  // v0.35.23 (note.md Next #2): an explicit resume is exactly the decision
  // the load hold waits for — release it before re-arming automation, or
  // the scheduleContinuation below would be a frozen no-op.
  if (clearLoadHold(state)) {
    persistState(ctx);
    appendLedger(ctx.cwd, "load_hold_released", { via: "goal-resume" });
    ctx.ui.notify("Load hold released — automation is live again.", "info");
  }
  const resumeCommand = activeGoalCommand("resume");
  if (manuallyResumeMainModelRecovery(ctx)) return;
  if (state.mainModelRecovery?.retryAt || state.mainModelRecovery?.pendingModelSwitch) {
    clearMainModelRecoveryTimer();
    flags.continuationDispatchStoodDown = false;
    // v0.34.92: the chat-prompt re-arm was removed; recovery is timer-driven.
    ctx.ui.notify("Retrying the saved main-model recovery now — one provider probe, then the configured fallback models if needed.", "info");
    void probeMainModelRecovery(ctx);
    return;
  }
  if (state.mainModelRecovery?.primaryProbeAt || state.mainModelRecovery?.primaryProbeInFlight) {
    clearMainModelRecoveryTimer();
    flags.continuationDispatchStoodDown = false;
    ctx.ui.notify("Probing the preferred primary now — the current fallback remains available if the primary is still unhealthy.", "info");
    void probeMainModelRecovery(ctx);
    return;
  }
  // v0.34.3: /goal resume on an ACTIVE-but-idle goal re-kicks its
  // continuation (was: silent return — the user got NOTHING while the
  // widget said "active"). One-active-thing still holds: an active loop
  // wins over the re-kick.
  if (state.goal && state.goal.status === "active") {
    if (isLoopActive()) {
      ctx.ui.notify("A loop is active — one active thing at a time. /loop stop it first, then resume the goal.", "warning");
      return;
    }
    appendLedger(ctx.cwd, "resume_rekick", { goalId: state.goal.id, policy: state.goal.policy, via: resumeCommand });
    if (state.goal.interruptedAt) updateGoal({ interruptedAt: undefined, interruptedReason: undefined }, ctx); // v0.34.7: same marker law here
    ctx.ui.notify(
      `The ${state.goal.policy === "list" ? "list item" : "goal"} is ACTIVE but idle — re-firing its continuation: ${displaySlice(state.goal.objective, 70)}`,
      "info",
    );
    scheduleContinuation(ctx, true);
    return;
  }
  if (state.goal?.status === "auditing") {
    if (!state.goal.pendingCompletion) {
      ctx.ui.notify(`A detached completion auditor is in flight — wait for its verdict (the status line shows auditor running). ${activeGoalSurfaceCommand("cancel")} discards the pending claim.`, "info");
      return;
    }
    if (flags.completionAuditInFlight) {
      ctx.ui.notify(`The detached completion auditor is already running — wait for its verdict or ${activeGoalSurfaceCommand("cancel")} to discard the pending claim.`, "info");
      return;
    }
    if (isLoopActive()) {
      ctx.ui.notify("A loop is active — one active thing at a time. /loop stop it first, then resume the completion audit.", "warning");
      return;
    }
    const staleEntry = warnIfStaleAtEntry(ctx, resumeCommand);
    if (staleEntry) return;
    markCompletionAuditRecoveryPending(ctx, "manual-resume");
    flags.completionAuditRecoveryArmed = true;
    ctx.ui.notify("Resuming the stored completion claim — starting a detached auditor (no agent turn needed).", "info");
    void retryStoredCompletionAudit("manual");
    return;
  }
  if (!state.goal || state.goal.status !== "paused") {
    // v0.34.103 (GitHub #6, Defect B): /goal resume on an archived,
    // complete, or aborted goal produced NO feedback at all — an
    // ineffective command must answer. Name the actual state and the
    // real recovery path instead of swallowing the verb silently.
    if (!state.goal) {
      const loopHint = isLoopActive() ? " A loop is active: /loop resume (or /loop status)." : " /goal <objective> starts one (or /list show for the queue).";
      ctx.ui.notify(`Nothing to resume — no goal is active or paused.${loopHint}`, "info");
      return;
    }
    const label = state.goal.policy === "list" ? "list item" : "goal";
    const terminal = state.goal.status === "complete" || state.goal.status === "aborted";
    if (terminal) {
      ctx.ui.notify(
        `The ${label} is ${state.goal.status} (archived) — it can't be resumed. ${state.goal.policy === "list" ? "/list add <objective> re-queues it; /list show lists waiting items." : "/goal <objective> starts a fresh one; /goal archive lists archived goals."}`,
        "warning",
      );
    } else {
      ctx.ui.notify(`The ${label} is ${state.goal.status} — nothing to resume. ${activeGoalStatusCommand()} for the current state.`, "info");
    }
    return;
  }
  // v0.28.21: one-active-thing — the LAST unguarded activation path. A
  // paused goal/list-item must not resume over a live loop (covers
  // /goal resume AND /list resume, which routes here).
  if (isLoopActive()) {
    ctx.ui.notify("A loop is active — one active thing at a time. /loop stop it first, then resume the goal.", "warning");
    return;
  }
  // v0.28.1 (S1/S3): resuming in a stale session used to flip status to
  // active, claim "Resumed goal", then re-pause on the stale send failure
  // (or zombie — S1). Now: persist the resume (the next fresh session
  // auto-resumes ACTIVE goals), mark the interrupt, tell the truth, and
  // skip the send that can never land.
  const staleEntry = warnIfStaleAtEntry(ctx, resumeCommand);
  // v0.12.0: refresh the token cap from CURRENT settings on resume — goals
  // snapshot the cap at creation, so a goal paused under an old default
  // (e.g. 10M) would re-pause instantly even after the default changed.
  const freshLimit = loadSettings(ctx.cwd).tokenLimit ?? DEFAULT_TOKEN_LIMIT;
  const usage = state.goal.usage
    ? { tokensUsed: state.goal.usage.tokensUsed, tokensLimit: freshLimit }
    : undefined;
  // v0.34.2: clear the stale-handle interrupt marker on a MANUAL resume too —
  // the only clear-site used to be the autoResume restore path, so with
  // autoresume=off a resumed goal kept the red "⚠ interrupted — stale handle"
  // status line forever while actively working (hegemon, 2026-08-01). The
  // marker's promise ("a fresh session will resume you") is fulfilled by a
  // manual resume exactly as by an automatic one. (staleEntry still re-marks
  // below — a resume inside a stale session is a NEW interrupt.)
  const storedCompletion = state.goal.pendingCompletion;
  updateGoal({ status: "active", pauseReason: undefined, pauseSuggestedAction: undefined, pauseKind: undefined, pauseOptions: undefined, pauseRecommended: undefined, pauseResumeAt: undefined, interruptedAt: undefined, interruptedReason: undefined, autoResumedAt: undefined, autoResumedEvent: undefined, ...(staleEntry ? { interruptedAt: nowIso(), interruptedReason: "resumed in a stale session" } : {}), ...(usage ? { usage } : {}) }, ctx);
  if (staleEntry) return;
  // A stored completion claim is a direct-audit resume, not an agent turn.
  // Keeping the claim while merely scheduling a continuation left manual
  // pause/resume with an ACTIVE goal that no timer would ever consume.
  if (storedCompletion) {
    ctx.ui.notify("Resuming the stored completion claim — starting a detached auditor (no agent turn needed).", "info");
    void retryStoredCompletionAudit("manual");
    return;
  }
  // v0.22.5: say what was resumed — with a non-empty list this also resumes
  // the queue (the active goal IS the list's head item).
  // v0.22.7: name WHAT was resumed — list items resume through /list.
  const queued = listQueue().length;
  const isListItem = state.goal.policy === "list";
  ctx.ui.notify(
    isListItem
      ? `Resumed list item [${state.goal.id}]: ${displaySlice(state.goal.objective, 70)}${queued > 0 ? ` (+${queued} waiting in the list)` : ""}`
      : `Resumed goal [${state.goal.id}]: ${displaySlice(state.goal.objective, 70)}${queued > 0 ? ` (+${queued} waiting in the list — resuming the list's head)` : ""}`,
    "info",
  );
  scheduleContinuation(ctx, true);
}

async function cmdCancel(ctx: ExtensionContext): Promise<void> {
  if (!state.goal) {
    // v0.28.14: users reach for /goal cancel to kill a LOOP (no goal
    // active) — point at the right verb instead of doing nothing silently.
    if (isLoopActive()) {
      ctx.ui.notify("No goal to cancel — a LOOP is active: /loop stop (or /loop cancel) ends it.", "info");
    }
    return;
  }
  const noun = goalNoun();
  if (!archiveCurrentGoal(ctx, "aborted", "user cancelled")) return;
  // Abort only after the durable archive + user-facing confirmation have
  // landed. Aborting immediately used to cut off the rest of compound
  // cancel/wipe cleanup and made the user repeat the command.
  ctx.ui.notify(`${noun} aborted.${isLoopActive() ? " A loop is still active — /loop stop ends it." : ""}`, "info");
  ctx.abort();
}

// ---- v0.28.23: decision picker popup ----
// A decision pause is ACTIONABLE — the widget card summarizes (and
// truncates) it, but picking from a truncated wall was the user's
// complaint. Borrow Claude Code / muselinn-Ask: a real select() modal
// with the FULL option text, pick → act. Escape leaves the card as the
// fallback; /goal decide re-opens the picker at any time.

let decisionPromptOpen = false;

/** True when the goal is paused on a user decision with options. */
function pendingDecision(): Goal | null {
  const g = state.goal;
  return g && g.status === "paused" && g.pauseKind === "decision" && g.pauseOptions && g.pauseOptions.length > 0 ? g : null;
}

/** Open the decision picker for the current decision pause. Returns true
 * when a picker was shown (false → caller notifies "no pending decision"). */
async function showDecisionPrompt(ctx: ExtensionContext): Promise<boolean> {
  const g = pendingDecision();
  if (!g || !ctx.hasUI || decisionPromptOpen) return false;
  decisionPromptOpen = true;
  try {
    const title = `Decision needed — ${displaySlice(g.objective, 72)}${g.pauseReason ? ` · ${displaySlice(sanitizeProviderDisplayText(g.pauseReason), 80)}` : ""}`;
    const options = g.pauseOptions!.map((o, i) => (g.pauseRecommended === i + 1 ? `${o}  (recommended)` : o));
    const pick = await ctx.ui.select(title, options);
    if (!pick) return true; // Escape — the widget card remains the fallback
    const idx = options.indexOf(pick);
    const label = g.pauseOptions![idx] ?? pick.replace(/ {2}\(recommended\)$/, "");
    // v0.29.3: the wipe escape — "… (/glla wipe)" options run the wipe
    // (which Confirms on its own — destructive actions keep their gate).
    if (/\(\/glla wipe\)\s*$/.test(label)) {
      await cmdGllaWipe(ctx);
      return true;
    }
    // Executable options — "Label (/goal cancel)" — RUN the command.
    // Placeholder commands (…/<arg>) fall through to the message path.
    const cmdMatch = label.match(/\(\/(goal|list|loop) ([a-z]+)\)\s*$/);
    if (cmdMatch && !label.includes("…") && !label.includes("<")) {
      const [, group, verb] = cmdMatch;
      if (group === "goal" && verb === "resume") await cmdResume(ctx);
      else if (group === "goal" && verb === "cancel") await cmdCancel(ctx);
      else if (group === "loop" && verb === "stop") await cmdLoop("stop", ctx);
      else if (group === "loop" && verb === "resume") await cmdLoop("resume", ctx);
      else {
        safeSteerUser(ctx, `Decision for the paused goal "${displaySlice(g.objective, 240)}": ${sanitizeDisplayText(label)} — continue on this path.`);
        await cmdResume(ctx);
      }
      return true;
    }
    // Content choice — deliver to the agent, then resume.
    safeSteerUser(ctx, `Decision for the paused goal "${displaySlice(g.objective, 240)}": ${sanitizeDisplayText(label)} — continue on this path.`);
    await cmdResume(ctx);
    return true;
  } finally {
    decisionPromptOpen = false;
  }
}

/** Pop the picker after a decision pause lands — deferred so the current
 * turn finishes first (pi serializes dialogs). No-ops without a UI, when
 * disabled (set Decision popup = off in /glla settings), or when one is already open. */
function maybeDecisionPopup(ctx: ExtensionContext): void {
  if (!ctx.hasUI || loadSettings(ctx.cwd).decisionPopup === false) return;
  const cwd = ctx.cwd;
  scheduleSessionTimeout(() => {
    const fresh = freshCtx();
    if (!fresh || fresh.cwd !== cwd) return;
    void showDecisionPrompt(fresh).catch(() => {});
  }, 600);
}

async function cmdGoals(ctx: ExtensionContext): Promise<void> {
  const dir = archiveDir(ctx.cwd);
  if (!fs.existsSync(dir)) {
    ctx.ui.notify("No archived goals yet.", "info");
    return;
  }
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".md")).sort().reverse();
  if (files.length === 0) {
    ctx.ui.notify("No archived goals yet.", "info");
    return;
  }
  const lines = files.slice(0, 20).map((f) => {
    let status = "?";
    let stop = "";
    let obj = "";
    try {
      const content = fs.readFileSync(path.join(dir, f), "utf-8");
      status = content.match(/\*\*Status\*\*:\s*(\w+)/)?.[1] ?? "?";
      stop = content.match(/\*\*Stop reason\*\*:\s*(.+)/)?.[1]?.trim() ?? "";
      obj = content.match(/## Objective\s+>\s*(.+)/)?.[1]?.trim() ?? "";
    } catch { /* unreadable file — show name only */ }
    return `${f.replace(/\.md$/, "")} [${status}] ${displaySlice(obj, 60)}${stop ? ` — ${displaySlice(stop, 40)}` : ""}`;
  });
  ctx.ui.notify(
    `Archived goals (${files.length}${files.length > 20 ? ", showing 20" : ""}):\n` + lines.join("\n"),
    "info",
  );
}

export interface ConflictTweakOptions {
  /** Allow the conflict resolver to update a live/auditing list item as one
   * whole-objective transaction. The user already chose "Update current
   * objective" in the conflict picker; normal `/list tweak` remains paused-only. */
  allowLiveList?: boolean;
}

export async function cmdTweak(
  args: string,
  ctx: ExtensionContext,
  mode: "goal" | "list" = "goal",
  options: ConflictTweakOptions = {},
): Promise<boolean> {
  const current = state.goal;
  const liveListConflict = mode === "list"
    && options.allowLiveList === true
    && current?.policy === "list"
    && (current.status === "active" || current.status === "auditing");
  const expectedStatus = mode === "list" ? "paused" : "active";
  if (!current || (current.status !== expectedStatus && !liveListConflict) || (mode === "list" && current.policy !== "list")) {
    ctx.ui.notify(
      mode === "list"
        ? "No paused list item to tweak. /list tweak <replacement objective, optional 'Done when: ...' clause>"
        : "No active goal to tweak. /goal <objective> to start one.",
      "info",
    );
    return false;
  }
  let raw = args.trim();
  if (raw.length >= 2 && ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'")))) {
    raw = raw.slice(1, -1).trim();
  }
  if (!raw) {
    // v0.34.69 (note.md 2026-08-07: "list tweak seems too literal, doesnt
    // work, it should launcher into a what we update into"): a bare tweak
    // now LAUNCHES the update-proposal flow instead of dying with "Usage:".
    // The current item text is shown (notify preview + input pre-fill), the
    // replacement is collected interactively, and the proposal confirm below
    // still gates the apply — old→new, confirm, then apply.
    const surface = mode === "list" ? "list item" : "goal";
    ctx.ui.notify(
      `Tweak ${surface} — current: ${displaySlice(current.objective, 120)}`,
      "info",
    );
    let v: string | undefined;
    try {
      v = await ctx.ui.input(
        mode === "list"
          ? "What should we update the list item into? (replacement objective, optional 'Done when: ...' clause)"
          : "What should we update the goal into? (replacement objective, optional 'Done when: ...' clause)",
        current.objective,
      );
    } catch {
      v = undefined;
    }
    if (v === undefined || !v.trim()) {
      ctx.ui.notify("Tweak cancelled; nothing changed.", "info");
      return false;
    }
    raw = v.trim();
  }
  const proposed = extractVerificationContract(raw);
  const newObjective = proposed.objective;
  if (!newObjective) {
    // (a bare input of "Done when: ..." only yields this — the replacement
    // has no objective part to apply)
    ctx.ui.notify(
      mode === "list"
        ? "No objective in the replacement text — include what the list item should become."
        : "No objective in the replacement text — include what the goal should become.",
      "info",
    );
    return false;
  }
  // v0.34.51 contract-text semantics (defined + pinned by tests):
  //   supplied clause  → REPLACE the stored contract
  //   omitted clause   → PRESERVE the stored contract (a reword must not
  //                      silently destroy the verification gate)
  //   bare marker      → CLEAR the stored contract ("Done when:" with nothing)
  const hasNewContract = proposed.verificationContract.length > 0;
  const clearsContract = !hasNewContract && proposed.explicitClear;
  // v0.34.69: no-op guard — an identical objective with no contract change
  // must not bump the v0.34.61 revision (which would invalidate the last
  // auditor approval for a tweak that changed NOTHING). Pre-filling the
  // input with the current text makes this reachable by a plain Enter.
  if (
    newObjective.trim() === current.objective.trim()
    && !hasNewContract
    && !clearsContract
  ) {
    ctx.ui.notify("Tweak cancelled — the objective is unchanged.", "info");
    return false;
  }
  let confirmed = false;
  try {
    confirmed = await ctx.ui.confirm(
      mode === "list" ? "Tweak list item?" : "Tweak goal?",
      `CURRENT:\n${sanitizeDisplayText(current.objective)}\n\nNEW:\n${sanitizeDisplayText(newObjective)}` +
      (hasNewContract
        ? `\n\nNew contract:\n${sanitizeDisplayText(proposed.verificationContract)}`
        : clearsContract
          ? "\n\n(Empty 'Done when:' — the verification contract is cleared.)"
          : "\n\n(New text carries no contract; the old contract is kept.)"),
    );
  } catch {
    confirmed = false;
  }
  if (!confirmed) {
    ctx.ui.notify("Tweak cancelled; goal unchanged.", "info");
    return false;
  }
  // The proposal dialog yields to the host. A pause, recovery mark, or other
  // same-goal update may replace state.goal while it is open. Rebase the
  // tweak onto that latest object instead of restoring the pre-dialog
  // snapshot through bumpGoalRevision(current). If another goal replaced it,
  // do not apply this confirmation to the new goal.
  const latest = state.goal;
  if (!latest || latest.id !== current.id) {
    ctx.ui.notify("Tweak cancelled — the goal changed while confirmation was open; no stale state was restored.", "warning");
    return false;
  }
  if (latest.status === "complete" || latest.status === "aborted") {
    ctx.ui.notify("Tweak cancelled — the goal finished while confirmation was open; no stale state was restored.", "warning");
    return false;
  }
  const priorProvenance = latest.objectiveProvenance;
  const userSeeds = [...(priorProvenance?.userSeeds ?? []), raw].slice(-10);
  const replacingLiveList = liveListConflict
    && latest.policy === "list"
    && (latest.status === "active" || latest.status === "auditing");
  const cancellingAudit = replacingLiveList && latest.status === "auditing";
  const pendingAuditAttempt = cancellingAudit ? latest.pendingCompletion?.attemptId : undefined;
  if (cancellingAudit) {
    if (pendingAuditAttempt) cancelDetachedGoalCompletionAuditor(ctx.cwd, pendingAuditAttempt);
    // Invalidate the detached worker before clearing its durable claim. Its
    // finally block then cannot clear a newer audit's ownership, and the
    // next continuation is free to work the newly adopted whole objective.
    flags.completionAuditInFlight = false;
    flags.latestAuditProgress = null;
    flags.completionAuditRecoveryArmed = false;
    appendLedger(ctx.cwd, "objective_conflict_audit_cancelled", {
      goalId: latest.id,
      attemptId: pendingAuditAttempt,
      reason: "whole-objective conflict update",
    });
  }
  const patch: Partial<Goal> = {
    objective: newObjective,
    objectiveProvenance: {
      originalObjective: priorProvenance?.originalObjective ?? current.objective,
      ...(priorProvenance?.originalContract ? { originalContract: priorProvenance.originalContract } : {}),
      userSeeds,
    },
    ...(cancellingAudit
      ? { status: "active", pendingCompletion: undefined, completionSummary: undefined }
      : {}),
  };
  if (hasNewContract) patch.verificationContract = proposed.verificationContract;
  else if (clearsContract) patch.verificationContract = "";
  // omitted clause → no verificationContract key in the patch: preserved.
  // v0.34.61: contract-scoped revision bump — one of exactly two sites
  // (the other: complete_goal newObjective). persistState no longer bumps.
  state.goal = bumpGoalRevision(latest);
  updateGoal(patch, ctx);
  appendLedger(ctx.cwd, "goal_tweaked", {
    goalId: latest.id,
    objective: newObjective,
    via: replacingLiveList ? "objective conflict whole-list update" : mode === "list" ? "/list tweak" : "/goal tweak",
  });
  if (replacingLiveList) {
    appendLedger(ctx.cwd, "objective_conflict_updated", {
      goalId: latest.id,
      mode: "list",
      wholeObjective: true,
      objective: newObjective,
      auditCancelled: cancellingAudit,
    });
    ctx.ui.notify("Whole list objective updated; the current item continues against the new objective.", "info");
    scheduleContinuation(ctx, true);
    return true;
  }
  if (mode === "list") {
    ctx.ui.notify("List item tweaked; it remains paused. /list resume to continue.", "info");
    return true;
  }
  ctx.ui.notify("Goal tweaked. The loop continues against the new objective.", "info");
  scheduleContinuation(ctx, true);
  return true;
}

/**
 * Conflict resolution is a whole-objective operation. Try the incoming
 * objective once as the proposed replacement; if that cannot be applied,
 * retry the same whole-objective editor (bounded twice). Never descend into
 * `taskList` or ask the user to update tasks one by one.
 */
export async function updateWholeObjectiveFromConflict(
  ctx: ExtensionContext,
  objective: string,
  mode: "goal" | "list",
): Promise<boolean> {
  const options: ConflictTweakOptions = mode === "list" ? { allowLiveList: true } : {};
  if (await cmdTweak(objective, ctx, mode, options)) return true;
  for (let attempt = 1; attempt <= 2; attempt++) {
    appendLedger(ctx.cwd, "objective_conflict_update_retry", {
      mode,
      attempt,
      wholeObjective: true,
    });
    if (await cmdTweak("", ctx, mode, options)) return true;
  }
  return false;
}

// =================================================================
// /list commands (loop 2)
// =================================================================

/**
 * The ONE enqueue path (v0.8.4): bulk import, items[] drafting, and the
 * agent's list_add tool all funnel here. Texts → ListItems (with per-item
 * contract extraction) → appended to the queue → persisted → first item
 * activated when nothing is running. Returns the count enqueued.
 */
// v0.29.1: zombie-twin guard. A draft/enqueue whose objective matches a
// goal COMPLETED in the last 24h re-creates just-finished work — field-
// observed in junk-runner: the INFRA-NEW-18 close was re-drafted 3 minutes
// after the auditor approved it and autoaccept waved the twin straight in,
// where it stormed for 9h against a dead provider. Normalized compare (goal
// ids stripped), 24h lookback, loud skip — never silent.
const DUPLICATE_LOOKBACK_MS = 24 * 60 * 60 * 1000;
const LEDGER_TAIL_BYTES = 256 * 1024;
function recentlyCompletedObjectives(cwd: string): Set<string> {
  const done = new Set<string>();
  try {
    const p = ledgerPath(cwd);
    const size = fs.statSync(p).size;
    const buf = Buffer.alloc(Math.min(size, LEDGER_TAIL_BYTES));
    const fd = fs.openSync(p, "r");
    fs.readSync(fd, buf, 0, buf.length, Math.max(0, size - buf.length));
    fs.closeSync(fd);
    const cutoff = Date.now() - DUPLICATE_LOOKBACK_MS;
    for (const line of buf.toString("utf-8").split("\n")) {
      if (!line.includes('"goal_archived"') || !line.includes('"complete"')) continue;
      try {
        const e = JSON.parse(line);
        if (e?.type !== "goal_archived" || e.value?.status !== "complete") continue;
        if (!(Date.parse(e.ts ?? "") >= cutoff)) continue;
        // v0.29.1+ entries carry the objective inline; older entries fall
        // back to the archived goal file (## Objective → "> …" line).
        let objective = typeof e.value?.objective === "string" ? e.value.objective : "";
        if (!objective && e.value?.goalId) {
          try {
            const md = fs.readFileSync(archivedGoalPath(cwd, e.value.goalId), "utf-8");
            objective = md.split("## Objective")[1]?.split("\n").find((l: string) => l.startsWith("> "))?.slice(2) ?? "";
          } catch { /* archived file gone — skip */ }
        }
        if (objective) done.add(normalizeObjective(objective));
      } catch { /* malformed line — skip */ }
    }
  } catch { /* no ledger yet */ }
  return done;
}

export function hydrateListQueueFromDisk(ctx: ExtensionContext): number {
  const memory = listQueue();
  const exclude = new Set<string>();
  if (state.goal?.id) exclude.add(state.goal.id);
  const disk = readQueueFromDisk(ctx.cwd, exclude);
  const known = new Set(memory.map((item) => item.id));
  const recovered = disk.filter((item) => !known.has(item.id));
  if (recovered.length === 0) return 0;
  const merged = [...memory, ...recovered].sort(compareQueueItems);
  replaceState({ ...state, list: merged });
  persistState(ctx);
  appendLedger(ctx.cwd, "list_recovered_from_disk", { count: recovered.length, hydrated: true });
  return recovered.length;
}

function enqueueItems(ctx: ExtensionContext, texts: string[], source: string, opts?: { autoActivate?: boolean }): number {
  hydrateListQueueFromDisk(ctx);
  const recentlyDone = recentlyCompletedObjectives(ctx.cwd);
  const fresh = texts.filter((t) => !recentlyDone.has(normalizeObjective(parseListItemDeclaration(t).objective)));
  const skipped = texts.length - fresh.length;
  if (skipped > 0) {
    const first = texts.find((t) => recentlyDone.has(normalizeObjective(parseListItemDeclaration(t).objective))) ?? "";
    appendLedger(ctx.cwd, "list_duplicate_skipped", { source, count: skipped, objective: first.slice(0, 200) });
    ctx.ui.notify(`Skipped ${skipped} item(s) duplicating work COMPLETED in the last 24h (zombie-twin guard): ${first.slice(0, 90)}`, "warning");
  }
  if (fresh.length === 0) return 0;
  const items = fresh.map((text) => {
    const extracted = parseListItemDeclaration(text);
    return {
      id: newGoalId(),
      objective: extracted.objective,
      ...(extracted.agentRole ? { agentRole: extracted.agentRole } : {}),
      verificationContract: extracted.verificationContract || undefined,
      ...(extracted.parallelSafe === undefined ? {} : { parallelSafe: extracted.parallelSafe }),
      // parentObjective is the parse step's transient; the resolved
      // parentId is set below (queue-bound resolution) or stripped on refusal.
      parentObjective: extracted.parentObjective,
      addedAt: nowIso(),
    };
  });
  // v0.34.81 (LIGHT parent/child): bind each child's parentId by objective
  // match. Earlier items in THIS batch win (the natural declaration order:
  // parent first, then its children); if not found there, fall back to the
  // existing queue. Refusals are reported individually — empty objectives
  // (a marker line with no child text after the separator), unresolved
  // parents (typo or parent not yet declared), and one-level-only nesting
  // (a child whose parent is itself a subtask). The rest of the batch is
  // still added; a refusal does NOT roll back the successful bindings.
  const existing = listQueue();
  const refused: string[] = [];
  const resolved: ListItem[] = [];
  for (const item of items) {
    if (!item.parentObjective) {
      resolved.push(item);
      continue;
    }
    if (!item.objective) {
      refused.push(`empty objective after "Subtask of: ${item.parentObjective}" — add the child text after a spaced em-dash separator (e.g. "Subtask of: ${item.parentObjective} — <child>").`);
      continue;
    }
    const candidates = [...resolved, ...existing];
    const parent = candidates.find((c) => normalizeObjective(c.objective) === normalizeObjective(item.parentObjective!));
    if (!parent) {
      refused.push(`unresolved parent "${item.parentObjective}" for child "${item.objective.slice(0, 60)}" — add the parent first (or check the objective spelling).`);
      continue;
    }
    if (parent.parentId) {
      refused.push(`nested subtask "${item.objective.slice(0, 60)}" — one level only (parent "${parent.objective.slice(0, 60)}" is itself a subtask of "${existing.find((c) => c.id === parent.parentId)?.objective.slice(0, 60) ?? "another item"}").`);
      continue;
    }
    const { parentObjective: _drop, ...stored } = item;
    void _drop;
    resolved.push({ ...stored, parentId: parent.id });
  }
  if (refused.length > 0) {
    appendLedger(ctx.cwd, "list_subtask_refused", { source, count: refused.length, refusals: refused });
    ctx.ui.notify(`Refused ${refused.length} subtask item(s): ${refused.join(" | ")}.`, "warning");
  }
  if (resolved.length === 0) return 0;
  const itemsToWrite = assignQueueOrder(resolved, listQueue());
  // v0.34.60: disk-first write order. Each item lands on disk BEFORE any
  // in-memory state mutation, so /list survives a stale extension handle
  // (e.g. /reload, plugin re-init, RAM-only state loss). The
  // .queue.json sidecar is atomic (temp + rename) and idempotent (skips
  // existing files rather than overwriting). A failed member aborts the
  // batch and removes only sidecars written by this attempt.
  const written = itemsToWrite.map((item) => writeQueueItemFile(ctx.cwd, item));
  const failedWrite = written.find((result) => result.failed);
  if (failedWrite) {
    written.forEach((result, index) => {
      if (result.wrote) deleteQueueItemFile(ctx.cwd, itemsToWrite[index]!.id);
    });
    appendLedger(ctx.cwd, "list_queue_disk_write_failed", { source, count: itemsToWrite.length, path: failedWrite.path });
    ctx.ui.notify(`Could not persist the queued item(s) from ${source}; no in-memory queue mutation was applied. Fix disk access and retry.`, "warning");
    return 0;
  }
  replaceState({ ...state, list: [...listQueue(), ...itemsToWrite] });
  const diskFirst = written.filter((w) => w.wrote).length === itemsToWrite.length;
  appendLedger(ctx.cwd, "list_queue_disk_first", { source, count: itemsToWrite.length, diskFirst });
  persistState(ctx);
  appendLedger(ctx.cwd, "list_imported", { source, count: itemsToWrite.length });
  if (!state.goal || state.goal.status === "complete" || state.goal.status === "aborted") {
    // v0.28.28: unsolicited sources (the reviewer) do NOT auto-start the
    // head unless autoResume is on — "I cancelled a goal and the next one
    // started itself" was the field complaint. User-driven imports keep
    // the immediate-start behavior (opts default true).
    if (opts?.autoActivate === false) {
      ctx.ui.notify(`Queued ${itemsToWrite.length} item(s) from ${source} — /list next when ready (auto-start is opt-in: enable Auto-resume in /glla settings).`, "info");
      appendLedger(ctx.cwd, "list_autoactivation_held", { source, count: itemsToWrite.length });
    } else {
      activateNextListItem(ctx);
    }
  }
  return itemsToWrite.length;
}

/** Bulk-enqueue parsed items: one Confirm for the whole batch, never drafts. */
async function bulkAddItems(ctx: ExtensionContext, parsed: string[], sourceName: string): Promise<void> {
  if (parsed.length === 0) {
    ctx.ui.notify("No items found (headings/blank lines don't count).", "warning");
    return;
  }
  // v0.23.7: show ALL items in full — a Confirm the user can't fully
  // read is not a gate (same rule as the draft dialog, v0.23.5).
  const preview = parsed.map((t, i) => `  ${i + 1}. ${t}`).join("\n");
  let confirmed = true;
  if (ctx.hasUI) {
    try {
      confirmed = await ctx.ui.confirm(
        "Import into list?",
        `${parsed.length} items from ${sourceName}:\n${preview}`,
      );
    } catch {
      confirmed = false;
    }
  }
  if (!confirmed) {
    ctx.ui.notify("Import cancelled.", "info");
    return;
  }
  const n = enqueueItems(ctx, parsed, sourceName);
  if (state.goal && state.goal.status === "active") {
    ctx.ui.notify(`Imported ${n} items (${listQueue().length} waiting in the list).`, "info");
  }
}

/** Bulk-enqueue from a file: read, parse, delegate to bulkAddItems. */
async function bulkAddFromFile(ctx: ExtensionContext, abs: string): Promise<void> {
  let content: string;
  try {
    content = fs.readFileSync(abs, "utf-8");
  } catch {
    ctx.ui.notify(`Cannot read: ${abs}`, "warning");
    return;
  }
  await bulkAddItems(ctx, parseListImport(content), path.basename(abs));
}

async function cmdList(args: string, ctx: ExtensionContext): Promise<void> {
  // v0.28.1 (S3): honest staleness warning; read-only subcommands still work.
  const staleEntry = warnIfStaleAtEntry(ctx, "/list");
  const parts = args.trim().split(/\s+/);
  const sub = (parts[0] ?? "").toLowerCase();
  const rest = args.trim().slice(sub.length).trim();

  // v0.34.51: mutating subcommands are REFUSED on a stale handle. An
  // add/clear/cancel/next/remove in a doomed process would persist state the
  // stale session can neither announce nor run — an idle-queue add even
  // activates a goal that can never start, without the interrupt marker
  // goStaleTerminal stamps on send failures. The entry probe already printed
  // the honest recovery result; the user's command belongs to the fresh
  // instance after the lifecycle replacement.
  if (staleEntry && LIST_MUTATING_SUBCOMMANDS.has(sub)) {
    if (queuePendingListOperation(ctx, args)) return;
    appendLedger(ctx.cwd, "list_mutation_refused_stale", { sub });
    return;
  }
  // v0.34.68 (bug 1.7): heal a corrupted mode flag BEFORE the pause/
  // resume/tweak/cancel gates branch on state.goal.policy — the gate used
  // to silently refuse the whole surface until a restart.
  healGoalPolicy(ctx);
  // v0.35.4 audit: sidecars are durable queue state, not a display-only
  // fallback. Hydrate orphaned disk items before any list surface can count,
  // remove, cancel, or activate them.
  if (!staleEntry) hydrateListQueueFromDisk(ctx);

  if (sub === "audit") {
    // v0.31.0: /list audit [focus] — collect-then-drain (user design
    // 2026-07-31: "run a project audit, collect a bunch of tasks, then do
    // them all too"). The audit item COLLECTS findings (changes no code);
    // its completion fans each open finding out into the queue and the
    // list drains them fix by fix, each with its own isolated audit.
    // Distinct from /goal audit (fix-in-pass, one audited unit) and
    // /loop audit (forever fix-first cadence).
    // v0.31.1: an active audit loop is already draining this findings file —
    // a collect pass would double-hunt the same ground.
    if (state.loop?.active && state.loop.target.includes(LOOP_AUDIT_MARKER)) {
      appendLedger(ctx.cwd, "audit_stack_warn", { have: "loop", starting: "list" });
      ctx.ui.notify("An audit loop is already draining findings here — /list audit would double-hunt the same ground. /loop status to see it.", "warning");
    }
    const objective = listAuditCollectTarget(rest || undefined);
    const n = enqueueItems(ctx, [objective], "/list audit");
    if (n === 0) return; // zombie-twin guard already explained itself
    ctx.ui.notify(
      "Audit collection item queued — it CHANGES NO CODE: it appends findings to " +
        AUDIT_FINDINGS_REL +
        ", and on completion each open finding becomes its own list item (fixes drain one audited commit at a time). DECIDE findings are presented to you, never queued.",
      "info",
    );
    return;
  }

  if (sub === "depth") {
    // v0.25.3: long-running state at a glance — queue depth, oldest item
    // age, average item duration from archived list-policy goals.
    let entries: Array<{ type: string; value?: any }> = [];
    try {
      entries = parseLedgerEntries(fs.readFileSync(ledgerPath(ctx.cwd), "utf-8"));
    } catch {
      /* no ledger yet */
    }
    const stats = computeListDepth(listQueue(), entries, Date.now());
    ctx.ui.notify(`/list depth: ${formatListDepth(stats)}`, "info");
    return;
  }

  if (sub === "tweak") {
    await cmdTweak(rest, ctx, "list");
    return;
  }

  if (sub === "pause" && !rest) {
    if (!state.goal || state.goal.policy !== "list") {
      ctx.ui.notify(
        state.goal ? "The active work is a standalone goal — /goal pause to pause it." : "No active list item to pause. /list show to see the list.",
        "info",
      );
      return;
    }
    await cmdPause(ctx);
    return;
  }

  if (sub === "resume" && !rest) {
    // Resume the list's head. The head activates AS the active goal, so this
    // is the same motion as /goal resume — named for the surface the user is
    // looking at (v0.22.7: "we would just unpause, and that is next").
    // An unacknowledged continuation leaves a list item ACTIVE with an
    // interruption marker (the work was not user-paused). Treat that exact
    // recovery state as resumable here; otherwise /list resume would reject
    // the one command that can release its dispatch stand-down.
    const listDispatchRecovery = state.goal
      && state.goal.policy === "list"
      && state.goal.status === "active"
      && (!!state.goal.interruptedAt || flags.continuationDispatchStoodDown);
    if (!state.goal || (state.goal.status !== "paused" && !listDispatchRecovery)) {
      const terminalListItem = state.goal?.policy === "list"
        && (state.goal.status === "complete" || state.goal.status === "aborted");
      ctx.ui.notify(
        terminalListItem
          ? `The last list item is ${statusLabel(state.goal!.status)} and archived${state.goal!.stopReason ? ` (${displaySlice(state.goal!.stopReason, 90)})` : ""}; nothing to resume. Re-add it with /list or activate a waiting item with /list next.`
          : "No paused list item to resume. /list show to see the list.",
        "info",
      );
      return;
    }
    if (state.goal.policy !== "list") {
      ctx.ui.notify(`The paused goal didn't come from the list — ${activeGoalSurfaceCommand("resume")} to continue it.`, "info");
      return;
    }
    await cmdResume(ctx);
    return;
  }

  if (!sub || sub === "show") {
    const memQueue = listQueue();
    // v0.34.60: stale-handle fallback. If in-memory is empty but disk has
    // queue sidecar files (a fresh pi session that hasn't yet reparsed
    // active.jsonl, or a torn jsonl write), recover from
    // .pi-glla/goals/*.queue.json instead of falsely reporting "list is
    // empty". Exclude any goalId that's already active or archived so we
    // don't re-show active/finished work as queued.
    let queue = memQueue;
    if (queue.length === 0) {
      const exclude = new Set<string>();
      if (state.goal?.id) exclude.add(state.goal.id);
      const diskQueue = readQueueFromDisk(ctx.cwd, exclude);
      if (diskQueue.length > 0) {
        appendLedger(ctx.cwd, "list_recovered_from_disk", { count: diskQueue.length });
        queue = diskQueue;
      }
    }
    const lines: string[] = [];
    if (state.goal) {
      const terminal = state.goal.status === "complete" || state.goal.status === "aborted";
      lines.push(`${terminal ? "Last" : "Active"}: [${state.goal.policy}] ${displaySlice(state.goal.objective, 80)} (${statusLabel(state.goal.status)})`);
      if (state.goal.repairTarget) {
        lines.push(`Replan target (preserved): ${displaySlice(state.goal.repairTarget.objective, 180)}`);
      }
    } else {
      lines.push("Active: (none)");
    }
    const recoveryLines = formatMainModelRecoveryStatus(state.mainModelRecovery, normalizeMainModelFallbackRefs(loadSettings(ctx.cwd).mainModelFallbacks));
    if (recoveryLines.length > 0) lines.push(...recoveryLines);
    if (queue.length === 0) {
      lines.push("List: empty. /list <describe your tasks, or a plan file> — the agent shapes dumps into items, files import directly.");
    } else {
      lines.push(`List (${queue.length}):`);
      const PAGE = 15;
      // v0.34.81 (LIGHT parent/child): render parents as `[group: N open]`
      // and their children as hierarchical sub-numbers (`1.1`, `1.2`).
      // Groups are skipped in the outer loop; children are rendered under
      // their parent, preserving queue order so adjacent declarations stay
      // adjacent visually. The PAGE limit caps top-level entries — a parent
      // at the boundary still shows all of its children to keep the block
      // coherent (children of a sliced-off parent would orphan).
      let flat = 0;
      let omitted = 0;
      for (const item of queue) {
        if (item.parentId) continue; // rendered under its parent
        if (flat >= PAGE) { omitted++; continue; }
        const children = queue.filter((c) => c.parentId === item.id);
        const open = groupOpenChildren(item.id);
        flat++;
        const labels: string[] = [];
        if (item.agentRole) labels.push(item.agentRole);
        if (item.parallelSafe) labels.push("parallel");
        if (open > 0) labels.push(`group: ${open} open`);
        const tag = labels.length ? ` [${labels.join(", ")}]` : "";
        lines.push(`  ${flat}. ${displaySlice(item.objective, 90)}${tag}`);
        if (item.repairTarget) {
          lines.push(`     ↳ REPLAN TARGET: ${displaySlice(item.repairTarget.objective, 180)}`);
        }
        children.forEach((c, ci) =>
          lines.push(`     ${flat}.${ci + 1} ${displaySlice(c.objective, 80)}${c.agentRole ? ` [${c.agentRole}]` : ""}${c.parallelSafe ? " [parallel]" : ""}`),
        );
      }
      if (omitted > 0) {
        lines.push(`  … and ${omitted} more top-level item(s). /list remove <n> to prune, /list clear to empty.`);
      }
    }
    ctx.ui.notify(lines.join("\n"), "info");
    return;
  }


  // v0.19.0: `add` and `import` are pure no-op aliases — the verb changes
  // nothing, detection routes everything. `/list plan.md` and
  // `/list add plan.md` both import; `/list fix x, do y` and
  // `/list add fix x, do y` both draft. Rationale: a list item activates
  // RAW when it reaches the head, so the drafting interview is the only
  // quality gate an item ever gets — a verb whose only job was skipping
  // that gate was a leak, not an escape hatch. The direct path is an
  // explicit "Done when:" clause (user already did the contract work).
  if (sub === "add" || sub === "import") {
    if (!rest) {
      await startDrafting(ctx, "list");
      return;
    }
    const aliased = routeListText(ctx.cwd, rest.replace(/^["']|["']$/g, ""));
    if (aliased.kind === "file") {
      await bulkAddFromFile(ctx, aliased.path);
      return;
    }
    if (aliased.kind === "batch") {
      await bulkAddItems(ctx, aliased.items, "pasted text");
      return;
    }
    if (aliased.kind === "direct") {
      addSingleItem(ctx, aliased.text);
      return;
    }
    await startDrafting(ctx, "list", aliased.seed);
    return;
  }

  if (sub === "clear" && !rest) {
    // v0.34.61: delete the sidecars of every removed item BEFORE clearing
    // state. The /list disk-recovery fallback scans .pi-glla/goals/*.queue.json
    // when memQueue is empty; without this, a /list clear followed by a
    // stale-handle reload would resurrect the cleared items.
    const dropped = listQueue();
    const clearedSidecars = clearQueueItemFiles(ctx.cwd);
    replaceState({ ...state, list: [] });
    persistState(ctx);
    appendLedger(ctx.cwd, "list_cleared", { count: dropped.length, sidecars: clearedSidecars.removed });
    if (clearedSidecars.failed.length > 0) ctx.ui.notify(`List clear could not remove ${clearedSidecars.failed.length} queue sidecar(s); the list is not fully clean.`, "warning");
    ctx.ui.notify(`List cleared. Active goal (if any) is untouched — ${activeGoalSurfaceCommand("cancel")} for that, /list cancel to stop the whole list.`, "info");
    return;
  }

  // v0.24.1: ONE verb for "stop this whole list" — aborts the active item
  // when it's list-sourced AND drops the waiting items. Before this the user
  // had to know to combine /goal cancel + /list clear.
  if (sub === "cancel" && !rest) {
    const waiting = listQueue().length;
    const activeIsListItem = state.goal?.policy === "list" && (state.goal.status === "active" || state.goal.status === "paused" || state.goal.status === "auditing");
    if (waiting === 0 && !activeIsListItem) {
      ctx.ui.notify(`No list to cancel — nothing waiting, and the active goal (if any) isn't a list item. ${activeGoalSurfaceCommand("cancel")} aborts a standalone goal.`, "info");
      return;
    }
    const dropped = waiting;
    if (activeIsListItem && !archiveCurrentGoal(ctx, "aborted", "list cancelled")) return;
    // v0.35.0: clear the union of RAM and disk queue state. Orphaned
    // sidecars otherwise resurrected after a stale reload.
    const clearedSidecars = clearQueueItemFiles(ctx.cwd);
    replaceState({ ...state, list: [] });
    persistState(ctx);
    appendLedger(ctx.cwd, "list_cancelled", { abortedActive: activeIsListItem, dropped, sidecars: clearedSidecars.removed });
    ctx.ui.notify(
      `List cancelled: ${activeIsListItem ? "active item aborted + " : ""}${dropped} waiting item(s) dropped.${!activeIsListItem && state.goal && state.goal.status === "active" ? ` Active goal is not a list item — untouched (${activeGoalSurfaceCommand("cancel")} for that).` : ""}`,
      "info",
    );
    if (clearedSidecars.failed.length > 0) ctx.ui.notify(`List cancel could not remove ${clearedSidecars.failed.length} queue sidecar(s); retry after fixing disk access.`, "warning");
    if (activeIsListItem) ctx.abort();
    return;
  }

  if (sub === "next") {
    // Skip the current active goal (abort it) and activate a queued item.
    // Bare = the head (FIFO default); /list next <n> = item n (shopping-list
    // semantics: order is the default, not the law).
    const n = rest ? Number.parseInt(rest, 10) : 1;
    if (!Number.isInteger(n) || n < 1) {
      ctx.ui.notify(`Usage: /list next [1-${listQueue().length || 1}]`, "info");
      return;
    }
    const targetItem = listQueue()[n - 1];
    if (targetItem) {
      const current = liveObjectives(state);
      if (current.length > 0) {
        const choice = await chooseObjectiveConflict(ctx, "list", targetItem.objective, current);
        if (choice === "cancel") {
          ctx.ui.notify("List activation cancelled; the current objective is unchanged.", "info");
          return;
        }
        if (choice === "update") {
          const incomingWholeList = targetItem.objective + (targetItem.verificationContract ? `\nDone when:\n${targetItem.verificationContract}` : "");
          const updated = await updateWholeObjectiveFromConflict(ctx, incomingWholeList, "list");
          if (!updated) {
            ctx.ui.notify("Whole list update was not applied; the current objective and queue are unchanged.", "info");
          }
          return;
        }
        for (const item of current) {
          if (item.kind === "loop" && isLoopActive()) await cmdLoop("stop", ctx);
          else if (item.kind !== "loop" && state.goal && ["active", "auditing"].includes(state.goal.status)) {
            if (!archiveCurrentGoal(ctx, "aborted", `skipped via /list next ${n > 1 ? n : ""}`.trim())) return;
          }
        }
      }
    }
    if (!activateNextListItem(ctx, n, { explicit: true })) {
      ctx.ui.notify(listQueue().length === 0 ? "List is empty — nothing to activate." : `No item #${n} (list has ${listQueue().length}).`, "info");
    }
    return;
  }

  if (sub === "remove" || sub === "rm") {
    const n = Number.parseInt(rest, 10);
    const queue = listQueue();
    if (!Number.isFinite(n) || n < 1 || n > queue.length) {
      ctx.ui.notify(`Usage: /list remove <1-${queue.length}>`, "info");
      return;
    }
    const removed = queue[n - 1]!;
    // v0.34.61: delete the sidecar so the /list disk-recovery fallback
    // cannot resurrect the removed item. Without this, the new fallback
    // (cmdList → readQueueFromDisk) would show the removed item after
    // a stale-handle /list, contradicting the user's explicit remove.
    deleteQueueItemFile(ctx.cwd, removed.id);
    replaceState({ ...state, list: queue.filter((_, i) => i !== n - 1) });
    persistState(ctx);
    appendLedger(ctx.cwd, "list_removed", { id: removed.id, objective: removed.objective });
    ctx.ui.notify(`Removed: ${displaySlice(removed.objective, 80)}`, "info");
    return;
  }

  // v0.34.53: /list settings is not a list verb — it used to fall into the
  // natural-language dump and start a drafting interview with seed
  // "settings". Settings live under /glla: the bare command opens the
  // settings table and the action verbs (status, resume, wipe, …) live
  // there too. Redirect explicitly — never draft from a settings query.
  // Read-only: works on a stale handle too, like the /glla read-only actions.
  if (sub === "settings") {
    appendLedger(ctx.cwd, "list_settings_redirect", {});
    ctx.ui.notify(
      "Settings are under /glla, not /list — bare /glla opens the settings table (status/log/stats/audits and the actions live there too).",
      "info",
    );
    return;
  }

  // v0.18.0: an unknown first word isn't an error — it's a natural-language
  // dump. "/list fix the login bug, add dark mode, write docs" should MAKE
  // a list, not print usage. Detection chain: file → batch → contract →
  // conversational decomposition (drafting). The explicit verb for adding
  // one item verbatim is /list add.
  let raw = args.trim();
  if (raw.length >= 2 && ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'")))) {
    raw = raw.slice(1, -1).trim();
  }
  // The dump fallthrough is always mutating — refuse it on a stale handle.
  if (staleEntry) {
    if (queuePendingListOperation(ctx, args)) return;
    appendLedger(ctx.cwd, "list_mutation_refused_stale", { sub: "dump" });
    return;
  }
  const route = routeListText(ctx.cwd, raw);
  if (route.kind === "file") {
    await bulkAddFromFile(ctx, route.path);
    return;
  }
  if (route.kind === "batch") {
    await bulkAddItems(ctx, route.items, "pasted text");
    return;
  }
  if (route.kind === "direct") {
    addSingleItem(ctx, route.text);
    return;
  }
  await startDrafting(ctx, "list", route.seed);
}

/** Append one objective to the list; activate immediately when idle. */
function addSingleItem(ctx: ExtensionContext, raw: string): void {
  hydrateListQueueFromDisk(ctx);
  const extracted = parseListItemDeclaration(raw);
  const item = assignQueueOrder([{
    id: newGoalId(),
    objective: extracted.objective,
    ...(extracted.agentRole ? { agentRole: extracted.agentRole } : {}),
    verificationContract: extracted.verificationContract || undefined,
    ...(extracted.parallelSafe === undefined ? {} : { parallelSafe: extracted.parallelSafe }),
    addedAt: nowIso(),
  }], listQueue())[0]!;
  // v0.34.61: disk-first — write the sidecar BEFORE mutating state so the
  // item survives an orchestrator-turn death between state mutation and
  // persistState (the original bug for /list add "<direct text>").
  const written = writeQueueItemFile(ctx.cwd, item);
  if (written.failed) {
    ctx.ui.notify("Could not persist the list item; no in-memory queue mutation was applied. Fix disk access and retry.", "warning");
    return;
  }
  replaceState({ ...state, list: [...listQueue(), item] });
  persistState(ctx);
  appendLedger(ctx.cwd, "list_added", { id: item.id, objective: item.objective });
  // Nothing active → activate immediately.
  if (!state.goal || state.goal.status === "complete" || state.goal.status === "aborted") {
    activateNextListItem(ctx);
  } else {
    ctx.ui.notify(`Added to the list (${listQueue().length} waiting): ${displaySlice(extracted.objective, 80)}`, "info");
  }
}

/**
 * Push notification, folded IN by default (v0.28.34 — user: "leaving it to
 * the user to set up sucks, cause then they won't have it"). Resolution:
 *   notifyCmd === "off"   → silent (explicit opt-out)
 *   notifyCmd set         → that command, message passed as $1
 *   notifyCmd unset       → auto-detect ONCE per session: notify-send
 *                           (Linux) or osascript (macOS); none → silent.
 * Pushes fire only where there is something to DO — pauses, auditor
 * verdicts, storms, wedge, persistence degradation — never per-turn noise.
 * Fire-and-forget: a broken notifier never blocks the loop.
 */
let autoNotifyCmd: string | null | undefined; // undefined = not probed yet

function probeAutoNotify(ctx: ExtensionContext): void {
  if (autoNotifyCmd !== undefined || !flags.extensionApi) return;
  autoNotifyCmd = null; // probing sentinel — drops at most the first push
  void flags.extensionApi
    .exec("bash", ["-c", "command -v notify-send || command -v osascript || true"], { cwd: ctx.cwd })
    .then((r) => {
      const found = String((r as { stdout?: string }).stdout ?? "").trim();
      if (found.endsWith("notify-send")) autoNotifyCmd = `notify-send "pi-goal-list-loop-audit" "$1"`;
      // env-var handoff: the message never touches AppleScript quoting.
      else if (found.endsWith("osascript")) autoNotifyCmd = `GLLA_MSG="$1" osascript -e 'display notification (system attribute "GLLA_MSG") with title "pi-goal-list-loop-audit"'`;
      else autoNotifyCmd = null;
    })
    .catch(() => {
      autoNotifyCmd = null;
    });
}


async function cmdReview(args: string, ctx: ExtensionContext): Promise<void> {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  const id = parts[0] ?? "";
  const modeArg = parts[1];
  const validModes = ["off", "on", "auto", "aggressive"] as const;
  const mode = (validModes as readonly string[]).includes(modeArg ?? "")
    ? (modeArg as typeof validModes[number])
    : undefined;
  if (modeArg && !mode) {
    ctx.ui.notify(`Unknown mode "${modeArg}" — use off | on | auto | aggressive.`, "warning");
    return;
  }
  if (!id) {
    ctx.ui.notify(`Usage: /review <goal-id> [${validModes.join("|")}] — see /goal archive for ids.`, "info");
    return;
  }
  // Resolve the id against the archive (suffix match allowed).
  let goalId = id;
  let objective = "(archived goal)";
  try {
    const files = fs.readdirSync(archiveDir(ctx.cwd)).filter((f) => f.endsWith(".md"));
    const match = files.find((f) => f === `${id}.md`) ?? files.find((f) => f.includes(id));
    if (!match) {
      ctx.ui.notify(`No archived goal matching "${id}". /goal archive lists them.`, "warning");
      return;
    }
    goalId = match.replace(/\.md$/, "");
    const md = fs.readFileSync(path.join(archiveDir(ctx.cwd), match), "utf-8");
    const objMatch = md.match(/## Objective\n\n> ([\s\S]*?)(?:\n\n|$)/);
    if (objMatch) objective = objMatch[1]!.replace(/\n/g, " ").slice(0, 300);
  } catch {
    ctx.ui.notify(`No archive found for ${id}.`, "warning");
    return;
  }
  fireReviewer(ctx, { kind: "goal", goalId, objective, terminal: "goal-complete" }, { manual: true, mode });
}

/** v0.27.9: /glla tooloverride <action> [args] — per-tool override menu.
 * Actions:
 *   list                                show current allow/hide/perToolConfig
 *   allow <tool>                        force <tool> visible despite modlist
 *   hide <tool>                         force <tool> hidden despite session
 *   unallow <tool>                      remove from allow list
 *   unhide <tool>                       remove from hide list
 *   set <tool> <key>=<value>            write perToolConfig[tool][key]
 *   unset <tool> <key>                  remove perToolConfig[tool][key]
 * Example: /glla tooloverride allow bash hide write_file set bash timeout=60 */
async function cmdToolOverride(args: string, ctx: ExtensionContext): Promise<void> {
  const settings = loadSettings(ctx.cwd);
  const current = settings.toolOverrides ?? {};
  const parts = args.trim().split(/\s+/).filter(Boolean);
  const action = parts[0];
  if (!action || action === "list" || action === "show") {
    const allow = current.allow ?? [];
    const hide = current.hide ?? [];
    const cfg = current.perToolConfig ?? {};
    const out = `toolOverrides (project):\n  allow: ${allow.length ? allow.join(", ") : "(none)"}\n  hide: ${hide.length ? hide.join(", ") : "(none)"}\n  perToolConfig: ${Object.keys(cfg).length ? JSON.stringify(cfg) : "(none)"}`;
    ctx.ui.notify(out, "info");
    return;
  }
  const apply = (patch: Partial<NonNullable<Settings["toolOverrides"]>>) => {
    saveSettings("project", ctx.cwd, { toolOverrides: { ...current, ...patch } });
  };
  if (action === "allow" || action === "hide" || action === "unallow" || action === "unhide") {
    const tool = parts[1];
    if (!tool) {
      ctx.ui.notify(`Usage: /glla tooloverride ${action} <tool>`, "warning");
      return;
    }
    if (action === "allow") {
      const allow = current.allow ?? [];
      if (!allow.includes(tool)) apply({ allow: [...allow, tool] });
      ctx.ui.notify(`"${tool}" is now always visible to the agent (project override saved).`, "info");
    } else if (action === "hide") {
      const hide = current.hide ?? [];
      if (!hide.includes(tool)) apply({ hide: [...hide, tool] });
      ctx.ui.notify(`"${tool}" is now always hidden from the agent (project override saved).`, "info");
    } else if (action === "unallow") {
      apply({ allow: (current.allow ?? []).filter((t) => t !== tool) });
      ctx.ui.notify(`"${tool}" visibility override removed — the session decides again.`, "info");
    } else {
      apply({ hide: (current.hide ?? []).filter((t) => t !== tool) });
      ctx.ui.notify(`"${tool}" hide override removed — the session decides again.`, "info");
    }
    return;
  }
  if (action === "set" || action === "unset") {
    const tool = parts[1];
    const kv = parts[2];
    if (!tool || !kv) {
      ctx.ui.notify(`Usage: /glla tooloverride ${action} <tool> <key>[=<value>]`, "warning");
      return;
    }
    const cfg = { ...(current.perToolConfig ?? {}) };
    const toolCfg = { ...(cfg[tool] ?? {}) };
    if (action === "set") {
      const eq = kv.indexOf("=");
      if (eq < 0) {
        ctx.ui.notify(`set needs key=value: got "${kv}"`, "warning");
        return;
      }
      const k = kv.slice(0, eq);
      const v: unknown = parseToolOverrideValue(kv.slice(eq + 1));
      toolCfg[k] = v;
    } else {
      delete toolCfg[kv];
    }
    cfg[tool] = toolCfg;
    apply({ perToolConfig: cfg });
    ctx.ui.notify(
      action === "set"
        ? `"${tool}" setting saved: ${kv.slice(0, kv.indexOf("="))} = ${JSON.stringify(toolCfg[kv.slice(0, kv.indexOf("="))])} (project override).`
        : `"${tool}" setting "${kv}" removed — back to the built-in default.`,
      "info",
    );
    return;
  }
  ctx.ui.notify(`Unknown tooloverride action: ${action}. Use: list | allow | hide | unallow | unhide | set | unset.`, "warning");
}

/** Parse a tool-override value: numbers, booleans, JSON objects/arrays, else string. */
function parseToolOverrideValue(s: string): unknown {
  const trimmed = s.trim();
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed === "null") return null;
  if (/^-?\d+$/.test(trimmed)) return Number(trimmed);
  if (/^-?\d+\.\d+$/.test(trimmed)) return Number(trimmed);
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try { return JSON.parse(trimmed); } catch { /* fall through */ }
  }
  return trimmed;
}

/** v0.27.5: /glla reviewer | postaudit — the post-completion audit config menu
 * (project-scoped). Reads the dual-write settings (postaudit wins over the
 * legacy reviewer key), and writes back to whichever key was read first —
 * so we don't drift two parallel config blocks. */
async function cmdReviewerSettings(ctx: ExtensionContext): Promise<void> {
  const settings = loadSettings(ctx.cwd);
  const block = (settings.postaudit ?? settings.reviewer) as Partial<ReviewerConfig> | undefined;
  const settingsKey: "postaudit" | "reviewer" = settings.postaudit !== undefined ? "postaudit" : "reviewer";
  if (!ctx.hasUI) {
    const cfg = resolveReviewerConfig(block);
    ctx.ui.notify(`${settingsKey} (project): ${JSON.stringify(cfg, null, 2)}`, "info");
    return;
  }
  const load = () => resolveReviewerConfig(loadSettings(ctx.cwd)[settingsKey] as Partial<ReviewerConfig> | undefined);
  const save = (patch: Partial<ReviewerConfig>) =>
    saveSettings("project", ctx.cwd, { [settingsKey]: { ...load(), ...patch } as Record<string, unknown> });
  for (;;) {
    const cfg = load();
    let choice: string | undefined;
    try {
      choice = await ctx.ui.select("Postaudit — post-completion follow-up enqueuer (project settings)", reviewerMenuOptions(cfg));
    } catch {
      return;
    }
    if (!choice || choice === "Done") return;
    try {
      if (choice.startsWith("Enabled")) save({ enabled: !cfg.enabled });
      else if (choice.startsWith("Mode")) {
        // v0.27.9: 4-state cycle off → on → auto → aggressive → off
        const order: Array<"off" | "on" | "auto" | "aggressive"> = ["off", "on", "auto", "aggressive"];
        const i = order.indexOf(cfg.mode as typeof order[number]);
        const next = order[(i + 1) % order.length]!;
        save({ mode: next });
      }
      else if (choice.startsWith("Fire on goal-complete")) save({ fireOn: cfg.fireOn.includes("goal-complete") ? cfg.fireOn.filter((e) => e !== "goal-complete") : [...cfg.fireOn, "goal-complete"] });
      else if (choice.startsWith("Fire on list-complete")) save({ fireOn: cfg.fireOn.includes("list-complete") ? cfg.fireOn.filter((e) => e !== "list-complete") : [...cfg.fireOn, "list-complete"] });
      else if (choice.startsWith("Cascade: audit-on-clean")) save({ cascade: cfg.cascade.includes("fire-audit-on-clean") ? cfg.cascade.filter((c) => c !== "fire-audit-on-clean") : [...cfg.cascade, "fire-audit-on-clean"] });
      else if (choice.startsWith("Max findings")) {
        const v = await ctx.ui.input("Max findings per review", "1-50");
        const n = Number(v?.trim());
        if (Number.isSafeInteger(n) && n >= 1 && n <= 50) save({ maxFindingsPerReview: n });
      } else if (choice.startsWith("Max reviews")) {
        const v = await ctx.ui.input("Max reviewer fires per day", "1-100");
        const n = Number(v?.trim());
        if (Number.isSafeInteger(n) && n >= 1 && n <= 100) save({ maxReviewsPerDay: n });
      }
    } catch (err) {
      // v0.28.11 (E7): a swallowed save failure made the user believe the
      // toggle landed. Loud now.
      ctx.ui.notify(`Postaudit setting NOT saved: ${err instanceof Error ? err.message : String(err)} — check .pi-glla/settings.json permissions.`, "warning");
    }
  }
}

/**
 * v0.25.2: /glla stats — one command, every project's rollup. Args:
 *   (none)            markdown table, all discovered projects
 *   json              machine-readable rollup (same schema as the table)
 *   premature         only projects with premature_success > 0, ratio-sorted
 *   project=<path>    limit the scan to one project
 */
function cmdStats(args: string, ctx: ExtensionContext): void {
  const asJson = /\bjson\b/.test(args);
  const prematureOnly = /\bpremature\b/.test(args);
  const projectMatch = args.match(/project=(\S+)/);
  let rollups: ProjectRollup[] = [];
  if (projectMatch) {
    const p = projectMatch[1]!.replace(/^~/, os.homedir());
    const r = rollupProject(p);
    if (!r) {
      ctx.ui.notify(`/glla stats: no .pi-glla/active.jsonl under ${p}`, "warning");
      return;
    }
    rollups = [r];
  } else {
    const projects = discoverGllaProjects({ cwd: ctx.cwd });
    for (const p of projects) {
      const r = rollupProject(p);
      if (r) rollups.push(r);
    }
    if (rollups.length === 0) {
      ctx.ui.notify("/glla stats: no projects with .pi-glla/active.jsonl found on this rig.", "info");
      return;
    }
  }
  if (prematureOnly) rollups = filterPremature(rollups);
  const out = asJson ? formatRollupJson(rollups) : formatRollupTable(rollups);
  ctx.ui.notify(`glla stats — ${rollups.length} project(s)${prematureOnly ? " (premature filter)" : ""}\n${out}`, "info");
}

/**
 * v0.25.4: /glla audits [N|full] — browse the durable per-project audit
 * log (.pi-glla/audits.jsonl). Default: last 10 verdicts, one line each.
 * "full" prints the latest report in full.
 */
/**
 * v0.28.28: /glla log [N] — human-readable tail of the event ledger (the
 * forensic trail: who created/resumed/paused goals, from where). Skips the
 * high-frequency noise entries (state snapshots, re-arm internals) unless
 * "all" is passed. N defaults to 15.
 */
const LOG_NOISE = new Set(["state", "send_rearm_start", "heartbeat_suppressed_tick"]);
function cmdLog(args: string, ctx: ExtensionContext): void {
  const all = /\ball\b/.test(args);
  const nMatch = args.match(/\b(\d+)\b/);
  const n = Math.min(Math.max(parseInt(nMatch?.[1] ?? "15", 10) || 15, 1), 100);
  let entries: Array<{ type: string; at?: string; value?: any }> = [];
  try {
    entries = parseLedgerEntries(fs.readFileSync(ledgerPath(ctx.cwd), "utf-8"));
  } catch {
    ctx.ui.notify("No ledger yet — .pi-glla/active.jsonl doesn't exist.", "info");
    return;
  }
  const visible = all ? entries : entries.filter((e) => !LOG_NOISE.has(e.type));
  const tail = visible.slice(-n);
  if (tail.length === 0) {
    ctx.ui.notify("Ledger is empty (no non-noise events yet).", "info");
    return;
  }
  const lines = tail.map((e) => {
    const t = (e.at ?? "").slice(11, 19);
    const v = e.value ?? {};
    const detail = Object.entries(v)
      .filter(([k]) => k !== "goalId" && k !== "report")
      .map(([k, val]) => `${k}=${typeof val === "string" ? val.slice(0, 60) : JSON.stringify(val)?.slice(0, 60)}`)
      .join(" ");
    return `${t}  ${e.type}${detail ? `  ${detail}` : ""}`;
  });
  ctx.ui.notify(`Ledger tail (last ${tail.length}${all ? "" : " non-noise"} events — /glla log <N> for more, /glla log all to include noise):\n${lines.join("\n")}`, "info");
}

/** v0.34.57: /glla switchlog [N] — the model-switch trail (model_switch +
 * forbidden_model_switch ledger events). Read-only: works on a stale
 * handle, like the other /glla read-only actions. */
function cmdSwitchlog(args: string, ctx: ExtensionContext): void {
  const nMatch = args.match(/\b(\d+)\b/);
  const n = Math.min(Math.max(parseInt(nMatch?.[1] ?? "15", 10) || 15, 1), 100);
  let entries: Array<{ type: string; at?: string; value?: any }> = [];
  try {
    entries = parseLedgerEntries(fs.readFileSync(ledgerPath(ctx.cwd), "utf-8"));
  } catch {
    ctx.ui.notify("No ledger yet — .pi-glla/active.jsonl doesn't exist.", "info");
    return;
  }
  const switches = entries.filter((e) => e.type === "model_switch" || e.type === "forbidden_model_switch");
  const tail = switches.slice(-n);
  if (tail.length === 0) {
    ctx.ui.notify("No model switches recorded yet — /glla switchlog shows the model_switch / forbidden_model_switch trail.", "info");
    return;
  }
  const lines = tail.map((e) => {
    const t = (e.at ?? "").slice(11, 19);
    const v = e.value ?? {};
    const arrow = `${v.from ?? "(unknown)"} → ${v.to ?? "(unknown)"}`;
    const tag = e.type === "forbidden_model_switch" ? "FORBIDDEN" : "switch";
    const outcome = v.blocked === true ? " (BLOCKED)" : v.blocked === false ? " (violation)" : "";
    const reason = v.reason ? ` [${v.reason}]` : "";
    return `${t}  ${tag}  ${arrow}${outcome}${reason}`;
  });
  ctx.ui.notify(`Model-switch trail (last ${tail.length} — /glla switchlog <N> for more):\n${lines.join("\n")}`, "info");
}

/**
 * v0.28.31 (renamed v0.28.33): /glla wipe — ONE confirmed command that leaves a project with
 * zero live glla state. User directive: "make sure we only have one goal or
 * loop or list at a time — many of my older projects have leftovers" (the
 * fleet scan found queued lists up to 56 deep, held loops at iter 50, and
 * paused goals across ~10 projects). The goal is archived HONESTLY (aborted
 * — lands in goals/ + the archive, reviewer's abort-suppression applies),
 * the list is cleared, the loop record is wiped after a graceful stop.
 * History stays in .pi-glla; only the live state goes.
 */
async function cmdGllaWipe(ctx: ExtensionContext, entryChecked = false): Promise<void> {
  if (!entryChecked && warnIfStaleAtEntry(ctx, "/glla wipe")) return;
  const g = state.goal;
  const live = g && (g.status === "active" || g.status === "paused" || g.status === "auditing");
  const memoryQueue = listQueue();
  const diskQueue = readQueueFromDisk(ctx.cwd);
  const sidecarCount = queueItemSidecarCount(ctx.cwd);
  const orphanQueue = diskQueue.filter((item) => !memoryQueue.some((queued) => queued.id === item.id));
  const n = Math.max(memoryQueue.length, sidecarCount, memoryQueue.length + orphanQueue.length);
  const loop = state.loop;
  const hasRecovery = !!state.mainModelRecovery || mainModelRecoveryTimerActive();
  const dispatchSidecarPresent = continuationDispatchPending() || dispatchRecordExists(ctx.cwd);
  if (!g && n === 0 && !loop && !hasRecovery && !dispatchSidecarPresent) {
    ctx.ui.notify("glla state is already clean — no goal, no list, no loop, no recovery.", "info");
    return;
  }
  const parts: string[] = [];
  if (live) parts.push(`goal archived as aborted: ${displaySlice(g!.objective, 70)}`);
  else if (g) parts.push(`terminal goal record cleared (${g.status})`);
  if (n > 0) parts.push(`list cleared (${n} item${n === 1 ? "" : "s"})`);
  if (loop) parts.push(`loop ${loop.active ? "stopped" : "cleared"} (iter ${loop.iteration}${loop.bestValue !== null && loop.bestValue !== undefined ? `, best ${loop.bestValue}` : ""})`);
  if (hasRecovery) parts.push("main-model recovery cleared");
  if (dispatchSidecarPresent) parts.push("pending continuation dispatch cleared");
  if (!ctx.hasUI) {
    ctx.ui.notify("Wipe requires an interactive Confirm dialog; no state was changed.", "warning");
    return;
  }
  try {
    const ok = await ctx.ui.confirm("Wipe glla state?", `${parts.map((p) => `  ${p}`).join("\n")}\n\nHistory stays in .pi-glla (archive + ledger); the live state is wiped.`);
    if (!ok) {
      ctx.ui.notify("Wipe cancelled.", "info");
      return;
    }
  } catch {
    ctx.ui.notify("Wipe cancelled.", "info");
    return;
  }
  appendLedger(ctx.cwd, "glla_wipe", {
    goalId: live ? g!.id : undefined,
    listCleared: n,
    loop: loop ? { iteration: loop.iteration, active: loop.active } : undefined,
    recovery: hasRecovery,
    dispatchSidecar: dispatchSidecarPresent,
  });
  const abortAfterWipe = !!live;
  if (live) {
    // Do not abort here: wipe still has to clear queue sidecars and loop
    // state. The old early abort made a second /glla wipe appear necessary.
    if (!archiveCurrentGoal(ctx, "aborted", "user wipe (/glla wipe)")) return;
  } else if (g) {
    replaceState({ ...state, goal: null });
  }
  // Clear provider-recovery and continuation artifacts only after a live-goal
  // archive succeeds. An archive failure must leave all resumable work intact.
  clearMainModelRecoveryTimer();
  state.mainModelRecovery = undefined;
  flags.mainModelAbortForRecovery = false;
  flags.mainModelSwitchInFlight = false;
  const dispatchCleared = resetContinuationDispatchState(ctx.cwd);
  let failedSidecars: string[] = [];
  const failedCleanup: string[] = dispatchSidecarPresent && !dispatchCleared ? ["continuation dispatch"] : [];
  if (n > 0) {
    // v0.35.0: clear the union of RAM and disk queue state. Orphaned
    // sidecars otherwise resurrected after a stale reload.
    const clearedSidecars = clearQueueItemFiles(ctx.cwd);
    failedSidecars = clearedSidecars.failed;
    replaceState({ ...state, list: [] });
    appendLedger(ctx.cwd, "list_cleared", { via: "glla_wipe", count: n, sidecars: clearedSidecars.removed });
  }
  if (loop) {
    clearLoopTimer();
    // Persist the clean live slot BEFORE branch cleanup can cross a stale
    // context. A failed git cleanup must not resurrect the old loop on reload.
    replaceState({ ...state, loop: undefined });
    persistState(ctx);
    const wipeGeneration = flags.sessionGeneration;
    await finishLoopGit(ctx, loop);
    const afterFinish = freshCtxForGeneration(wipeGeneration);
    if (!afterFinish) return;
    ctx = afterFinish;
    appendLedger(ctx.cwd, "loop_stopped", { reason: "user wipe (/glla wipe)", iterations: loop.iteration, best: loop.bestValue });
  }
  persistState(ctx);
  const failedCleanupCount = failedSidecars.length + failedCleanup.length;
  if (failedCleanupCount > 0) {
    const failedLabels = [...failedSidecars.map(() => "queue sidecar"), ...failedCleanup].join(", ");
    ctx.ui.notify(`Wipe could not remove ${failedCleanupCount} live artifact(s) (${failedLabels}); the clean slate is incomplete.`, "warning");
  }
  ctx.ui.notify(`glla wipe done: ${parts.join(" · ")}. ${failedCleanupCount > 0 ? "Partial clean slate — fix disk access and retry." : "Clean slate."}`, "info");
  notifyExternal(ctx, failedCleanupCount > 0 ? "glla wipe incomplete — live cleanup needs attention." : "glla state wiped by user — clean slate.");
  if (abortAfterWipe) ctx.abort();
}

/**
 * v0.28.32: /glla resume — resume WHATEVER is resumable, without the user
 * needing to know whether they're supervising a goal, a list item, or a
 * held loop. Safe because one-active-thing is enforced (v0.28.14+): at
 * most one thing can be ACTIVE, so the only ambiguity is paused-goal +
 * held-loop coexisting (nothing running, two resumables — e.g. polis
 * today) → the v0.28.23 decision-picker pattern. Verbs whose semantics
 * genuinely differ per type (tweak/finish/next/decide/refine) stay typed.
 */
/**
 * v0.35.15: `/glla pause` — freeze the SUPERVISOR, not the work.
 *
 * Broad by design (user-confirmed 2026-08-21): every automatic side-effect
 * stops — heartbeat re-arms/stale probes/zombie cleanup, recovery probes,
 * auto-resume, auto-continuation dispatch, loop ticks, and the proactive
 * auditor quiet-phase notification. The active goal/list item/loop state is
 * untouched and any detached worker keeps running; only the automatic
 * machinery around it freezes. Manual user commands still work. Persisted
 * via `supervisorPausedAt`, so a session restart cannot silently re-arm
 * machinery the user explicitly stopped. Pausing while a recovery claim is
 * parked keeps the claim durable on disk — nothing is discarded.
 */
async function cmdGllaPause(ctx: ExtensionContext): Promise<void> {
  if (warnIfStaleAtEntry(ctx, "/glla pause")) return;
  releaseInitialSessionLoadBarrier();
  const already = typeof state.supervisorPausedAt === "number";
  const pausedAtMs = Date.now();
  replaceState({ ...state, supervisorPausedAt: pausedAtMs });
  persistState(ctx);
  appendLedger(ctx.cwd, "supervisor_pause", already ? { repeat: true } : {});
  // An armed continuation/recovery timer may already be scheduled; every
  // dispatch point checks supervisorPaused() so stale timers become no-ops.
  ctx.ui.notify(already
    ? "Supervisor is already paused — all automatic machinery stays frozen (active work untouched). /glla resume to unfreeze."
    : "Supervisor PAUSED — heartbeat re-arms, recovery probes, auto-resume, continuation dispatch, loop ticks, and auditor quiet notifies are frozen. The active goal/list item/loop and detached workers keep running. /glla resume to unfreeze.",
    "warning");
}

async function cmdGllaResume(ctx: ExtensionContext): Promise<void> {
  // v0.29.12: a zombie instance (handle dead after session replacement)
  // used to answer "Nothing to resume" — the resume path must name the
  // real recovery (/reload rebuilds extensions in place), not mislead.
  if (warnIfStaleAtEntry(ctx, "/glla resume")) return;
  releaseInitialSessionLoadBarrier();
  // v0.35.15: clearing a supervisor pause is resume's first job — the flag
  // outlives sessions, so an explicit /glla resume must always unfreeze the
  // machinery even when there is nothing else to resume afterwards.
  let clearedSupervisorPause = false;
  if (typeof state.supervisorPausedAt === "number") {
    const frozenMs = Date.now() - state.supervisorPausedAt;
    delete (state as { supervisorPausedAt?: number }).supervisorPausedAt;
    persistState(ctx);
    clearedSupervisorPause = true;
    appendLedger(ctx.cwd, "supervisor_resume", { frozenMs });
    ctx.ui.notify(`Supervisor RESUMED after ${fmtElapsed(frozenMs)} — heartbeat re-arms, recovery probes, auto-resume, continuation dispatch, and auditor quiet notifies are live again.`, "info");
  }
  if (manuallyResumeMainModelRecovery(ctx)) return;
  if (state.mainModelRecovery?.retryAt || state.mainModelRecovery?.pendingModelSwitch) {
    clearMainModelRecoveryTimer();
    flags.continuationDispatchStoodDown = false;
    ctx.ui.notify("Retrying the saved main-model recovery now — one provider probe, then the configured fallback models if needed.", "info");
    void probeMainModelRecovery(ctx);
    return;
  }
  const g = state.goal;
  const goalResumable = g && g.status === "paused";
  const loopResumable = state.loop && !state.loop.active && state.loop.stopReason === HELD_ON_RESTORE;
  if (goalResumable && loopResumable) {
    if (ctx.hasUI) {
      try {
        const loopLabel = `Resume the held loop (iter ${state.loop!.iteration}, best ${state.loop!.bestValue ?? "n/a"}): ${displaySlice(state.loop!.target, 80)}`;
        const pick = await ctx.ui.select("Two things can resume — which one?", [
          `Resume the ${g!.policy === "list" ? "list item" : "goal"}: ${displaySlice(g!.objective, 80)}`, 
          loopLabel,
        ]);
        if (pick === undefined) {
          ctx.ui.notify("Resume cancelled.", "info");
          return;
        }
        if (pick === loopLabel) {
          await cmdLoop("resume", ctx);
          return;
        }
        await cmdResume(ctx);
        return;
      } catch {
        // picker failed — fall through to goal-first
      }
    }
    await cmdResume(ctx);
    return;
  }
  if (goalResumable) {
    await cmdResume(ctx);
    return;
  }
  if (loopResumable) {
    await cmdLoop("resume", ctx);
    return;
  }
  // v0.34.3: an ACTIVE-but-idle goal is exactly what the user means by
  // "resume" (hellhunter 2026-08-01: widget said "list item · active", the
  // agent sat idle after a prose-only turn — the continuation that should
  // drive the new head never landed — and /glla resume shrugged "Nothing to
  // resume"). Re-kick the continuation instead of shrugging.
  if (g && g.status === "active") {
    appendLedger(ctx.cwd, "resume_rekick", { goalId: g.id, policy: g.policy });
    // v0.34.7: the re-kick fulfills the stale-handle marker's promise too
    // (junk-runner/polis/neonbreak 2026-08-01: actively working with the
    // ⚠ interrupted banner still screaming — the v0.34.2 clear only lived
    // in the paused-resume path; the staleness entry-guard above already
    // filtered out a stale session reaching this branch).
    if (g.interruptedAt) updateGoal({ interruptedAt: undefined, interruptedReason: undefined }, ctx);
    ctx.ui.notify(
      `The ${g.policy === "list" ? "list item" : "goal"} is ACTIVE but idle — re-firing its continuation: ${displaySlice(g.objective, 70)}`,
      "info",
    );
    scheduleContinuation(ctx, true);
    return;
  }
  if (g && g.status === "auditing") {
    if (!g.pendingCompletion) {
      ctx.ui.notify("A detached completion auditor is in flight — wait for its verdict (the status line shows auditor running). /glla cancel discards the pending claim.", "info");
      return;
    }
    if (flags.completionAuditInFlight) {
      ctx.ui.notify("The detached completion auditor is already running — wait for its verdict or /glla cancel to discard the pending claim.", "info");
      return;
    }
    markCompletionAuditRecoveryPending(ctx, "manual-resume");
    flags.completionAuditRecoveryArmed = true;
    ctx.ui.notify("Resuming the stored completion claim — starting a detached auditor (no agent turn needed).", "info");
    void retryStoredCompletionAudit("manual");
    return;
  }
  if (state.loop?.active) {
    appendLedger(ctx.cwd, "resume_rekick", { loop: true, iteration: state.loop.iteration });
    if (flags.continuationDispatchStoodDown) releaseContinuationDispatchStandDown();
    ctx.ui.notify(`The loop is ACTIVE — re-firing its tick (iteration ${state.loop.iteration}). If it wedges again, /loop status for the diagnostics.`, "info");
    scheduleLoopTick(ctx);
    return;
  }
  if (clearedSupervisorPause) {
    // The pause was the only thing being resumed — do not follow it with a
    // misleading "Nothing to resume".
    return;
  }
  ctx.ui.notify("Nothing to resume — no paused goal/list-item, no held loop. /goal, /list, or /loop to start something.", "info");
}

/**
 * v0.34.119: /glla cancel means cancel the active OBJECTIVE, not merely
 * whichever one live artifact happens to win a type-blind dispatch. For a
 * list objective that means the active list item plus every waiting item
 * (the same durable semantics as /list cancel). A standalone goal still
 * archives only itself; a loop with no goal is stopped separately.
 *
 * `/list cancel` remains the explicit list-scoped spelling and `/glla wipe`
 * remains the destructive all-state spelling. The important distinction is
 * that `/glla cancel` no longer leaves a list objective half-alive in the
 * queue after aborting only its current item.
 */
async function cmdGllaCancel(ctx: ExtensionContext): Promise<void> {
  // A running loop is itself the active objective. Stop it before looking at
  // an unrelated waiting list; otherwise `/glla cancel` can silently drop the
  // queue while leaving the loop running.
  if (state.loop?.active) {
    await cmdLoop("stop", ctx);
    return;
  }
  const g = state.goal;
  const liveGoal = g && (g.status === "active" || g.status === "paused" || g.status === "auditing");
  // A standalone live goal is the active objective even when an unrelated
  // waiting backlog exists. A list-policy goal owns its queue, so canceling
  // that objective drops both together.
  if (liveGoal && g!.policy !== "list") {
    await cmdCancel(ctx);
    return;
  }
  const hasListObjective = listQueue().length > 0 || (liveGoal && g!.policy === "list");
  if (hasListObjective) {
    await cmdList("cancel", ctx);
    return;
  }
  if (g && (g.status === "active" || g.status === "paused" || g.status === "auditing")) {
    await cmdCancel(ctx);
    return;
  }
  if (state.loop) {
    await cmdLoop("stop", ctx);
    return;
  }
  ctx.ui.notify("Nothing to cancel — no active/paused goal/list-item, no loop. Queued list items: /list cancel; everything: /glla wipe.", "info");
}

function cmdAudits(args: string, ctx: ExtensionContext): void {
  const full = /\bfull\b/.test(args);
  const all = /\b(?:all|global|log)\b/.test(args);
  const nMatch = args.match(/\b(\d+)\b/);
  if (full) {
    // Latest report — active goal's history first, then the log.
    const fromGoal = state.goal?.auditHistory?.at(-1);
    if (fromGoal?.report) {
      ctx.ui.notify(`Latest audit on this goal — ${fromGoal.model} (${fromGoal.at})\n${sanitizeProviderAuditReport(fromGoal.report)}`, "info");
      return;
    }
    const latest = readAuditLog(ctx.cwd).at(-1);
    ctx.ui.notify(latest ? `Latest audit — ${latest.verdict} (${latest.model}, ${latest.at})\n${sanitizeProviderAuditReport(latest.report)}` : "No audits logged yet.", "info");
    return;
  }
  // Default: the ACTIVE goal's own audit history (with per-audit elapsed);
  // "all"/"global"/"log" browses the durable cross-goal log.
  if (!all && state.goal?.auditHistory && state.goal.auditHistory.length > 0) {
    ctx.ui.notify(
      `glla audits — this goal's history (${state.goal.auditHistory.length} verdict(s); /glla audits all for the project log)\n${formatGoalAuditHistory(state.goal)}`,
      "info",
    );
    return;
  }
  const n = nMatch ? Number(nMatch[1]) : 10;
  const entries = readAuditLog(ctx.cwd, n);
  ctx.ui.notify(`glla audits — last ${entries.length} verdict(s) in ${ctx.cwd}\n${formatAuditLog(entries)}`, "info");
}

// /glla version is intentionally read-only and package-backed. Keeping the
// version lookup next to the command surface makes an installed extension
// identify itself even when its host session is stale or no live goal exists.
function cmdGllaVersion(ctx: ExtensionContext): void {
  ctx.ui.notify(formatGllaVersion(), "info");
}

// v0.29.8: /glla status — the unified "what's running" surface (user: "we
// need to type goal status [to check], so that command at least is missing
// for checking on whatever active process we have"). Read-only aggregate of
// the ONE state — goal, list queue, loop, pending decisions — with pointers
// to the deep surfaces.
function cmdGllaStatus(ctx: ExtensionContext): void {
  const lines: string[] = [];
  // v0.35.15: name a frozen supervisor FIRST — it changes how every other
  // line reads (nothing automatic will fire while this is set).
  if (typeof state.supervisorPausedAt === "number") {
    lines.push(`supervisor: ⏸ PAUSED since ${new Date(state.supervisorPausedAt).toISOString()} — re-arms/recovery/dispatch frozen — /glla resume`);
  }
  const g = state.goal;
  if (g) {
    const tok = (g.usage?.tokensUsed ?? 0) > 0 ? ` · ${g.usage!.tokensUsed} tok` : "";
    const audit = g.status === "auditing"
      ? isCompletionAuditRecoveryPending(g) ? " (audit recovery pending)" : flags.completionAuditInFlight && flags.latestAuditProgress?.label === "queued" ? " (detached auditor queued)" : flags.completionAuditInFlight ? " (detached auditor running…)" : " (audit awaiting lifecycle recovery)"
      : "";
    const pause = g.status === "paused" && g.pauseReason ? ` — ${displaySlice(sanitizeProviderDisplayText(g.pauseReason), 90)}` : "";
    lines.push(`goal [${g.policy}] ${g.status}${audit}${tok}: ${displaySlice(g.objective, 90)}${pause}`);
  } else {
    lines.push("goal: none");
  }
  const q = listQueue();
  lines.push(`list: ${q.length === 0 ? "empty" : `${q.length} queued — head: ${displaySlice(q[0]?.objective ?? "", 70)}`}`);
  const l = state.loop;
  if (l) {
    lines.push(`loop: ${l.active ? "ACTIVE" : `held/stopped — ${sanitizeDisplayText(l.stopReason ?? "n/a")}`} · iter ${l.iteration}/${l.maxIterations > 0 ? l.maxIterations : "∞"} · best ${l.bestValue ?? "n/a"} · stall ${l.stallCount} — ${displaySlice(l.target, 60)}`);
  } else {
    lines.push("loop: none");
  }
  if (g?.status === "paused" && g.pauseKind === "decision" && g.pauseOptions?.length) {
    lines.push(`decision pending (${g.pauseOptions.length} options) — ${activeGoalSurfaceCommand("decide")}`);
  }
  lines.push("deep: /goal status · /list · /loop status · /glla stats · /glla audits · /glla log");
  ctx.ui.notify(`glla status\n${lines.join("\n")}`, "info");
}

async function cmdSettings(args: string, ctx: ExtensionContext): Promise<void> {
  // v0.34.52: settings entry probe — mirror of cmdList's stale gate. Bare
  // /glla is a settings surface every choice of which writes state, and
  // wipe/reset/cancel/resume/reviewer/postaudit/tooloverride mutate
  // directly; on a stale handle (pi session replacement) those writes
  // would land from a doomed process that can neither announce nor run
  // them. Refuse with the standard recovery message from the entry probe
  // and a ledger trail; read-only surfaces (status/log/stats/audits) and
  // the unknown-action notice stay usable for inspection.
  const staleEntry = warnIfStaleAtEntry(ctx, "/glla");
  // `/glla` is the settings surface. Arguments belong to the action namespace
  // below (status, resume, stats, etc.); settings are edited in the table
  // rather than through noisy inline assignments.
  const trimmed = args.trim();
  const verb = trimmed ? trimmed.split(/\s+/)[0]!.toLowerCase() : "ui";
  if (staleEntry && (verb === "ui" || SETTINGS_MUTATING_ACTIONS.has(verb))) {
    appendLedger(ctx.cwd, "settings_mutation_refused_stale", { sub: verb });
    return;
  }
  // v0.25.2: /glla stats sub-mode — cross-project telemetry rollups.
  if (/^version(?:\s|$)/.test(trimmed)) {
    cmdGllaVersion(ctx);
    return;
  }
  if (/^stats(?:\s|$)/.test(trimmed)) {
    cmdStats(trimmed.slice("stats".length).trim(), ctx);
    return;
  }
  if (/^audits(?:\s|$)/.test(trimmed)) {
    cmdAudits(trimmed.slice("audits".length).trim(), ctx);
    return;
  }
  if (/^status(?:\s|$)/.test(trimmed)) {
    cmdGllaStatus(ctx);
    return;
  }
  if (/^log(?:\s|$)/.test(trimmed)) {
    cmdLog(trimmed.slice("log".length).trim(), ctx);
    return;
  }
  if (/^switchlog(?:\s|$)/.test(trimmed)) {
    cmdSwitchlog(trimmed.slice("switchlog".length).trim(), ctx);
    return;
  }
  if (/^fallbacks(?:\s|$)/.test(trimmed)) {
    const action = trimmed.slice("fallbacks".length).trim().toLowerCase();
    if (action === "clear" || action === "off" || action === "unset" || action === "none") {
      saveSettings("global", ctx.cwd, { mainModelFallbacks: undefined });
      if (state.mainModelRecovery) {
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
      ctx.ui.notify("Main agent fallback models cleared globally and any pending fallback switch was cancelled.", "info");
    } else {
      const settings = loadSettings(ctx.cwd);
      ctx.ui.notify(`Main agent fallback models: ${formatMainModelFallbacks(settings.mainModelFallbacks)}. Use /glla fallbacks clear to remove them.`, "info");
    }
    return;
  }
  if (/^wipe(?:\s|$)/.test(trimmed)) {
    await cmdGllaWipe(ctx, true);
    return;
  }
  if (/^reset(?:\s|$)/.test(trimmed)) {
    ctx.ui.notify("/glla reset is now /glla wipe (renamed — too close to /glla resume). Nothing was done.", "info");
    return;
  }
  if (/^resume(?:\s|$)/.test(trimmed)) {
    await cmdGllaResume(ctx);
    return;
  }
  if (/^pause(?:\s|$)/.test(trimmed)) {
    await cmdGllaPause(ctx);
    return;
  }
  if (/^cancel(?:\s|$)/.test(trimmed)) {
    await cmdGllaCancel(ctx);
    return;
  }
  if (/^reviewer(?:\s|$)/.test(trimmed)) {
    await cmdReviewerSettings(ctx);
    return;
  }
  if (/^postaudit(?:\s|$)/.test(trimmed)) {
    await cmdReviewerSettings(ctx);
    return;
  }
  if (/^tooloverride(?:\s|$)/.test(trimmed)) {
    await cmdToolOverride(trimmed.slice("tooloverride".length).trim(), ctx);
    return;
  }
  if (trimmed) {
    ctx.ui.notify(
      `Unknown /glla action "${trimmed}". Use /glla to open settings; command arguments are reserved for actions.`,
      "warning",
    );
    return;
  }
  if (ctx.hasUI) {
    await openSettingsUI(ctx);
    return;
  }
  // Headless fallback: read-only effective values with provenance. Writes
  // require the interactive settings table so the command namespace stays
  // unambiguous and action-oriented.
  const prov = settingsProvenance(ctx.cwd);
  const fmt = (k: keyof Settings, label: string) => {
    const p = prov[k];
    const v = p.value === undefined ? "(unset)" : String(p.value);
    return `${label}: ${v}  [${p.source}]`;
  };
  const effectiveSettings = loadSettings(ctx.cwd);
  ctx.ui.notify(
    [
      `mainAgentFallbackModels: ${formatMainModelFallbacks(effectiveSettings.mainModelFallbacks)}  [${prov.mainModelFallbacks?.source ?? "default"}]`,
      fmt("mainModelRetryMinutes", "mainModelRetryMinutes (base minutes; doubles per attempt)"),
      fmt("mainModelFailback", "mainModelFailback (auto/sticky)"),
      fmt("mainModelPrimaryProbeMinutes", "mainModelPrimaryProbeMinutes"),
      fmt("drafterModel", "drafterAgent (drafting only)"),
      fmt("drafterThinkingLevel", "drafterThinking (drafting only)"),
      fmt("drafterModelFallbacks", "drafterFallbackAgents (drafting only)"),
      fmt("forbiddenModels", "forbiddenModels"),
      fmt("blockForbiddenModelSwitches", "blockForbidden"),
      fmt("visionAssist", "visionAssist"),
      fmt("auditorModel", "auditorModel"),
      fmt("auditorThinkingLevel", "thinking"),
      fmt("notifyCmd", "notify"),
      fmt("tokenLimit", "tokenLimit"),
      fmt("autoResume", "autoResume"),
      fmt("autoAcceptDrafts", "autoAccept"),
      fmt("decisionPopup", "decisionPopup"),
      fmt("carryover", "carryover"),
      fmt("auditorModelFallback", "auditorModelFallback"),
      fmt("auditorSameSessionSwap", "auditorSameSessionSwap"),
      fmt("auditorSilent", "auditorSilent"),
      fmt("auditorProgressSignals", "auditorProgressSignals"),
      fmt("hourlyRetryProbe", "hourlyRetryProbe"),
      fmt("subagentModelStrategy", "subagentModelStrategy"),
      fmt("subagentModelOverrides", "subagentModelOverrides"),
      fmt("subagentFallbacks", "subagentFallbacks"),
      fmt("toolOverrides", "toolOverrides"),
      fmt("auditCap", "auditCap"),
      fmt("auditFeedbackChars", "auditFeedbackChars"),
      fmt("aggressiveMode", "aggressiveMode"),
      fmt("stuckMaxInterventions", "stuckMaxInterventions"),
      fmt("stallEscalationRefires", "stallEscalation"),
      fmt("wedgeAlertMinutes", "wedgeAlert"),
      fmt("stallShortWords", "stallShortWords"),
      fmt("stallSimilarityThreshold", "stallSimilarityThreshold"),
      // v0.27.5: post-completion auditor config — read either the new
      // `postaudit` key or the legacy `reviewer` key (postaudit wins).
      `postaudit: ${JSON.stringify(loadSettings(ctx.cwd).postaudit ?? loadSettings(ctx.cwd).reviewer ?? {}) || '(unset — defaults)'}`,
      // v0.25.6: effective per-type subagent model resolution.
      ...OVERRIDABLE_AGENT_TYPES.map(
        (t) => `subagent ${t}: ${resolveEffectiveSubagentModel(t, loadSettings(ctx.cwd), (ctx.model as any)?.id ? `${(ctx.model as any).provider}/${(ctx.model as any).id}` : undefined)}`,
      ),
      `\nglobal:  ${globalSettingsPath()}`,
      `project: ${projectSettingsPath(ctx.cwd)}`,
      "Edit settings by opening /glla in an interactive session.",
    ].join("\n"),
    "info",
  );
}

// =================================================================
// Command-collision detector (PLAN.md D1)
//
// pi's runner.js resolveRegisteredCommands() never throws on duplicate
// command names: the first registrant keeps the bare name, later ones
// become "goal:2", "list:3", etc. So a collision degrades UX silently.
// We detect duplicates at session start and warn loudly once.
// =================================================================

const OUR_COMMANDS = ["goal", "glla", "list", "loop"];
let collisionWarned = false;

// Providers known to pi core. The detached worker receives only provider/id
// and resolves credentials in its extension-less child process. A provider
// defined in ~/.pi/agent/models.json with auth.json credentials works; a
// provider registered only in the parent extension runtime may not. Unknown
// providers get a soft one-time conditional notice: if audits error with auth
// failures, choose an explicit auditor model in the /glla settings table.
const KNOWN_BUILTIN_PROVIDERS = new Set([
  "anthropic", "google", "google-vertex", "google-gemini-cli", "openai", "openai-codex",
  "openrouter", "opencode", "azure-openai-responses", "groq", "cerebras", "xai", "zai",
  "minimax", "minimax-cn", "moonshotai", "kimi-coding", "github-copilot", "mistral", "huggingface",
]);
let providerWarned = false;

function warnIfAuditorProviderRisky(ctx: ExtensionContext): void {
  if (providerWarned) return;
  providerWarned = true;
  try {
    const settings = loadSettings(ctx.cwd);
    if (settings.auditorModel) return; // explicit auditor model — user's call
    const provider = (ctx.model as any)?.provider as string | undefined;
    if (!provider || KNOWN_BUILTIN_PROVIDERS.has(provider)) return;
    ctx.ui.notify(
      `pi-goal-list-loop-audit: session provider "${provider}" is not a known built-in. The auditor inherits the resolved model in-process, so this usually works — but if audits error with auth/provider failures, choose an explicit auditor model in /glla settings.`, 
      "info",
    );
  } catch {
    // non-fatal by design
  }
}

function warnOnCommandCollision(ctx: ExtensionContext): void {
  if (collisionWarned) return;
  collisionWarned = true;
  try {
    if (!flags.extensionApi) return;
    const counts = new Map<string, number>();
    for (const cmd of flags.extensionApi.getCommands() as any[]) {
      const name = String(cmd.invocationName ?? cmd.name ?? "").split(":")[0] ?? "";
      if (OUR_COMMANDS.includes(name)) {
        counts.set(name, (counts.get(name) ?? 0) + 1);
      }
    }
    const dupes = [...counts.entries()].filter(([, n]) => n > 1).map(([n]) => `/${n}`);
    if (dupes.length > 0) {
      const first = dupes[0] ?? "goal";
      ctx.ui.notify(
        `pi-goal-list-loop-audit: command collision on ${dupes.join(", ")}. Another extension registered the same name; ours may be reachable as /${first.slice(1)}:2. Consider disabling the other plugin.`,
        "warning",
      );
    }
  } catch {
    // getCommands unavailable or shape changed — stay silent, collision is non-fatal.
  }
}

// =================================================================
// Public extension entry
// =================================================================
// Model-switch ledger (v0.34.57 — bug #1.14)
// =================================================================

/** v0.34.57: model-switch ledger + forbidden-model gate. Writes the
 * `model_switch` entry for every real provider/model change (the
 * model_select event OR turn-boundary drift), and the
 * `forbidden_model_switch` violation entry when the target is forbidden.
 * Returns true when the switch was BLOCKED (the caller holds the previous
 * Model object and should revert it).
 *
 * Blocking is skipped while the plugin's own recovery rotation is in
 * flight (mainModelSwitchInFlight — that path is the AUTHORIZED switch
 * channel; reverting it would wedge recovery against itself) and never
 * applies to turn-boundary drift (the turn already started — detection
 * and the violation record are the honest actions there). The violation
 * entry always lands either way. */

/* ------------------------------------------------------------------ */
/* ------------------------------------------------------------------ */
/* Registration surface.                                               */
/* ------------------------------------------------------------------ */

export {
  addSingleItem,
  autoNotifyCmd,
  cmdGoal,
  cmdList,
  cmdReview,
  cmdReviewerSettings,
  cmdSettings,
  enqueueItems,
  maybeDecisionPopup,
  probeAutoNotify,
  recentlyCompletedObjectives,
  warnIfAuditorProviderRisky,
  warnOnCommandCollision,
};
