/**
 * goal-loop.ts — Loop 3 machinery: /loop command, tick engine, git finish.
 *
 * Decomposition step 2 (v0.34.110): extracted from extensions/loops/goal.ts.
 * - ZERO behavior change: moved bodies are byte-identical except module-level
 *   flag references rewritten to `flags.<name>` accessors.
 * - One-way imports: this module never imports from goal.ts or goal-commands.ts.
 * - Module-level mutable state owned here: loopTimer (the single loop tick
 *   timer handle). goal.ts observes it through loopTimerPending().
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionContext, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { state, replaceState } from "./goal-state.js";
import {
  appendLedger,
  clearLoadHold,
  formatMainModelRecoveryStatus,
  isStaleApiError,
  ledgerPath,
  nowIso,
  resolveEffectiveAggressiveSettings,
  sumNewAssistantTokens,
  supervisorPaused,
} from "./goal-loop-core.js";
import { BACKOFF_IDLE_RETRY_MS, MEASURE_TIMEOUT_MS } from "./goal-loop-backoff.js";
import {
  REPETITION,
  continueVariant,
  isActuallyStuck,
  loopInterventionDirective,
  textFingerprint,
  pushCapped,
} from "./goal-loop-repetition.js";
import {
  AUDIT_FINDINGS_REL,
  AUDIT_PLATEAU_MAX_REPRIEVES,
  GOAL_AUDIT_ONESHOT_MARKER,
  HELD_ON_RESTORE,
  LoopState,
  LoopTickOutcome,
  applyMeasurement,
  applyMetriclessTick,
  auditMeasureCmd,
  auditTarget,
  countCheckedSpecItems,
  countOpenAuditFindings,
  loopBranchName,
  loopFinishStopReason,
  parseLoopStartArgs,
  parseMetric,
  resolveSpecFiles,
  respecTarget,
  specFileHash,
  topOpenAuditFinding,
  LOOP_DEFAULTS,
} from "./goal-loop-forever.js";
import { loadSettings } from "./goal-settings.js";
import { normalizeMainModelFallbackRefs } from "./main-model-recovery.js";
import { createContinuationDispatch, type ContinuationDispatch } from "./goal-loop-dispatch.js";
import { attemptFreshSessionRecovery } from "./goal-recovery.js";
import { chooseObjectiveConflict, liveObjectives } from "./goal-objective-conflict.js";

type DispatchInput = Omit<Parameters<typeof createContinuationDispatch>[0], "id" | "sentAt">;

/* ------------------------------------------------------------------ */
/* Deps contract: everything this module needs from its host.          */
/* ------------------------------------------------------------------ */

export interface LoopFlags {
  get extensionApi(): ExtensionAPI | null;
  set extensionApi(v: ExtensionAPI | null);
  get extensionApiStale(): boolean;
  set extensionApiStale(v: boolean);
  get sessionGeneration(): number;
  set sessionGeneration(v: number);
  get sessionHandoffPending(): boolean;
  set sessionHandoffPending(v: boolean);
  get initialSessionLoadPending(): boolean;
  set initialSessionLoadPending(v: boolean);
  get pendingContinuationDispatch(): ContinuationDispatch | null;
  set pendingContinuationDispatch(v: ContinuationDispatch | null);
  get continuationDispatchStoodDown(): boolean;
  set continuationDispatchStoodDown(v: boolean);
  get lastContinuationSentAt(): number;
  set lastContinuationSentAt(v: number);
  get lastContinuationSentPayload(): { content: string; display: boolean } | null;
  set lastContinuationSentPayload(v: { content: string; display: boolean } | null);
  get loopRearmSince(): number;
  set loopRearmSince(v: number);
  get loopRearmStreak(): number;
  set loopRearmStreak(v: number);
  get countedLoopTokenMessages(): Set<string>;
  set countedLoopTokenMessages(v: Set<string>);
  get mainModelAbortForRecovery(): boolean;
  set mainModelAbortForRecovery(v: boolean);
  get postCompactResyncPending(): boolean;
  set postCompactResyncPending(v: boolean);
  get staleTerminalDone(): boolean;
  set staleTerminalDone(v: boolean);
  get zombieStoodDown(): boolean;
  set zombieStoodDown(v: boolean);
}

export interface LoopDeps {
  flags: LoopFlags;
  GOAL_EVENT_ENTRY: string;
  accountSendRearm: (ctx: ExtensionContext, kind: "continuation" | "loop") => void;
  armQueueStuckProbe: (sentAt: number) => void;
  buildPostCompactResync: () => string;
  clearMainModelRecoveryTimer: () => void;
  dispatchAccepted: (ctx: ExtensionContext, record: ContinuationDispatch) => boolean;
  dispatchFailed: (ctx: ExtensionContext, record: ContinuationDispatch, reason: string) => void;
  dispatchPrepare: (ctx: ExtensionContext, input: DispatchInput) => ContinuationDispatch | null;
  displaySlice: (s: string, max: number) => string;
  freshCtx: () => ExtensionContext | null;
  freshCtxForGeneration: (generation: number) => ExtensionContext | null;
  goStaleTerminal: (ctx: ExtensionContext, where: string) => void;
  mainModelRecoveryActive: () => boolean;
  manuallyResumeMainModelRecovery: (ctx: ExtensionContext) => boolean;
  notifyExternal: (ctx: ExtensionContext, message: string) => void;
  persistState: (ctx: ExtensionContext) => void;
  probeExtensionApiStale: () => boolean;
  probeMainModelRecovery: (ctx: ExtensionContext) => Promise<void>;
  releaseContinuationDispatchStandDown: () => void;
  releaseInitialSessionLoadBarrier: () => void;
  rememberCtx: (ctx: ExtensionContext) => void;
  resolveCarryover: (ctx: ExtensionContext, trigger: "goal" | "loop" | "list") => void;
  scheduleSessionTimeout: (callback: () => void, delayMs: number) => NodeJS.Timeout;
  sendContinuation: (goalId: string) => void;
  sendRearmDelayMs: (streak: number) => number;
  sessionManagerId: (ctx: ExtensionContext) => string;
  startDrafting: (ctx: ExtensionContext, target: "goal" | "list" | "loop", seed?: string, depth?: "normal" | "plan") => Promise<boolean>;
  activeGoalSurfaceCommand: (command: string) => string;
  archiveCurrentGoal: (ctx: ExtensionContext, status: "aborted", stopReason?: string) => boolean;
}

let deps: LoopDeps;

function formatLoopRecoveryStatusLines(ctx: ExtensionContext): string[] {
  return formatMainModelRecoveryStatus(
    state.mainModelRecovery,
    normalizeMainModelFallbackRefs(loadSettings(ctx.cwd).mainModelFallbacks),
  );
}

function formatLoopRecoveryStatus(ctx: ExtensionContext): string {
  const loop = state.loop;
  const lines = [
    `Loop: ${loop?.active ? "active" : "stopped"} — ${loop ? deps.displaySlice(loop.target, 80) : "loop parked during main-model recovery"}`,
    ...formatLoopRecoveryStatusLines(ctx),
    "Resume: /loop resume retries the saved loop recovery; /loop stop drops it.",
  ];
  return lines.join("\n");
}
let flags: LoopFlags;
let GOAL_EVENT_ENTRY: string;
let accountSendRearm: LoopDeps["accountSendRearm"], armQueueStuckProbe: LoopDeps["armQueueStuckProbe"], buildPostCompactResync: LoopDeps["buildPostCompactResync"], clearMainModelRecoveryTimer: LoopDeps["clearMainModelRecoveryTimer"], dispatchAccepted: LoopDeps["dispatchAccepted"],
    dispatchFailed: LoopDeps["dispatchFailed"], dispatchPrepare: LoopDeps["dispatchPrepare"], displaySlice: LoopDeps["displaySlice"], freshCtx: LoopDeps["freshCtx"], freshCtxForGeneration: LoopDeps["freshCtxForGeneration"],
    goStaleTerminal: LoopDeps["goStaleTerminal"], mainModelRecoveryActive: LoopDeps["mainModelRecoveryActive"], manuallyResumeMainModelRecovery: LoopDeps["manuallyResumeMainModelRecovery"], notifyExternal: LoopDeps["notifyExternal"], persistState: LoopDeps["persistState"],
    probeExtensionApiStale: LoopDeps["probeExtensionApiStale"], probeMainModelRecovery: LoopDeps["probeMainModelRecovery"], releaseContinuationDispatchStandDown: LoopDeps["releaseContinuationDispatchStandDown"], releaseInitialSessionLoadBarrier: LoopDeps["releaseInitialSessionLoadBarrier"], rememberCtx: LoopDeps["rememberCtx"],
    resolveCarryover: LoopDeps["resolveCarryover"], scheduleSessionTimeout: LoopDeps["scheduleSessionTimeout"], sendContinuation: LoopDeps["sendContinuation"], sendRearmDelayMs: LoopDeps["sendRearmDelayMs"], sessionManagerId: LoopDeps["sessionManagerId"],
    startDrafting: LoopDeps["startDrafting"], activeGoalSurfaceCommand: LoopDeps["activeGoalSurfaceCommand"], archiveCurrentGoal: LoopDeps["archiveCurrentGoal"];

export function createGoalLoop(d: LoopDeps): void {
  deps = d; flags = d.flags; GOAL_EVENT_ENTRY = d.GOAL_EVENT_ENTRY;
  accountSendRearm = d.accountSendRearm; armQueueStuckProbe = d.armQueueStuckProbe; buildPostCompactResync = d.buildPostCompactResync; clearMainModelRecoveryTimer = d.clearMainModelRecoveryTimer; dispatchAccepted = d.dispatchAccepted;
  dispatchFailed = d.dispatchFailed; dispatchPrepare = d.dispatchPrepare; displaySlice = d.displaySlice; freshCtx = d.freshCtx; freshCtxForGeneration = d.freshCtxForGeneration;
  goStaleTerminal = d.goStaleTerminal; mainModelRecoveryActive = d.mainModelRecoveryActive; manuallyResumeMainModelRecovery = d.manuallyResumeMainModelRecovery; notifyExternal = d.notifyExternal; persistState = d.persistState;
  probeExtensionApiStale = d.probeExtensionApiStale; probeMainModelRecovery = d.probeMainModelRecovery; releaseContinuationDispatchStandDown = d.releaseContinuationDispatchStandDown; releaseInitialSessionLoadBarrier = d.releaseInitialSessionLoadBarrier; rememberCtx = d.rememberCtx;
  resolveCarryover = d.resolveCarryover; scheduleSessionTimeout = d.scheduleSessionTimeout; sendContinuation = d.sendContinuation; sendRearmDelayMs = d.sendRearmDelayMs; sessionManagerId = d.sessionManagerId;
  startDrafting = d.startDrafting; activeGoalSurfaceCommand = d.activeGoalSurfaceCommand; archiveCurrentGoal = d.archiveCurrentGoal;
}

/* ------------------------------------------------------------------ */
/* Moved body (band b2 from goal.ts).                                  */
/* ------------------------------------------------------------------ */

// cap, or /loop stop. There is NO auditor in loop 3 — the metric is the
// verdict.
// =================================================================

let loopTimer: NodeJS.Timeout | null = null;

function clearLoopTimer(): void {
  if (loopTimer) {
    clearTimeout(loopTimer);
    loopTimer = null;
  }
}

function isLoopActive(): boolean {
  return !!state.loop?.active;
}

async function resolveLoopStartConflict(ctx: ExtensionContext, target: string): Promise<boolean> {
  const current = liveObjectives(state);
  if (current.length === 0) return true;
  const choice = await chooseObjectiveConflict(ctx, "loop", target, current);
  if (choice === "cancel") {
    ctx.ui.notify("New loop cancelled; the current objective is unchanged.", "info");
    return false;
  }
  if (choice === "update") {
    if (current.length === 1 && current[0]!.kind === "loop" && state.loop?.active) {
      state.loop = { ...state.loop, refineHint: target };
      persistState(ctx);
      appendLedger(ctx.cwd, "loop_refine_hint", { iteration: state.loop.iteration, hint: target.slice(0, 300), via: "active-start-conflict" });
      ctx.ui.notify("Update selected — the current loop will use this refinement hint; no second loop was started.", "info");
    } else {
      ctx.ui.notify("Update selected, but this cross-mode start has no safe in-place loop edit. No replacement was started.", "info");
    }
    return false;
  }
  for (const item of current) {
    if (item.kind === "loop" && isLoopActive()) {
      await cmdLoop("stop", ctx);
    } else if (item.kind !== "loop" && state.goal && ["active", "paused", "auditing"].includes(state.goal.status)) {
      if (!archiveCurrentGoal(ctx, "aborted", `replaced by new loop objective`)) return false;
    }
  }
  return true;
}

/** Run the user's measure command. Orchestrator-side, never agent-side. */
async function runMeasure(ctx: ExtensionContext, cmd: string): Promise<number | null> {
  if (!flags.extensionApi || flags.extensionApiStale) return null;
  try {
    const result = await flags.extensionApi.exec("bash", ["-c", cmd], { cwd: ctx.cwd, timeout: MEASURE_TIMEOUT_MS });
    const stdout = (result as any)?.stdout ?? "";
    return parseMetric(String(stdout));
  } catch {
    return null;
  }
}

/** git wrapper for branch=1 mode. Returns {ok, stdout}; never throws. */
async function runGit(ctx: ExtensionContext, args: string[]): Promise<{ ok: boolean; stdout: string }> {
  if (!flags.extensionApi) return { ok: false, stdout: "" };
  try {
    const result = await flags.extensionApi.exec("git", args, { cwd: ctx.cwd });
    const r = result as any;
    const code = typeof r?.code === "number" ? r.code : (r?.exitCode ?? 1);
    return { ok: code === 0, stdout: String(r?.stdout ?? "").trim() };
  } catch {
    return { ok: false, stdout: "" };
  }
}

function loopPrompt(loop: LoopState, regressionNote: string, strategyNote: string, boundsNote: string, interventionNote = "", variantNote = "", hypothesisNote = "", refineHintNote = ""): string {
  // v0.23.0: metricless loops get their own prompt — no metric section,
  // anti-doorknob rules instead of anti-gaming rules.
  const metricless = !loop.measureCmd;
  const tmplPath = path.resolve(__dirname, "..", "..", "prompts", metricless ? "goal-loop-forever-metricless.md" : "goal-loop-forever.md");
  let tmpl: string;
  try {
    tmpl = fs.readFileSync(tmplPath, "utf-8");
  } catch {
    tmpl = metricless
      ? `[LOOP ITERATION ${loop.iteration + 1}] Target: ${loop.target}. Metricless spec loop — make ONE real, inspectable change advancing the target. No cosmetic churn. ${variantNote} ${interventionNote}`
      : `[LOOP ITERATION ${loop.iteration + 1}] Target: ${loop.target}. Measure: ${loop.measureCmd} (${loop.direction}). Make ONE small change to improve the metric. ${interventionNote}`;
  }
  return tmpl
    .replace(/\$\{ITERATION\}/g, String(loop.iteration + 1))
    .replace(/\$\{TARGET\}/g, loop.target)
    .replace(/\$\{MEASURE_CMD\}/g, loop.measureCmd ?? "none")
    .replace(/\$\{DIRECTION\}/g, loop.direction ?? "none")
    .replace(/\$\{DIRECTION_WORD\}/g, loop.direction === "min" ? "lower is better" : "higher is better")
    .replace(/\$\{LAST_VALUE\}/g, loop.lastValue === null ? "(none yet)" : String(loop.lastValue))
    .replace(/\$\{BEST_VALUE\}/g, loop.bestValue === null ? "(none yet)" : String(loop.bestValue))
    .replace(/\$\{STALL_COUNT\}/g, String(loop.stallCount))
    .replace(/\$\{PLATEAU_WINDOW\}/g, String(loop.plateauWindow))
    .replace(/\$\{REGRESSION_NOTE\}/g, regressionNote)
    .replace(/\$\{STRATEGY_NOTE\}/g, strategyNote)
    .replace(/\$\{BOUNDS_NOTE\}/g, boundsNote)
    .replace(/\$\{INTERVENTION_NOTE\}/g, interventionNote)
    .replace(/\$\{VARIANT_NOTE\}/g, variantNote)
    .replace(/\$\{HYPOTHESIS_NOTE\}/g, hypothesisNote)
    .replace(/\$\{REFINE_HINT\}/g, refineHintNote);
}

function scheduleLoopTick(ctx: ExtensionContext): void {
  // v0.35.15: `/glla pause` freezes loop re-arms too — the supervisor's
  // automatic machinery includes the metric loop's turn dispatch.
  if (supervisorPaused(state)) return;
  if (mainModelRecoveryActive()) return;
  if (flags.sessionHandoffPending || flags.initialSessionLoadPending || flags.extensionApiStale || flags.staleTerminalDone || flags.zombieStoodDown || flags.continuationDispatchStoodDown || flags.pendingContinuationDispatch || !isLoopActive()) return;
  rememberCtx(ctx);
  clearLoopTimer();
  let delay = 0;
  try {
    delay = ctx.isIdle() && !ctx.hasPendingMessages() ? 0 : BACKOFF_IDLE_RETRY_MS;
  } catch {
    return;
  }
  loopTimer = scheduleSessionTimeout(() => sendLoopTurn(), delay);
}

function sendLoopTurn(): void {
  // v0.35.15: same as sendContinuation — pre-pause loop timers must not
  // dispatch turns while the supervisor is frozen.
  if (supervisorPaused(state)) return;
  if (mainModelRecoveryActive()) return;
  if (flags.sessionHandoffPending || flags.initialSessionLoadPending || flags.extensionApiStale || flags.staleTerminalDone || flags.zombieStoodDown || flags.continuationDispatchStoodDown || flags.pendingContinuationDispatch) return;
  loopTimer = null;
  if (!isLoopActive() || !flags.extensionApi) return;
  const ctx = freshCtx();
  if (!ctx || !ctx.isIdle() || ctx.hasPendingMessages()) {
    if (!ctx) {
      // v0.33.1: mirror sendContinuation — probe the handle (terminal exit)
      // and advance the streak so the cadence backs off instead of spinning
      // a flat 50ms below every watchdog.
      if (probeExtensionApiStale()) return;
      flags.loopRearmStreak++;
    } else accountSendRearm(ctx, "loop");
    loopTimer = scheduleSessionTimeout(() => sendLoopTurn(), sendRearmDelayMs(flags.loopRearmStreak)); // v0.28.29: backing-off cadence
    return;
  }
  const loop = state.loop!;
  // v0.29.10: "regressed" = the last two measurements moved the WRONG way
  // — not merely "didn't beat best". The old trigger (any non-improving
  // iteration) cried REGRESSED on stalls and on the audit loop's
  // degenerate baseline-0, telling agents to undo GOOD fixes (junk-runner
  // 2026-07-30: 17→16 was real progress; the prompt demanded a revert).
  const hist = loop.history;
  const prevValue = hist.length >= 2 ? hist[hist.length - 2]!.value : null;
  const lastHistValue = hist.length >= 1 ? hist[hist.length - 1]!.value : null;
  const trueRegression = prevValue !== null && lastHistValue !== null && loop.direction !== undefined &&
    (loop.direction === "min" ? lastHistValue > prevValue : lastHistValue < prevValue);
  const regressionNote = trueRegression
    ? loop.kind === "audit"
      ? "**The closed-findings count went DOWN last iteration — a checked finding was reopened or findings.md was rewritten (both forbidden). Restore the closed entries, then keep fixing the highest-severity OPEN items.**"
      : "**Your last change REGRESSED the metric. Undo it first, then try a different small change.**"
    : "";
  // Strategy rotation (from pi-loop-mode's one good idea): one stall before
  // the plateau window closes, stop polishing and change approach entirely.
  const strategyNote = loop.stallCount >= loop.plateauWindow - 1 && loop.stallCount > 0
    ? "**You are one stall from a plateau stop. Small tweaks are not working — try a FUNDAMENTALLY different approach: different file, different technique, or revert and rethink the angle of attack.**" +
      // v0.33.2: a metric flat AT BEST may mean the spec stopped capturing
      // "better" — the loop holds the evidence, so it says so (was: the
      // prompt said "call propose_loop_refine" but the loop never suggested it).
      (loop.lastValue !== null && loop.lastValue === loop.bestValue
        ? " **The metric has been flat at best — if the spec no longer captures 'better' (saturated metric, drifted target), call propose_loop_refine.**"
        : "")
    : "";
  // v0.34.0: divergence bail (pi-auto-review's one good idea) — N consecutive
  // iterations moving the metric the WRONG way means the changes themselves
  // are hurting (audit loops: fixes breaking things / findings reopening).
  // Note-only: the agent reassesses; nothing auto-stops.
  let trailingRegressions = 0;
  if (loop.direction) {
    for (let i = hist.length - 1; i > 0; i--) {
      const a = hist[i - 1]!.value, b = hist[i]!.value;
      if (a === null || b === null) break; // metricless ticks carry no value
      const regressed = loop.direction === "min" ? b > a : b < a;
      if (regressed) trailingRegressions++; else break;
    }
  }
  const divergenceNote = trailingRegressions >= 3
    ? `**${trailingRegressions} consecutive regressions — every recent change moved the metric the WRONG way. Stop making small edits and reassess the whole approach: are the fixes breaking things, or is the measure being gamed? If the target itself is drifting, call propose_loop_refine or recommend /loop stop.**`
    : "";
  const strategyNote2 = strategyNote + (strategyNote && divergenceNote ? " " : "") + divergenceNote;
  // v0.15.0: arbitrary bounds (never "completion") — surface what's armed.
  // v0.23.0: for metricless loops the bounds are the ONLY stop (no
  // plateau), so the note names that — and an unbounded metricless loop
  // gets the furnace warning.
  const metricless = !loop.measureCmd;
  const bounds: string[] = [];
  if (loop.timeLimitHours !== undefined) bounds.push(`${loop.timeLimitHours}h`);
  if (loop.tokenBudget !== undefined) bounds.push(`${loop.tokenBudget.toLocaleString()} tokens (used ${(loop.tokensUsed ?? 0).toLocaleString()})`);
  let boundsNote = "";
  if (metricless) {
    if (loop.maxIterations > 0) bounds.unshift(`${loop.maxIterations} iterations`);
    boundsNote = bounds.length
      ? `\n- Bounds armed: the loop ends after ${bounds.join(" or ")} — or /loop stop. There is NO plateau stop.`
      : `\n- NO bounds armed — this loop ends only at /loop stop. Spend each iteration like it costs money; it does.`;
  } else if (bounds.length) {
    boundsNote = `\n- Arbitrary bounds: the loop also stops after ${bounds.join(" or ")}`;
  }
  // v0.24.0: a stuck intervention REPLACES the pep talk — the rotating
  // directive names why the loop is stuck and what rung of the ladder it's on.
  // v0.29.19: a plateau reprieve's one-shot shove takes priority over the
  // stuck directive (they can't both be meaningful in the same iteration).
  const reprieveNote = loop.auditReprieveNote ?? "";
  if (reprieveNote) loop.auditReprieveNote = undefined;
  const interventionNote = reprieveNote || ((loop.consecutiveStuck ?? 0) > 0 && loop.lastStuckReason
    ? loopInterventionDirective(loop.consecutiveStuck!, loop.lastStuckReason, loop.recentTexts ?? [])
    : "");
  // v0.24.0: identical prompts invite identical answers — rotate the base
  // instruction (metricless loops; metric loops already vary via values).
  const variantNote = metricless ? continueVariant(loop.iteration) : "";
  // v0.33.2: one-shot prompt payloads, consumed on use.
  const hypothesisNote = loop.hypothesisFeedback ?? "";
  if (hypothesisNote) loop.hypothesisFeedback = undefined;
  const refineHintNote = loop.refineHint
    ? `**The operator suggests refining the spec:** ${loop.refineHint} — if the current spec no longer captures "better", call propose_loop_refine (target and/or measureCmd${loop.specFile ? " and/or specText/specAppend" : ""}); if it still stands, say why in one line and keep working.`
    : "";
  if (refineHintNote) loop.refineHint = undefined;
  try {
    let loopResync = "";
    if (flags.postCompactResyncPending) { try { loopResync = buildPostCompactResync(); } catch { loopResync = ""; } } // v0.33.1
    const attempt = dispatchPrepare(ctx, {
      generation: flags.sessionGeneration,
      ownerSessionId: sessionManagerId(ctx),
      kind: "loop",
      iteration: loop.iteration + 1,
      marker: `[LOOP ITERATION ${loop.iteration + 1}]`,
      resync: Boolean(loopResync),
    });
    if (!attempt) return;
    flags.extensionApi.sendMessage({
      customType: GOAL_EVENT_ENTRY,
      content: loopResync + loopPrompt(loop, regressionNote, strategyNote2, boundsNote, interventionNote, variantNote, hypothesisNote, refineHintNote),
      display: false,
    }, { triggerTurn: true, deliverAs: "followUp" });
    flags.lastContinuationSentPayload = { content: loopResync + loopPrompt(loop, regressionNote, strategyNote2, boundsNote, interventionNote, variantNote, hypothesisNote, refineHintNote), display: false }; // v0.34.88: verbatim retry payload
    if (!dispatchAccepted(ctx, attempt)) return;
    // v0.26.1: the send path is ledgered — the hegemon zombie spun 619
    // refires with zero visibility into whether sends were landing.
    flags.loopRearmStreak = 0; flags.loopRearmSince = 0; // v0.28.5 (E3): an accepted dispatch clears the storm
    appendLedger(ctx.cwd, "loop_turn_sent", { iteration: loop.iteration, attemptId: attempt.id, generation: attempt.generation });
    if (flags.pendingContinuationDispatch === null) return; // before_agent_start acked synchronously
    flags.lastContinuationSentAt = attempt.sentAt;
    armQueueStuckProbe(flags.lastContinuationSentAt);
  } catch (err) {
    // stale API — next agent_end reschedules (but if none comes, the
    // heartbeat's stall escalation stops the spin — v0.26.1).
    if (flags.pendingContinuationDispatch) dispatchFailed(ctx, flags.pendingContinuationDispatch, err instanceof Error ? err.message : String(err));
    appendLedger(ctx.cwd, "loop_turn_send_failed", { error: err instanceof Error ? err.message : String(err) });
    // v0.26.7: stale runtime is terminal, not transient — go loud now.
    if (isStaleApiError(err)) {
      if (!attemptFreshSessionRecovery(ctx, "sendLoopTurn")) goStaleTerminal(ctx, "sendLoopTurn");
    }
  }
}

/** agent_end hook for loop 3: measure → judge → continue or stop. */
async function runLoopTick(initialCtx: ExtensionContext, event?: any): Promise<void> {
  // v0.34.20: measurement/git work is asynchronous. Rebind the local
  // context after every await or abandon the tick; never let a replacement
  // session inherit the agent_end context.
  const generation = flags.sessionGeneration;
  const initial = freshCtxForGeneration(generation);
  if (!initial) return;
  let ctx: ExtensionContext = initial;
  const rebind = (): boolean => {
    const current = freshCtxForGeneration(generation);
    if (!current) return false;
    ctx = current;
    return true;
  };
  let loop = state.loop!;
  // v0.35.4: a concurrent /loop stop / pause / main-model park / resume /
  // refine replaces state.loop with a NEW object ({...state.loop, ...} spread
  // sites) while this tick is parked on a long await (runMeasure can take
  // minutes). Mutations on the captured object never reach the durable record
  // (persistState saves the LIVE state.loop), and finishLoopGit would git
  // reset/checkout against the wrong run. Abandon the tick when the loop
  // object was replaced by something missing/inactive; rebind only to a
  // replacement that is still ACTIVE (e.g. refineHint), so this iteration's
  // measurement stays attachable to the live run.
  const rebindLoop = (): boolean => {
    if (!rebind()) return false;
    if (state.loop === loop) return true;
    const replaced = state.loop;
    if (replaced && replaced.active) {
      loop = replaced;
      return true;
    }
    appendLedger(ctx.cwd, "loop_tick_abandoned", {
      iteration: loop.iteration,
      reason: replaced ? "loop object replaced mid-tick (inactive)" : "loop removed mid-tick",
    });
    return false;
  };
  // v0.15.0: token budget is an arbitrary bound; accumulate orchestrator-side.
  if (event?.messages) {
    loop.tokensUsed = (loop.tokensUsed ?? 0) + sumNewAssistantTokens(event.messages as unknown[], flags.countedLoopTokenMessages);
  }
  const metricless = !loop.measureCmd;
  const value = metricless ? null : await runMeasure(ctx, loop.measureCmd!);
  if (!rebindLoop()) return;
  // Hypothesis line (pi-autoresearch's good idea): the agent's stated intent
  // for the turn goes into the ledger, making loop history auditable.
  let hypothesis: string | undefined;
  let lastAssistantText = "";
  if (event) {
    const last = [...(event.messages as any[])].reverse().find((m) => m.role === "assistant");
    lastAssistantText = last && Array.isArray(last.content) ? last.content.filter((p: any) => p.type === "text").map((p: any) => p.text).join("\n") : "";
    hypothesis = lastAssistantText.match(/^HYPOTHESIS:\s*(.+)$/m)?.[1]?.trim().slice(0, 200);
  }
  // v0.24.0 anti-repetition: roll the behavior windows, then classify. The
  // plateau stop watches the NUMBER; this watches the WORK — a metricless
  // loop (no number) has no other defense against doorknob-polishing.
  const toolsUsed = loop.toolsThisTurn ?? 0;
  loop.toolsThisTurn = 0;
  loop.toollessStreak = toolsUsed === 0 ? (loop.toollessStreak ?? 0) + 1 : 0;
  // v0.25.1 multi-signal stuck gate: gather the iteration's progress
  // signals BEFORE classifying — file writes (tool_result bumps), git
  // commits since the iteration began (HEAD advance), spec_item_progress
  // ledger events since the iteration began. ANY positive signal exempts
  // the iteration: stable verification from a shipping loop is the goal
  // state of a metricless loop, not the stuck state.
  const iterStartHead = loop.iterMetrics?.iterationStartHead;
  const iterStartAt = loop.iterMetrics?.iterationStartAt;
  const currentHeadRes = await runGit(ctx, ["rev-parse", "HEAD"]);
  if (!rebindLoop()) return;
  const currentHead = currentHeadRes.ok ? currentHeadRes.stdout : undefined;
  let gitCommits = 0;
  if (iterStartHead && currentHead && iterStartHead !== currentHead) {
    const countRes = await runGit(ctx, ["rev-list", "--count", `${iterStartHead}..HEAD`]);
    if (!rebindLoop()) return;
    const n = Number.parseInt(countRes.stdout, 10);
    if (countRes.ok && Number.isFinite(n) && n > 0) gitCommits = n;
  }
  let specItemProgress = 0;
  if (iterStartAt) {
    try {
      const p = ledgerPath(ctx.cwd);
      const lines = fs.readFileSync(p, "utf-8").split("\n");
      for (const line of lines) {
        if (!line.includes("spec_item_progress")) continue;
        try {
          const entry = JSON.parse(line) as { at?: string };
          if (entry.at && entry.at >= iterStartAt) specItemProgress++;
        } catch { /* malformed line */ }
      }
    } catch { /* no ledger yet */ }
  }
  // v0.33.2: respec spec drift + checkbox progress — hash compared per
  // tick (external edits ledger spec_updated); newly checked boxes emit
  // the spec_item_progress signal the stuck gate already consumes (it was
  // consumed-but-never-emitted until now).
  if (loop.specFile) {
    const hash = specFileHash(loop.specFile);
    if (hash && loop.specHash && loop.specHash !== hash) {
      appendLedger(ctx.cwd, "spec_updated", { via: "external", iteration: loop.iteration });
      ctx.ui.notify("Spec file changed mid-loop — drift ledgered (spec_updated).", "info");
    }
    if (hash) loop.specHash = hash;
    const checked = countCheckedSpecItems(loop.specFile);
    if (checked !== null && loop.specChecked !== undefined && checked > loop.specChecked) {
      appendLedger(ctx.cwd, "spec_item_progress", { iteration: loop.iteration, newlyChecked: checked - loop.specChecked, totalChecked: checked });
    }
    if (checked !== null) loop.specChecked = checked;
  }
  const iterSignals = {
    fileWrites: loop.iterMetrics?.fileWrites ?? 0,
    gitCommits,
    specItemProgress,
    currentHead,
  };
  const previousText = loop.recentTexts && loop.recentTexts.length > 0 ? loop.recentTexts[loop.recentTexts.length - 1] : undefined;
  if (lastAssistantText) {
    loop.recentPrints = pushCapped(loop.recentPrints ?? [], textFingerprint(lastAssistantText), REPETITION.printWindow);
    loop.recentTexts = pushCapped(loop.recentTexts ?? [], lastAssistantText, REPETITION.textWindow);
  }
  const stuckReason = isActuallyStuck({
    assistantText: lastAssistantText,
    recentPrints: loop.recentPrints ?? [],
    previousText,
    recentToolResults: loop.recentToolResults ?? [],
    toollessStreak: loop.toollessStreak ?? 0,
    fileWriteCount: iterSignals.fileWrites,
    gitCommitCount: iterSignals.gitCommits,
    specItemProgressCount: iterSignals.specItemProgress,
  }, loop.toolSameRepeat);
  // Reset the accumulators so the NEXT iteration measures only itself.
  loop.iterMetrics = {
    fileWrites: 0,
    iterationStartHead: iterSignals.currentHead ?? loop.iterMetrics?.iterationStartHead,
    iterationStartAt: nowIso(),
  };
  if (stuckReason) {
    loop.consecutiveStuck = (loop.consecutiveStuck ?? 0) + 1;
    loop.lastStuckReason = stuckReason;
    appendLedger(ctx.cwd, "loop_stuck", { iteration: loop.iteration, reason: stuckReason, consecutive: loop.consecutiveStuck });
    if (loop.consecutiveStuck === 1 || loop.consecutiveStuck >= REPETITION.hardResetAfter) {
      ctx.ui.notify(`Loop stuck (${loop.consecutiveStuck}×): ${stuckReason}`, "warning");
    }
  } else {
    loop.consecutiveStuck = 0;
    loop.lastStuckReason = undefined;
  }
  let outcome: LoopTickOutcome = metricless ? applyMetriclessTick(loop, nowIso()) : applyMeasurement(loop, value, nowIso());
  // v0.33.2: close the hypothesis feedback loop — the prediction went into
  // the ledger; now the VERDICT rides the next iteration's prompt.
  if (loop.lastHypothesis) {
    const h = loop.history;
    const cur = h.length >= 1 ? h[h.length - 1]!.value : null;
    const prev = h.length >= 2 ? h[h.length - 2]!.value : null;
    if (metricless || cur === null) {
      loop.hypothesisFeedback = `Last iteration you predicted: "${loop.lastHypothesis}". ${metricless ? "Metricless loop — no number to verify it against; say honestly whether the prediction landed." : "The measure printed no number — the prediction is unverifiable."}`;
    } else {
      const moved = prev === null
        ? `first measurement ${cur}`
        : cur === prev
          ? `flat at ${cur}`
          : loop.direction === "min"
            ? (cur < prev ? `improved ${prev} → ${cur}` : `regressed ${prev} → ${cur}`)
            : (cur > prev ? `improved ${prev} → ${cur}` : `regressed ${prev} → ${cur}`);
      loop.hypothesisFeedback = `Last iteration you predicted: "${loop.lastHypothesis}". Result: metric ${moved} (best ${loop.bestValue}).`;
    }
  }
  loop.lastHypothesis = hypothesis;
  persistState(ctx);
  appendLedger(ctx.cwd, "loop_measured", {
    iteration: loop.iteration,
    value,
    best: loop.bestValue,
    stall: loop.stallCount,
    hypothesis,
    stuck: stuckReason,
  });
  // branch=1 mode: commit improvements, hard-reset regressions — always and
  // only on the scratch branch. v0.23.0: a metricless loop has no regression
  // signal, so every iteration stands and is committed. v0.35.4: a FLAT
  // (tied-best) or NULL measure is NOT a regression (v0.29.10/E5 — null
  // carries no movement information), so only a genuine worse-than-best
  // value hard-resets; flat/null iterations keep their work in the tree
  // for the next tick (or the terminal commit below).
  if (loop.branchName && outcome.kind === "continue") {
    if (metricless || outcome.improved) {
      await runGit(ctx, ["add", "-A"]);
      if (!rebindLoop()) return;
      const committed = await runGit(ctx, ["commit", "-m", metricless ? `pi-glla-loop: iteration ${loop.iteration}` : `pi-glla-loop: iteration ${loop.iteration} (${loop.direction}=${loop.bestValue})`]);
      if (!rebindLoop()) return;
      appendLedger(ctx.cwd, "loop_git", { action: "commit", iteration: loop.iteration, ok: committed.ok });
    } else if (value !== null && value !== loop.bestValue) {
      const reset = await runGit(ctx, ["reset", "--hard", "HEAD"]);
      if (!rebindLoop()) return;
      appendLedger(ctx.cwd, "loop_git", { action: "reset", iteration: loop.iteration, ok: reset.ok });
    }
    persistState(ctx);
  }
  // v0.35.4: a terminal stop never destroys the last iteration's work.
  // The continue-gate above means plateau/bounds/stuck stops skipped the
  // commit; finishLoopGit's unconditional reset --hard then erased the
  // final iteration — including an IMPROVING one stopped by maxIterations.
  // Commit any pending diff before the git-finish so the scratch branch
  // carries the terminal iteration.
  const commitPendingTerminalWork = async (): Promise<void> => {
    if (!loop.branchName) return;
    const pending = await runGit(ctx, ["status", "--porcelain"]);
    if (!rebindLoop()) return;
    if (!pending.ok || pending.stdout.length === 0) return;
    await runGit(ctx, ["add", "-A"]);
    if (!rebindLoop()) return;
    const committed = await runGit(ctx, ["commit", "-m", `pi-glla-loop: iteration ${loop.iteration} (${loop.direction ?? "spec"}=${loop.bestValue ?? "n/a"})`]);
    if (!rebindLoop()) return;
    appendLedger(ctx.cwd, "loop_git", { action: "commit-terminal", iteration: loop.iteration, ok: committed.ok });
  };
  // v0.24.0: the top of the stuck ladder — bounded and surfaced, same
  // philosophy as a plateau stop. The loop ends WITH the reason, not in silence.
  // v0.25.0: aggressiveMode raises the ladder (default 5 → 10, explicit wins).
  const maxStuckInterventions = resolveEffectiveAggressiveSettings(loadSettings(ctx.cwd)).stuckMaxInterventions;
  if (outcome.kind !== "stop" && (loop.consecutiveStuck ?? 0) >= maxStuckInterventions) {
    loop.active = false;
    loop.stopReason = `stuck — ${loop.lastStuckReason} (${loop.consecutiveStuck} consecutive interventions)`;
    persistState(ctx);
    await commitPendingTerminalWork();
    await finishLoopGit(ctx, loop);
    if (!rebindLoop()) return;
    ctx.ui.notify(`Loop stopped: ${loop.stopReason}. ${loop.history.length} iterations recorded.`, "warning");
    appendLedger(ctx.cwd, "loop_stopped", { reason: loop.stopReason, iterations: loop.iteration, best: loop.bestValue });
    notifyExternal(ctx, `Loop stopped: ${loop.stopReason}`);
    // v0.35.41: same contract as every other stop route below — a stuck
    // ladder stop frees the surface, so the waiting queue is announced.
    announceQueuedListAfterLoopEnd(ctx);
    return;
  }
  if (outcome.kind === "stop") {
    // v0.29.19: an audit loop's plateau is only honest when the well is
    // ACTUALLY dry. Plateauing with open findings means the agent fumbled
    // (or the provider ate) N turns — not "nothing left" (field: hegemon
    // stopped at best 74 with 13 OPEN boxes; polis at best 46 with 3+).
    // Stand the stop down with a strategy shove — bounded: the plateau
    // after the last reprieve stops with an honest blocked-named reason.
    if (loop.kind === "audit" && outcome.reason.startsWith("plateau —")) {
      const open = countOpenAuditFindings(ctx.cwd);
      if (open > 0) {
        const reprieves = (loop.auditPlateauReprieves ?? 0) + 1;
        if (reprieves <= AUDIT_PLATEAU_MAX_REPRIEVES) {
          loop.active = true;
          loop.stopReason = undefined;
          loop.stallCount = 0;
          loop.auditPlateauReprieves = reprieves;
          const topFinding = topOpenAuditFinding(ctx.cwd); // v0.33.2: name what to close, not just the count
          loop.auditReprieveNote = `PLATEAU REPRIEVE (${reprieves}/${AUDIT_PLATEAU_MAX_REPRIEVES}): ${open} finding(s) still OPEN in ${AUDIT_FINDINGS_REL} — the plateau stop does not fire while the well isn't dry. Stop hunting and stop narrating: pick the smallest OPEN finding and CLOSE it this iteration (fix commit + checked box).${topFinding ? ` Top open: ${topFinding}` : ""} ${AUDIT_PLATEAU_MAX_REPRIEVES - reprieves} reprieve(s) remain.`;
          persistState(ctx);
          appendLedger(ctx.cwd, "audit_plateau_reprieve", { open, reprieves, best: loop.bestValue });
          ctx.ui.notify(`Audit loop plateau reprieve (${reprieves}/${AUDIT_PLATEAU_MAX_REPRIEVES}): ${open} open findings — the well isn't dry, continuing.`, "info");
          scheduleLoopTick(ctx);
          return;
        }
        const honest = `plateau — no closure in ${loop.plateauWindow}×${reprieves} iterations despite ${open} open findings (treat as blocked; /loop resume to push again)`;
        loop.stopReason = honest;
        persistState(ctx);
        outcome = { kind: "stop", reason: honest };
      }
    }
    await commitPendingTerminalWork();
    await finishLoopGit(ctx, loop);
    if (!rebindLoop()) return;
    ctx.ui.notify(`Loop stopped: ${outcome.reason}. ${loop.history.length} iterations recorded.`, "info");
    appendLedger(ctx.cwd, "loop_stopped", { reason: outcome.reason, iterations: loop.iteration, best: loop.bestValue });
    notifyExternal(ctx, `Loop stopped: ${outcome.reason}`);
    announceQueuedListAfterLoopEnd(ctx);
    return;
  }
  scheduleLoopTick(ctx);
}

/** v0.35.22 (note.md Next #3, field 2026-08-21): when a loop ends by ANY
 * route, a queued item that was blocked while the loop owned the surface
 * (field: the repair card behind a paused suspicious goal — the user was
 * told "/list next starts it" but it silently no-oped) is startable again.
 * We ANNOUNCE that loudly instead of auto-dispatching: /loop stop and
 * /glla cancel are stop gestures (v0.34.121: cancel must not touch an
 * unrelated waiting queue), so the surface frees up and says so — the user
 * (or the normal cascade) decides what runs. Never a dead SILENT entry. */
export function announceQueuedListAfterLoopEnd(ctx: ExtensionContext): void {
  if (state.goal && state.goal.status === "active") return;
  const waiting = state.list?.length ?? 0;
  if (waiting === 0) return;
  const head = state.list![0]!.objective.slice(0, 80);
  ctx.ui.notify(
    `The loop ended — ${waiting} queued list item${waiting === 1 ? "" : "s"} can start again (up next: "${head}"). /list next starts it.`,
    "info",
  );
}

/** On loop stop (any reason): return to the original branch, tell the user
 * where the work lives and how to merge it. Scratch branch is never deleted. */
async function finishLoopGit(ctx: ExtensionContext, loop: LoopState): Promise<void> {
  if (!loop.branchName) return;
  const generation = flags.sessionGeneration;
  // Uncommitted remnants (final stalled iterations were reset already, but be safe).
  await runGit(ctx, ["reset", "--hard", "HEAD"]);
  const afterReset = freshCtxForGeneration(generation);
  if (!afterReset) return;
  ctx = afterReset;
  if (loop.originalBranch) {
    await runGit(ctx, ["checkout", loop.originalBranch]);
    const afterCheckout = freshCtxForGeneration(generation);
    if (!afterCheckout) return;
    ctx = afterCheckout;
  }
  ctx.ui.notify(
    `Loop work is on branch ${loop.branchName} (${loop.iteration} iterations, best ${loop.bestValue ?? "n/a"}).\nMerge with: git merge ${loop.branchName} — or delete with: git branch -D ${loop.branchName}`,
    "info",
  );
  appendLedger(ctx.cwd, "loop_git", { action: "finish", branch: loop.branchName, returnedTo: loop.originalBranch });
}

interface LoopConfig {
  target: string;
  /** Empty string = metricless spec loop (v0.23.0). */
  measureCmd: string;
  direction?: "min" | "max";
  plateauWindow: number;
  maxIterations: number;
  branch: boolean;
  force?: boolean;
  timeLimitHours?: number;
  tokenBudget?: number;
  /** v0.25.1: /loop start toolsamerepeat=N (0 = disable legacy check). */
  toolSameRepeat?: number;
  /** v0.29.10: don't seed bestValue from the pre-work baseline measure —
   * the first REAL measurement becomes the baseline. For loops whose
   * metric is created BY the first iteration (the audit loop: 0 open
   * findings just means findings.md doesn't exist yet); a seeded 0 pins
   * best at a value no iteration can beat, stalling every iteration. */
  deferBaseline?: boolean;
  /** v0.29.10: audit loops get audit-flavoured regression wording. */
  kind?: "audit";
  /** v0.33.2: respec loops carry their spec file (drift detection,
   * checkbox progress, refine specText writes). */
  specFile?: string;
}

/** Shared loop-start path: /loop start AND propose_loop_draft (after Confirm). */
async function startLoopFromConfig(ctx: ExtensionContext, cfg: LoopConfig): Promise<boolean> {
  releaseInitialSessionLoadBarrier();
  // v0.35.23 (note.md Next #2): explicitly starting a loop is the decision
  // a load hold waits for — release it or the first tick would be frozen.
  if (clearLoadHold(state)) {
    persistState(ctx);
    appendLedger(ctx.cwd, "load_hold_released", { via: "loop-start" });
  }
  if (!(await resolveLoopStartConflict(ctx, cfg.target))) return false;
  const conflictIdsAtStart = liveObjectives(state).map((item) => item.id).sort().join(",");
  // branch=1 mode: scratch branch ONLY. Refuse on non-git or dirty tree —
  // we never mix uncommitted user work into the loop's branch.
  let branchName: string | undefined;
  let originalBranch: string | undefined;
  if (cfg.branch) {
    const isRepo = await runGit(ctx, ["rev-parse", "--is-inside-work-tree"]);
    if (!isRepo.ok) {
      ctx.ui.notify("branch=1 requires a git repository.", "warning");
      return false;
    }
    const dirty = await runGit(ctx, ["status", "--porcelain"]);
    if (!dirty.ok || dirty.stdout.length > 0) {
      ctx.ui.notify("branch=1 requires a clean working tree — commit or stash your changes first.", "warning");
      return false;
    }
    const current = await runGit(ctx, ["rev-parse", "--abbrev-ref", "HEAD"]);
    originalBranch = current.ok ? current.stdout : undefined;
    branchName = loopBranchName(nowIso(), cfg.target);
    const created = await runGit(ctx, ["checkout", "-b", branchName]);
    if (!created.ok) {
      ctx.ui.notify(`Failed to create scratch branch ${branchName}.`, "warning");
      return false;
    }
  }
  // v0.35.4: refusals AFTER the scratch-branch checkout must put the user
  // back on their original branch — nothing else remembers it (state.loop
  // is only created on success). The scratch branch is never deleted here:
  // the auto-commit daemon may have landed commits on it while the baseline
  // measure ran, and deleting it would discard them.
  const restoreOriginalBranch = async (): Promise<void> => {
    if (!branchName || !originalBranch) return;
    const back = await runGit(ctx, ["checkout", originalBranch]);
    if (!back.ok) {
      ctx.ui.notify(
        `Loop start refused AND the branch restore failed — you are still on scratch branch ${branchName} (the measure may have left uncommitted changes blocking checkout).`, "warning",
      );
    }
  };
  // Baseline measurement before the first agent turn. A measure that
  // produces no number is a footgun: without a baseline the loop burns stall
  // iterations before plateau stops it. Refuse fast (force=1 overrides for
  // measures that only work after the agent builds something first).
  // v0.23.0: metricless loops skip the baseline entirely — there is no
  // measure to run, and no plateau to protect.
  const metricless = !cfg.measureCmd;
  const baseline = metricless || cfg.deferBaseline ? null : await runMeasure(ctx, cfg.measureCmd);
  if (!metricless && !cfg.deferBaseline && baseline === null && !(cfg as { force?: boolean }).force) {
    ctx.ui.notify(
      `/loop start refused: the measure produced no number.\nCommand: ${cfg.measureCmd}\nFix it so it prints exactly one number, or re-run with force=1 if it only works after the agent builds something first.\n(Non-numeric goal — research, docs, features? Use /goal: the independent auditor verifies semantically. /loop only believes a number.)`,
      "warning",
    );
    await restoreOriginalBranch();
    return false;
  }
  const conflictIdsNow = liveObjectives(state).map((item) => item.id).sort().join(",");
  if (conflictIdsNow !== conflictIdsAtStart && !(await resolveLoopStartConflict(ctx, cfg.target))) {
    await restoreOriginalBranch();
    return false;
  }
  resolveCarryover(ctx, "loop"); // v0.28.14: surface/clear stale leftovers
  releaseContinuationDispatchStandDown();
  replaceState({
    ...state,
    loop: {
      target: cfg.target,
      measureCmd: cfg.measureCmd || undefined,
      direction: cfg.direction,
      iteration: 0,
      maxIterations: cfg.maxIterations,
      plateauWindow: cfg.plateauWindow,
      stallCount: 0,
      bestValue: cfg.deferBaseline ? null : baseline,
      lastValue: cfg.deferBaseline ? null : baseline,
      kind: cfg.kind,
      active: true,
      history: [],
      startedAt: nowIso(),
      timeLimitHours: cfg.timeLimitHours,
      tokenBudget: cfg.tokenBudget,
      tokensUsed: 0,
      branchName,
      originalBranch,
      toolSameRepeat: cfg.toolSameRepeat,
      specFile: cfg.specFile,
      specHash: cfg.specFile ? specFileHash(cfg.specFile) ?? undefined : undefined,
      specChecked: cfg.specFile ? countCheckedSpecItems(cfg.specFile) ?? undefined : undefined,
      iterMetrics: { fileWrites: 0, iterationStartAt: nowIso() },
    },
  });
  persistState(ctx);
  appendLedger(ctx.cwd, "loop_started", { target: cfg.target, measureCmd: cfg.measureCmd || "none", direction: cfg.direction ?? "none", baseline, branch: branchName, timeLimitHours: cfg.timeLimitHours, tokenBudget: cfg.tokenBudget });
  ctx.ui.notify(
    metricless
      ? `Loop started (metricless spec loop — NO plateau stop): ${displaySlice(cfg.target, 60)}\nEnds only at ${cfg.maxIterations > 0 ? `max ${cfg.maxIterations} iterations` : "no iteration cap"}${cfg.timeLimitHours ? ` · ${cfg.timeLimitHours}h` : ""}${cfg.tokenBudget ? ` · ${cfg.tokenBudget.toLocaleString()} tokens` : ""} · /loop stop. Every iteration must make ONE real, inspectable change — cosmetic churn is the doorknob failure.` +
        (branchName ? `\nbranch mode: committing each iteration to ${branchName}` : "")
      : `Loop started: ${displaySlice(cfg.target, 60)}\nBaseline: ${cfg.deferBaseline ? "deferred — the first real measurement seeds it" : (baseline ?? "(forced without a number — first turn must produce one)")} · direction ${cfg.direction} · window ${cfg.plateauWindow} · ${cfg.maxIterations > 0 ? `max ${cfg.maxIterations}` : "no iteration cap"}` +
        (branchName ? `\nbranch mode: committing improvements to ${branchName}` : ""),
    "info",
  );
  scheduleLoopTick(ctx);
  return true;
}

async function cmdLoop(args: string, ctx: ExtensionContext): Promise<void> {
  const parts = args.trim().split(/\s+/);
  const sub = (parts[0] ?? "").toLowerCase();
  const rest = args.trim().slice(sub.length).trim();

  if (!sub || sub === "resume") {
    releaseInitialSessionLoadBarrier();
    if (state.mainModelRecovery?.manualResumeRequired && state.mainModelRecovery.kind === "loop") {
      manuallyResumeMainModelRecovery(ctx);
      return;
    }
    if ((state.mainModelRecovery?.retryAt || state.mainModelRecovery?.pendingModelSwitch) && state.mainModelRecovery.kind === "loop") {
      clearMainModelRecoveryTimer();
      flags.continuationDispatchStoodDown = false;
      ctx.ui.notify("Retrying the saved main-model recovery now — one provider probe, then the configured fallback models if needed.", "info");
      void probeMainModelRecovery(ctx);
      return;
    }
    // /loop with no args (or /loop resume, v0.28.22) → resume a held loop
    // if one is waiting; otherwise draft the loop config (metric design is
    // the whole game for a long-running loop; never start one blind).
    if (isLoopActive()) {
      if (flags.continuationDispatchStoodDown) {
        releaseContinuationDispatchStandDown();
        scheduleLoopTick(ctx);
        ctx.ui.notify("Loop dispatch stand-down cleared — retrying one continuation explicitly.", "info");
      } else {
        ctx.ui.notify("A loop is already active — /loop status to inspect, /loop stop to end it.", "info");
      }
      return;
    }
    const stored = state.loop;
    // v0.29.20: plain plateau stops are resumable too — pre-gate plateaus
    // could be false (hegemon/polis stopped 2026-07-31 with open findings
    // on 429-dead turns), and an explicit resume is the user's call; the
    // v0.29.19 gate + re-armed counters make the resumed run honest.
    const RESUMABLE_STOP = (r?: string): boolean =>
      r === HELD_ON_RESTORE ||
      !!r?.startsWith("provider errors —") ||
      !!r?.startsWith("stopped by user —") ||
      !!r?.startsWith("plateau —") ||
      !!r?.startsWith("stalled:") ||
      !!r?.startsWith("stuck —") ||
      // v0.35.54 (collect-pass HIGH finding): the v0.35.31 "metric never
      // moved" stop message promises "/loop resume retries or /loop stop",
      // but this predicate never matched that prefix — the promised command
      // answered "No held loop to resume" and, with propose_loop_refine
      // gated on an ACTIVE loop, the only recovery was /loop stop + a fresh
      // start discarding iteration history. Same class as the v0.35.25
      // issue-#14 zombie prefix (fixed there, missed for this brand-new
      // prefix). Resuming re-arms the counters; if the metric is still dead
      // it re-stops loudly after its window — and a measure-changing
      // propose_loop_refine (usable again once resumed) re-scopes the era so
      // the never-moved grace re-arms.
      !!r?.startsWith("metric never moved —") ||
      // v0.35.25 (issue #14): abortZombieRun parks with
      // "stopped: automatic zero-stream abort — … (/loop resume to retry)"
      // and its user-facing message PROMISES that resume command. The
      // predicate it lands in never matched the prefix, so /loop resume
      // answered "No held loop to resume" and the preserved iteration,
      // best value, and history were unreachable without re-drafting.
      !!r?.startsWith("stopped: automatic zero-stream abort");
    if (stored && !stored.active && RESUMABLE_STOP(stored.stopReason)) {
      // Branch-mode stop returns HEAD to originalBranch. Refuse a resume from
      // there rather than letting the next tick commit loop work to the
      // user's branch; the user can explicitly check out the recorded
      // scratch branch after preserving any intervening work.
      if (stored.branchName) {
        const currentBranch = await runGit(ctx, ["rev-parse", "--abbrev-ref", "HEAD"]);
        if (!currentBranch.ok || currentBranch.stdout !== stored.branchName) {
          appendLedger(ctx.cwd, "loop_resume_blocked_wrong_branch", {
            expected: stored.branchName,
            actual: currentBranch.ok ? currentBranch.stdout : "unknown",
          });
          ctx.ui.notify(`Loop resume refused: branch mode requires HEAD on ${stored.branchName}, but the current branch is ${currentBranch.ok ? currentBranch.stdout : "unknown"}. Check out the scratch branch explicitly, then run /loop resume.`, "warning");
          return;
        }
      }
      // v0.28.14: one-active-thing — a held loop must not resume over an
      // active goal/list-item (this was the last unguarded stacking path).
      if (state.goal && state.goal.status === "active") {
        ctx.ui.notify(`A goal is active — the held loop stays held. ${activeGoalSurfaceCommand("pause")} or ${activeGoalSurfaceCommand("cancel")} it first, then /loop resume.`, "warning");
        return;
      }
      // An explicit resume re-arms the counters: fresh stall window,
      // cleared dead-turn/stuck streaks, reprieves restored — the user
      // saying "push again" wins over the ladder's memory (v0.29.19).
      state.loop = { ...stored, active: true, stopReason: undefined, consecutiveErrors: 0, consecutiveStuck: 0, lastStuckReason: undefined, stallCount: 0, auditPlateauReprieves: 0 };
      persistState(ctx);
      // v0.35.23 (note.md Next #2): an explicit resume is exactly the
      // decision a load hold waits for — release it or the tick below
      // would be frozen.
      if (clearLoadHold(state)) {
        persistState(ctx);
        appendLedger(ctx.cwd, "load_hold_released", { via: "loop-resume" });
      }
      releaseContinuationDispatchStandDown();
      scheduleLoopTick(ctx);
      ctx.ui.notify(
        `Loop resumed: iteration ${stored.iteration}/${stored.maxIterations > 0 ? stored.maxIterations : "∞"} · best ${stored.bestValue ?? "n/a"} — ${displaySlice(stored.target, 60)}`, 
        "info",
      );
      return;
    }
    if (sub === "resume") {
      ctx.ui.notify("No held loop to resume. /loop to draft one, or /loop start \"<target>\" for an infinite metricless loop.", "info");
      return;
    }
    await startDrafting(ctx, "loop");
    return;
  }

  if (sub === "status") {
    const loop = state.loop;
    if (!loop) {
      if (state.mainModelRecovery?.kind === "loop") {
        ctx.ui.notify(formatLoopRecoveryStatus(ctx), "info");
        return;
      }
      ctx.ui.notify("No loop. /loop to draft one, /loop start \"<target>\" for an infinite metricless loop, or add measure=\"<cmd>\" direction=min|max for a metric loop [window=5] [max=50] [time=<hours>] [tokens=<budget>]", "info");
      return;
    }
    const lines = [
      `Loop: ${loop.active ? "active" : "stopped"} — ${displaySlice(loop.target, 80)}`, 
      `Metric: ${loop.measureCmd ? `${loop.measureCmd} (${loop.direction})` : "none — metricless spec loop (no plateau)"}`,
      `Iteration ${loop.iteration}/${loop.maxIterations > 0 ? loop.maxIterations : "∞"} · best ${loop.bestValue ?? "n/a"} · last ${loop.lastValue ?? "n/a"} · stall ${loop.stallCount}/${loop.plateauWindow}`,
    ];
    const bounds: string[] = [];
    if (loop.timeLimitHours !== undefined) bounds.push(`time ≤ ${loop.timeLimitHours}h`);
    if (loop.tokenBudget !== undefined) bounds.push(`tokens ${(loop.tokensUsed ?? 0).toLocaleString()}/${loop.tokenBudget.toLocaleString()}`);
    if (bounds.length) lines.push(`Bounds: ${bounds.join(" · ")}`);
    if (loop.refinements?.length) lines.push(`Spec refined ${loop.refinements.length}× (latest: iteration ${loop.refinements[loop.refinements.length - 1]!.iteration})`);
    if (loop.stopReason) lines.push(`Stopped: ${loop.stopReason}`);
    if (state.mainModelRecovery?.kind === "loop") lines.push(...formatLoopRecoveryStatusLines(ctx));
    const tail = loop.history.slice(-5);
    if (tail.length > 0) {
      lines.push("Recent: " + tail.map((h) => `${h.value ?? "ERR"}${h.improved ? "↑" : ""}`).join(" "));
    }
    ctx.ui.notify(lines.join("\n"), "info");
    return;
  }

  if (sub === "start") {
    let cfg;
    try {
      cfg = parseLoopStartArgs(rest);
    } catch (err) {
      ctx.ui.notify(
        `/loop start: ${err instanceof Error ? err.message : String(err)}\n(Non-numeric goal — research, docs, features? Use /goal: the auditor verifies semantically. /loop only believes a number. Or /loop with no args to draft.)`,
        "warning",
      );
      return;
    }
    await startLoopFromConfig(ctx, cfg);
    return;
  }

  // v0.28.14: /loop cancel is a first-class alias — users reached for
  // /goal cancel to kill loops because "cancel" is the verb they know.
  if (sub === "refine" || sub === "polish") {
    // v0.33.2: the operator's respec verb. The refine flow stays
    // agent-proposed + user-confirmed (propose_loop_refine) — this command
    // queues the operator's suggestion into the next iteration's prompt.
    // ("polish" accepted as an alias: the widget footer advertised it
    // before the command existed — now it does.)
    if (!isLoopActive()) {
      ctx.ui.notify("No active loop to refine — /loop start first.", "warning");
      return;
    }
    const hint = rest.trim();
    if (!hint) {
      ctx.ui.notify("Usage: /loop refine <what the spec should capture better> — the suggestion rides the next iteration's prompt; the agent proposes via propose_loop_refine and you confirm.", "info");
      return;
    }
    state.loop!.refineHint = hint.slice(0, 300);
    persistState(ctx);
    appendLedger(ctx.cwd, "loop_refine_hint", { iteration: state.loop!.iteration, hint: state.loop!.refineHint });
    ctx.ui.notify("Refine hint queued — it rides the next iteration's prompt.", "info");
    return;
  }

  if (sub === "stop" || sub === "cancel") {
    if (!state.loop) {
      ctx.ui.notify("No loop to stop.", "info");
      return;
    }
    clearLoopTimer();
    if (state.mainModelRecovery?.kind === "loop") {
      clearMainModelRecoveryTimer();
      state.mainModelRecovery = undefined;
      flags.mainModelAbortForRecovery = false;
      flags.continuationDispatchStoodDown = false;
    }
    // A user stop is authoritative even when the loop was already held by a
    // lifecycle marker. Do not let HELD_ON_RESTORE survive `/loop stop` and
    // become an automatic successor resume later.
    state.loop = { ...state.loop, active: false, stopReason: `stopped by user (/loop ${sub})` };
    persistState(ctx);
    const stopGeneration = flags.sessionGeneration;
    await finishLoopGit(ctx, state.loop);
    const afterFinish = freshCtxForGeneration(stopGeneration);
    if (!afterFinish) return;
    ctx = afterFinish;
    appendLedger(ctx.cwd, "loop_stopped", { reason: "user", iterations: state.loop.iteration, best: state.loop.bestValue });
    ctx.ui.notify(
      `Loop stopped after ${state.loop.iteration} iterations. Best: ${state.loop.bestValue ?? "n/a"}.`,
      "info",
    );
    notifyExternal(ctx, `Loop stopped by user after ${state.loop.iteration} iterations (best: ${state.loop.bestValue ?? "n/a"})`);
    announceQueuedListAfterLoopEnd(ctx);
    return;
  }

  // v0.25.1: a CLEAN end — "completed: <reason>", distinct from
  // stuck/plateau/stopped-by-user. Additive: /loop stop is untouched.
  if (sub === "finish") {
    if (!state.loop) {
      ctx.ui.notify("No loop to finish.", "info");
      return;
    }
    clearLoopTimer();
    if (state.mainModelRecovery?.kind === "loop") {
      clearMainModelRecoveryTimer();
      state.mainModelRecovery = undefined;
      flags.mainModelAbortForRecovery = false;
      flags.continuationDispatchStoodDown = false;
    }
    const reason = loopFinishStopReason(rest);
    state.loop = { ...state.loop, active: false, stopReason: reason };
    persistState(ctx);
    const finishGeneration = flags.sessionGeneration;
    await finishLoopGit(ctx, state.loop);
    const afterFinish = freshCtxForGeneration(finishGeneration);
    if (!afterFinish) return;
    ctx = afterFinish;
    appendLedger(ctx.cwd, "loop_stopped", { reason, iterations: state.loop.iteration, best: state.loop.bestValue });
    ctx.ui.notify(
      `Loop finished (${reason}) after ${state.loop.iteration} iterations. Best: ${state.loop.bestValue ?? "n/a"}.`,
      "info",
    );
    notifyExternal(ctx, `Loop finished: ${reason}`);
    announceQueuedListAfterLoopEnd(ctx);
    return;
  }

  if (sub === "audit") {
    // v0.29.0: the project-audit loop (user design: "the looper running
    // audits to see where to progress and what to fix — the thing that
    // fires at the end of goals and lists"). Unlike respec this is a
    // METRIC loop: the orchestrator counts CLOSED findings every iteration,
    // direction=max (v0.29.14 — open-count/min punished discovery), and the
    // plateau stop is the termination — no fixes landing for the window =
    // the well is dry. User typed the command = the act (same auto-start
    // rule as respec).
    // v0.35.0: activation below asks before replacing any live objective.
    // v0.31.1: a paused/active one-shot audit goal + this loop = two stacked
    // audit initiatives (junk-runner 2026-07-31: the held one-shot read as
    // "stalled" for 8h while the loop did all the work — the agent conflated
    // them and proposed completing the goal for the loop's work). Warn, name
    // the supersession, don't block — the user's agency, the user's call.
    if (state.goal && state.goal.objective.includes(GOAL_AUDIT_ONESHOT_MARKER)) {
      appendLedger(ctx.cwd, "audit_stack_warn", { have: "goal", starting: "loop", goalStatus: state.goal.status });
      ctx.ui.notify(
        `Heads up: a ${state.goal.status} one-shot audit goal exists in this session — the audit loop SUPERSEDES it (one pass + fixes IS the loop's job). ${activeGoalSurfaceCommand("cancel")} clears it; one audit initiative per session.`,
        "warning",
      );
    }
    await startLoopFromConfig(ctx, {
      target: auditTarget(),
      measureCmd: auditMeasureCmd(),
      direction: "max",
      plateauWindow: LOOP_DEFAULTS.plateauWindow,
      maxIterations: 0,
      branch: false,
      force: false,
      // v0.29.10: the audit loop's metric is CREATED by iteration 1 —
      // seeding best from the pre-discovery 0 stalls every iteration and
      // plateau-stops mid-work at the window. Defer the baseline.
      deferBaseline: true,
      kind: "audit",
    });
    return;
  }

  if (sub === "respec") {
    // v0.24.3: reconcile the codebase against the root spec, forever.
    // Same auto-start path as /loop start (the user typed the command —
    // that IS the act); metricless + unbounded by design. No limit-nagging:
    // bounds exist on /loop start for whoever wants them.
    const specs = resolveSpecFiles(ctx.cwd);
    if (specs.length === 0) {
      // No spec → the target is undetermined; grill instead of dead-ending
      // on an error (v0.24.4).
      ctx.ui.notify("No SPEC.md / spec.md in the project root — drafting the loop target with you (or bootstrap a spec first).", "info");
      await startDrafting(
        ctx,
        "loop",
        "reconcile the codebase against the project spec — but NO SPEC.md / spec.md exists in the root. Grill the user: should the first work be bootstrapping a SPEC.md from the current code (then reconcile against it), or is the reconciliation target better stated in prose? Challenge vague answers.",
      );
      return;
    }
    let specPath = specs[0]!;
    if (specs.length > 1) {
      // Two specs = ambiguous — never silently pick (v0.24.4). One
      // slash-bar select, plus a nudge to consolidate.
      const names = specs.map((p) => path.basename(p));
      const choice = await ctx.ui.select(
        "Both SPEC.md and spec.md exist in the root — which one is the spec?",
        names,
      );
      if (choice === undefined) {
        ctx.ui.notify("respec cancelled.", "info");
        return;
      }
      specPath = specs[names.indexOf(choice)]!;
      ctx.ui.notify(
        `Using ${path.basename(specPath)} as the spec. Both files exist — worth consolidating; the loop treats only ${path.basename(specPath)} as the spec.`,
        "info",
      );
    }
    const target = respecTarget(path.basename(specPath));
    await startLoopFromConfig(ctx, {
      target,
      measureCmd: "",
      direction: undefined,
      plateauWindow: LOOP_DEFAULTS.plateauWindow,
      maxIterations: 0,
      branch: false,
      force: false,
      specFile: specPath, // v0.33.2
    });
    return;
  }

  // v0.35.33: /loop plan [target] — the extended draft for a loop config:
  // deep research + multi-round metric design, same propose_loop_draft Confirm.
  // Explicit sub BEFORE the natural-language fallthrough (otherwise "plan"
  // would become a loop TARGET).
  if (sub === "plan") {
    if (isLoopActive()) {
      ctx.ui.notify("A loop is already active — /loop status to inspect, /loop stop to end it.", "info");
      return;
    }
    await startDrafting(ctx, "loop", rest || undefined, "plan");
    return;
  }

  // Anything else is a natural-language target (v0.22.4): draft it — the
  // metric is the whole game for a loop, and /loop start with full params
  // is the skip-drafting path. Previously this fell through to a usage
  // line, so "/loop make the tests faster" did nothing useful.
  if (isLoopActive()) {
    ctx.ui.notify("A loop is already active — /loop status to inspect, /loop stop to end it.", "info");
    return;
  }
  await startDrafting(ctx, "loop", args.trim());
}

// =================================================================
// Tools exposed to the agent
// =================================================================

const STALE_TOOL_CONTEXT_MESSAGE =
  "This tool call crossed a session replacement before it could run. No stale context was used; wait for a fresh session_start and retry.";


/* ------------------------------------------------------------------ */
/* Registration surface.                                               */
/* ------------------------------------------------------------------ */

export function loopTimerPending(): boolean {
  return loopTimer !== null;
}

export { cmdLoop, finishLoopGit, isLoopActive, clearLoopTimer, scheduleLoopTick, runLoopTick, startLoopFromConfig, STALE_TOOL_CONTEXT_MESSAGE };
