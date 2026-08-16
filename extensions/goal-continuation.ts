// ============================================================================
// goal-continuation.ts — decomposition step 5 (v0.34.113)
// ============================================================================
// The continuation cluster extracted from extensions/loops/goal.ts:
//   - continuation start timeout + no-turn-start watchdog (v0.34.88)
//   - the dispatch sidecar (continuation-dispatch.json) lifecycle
//   - scheduleContinuation / sendContinuation / stall + length sends
//   - send-rearm storm accounting (accountSendRearm / escalateSendRearmStorm)
//   - post-compaction rearm cap (COMPACTION_REARM_CAP) + resync block
//   - queue-stuck probe
//   - buildPostCompactResync / continuationPrompt (prompt assembly)
//
// Positioning invariants (docs/GLLA-POSITIONING-AND-DECOMPOSITION-2026-08-08.md):
//   - ZERO behavior change: moved function bodies are byte-identical except
//     mechanical `flags.X` accessor re-spellings for goal.ts-owned lets and
//     dep-function re-spellings (persistState → persistState etc., wired at
//     factory time).
//   - One-way imports: this module NEVER imports from extensions/loops/goal.ts.
//   - Module-level mutable state stays in the module that owns it: the timer
//     state + dispatch sidecar + rearm counters owned by this cluster live
//     HERE (like goal-loop.ts's loopTimer), never read directly from goal.ts.
//     goal.ts observes them only through the exported accessor getters.
//   - Ledger event names unchanged (goal_continuation_sent,
//     goal_continuation_send_failed, continuation_dispatch_*,
//     send_rearm_*, queue_stuck_detected, ...).
// ============================================================================

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { state, replaceState } from "./goal-state.js";
import {
  appendLedger,
  nowIso,
  newGoalId,
  archivedGoalPath,
  goalMdPath,
  writeGoalMd,
  sanitizeDisplayText,
  findNextPendingTask,
  buildTaskSummary,
  LONG_RUNNING_JUDGMENT_POLICY,
  auditVerdictLabel,
  isFullAuditObjective,
  resolveEffectiveAggressiveSettings,
  isStaleApiError,
  type Goal,
  type ObjectiveRepairTarget,
} from "./goal-loop-core.js";
import {
  createContinuationDispatch,
  transitionDispatch,
  dispatchMatchesOwner,
  dispatchPromptMatches,
  dispatchTimedOut,
  persistDispatchRecord,
  clearDispatchRecord,
  type ContinuationDispatch,
} from "./goal-loop-dispatch.js";
import { BACKOFF_IDLE_RETRY_MS, HEARTBEAT_MAX_NUDGES } from "./goal-loop-backoff.js";
import { LENGTH_CONTINUE_MAX, LENGTH_CONTINUE_TEXT } from "./length-continue.js";
import { VISION_ASSIST_GUIDANCE } from "./vision-assist.js";
import { loadSettings } from "./goal-settings.js";
import { clearLoopTimer, isLoopActive } from "./goal-loop.js";
import { attemptFreshSessionRecovery, mainModelRecoveryActive, recoverMainModelFromSendStorm } from "./goal-recovery.js";
import { sendStormEscalateMs } from "./main-model-recovery.js";
import {
  appendObjectiveRepairRecord,
  applyObjectiveRepair,
  assessSuspiciousObjective,
  buildQueuedRepairRecord,
  buildRepairTaskObjective,
  deriveObjectiveRepair,
  hasQueuedObjectiveRepair,
} from "./faulty-objective-recovery.js";

/** goal.ts-owned module lets the continuation cluster reads/writes through
 * this accessor. Getters/setters are wired by goal.ts at factory time
 * (mirror-lets pattern, same as HeartbeatFlags / RecoveryFlags). */
export interface ContinuationFlags {
  get sessionGeneration(): number;
  get sessionHandoffPending(): boolean;
  get initialSessionLoadPending(): boolean;
  get extensionApiStale(): boolean;
  get staleTerminalDone(): boolean;
  get zombieStoodDown(): boolean;
  get extensionApi(): ExtensionAPI | null;
  get postCompletionSettleUntil(): number;
  set postCompletionSettleUntil(v: number);
  get postCompactResyncPending(): boolean;
  set postCompactResyncPending(v: boolean);
  get abortedStandDown(): boolean;
  set abortedStandDown(v: boolean);
  get lastCompactionAt(): number;
  // v0.34.124: epoch of the last main-model-recovery resume (provider failure
  // lifted). The continuation start watchdog re-arms through a grace window
  // after this — pi's model chain is still warming and the first turn can
  // take minutes to start (field: deals 2026-08-10 21:11-21:14).
  get lastMainModelRecoveryResumeAt(): number;
  set lastMainModelRecoveryResumeAt(v: number);
  get lastActivityAt(): number;
  get lastRealActivityAt(): number;
  get loopRearmStreak(): number;
  set loopRearmStreak(v: number);
  get loopRearmSince(): number;
  set loopRearmSince(v: number);
  get loopRearmMilestone(): number;
  set loopRearmMilestone(v: number);
  get completionAuditInFlight(): boolean;
}

/** goal.ts functions/consts the continuation cluster calls. Wired by goal.ts
 * at factory time. */
export interface ContinuationDeps {
  instanceId: string;
  GOAL_EVENT_ENTRY: string;
  LIST_COMPLETION_SETTLE_MS: number;
  persistState(ctx: ExtensionContext): void;
  updateGoal(patch: Partial<Goal>, ctx: ExtensionContext): void;
  refreshUI(ctx: ExtensionContext): void;
  notifyExternal(ctx: ExtensionContext, message: string): void;
  noteActivity(real?: boolean): void;
  rememberCtx(ctx: ExtensionContext): void;
  freshCtx(): ExtensionContext | null;
  freshCtxForGeneration(generation: number): ExtensionContext | null;
  probeExtensionApiStale(): boolean;
  goStaleTerminal(ctx: ExtensionContext, where: string): void;
  isForeignCtx(ctx: ExtensionContext): boolean;
  sessionManagerId(ctx: ExtensionContext): string;
  isActionableGoal(): boolean;
  isSupervising(): boolean;
  goalNoun(): string;
  activeGoalSurfaceCommand(command: string): string;
  scheduleSessionTimeout(callback: () => void, delayMs: number): NodeJS.Timeout;
  enqueueRepairTask(ctx: ExtensionContext, objective: string, target?: ObjectiveRepairTarget): void;
}

let flags: ContinuationFlags;
let instanceId: ContinuationDeps["instanceId"];
let GOAL_EVENT_ENTRY: ContinuationDeps["GOAL_EVENT_ENTRY"];
let LIST_COMPLETION_SETTLE_MS: ContinuationDeps["LIST_COMPLETION_SETTLE_MS"];
let persistState: ContinuationDeps["persistState"];
let updateGoal: ContinuationDeps["updateGoal"];
let refreshUI: ContinuationDeps["refreshUI"];
let notifyExternal: ContinuationDeps["notifyExternal"];
let noteActivity: ContinuationDeps["noteActivity"];
let rememberCtx: ContinuationDeps["rememberCtx"];
let freshCtx: ContinuationDeps["freshCtx"];
let freshCtxForGeneration: ContinuationDeps["freshCtxForGeneration"];
let probeExtensionApiStale: ContinuationDeps["probeExtensionApiStale"];
let goStaleTerminal: ContinuationDeps["goStaleTerminal"];
let isForeignCtx: ContinuationDeps["isForeignCtx"];
let sessionManagerId: ContinuationDeps["sessionManagerId"];
let isActionableGoal: ContinuationDeps["isActionableGoal"];
let isSupervising: ContinuationDeps["isSupervising"];
let goalNoun: ContinuationDeps["goalNoun"];
let activeGoalSurfaceCommand: ContinuationDeps["activeGoalSurfaceCommand"];
let scheduleSessionTimeout: ContinuationDeps["scheduleSessionTimeout"];
let enqueueRepairTask: ContinuationDeps["enqueueRepairTask"];

export function createGoalContinuation(flagsArg: ContinuationFlags, d: ContinuationDeps): void {
  flags = flagsArg;
  instanceId = d.instanceId;
  GOAL_EVENT_ENTRY = d.GOAL_EVENT_ENTRY;
  LIST_COMPLETION_SETTLE_MS = d.LIST_COMPLETION_SETTLE_MS;
  persistState = d.persistState;
  updateGoal = d.updateGoal;
  refreshUI = d.refreshUI;
  notifyExternal = d.notifyExternal;
  noteActivity = d.noteActivity;
  rememberCtx = d.rememberCtx;
  freshCtx = d.freshCtx;
  freshCtxForGeneration = d.freshCtxForGeneration;
  probeExtensionApiStale = d.probeExtensionApiStale;
  goStaleTerminal = d.goStaleTerminal;
  isForeignCtx = d.isForeignCtx;
  sessionManagerId = d.sessionManagerId;
  isActionableGoal = d.isActionableGoal;
  isSupervising = d.isSupervising;
  goalNoun = d.goalNoun;
  activeGoalSurfaceCommand = d.activeGoalSurfaceCommand;
  scheduleSessionTimeout = d.scheduleSessionTimeout;
  enqueueRepairTask = d.enqueueRepairTask;
}

/* ------------------------------------------------------------------ */
/* Cluster A — continuation start timeout + test hooks                 */
/* ------------------------------------------------------------------ */

// v0.34.88: the first no-turn-start window is 30s (was 150s — too long for
// a user waiting on /list resume); a single automatic retry with a 60s
// backoff re-sends the EXACT original message, so most transient misses
// self-heal; only the second window failure declares unacknowledged (the
// explicit /list|/goal|/loop resume fallback for genuine provider stalls).
const CONTINUATION_START_TIMEOUT_MS = Number(process.env.GLLA_CONTINUATION_START_TIMEOUT_MS ?? 30_000);
const NO_TURN_START_RETRY_BACKOFF_MS = 60_000;
let continuationStartTimeoutOverrideMs: number | null = null;
let continuationRetryBackoffOverrideMs: number | null = null;
function continuationStartTimeoutMs(): number {
  return continuationStartTimeoutOverrideMs ?? CONTINUATION_START_TIMEOUT_MS;
}
function continuationRetryBackoffMs(): number {
  return continuationRetryBackoffOverrideMs ?? NO_TURN_START_RETRY_BACKOFF_MS;
}
/** Test-only: make the bounded start-proof watchdog observable without waiting 30s. */
export function __testOnlySetContinuationStartTimeout(timeoutMs: number | null): void {
  continuationStartTimeoutOverrideMs = timeoutMs;
}
/** Test-only: make the single retry backoff observable without waiting 60s. */
export function __testOnlySetContinuationRetryBackoff(backoffMs: number | null): void {
  continuationRetryBackoffOverrideMs = backoffMs;
}

/* ------------------------------------------------------------------ */
/* Cluster B — continuation-owned module state (dispatch sidecar)      */
/* ------------------------------------------------------------------ */

let pendingContinuationDispatch: ContinuationDispatch | null = null;
let continuationStartTimer: NodeJS.Timeout | null = null;
let continuationDispatchStoodDown = false;
// v0.34.88: the EXACT payload of the last accepted dispatch send. The retry
// re-sends this verbatim (same customType/content/display) — no per-kind
// rebuild, no marker parsing; only one dispatch is ever pending, so this
// always pairs with pendingContinuationDispatch.
let lastContinuationSentPayload: { content: string; display: boolean } | null = null;

let continuationTimer: NodeJS.Timeout | null = null;
let continuationScheduledFor: string | null = null;

let lastContinuationSentAt = 0;

let queueStuckProbe: ReturnType<typeof setTimeout> | null = null;

// v0.28.5 (E3): send-retry re-arm accounting. The 50ms BACKOFF_IDLE_RETRY
// re-arm loop used to spin for HOURS with zero ledger events while the idle
// watchdogs stayed suppressed. Now: counted, ledgered (start + every 30s),
// and escalated loudly past 5 minutes.
let continuationRearmStreak = 0;
let continuationRearmSince = 0;
// v0.34.102: one-shot "no turn started" notify per storm milestone window
// (rearm storm fires with no accepted dispatch — the user's "pi did not
// start a turn" state under a recovery park).
let lastNoTurnStartedNotifiedAt = 0;
let continuationRearmMilestone = 0;
// v0.34.57: per-record counter capping the compaction-paused re-arm loop.
// A stuck session that never produces a new compaction event must not
// re-arm indefinitely; after 3 rearms (default 3 × 30s = 90s, plus the 60s
// retry backoff if the single auto-retry already fired) the
// watchdog fires the unacknowledged warning so the user can intervene.
const COMPACTION_REARM_CAP = 3;
const continuationStartCompactionRearms = new Map<string, number>();

// v0.34.124: post-recovery turn-start grace. mainModelRecoverySucceeded
// schedules the continuation ~1s after recovery, but pi's
// model chain is still warming (provider 429 backoff) — the first turn
// after a recovery can take minutes to start. Firing the 90s watchdog in
// that window interrupted a live goal whose turn started at +2m51s
// (field: deals 2026-08-10 21:13:15 "did not start turn"). Re-arm at the
// same 30s cadence through the grace window, capped, then fall through
// to the unacknowledged verdict exactly as before.
const MAIN_MODEL_RECOVERY_START_GRACE_MS = 5 * 60_000;
const RECOVERY_REARM_CAP = 10;
// Keyed by the pending dispatch id; clearRecoveryRearms is called with every
// terminal dispatch cleanup so one entry cannot survive its five-minute
// post-recovery grace window.
const continuationStartRecoveryRearms = new Map<string, number>();

function noteRecoveryRearm(id: string): number {
  const n = (continuationStartRecoveryRearms.get(id) ?? 0) + 1;
  continuationStartRecoveryRearms.set(id, n);
  return n;
}

const SEND_REARM_LEDGER_MILESTONES_MS = [2 * 60_000, 5 * 60_000, 10 * 60_000];
// v0.28.29: escalation is TIME-based and ACTIVITY-gated. A busy session is
// NORMAL — the user conversing, or one long subagent turn — and the old
// flat-50ms × 6000-count rule misread 5 minutes of busy as "wedged" and
// paused the goal (the polis field report). Escalate only after 15 minutes
// of failed sends AND no session activity in the last 5 minutes (a wedged
// queue shows no events at all; a busy one streams constantly).
const SEND_REARM_ESCALATE_SILENT_MS = 5 * 60_000;

/* ------------------------------------------------------------------ */
/* Cluster C — rearm accounting (send-rearm storm)                     */
/* ------------------------------------------------------------------ */

/** v0.28.29: busy-retry cadence backs off — 50ms for the first beats
 * (instant pickup right after a turn ends), then 250ms, 1s, 5s, 15s, 30s
 * cap. agent_end reschedules independently, so the slow tail costs nothing
 * in the common case; it only caps the ledger/CPU spam of a long busy stretch. */
export function sendRearmDelayMs(streak: number): number {
  if (streak <= 4) return 50;
  if (streak <= 8) return 250;
  if (streak <= 12) return 1_000;
  if (streak === 13) return 5_000;
  if (streak === 14) return 15_000;
  return 30_000;
}

export function accountSendRearm(ctx: ExtensionContext, kind: "continuation" | "loop"): void {
  const streak = kind === "continuation" ? ++continuationRearmStreak : ++flags.loopRearmStreak;
  if (streak === 1) {
    if (kind === "continuation") { continuationRearmSince = Date.now(); continuationRearmMilestone = 0; } else { flags.loopRearmSince = Date.now(); flags.loopRearmMilestone = 0; }
    appendLedger(ctx.cwd, "send_rearm_start", { kind });
    return;
  }
  const since = kind === "continuation" ? continuationRearmSince : flags.loopRearmSince;
  const elapsed = Date.now() - since;
  const milestone = kind === "continuation" ? continuationRearmMilestone : flags.loopRearmMilestone;
  if (milestone < SEND_REARM_LEDGER_MILESTONES_MS.length && elapsed >= SEND_REARM_LEDGER_MILESTONES_MS[milestone]!) {
    if (kind === "continuation") continuationRearmMilestone++; else flags.loopRearmMilestone++;
    appendLedger(ctx.cwd, "send_rearm_storm", { kind, streak, minutes: Math.round(elapsed / 60000) });
    // v0.34.102 (field: dracon-platform 2026-08-08 091828 "pi did not
    // start a turn"): a continuation storm with NO accepted dispatch since
    // it began is the exact "no turn started" state. The existing
    // continuation_unanswered diagnostic only fires when the plugin itself
    // SENT a continuation (lastContinuationSentAt > 0) — under a recovery
    // park the send path is gated so it never fires, and the rearm storm
    // raged 68m with zero user-facing explanation. Surface it once per
    // storm milestone (2m/5m/10m), ledgered distinctly.
    if (kind === "continuation") {
      const noDispatchAccepted = lastContinuationSentAt === 0 || lastContinuationSentAt < continuationRearmSince;
      if (noDispatchAccepted && lastNoTurnStartedNotifiedAt + SEND_REARM_LEDGER_MILESTONES_MS[0]! <= Date.now()) {
        lastNoTurnStartedNotifiedAt = Date.now();
        appendLedger(ctx.cwd, "rearm_no_turn_started", { streak, minutes: Math.round(elapsed / 60000) });
        const msg = `glla: pi accepted no continuation for ${Math.round(elapsed / 60000)}m (${streak} re-arms, no turn started) — the send queue may be stuck. The generic recovery probe is retrying automatically; no action needed unless it reaches the automatic horizon.`;
        ctx.ui.notify(msg, "warning");
        notifyExternal(ctx, msg);
      }
    }
  }
  if (elapsed >= sendStormEscalateMs() && Date.now() - flags.lastActivityAt >= SEND_REARM_ESCALATE_SILENT_MS) {
    if (kind === "continuation") { continuationRearmStreak = 0; continuationRearmSince = 0; } else { flags.loopRearmStreak = 0; flags.loopRearmSince = 0; }
    escalateSendRearmStorm(ctx, kind);
  }
}

function escalateSendRearmStorm(ctx: ExtensionContext, kind: "continuation" | "loop"): void {
  // Same loud-terminal shape as escalateStallNow (v0.24.7). v0.28.29: this
  // only fires on a REAL wedge now (15m of failed sends + 5m of zero
  // session activity) — busy-but-alive sessions never reach it.
  const mins = Math.round(sendStormEscalateMs() / 60000);
  const silent = Math.round(SEND_REARM_ESCALATE_SILENT_MS / 60000);
  appendLedger(ctx.cwd, "send_rearm_escalated", { kind, afterMinutes: mins, silentMinutes: silent });
  if (kind === "loop" && isLoopActive()) {
    void recoverMainModelFromSendStorm(ctx, kind);
    return;
  }
  if (
    state.goal &&
    (state.goal.status === "auditing" || flags.completionAuditInFlight || state.goal.pendingCompletion)
  ) {
    // v0.29.1: NEVER storm-pause the completion lifecycle. An isolated
    // auditor run takes minutes and the main session is EXPECTED to be
    // silent while it works — 15m of wedged re-arms + that silence is the
    // exact trigger shape, so completing a goal under a wedged queue used
    // to guarantee a mid-audit pause (field-observed in pully + hellhunter
    // + junk-runner: "complete ending in a pause retry storm"). The audit
    // lifecycle owns its own pauses.
    appendLedger(ctx.cwd, "send_rearm_escalated_suppressed", { reason: "audit-lifecycle" });
    ctx.ui.notify("Send-retry storm during the completion audit — NOT pausing; the auditor's silence is expected. If pi is wedged, Escape cancels the stuck run; the stored claim survives.", "info");
    return;
  }
  // A core send retry is different from a dead dispatch: after 15m of
  // zero stream activity, stop the stuck core retry, rotate to a configured
  // backup when possible, and install a durable recovery probe. This keeps
  // the old no-blind-resend invariant without requiring the user to notice
  // the wedge and press Escape while waiting for an assumed external change.
  if (isSupervising()) {
    void recoverMainModelFromSendStorm(ctx, kind);
    return;
  }
  if (state.goal && state.goal.status === "active") {
    updateGoal({
      status: "paused",
      pauseKind: "error",
      pauseReason: `send-retry storm: ${mins}m of re-arms with no session activity for ${silent}m — the session never went idle for the continuation`,
      pauseSuggestedAction: `The session produced no events while the send retried (wedged queue — pi may still be holding the provider retry; pi prints 'escape to cancel'). Press Escape, then ${activeGoalSurfaceCommand("resume")}. A fresh session_start rebinds the goal; restart pi normally only if no replacement arrives.`,
    }, ctx);
    ctx.ui.notify(`${goalNoun()} paused: send-retry storm (${mins}m, session silent ${silent}m). Escape cancels the stuck run, then ${activeGoalSurfaceCommand("resume")}. A fresh session_start rebinds it; restart pi normally only if no replacement arrives.`, "warning");
    notifyExternal(ctx, `${goalNoun()} paused: send-retry storm.`);
  }
}

/* ------------------------------------------------------------------ */
/* Cluster D — dispatch sidecar lifecycle                              */
/* ------------------------------------------------------------------ */

export function clearContinuationTimer(): void {
  if (continuationTimer) {
    clearTimeout(continuationTimer);
    continuationTimer = null;
  }
  continuationScheduledFor = null;
}

export function clearContinuationStartWatchdog(): void {
  if (continuationStartTimer) {
    clearTimeout(continuationStartTimer);
    continuationStartTimer = null;
  }
  if (pendingContinuationDispatch) {
    clearCompactionRearms(pendingContinuationDispatch.id);
    clearRecoveryRearms(pendingContinuationDispatch.id);
  }
  pendingContinuationDispatch = null;
  lastContinuationSentAt = 0;
  lastContinuationSentPayload = null;
}

function noteCompactionRearm(id: string): number {
  const next = (continuationStartCompactionRearms.get(id) ?? 0) + 1;
  continuationStartCompactionRearms.set(id, next);
  return next;
}
function clearCompactionRearms(id: string): void {
  continuationStartCompactionRearms.delete(id);
}
function clearRecoveryRearms(id: string): void {
  continuationStartRecoveryRearms.delete(id);
}

function dispatchLabel(record: ContinuationDispatch): string {
  if (record.kind === "loop") return `loop iteration ${record.iteration ?? "?"}`;
  if (record.kind === "stall") return "stall warning";
  if (record.kind === "length") return "length continuation";
  return `${state.goal?.policy === "list" ? "list item" : "goal"}${record.goalId ? ` ${record.goalId}` : ""}`;
}

/**
 * Keep the dispatch lifecycle facts together in every ledger boundary. The
 * sidecar phase is useful for recovery, but a ledger reader also needs to
 * distinguish enqueue acknowledgement, start proof, timeout, and settlement
 * without inferring one from a neighboring event.
 */
function dispatchLedgerValue(record: ContinuationDispatch, facts: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: record.id,
    kind: record.kind,
    ...(record.goalId === undefined ? {} : { goalId: record.goalId }),
    ...(record.iteration === undefined ? {} : { iteration: record.iteration }),
    generation: record.generation,
    ownerSessionId: record.ownerSessionId,
    marker: record.marker,
    sentAt: record.sentAt,
    phase: record.phase,
    timeoutMs: record.timeoutMs ?? continuationStartTimeoutMs(),
    ...facts,
  };
}

export function dispatchPrepare(
  ctx: ExtensionContext,
  input: Omit<Parameters<typeof createContinuationDispatch>[0], "id" | "sentAt">,
): ContinuationDispatch | null {
  if (input.generation !== flags.sessionGeneration) {
    appendLedger(ctx.cwd, "faulty_objective_stale_attempt_fence", {
      where: "dispatch-prepare",
      inputGeneration: input.generation,
      currentGeneration: flags.sessionGeneration,
      goalId: input.goalId ?? null,
    });
    return null;
  }
  const record: ContinuationDispatch = {
    ...createContinuationDispatch({
      ...input,
      id: `${instanceId}:${input.generation}:${newGoalId()}`,
    }),
    timeoutMs: continuationStartTimeoutMs(),
  };
  // Central fail-closed check: every goal/stall dispatch, including callers
  // that do not pass through scheduleContinuation, must revalidate the live
  // goal identity and objective before touching pi's follow-up queue.
  if (input.kind === "goal" || input.kind === "stall") {
    if (!state.goal || state.goal.id !== input.goalId || state.goal.status !== "active") return null;
    if (!guardGoalBeforeContinuation(ctx, "dispatch-prepare", input.goalId)) return null;
  }
  // Persist ownership BEFORE asking pi to enqueue the follow-up. If this
  // fails, an accepted send would be impossible to reconcile after a reload.
  if (!persistDispatchRecord(ctx.cwd, record)) {
    continuationDispatchStoodDown = true;
    appendLedger(ctx.cwd, "continuation_dispatch_persistence_failed", { id: record.id, phase: record.phase, generation: record.generation });
    ctx.ui.notify("glla: could not persist the continuation dispatch record, so no automatic turn was sent. Fix .pi-glla storage, then resume explicitly.", "error");
    return null;
  }
  pendingContinuationDispatch = record;
  appendLedger(ctx.cwd, "continuation_dispatch_prepared", dispatchLedgerValue(record, {
    acknowledgement: "pending",
    startProofSource: null,
    settlement: "pending",
    resync: record.resync,
  }));
  return record;
}

export function dispatchFailed(ctx: ExtensionContext, record: ContinuationDispatch, reason: string): void {
  if (pendingContinuationDispatch !== record) return;
  const settledAt = Date.now();
  const failed: ContinuationDispatch = {
    ...transitionDispatch(record, "failed"),
    settledAt,
  };
  pendingContinuationDispatch = failed;
  persistDispatchRecord(ctx.cwd, failed);
  appendLedger(ctx.cwd, "continuation_dispatch_failed", dispatchLedgerValue(failed, {
    acknowledgement: "rejected",
    startProofSource: null,
    settlement: "failed",
    settledAt,
    reason,
  }));
  clearContinuationStartWatchdog();
}

export function dispatchStartAcknowledged(ctx: ExtensionContext, source: string, prompt?: unknown): boolean {
  // v0.34.104 ([Image-#1]): any real agent activity during the
  // post-list-completion settle window means pi woke up on its own — the
  // deferred continuation must be cancelled so we don't double-dispatch.
  if (flags.postCompletionSettleUntil > 0) {
    const remaining = flags.postCompletionSettleUntil - Date.now();
    if (remaining > 0) {
      clearContinuationTimer();
      continuationScheduledFor = null;
      appendLedger(ctx.cwd, "list_completion_settle_cleared", { source, remainingMs: remaining });
    }
    flags.postCompletionSettleUntil = 0;
  }
  const record = pendingContinuationDispatch;
  if (!record || flags.sessionHandoffPending || flags.extensionApiStale || flags.staleTerminalDone || flags.zombieStoodDown) return false;
  if (record.generation !== flags.sessionGeneration || isForeignCtx(ctx)) return false;
  if (!dispatchMatchesOwner(record, flags.sessionGeneration, sessionManagerId(ctx))) return false;
  if ((record.kind === "goal" || record.kind === "stall") && (!state.goal || state.goal.id !== record.goalId || state.goal.status !== "active")) return false;
  // before_agent_start is the strongest proof: it must carry this exact
  // dispatch marker. Later low-level events are accepted as compatibility
  // proofs because older pi builds may not expose the prompt there.
  if (source === "before_agent_start" && !dispatchPromptMatches(record, prompt)) return false;
  const settledAt = Date.now();
  const started: ContinuationDispatch = {
    ...transitionDispatch(record, "started"),
    startedAt: settledAt,
    settledAt,
    startProofSource: source,
  };
  pendingContinuationDispatch = started;
  persistDispatchRecord(ctx.cwd, started);
  clearContinuationStartWatchdog();
  clearCompactionRearms(record.id);
  clearDispatchRecord(ctx.cwd);
  lastContinuationSentAt = 0;
  if (record.resync) flags.postCompactResyncPending = false;
  noteActivity(true);
  appendLedger(ctx.cwd, "continuation_start_acknowledged", dispatchLedgerValue(started, {
    acknowledgement: "accepted",
    startProofSource: source,
    settlement: "started",
    startedAt: started.startedAt,
    settledAt,
  }));
  return true;
}

function dispatchStartUnacknowledged(ctx: ExtensionContext, record: ContinuationDispatch): void {
  if (pendingContinuationDispatch !== record || record.phase !== "accepted") return;
  const timedOutAt = Date.now();
  const unacknowledged: ContinuationDispatch = {
    ...transitionDispatch(record, "unacknowledged"),
    timedOutAt,
    settledAt: timedOutAt,
  };
  persistDispatchRecord(ctx.cwd, unacknowledged);
  clearContinuationStartWatchdog();
  continuationDispatchStoodDown = true;
  lastContinuationSentAt = 0;
  const reason = `continuation start acknowledgement timed out (${record.id})`;
  appendLedger(ctx.cwd, "continuation_start_unacknowledged", dispatchLedgerValue(unacknowledged, {
    acknowledgement: "accepted",
    startProofSource: null,
    settlement: "unacknowledged",
    timedOutAt,
    settledAt: timedOutAt,
  }));
  if (record.kind === "loop" && state.loop?.active) {
    clearLoopTimer();
    state.loop = {
      ...state.loop,
      active: false,
      stopReason: `stalled: continuation start acknowledgement timed out (${record.id}) — /loop resume to retry explicitly`,
    };
    persistState(ctx);
  }
  if (state.goal && state.goal.status === "active" && (record.kind === "goal" || record.kind === "stall")) {
    updateGoal({ interruptedAt: nowIso(), interruptedReason: reason }, ctx);
  }
  const msg = `glla: pi accepted the ${dispatchLabel(record)} continuation, but no observable turn-start event arrived within ${Math.round((Date.now() - record.sentAt) / 1000)}s despite one automatic retry. Automatic re-sends are stopped to avoid a blind queue storm. The work is safe in .pi-glla; start a fresh session or use /goal resume, /list resume, or /loop resume to retry explicitly.`;
  ctx.ui.notify(msg, "warning");
  notifyExternal(ctx, sanitizeDisplayText(msg));
  refreshUI(ctx);
}

function armContinuationStartWatchdog(ctx: ExtensionContext, record: ContinuationDispatch): void {
  if (pendingContinuationDispatch !== record || record.phase !== "accepted") return;
  if (continuationStartTimer) clearTimeout(continuationStartTimer);
  const generation = record.generation;
  continuationStartTimer = scheduleSessionTimeout(() => {
    continuationStartTimer = null;
    if (pendingContinuationDispatch !== record || record.phase !== "accepted") return;
    const current = freshCtxForGeneration(generation);
    if (!current) return;
    // v0.34.57: a compaction that landed AFTER the dispatch was accepted is
    // legitimate busy time — the session is mid-compact and the turn-start
    // event will arrive after the compact + resume debt. Re-arm the watchdog
    // instead of firing the false-positive unacknowledged warning. The 3-min
    // compactionGraceUntil alone misses compactions that finish within or
    // past the grace window (field 115855/115858/115901).
    if (flags.lastCompactionAt > (record.acceptedAt ?? 0)) {
      const rearms = noteCompactionRearm(record.id);
      appendLedger(current.cwd, "continuation_start_paused_for_compaction", dispatchLedgerValue(record, {
        lastCompactionAt: flags.lastCompactionAt,
        acceptedAt: record.acceptedAt ?? 0,
        rearmCount: rearms,
        capped: rearms >= COMPACTION_REARM_CAP,
      }));
      if (rearms < COMPACTION_REARM_CAP) {
        armContinuationStartWatchdog(current, record);
        return;
      }
      // Cap reached: go directly to the unacknowledged warning so the
      // user can intervene. Do not enter the normal timeout branch: its
      // one automatic retry would add another 60s after the cap.
      dispatchStartUnacknowledged(current, record);
      return;
    }
    // v0.34.124: post-recovery grace — same re-arm pattern for a goal
    // resumed from a main-model-recovery park. pi just switched the model
    // chain and the first turn start is legitimately slow (provider still
    // backing off). Re-arm at 30s cadence through the 5-minute window;
    // only a genuinely dead turn past the grace hits the verdict.
    const recoveryResumeAt = flags.lastMainModelRecoveryResumeAt;
    if (recoveryResumeAt > 0 && Date.now() - recoveryResumeAt < MAIN_MODEL_RECOVERY_START_GRACE_MS) {
      const rearms = noteRecoveryRearm(record.id);
      appendLedger(current.cwd, "continuation_start_paused_for_recovery", dispatchLedgerValue(record, {
        recoveryResumeAgeMs: Date.now() - recoveryResumeAt,
        rearmCount: rearms,
        capped: rearms >= RECOVERY_REARM_CAP,
      }));
      if (rearms < RECOVERY_REARM_CAP) {
        armContinuationStartWatchdog(current, record);
        return;
      }
      // Cap reached: go directly to the unacknowledged warning. The normal
      // timeout branch below permits one automatic retry, which is no longer
      // appropriate after the bounded recovery grace has been exhausted.
      dispatchStartUnacknowledged(current, record);
      return;
    }
    if (dispatchTimedOut(record, Date.now(), record.timeoutMs ?? continuationStartTimeoutMs())) {
      // v0.34.88: exactly ONE automatic retry with backoff before declaring
      // unacknowledged. The retry re-sends the verbatim original payload so
      // a transient miss (accepted enqueue, turn-start event lost) self-heals
      // without the user; only the second window failure — a genuine provider
      // stall — hits the explicit /list|/goal|/loop resume fallback. A
      // skipped/failed retry falls through to unacknowledged immediately.
      if (!record.retryCount && retryContinuationDispatch(current, record)) return;
      dispatchStartUnacknowledged(current, record);
    }
  }, record.timeoutMs ?? continuationStartTimeoutMs());
}

/** v0.34.88: the single no-turn-start retry. Re-sends the verbatim original
 * payload (captured at first send), marks the record retried + persisted so
 * a reload mid-backoff stays consistent, re-arms the watchdog with the
 * backoff window, and ledgeres the retry. Returns true when the retry was
 * sent and the backoff watchdog is running; false means the unacknowledged
 * path should fire now (skipped because the goal/loop is no longer
 * actionable, or the send failed). */
function retryContinuationDispatch(ctx: ExtensionContext, record: ContinuationDispatch): boolean {
  if (pendingContinuationDispatch !== record || record.phase !== "accepted") return false;
  if (record.kind === "goal" || record.kind === "stall") {
    if (!state.goal || state.goal.id !== record.goalId || state.goal.status !== "active") return false;
    if (!guardGoalBeforeContinuation(ctx, "dispatch-retry", record.goalId)) return false;
  }
  // Belt-and-braces: the watchdog is normally cleared on pause/reload, but a
  // goal parked by another path mid-wait must never get a blind re-send.
  if (record.kind === "loop") {
    if (!state.loop?.active) return false;
  } else if (record.kind === "goal" || record.kind === "stall") {
    if (state.goal?.status !== "active") return false;
  }
  const payload = lastContinuationSentPayload;
  if (!payload) return false;
  if (!flags.extensionApi || flags.extensionApiStale) return false; // stale runtime = terminal; the unacknowledged path notifies
  try {
    flags.extensionApi.sendMessage({ customType: GOAL_EVENT_ENTRY, content: payload.content, display: payload.display }, { triggerTurn: true, deliverAs: "followUp" });
  } catch (err) {
    appendLedger(ctx.cwd, "continuation_retry_send_failed", { id: record.id, kind: record.kind, error: err instanceof Error ? err.message : String(err) });
    if (isStaleApiError(err)) {
      // v0.34.117: auto-recover with a fresh session first (no /new needed).
      // Falls back to the terminal park only when the entrypoint is missing.
      if (!attemptFreshSessionRecovery(ctx, "retryContinuationDispatch")) goStaleTerminal(ctx, "retryContinuationDispatch");
    }
    return false; // the retry itself failed — genuine stall, fail closed now
  }
  record.retryCount = 1;
  record.retrySentAt = Date.now();
  record.timeoutMs = continuationRetryBackoffMs();
  persistDispatchRecord(ctx.cwd, record);
  appendLedger(ctx.cwd, "continuation_retry_sent", dispatchLedgerValue(record, {
    retrySentAt: record.retrySentAt,
    nextTimeoutMs: record.timeoutMs,
    totalWaitMs: record.retrySentAt - record.sentAt + record.timeoutMs,
  }));
  armContinuationStartWatchdog(ctx, record);
  return true;
}

export function dispatchAccepted(ctx: ExtensionContext, record: ContinuationDispatch): boolean {
  if ((record.kind === "goal" || record.kind === "stall") && (!state.goal || state.goal.id !== record.goalId || state.goal.status !== "active")) {
    if (pendingContinuationDispatch === record) dispatchFailed(ctx, record, "stale goal identity before dispatch acceptance");
    return false;
  }
  // A synchronous before_agent_start can acknowledge while sendMessage is
  // still on the stack. Do not overwrite that proof with "accepted".
  if (pendingContinuationDispatch !== record) return true;
  const acceptedAt = Date.now();
  const accepted: ContinuationDispatch = {
    ...transitionDispatch(record, "accepted"),
    acceptedAt,
  };
  pendingContinuationDispatch = accepted;
  appendLedger(ctx.cwd, "continuation_dispatch_accepted", dispatchLedgerValue(accepted, {
    acknowledgement: "accepted",
    startProofSource: null,
    settlement: "pending",
    acceptedAt,
  }));
  if (!persistDispatchRecord(ctx.cwd, accepted)) {
    dispatchStartUnacknowledged(ctx, accepted);
    return false;
  }
  armContinuationStartWatchdog(ctx, accepted);
  return true;
}

export function releaseContinuationDispatchStandDown(): void {
  continuationDispatchStoodDown = false;
  clearContinuationStartWatchdog();
}

/* ------------------------------------------------------------------ */
/* Cluster E — queue-stuck probe                                       */
/* ------------------------------------------------------------------ */

function queueStuckProbeMs(): number {
  return Number(process.env.GLLA_QUEUE_STUCK_MS ?? 45_000);
}

export function armQueueStuckProbe(sentAt: number): void {
  if (queueStuckProbe) clearTimeout(queueStuckProbe);
  queueStuckProbe = scheduleSessionTimeout(() => {
    queueStuckProbe = null;
    try {
      const ctx = freshCtx();
      if (!ctx) return; // no fresh lifecycle context — do not touch a stale one
      if (!isSupervising()) return; // paused/completed meanwhile
      if (lastContinuationSentAt !== sentAt) return; // a newer send armed its own probe
      if (flags.lastRealActivityAt > sentAt) return; // the turn started and worked
      if (!ctx.isIdle()) return; // a turn is running — healthy
      if (!ctx.hasPendingMessages()) return; // consumed — even an instant 429 consumes
      appendLedger(ctx.cwd, "queue_stuck_detected", { waitedMs: Date.now() - sentAt });
      const msg = `${goalNoun()}: the continuation is QUEUED but pi won't start a turn — the turn trigger is dead (re-sends only queue). glla will resume from a fresh session_start; if no replacement arrives, restart pi normally and restore the saved work.`;
      ctx.ui.notify(msg, "warning");
      notifyExternal(ctx, msg);
    } catch { /* stale ctx — the live instance owns the probe now */ }
  }, queueStuckProbeMs());
}

/* ------------------------------------------------------------------ */
/* Cluster F — scheduleContinuation / sendContinuation / stall+length  */
/* ------------------------------------------------------------------ */

/**
 * v0.35.x: a stale or reviewer-derived objective must never reach pi's
 * follow-up queue. This is the final shared choke point for manual resume,
 * session-start auto-resume, list activation, and delayed continuation sends.
 * Repair is intentionally provenance-only: event handlers do not create a
 * model turn or invent a task. A missing repair becomes a paused goal plus a
 * short queued repair item.
 */
export function guardGoalBeforeContinuation(
  ctx: ExtensionContext,
  where: string,
  expectedGoalId?: string,
  options: { allowAuditing?: boolean } = {},
): boolean {
  const allowAuditing = options.allowAuditing === true;
  const goal = state.goal;
  if (!goal) return false;
  if (expectedGoalId && goal.id !== expectedGoalId) {
    appendLedger(ctx.cwd, "faulty_objective_stale_attempt_fence", { goalId: goal.id, expectedGoalId, where, generation: flags.sessionGeneration });
    return false;
  }
  if (goal.status === "complete" || goal.status === "aborted") {
    appendLedger(ctx.cwd, "faulty_objective_terminal_fence", { goalId: goal.id, status: goal.status, where });
    return false;
  }
  if (goal.status === "auditing" && !allowAuditing) return false;
  if (goal.status !== "active" && goal.status !== "paused" && goal.status !== "auditing") return false;

  const storedArchive = goal.archivedPath
    ? (path.isAbsolute(goal.archivedPath) ? goal.archivedPath : path.resolve(ctx.cwd, goal.archivedPath))
    : archivedGoalPath(ctx.cwd, goal.id);
  if (fs.existsSync(storedArchive)) {
    appendLedger(ctx.cwd, "faulty_objective_archive_fence", { goalId: goal.id, where, archive: storedArchive });
    try { fs.rmSync(goalMdPath(ctx.cwd, goal.id), { force: true }); } catch { /* best effort */ }
    replaceState({ ...state, goal: null });
    persistState(ctx);
    ctx.ui.notify("The goal was already archived/cancelled; stale in-memory work was discarded.", "warning");
    return false;
  }
  // v0.35.x: an interrupted terminal archive from the old ordering could
  // leave an ACTIVE goal carrying its terminal stopReason. It is no longer
  // actionable, even when the archive write never landed; do not dispatch
  // it as if the completion claim were still open.
  if (goal.stopReason) {
    appendLedger(ctx.cwd, "faulty_objective_terminal_fence", {
      goalId: goal.id,
      status: goal.status,
      stopReason: goal.stopReason,
      where,
    });
    return false;
  }

  // A repair/replan card is intentionally not auto-repaired again. Its
  // original target is durable in repairTarget; only a confirmed task-list
  // redraft may clear that latch. This prevents the generic repair objective
  // from becoming an endlessly self-repeating successor.
  if (goal.repairTarget) {
    appendLedger(ctx.cwd, "faulty_objective_replan_required", {
      goalId: goal.id,
      where,
      targetId: goal.repairTarget.id,
      originalObjective: goal.repairTarget.objective,
      reasons: goal.repairTarget.reasons,
    });
    ctx.ui.notify(`Replan required before continuing: ${goal.repairTarget.objective.slice(0, 140)}`, "warning");
    return false;
  }

  const assessment = assessSuspiciousObjective(goal.objective, goal.verificationContract);
  if (!assessment.suspicious) return true;

  const proposal = deriveObjectiveRepair(goal, assessment);
  if (proposal) {
    const record = applyObjectiveRepair(goal, proposal, nowIso());
    persistState(ctx);
    writeGoalMd(ctx.cwd, goal);
    appendLedger(ctx.cwd, "faulty_objective_auto_repaired", {
      goalId: goal.id,
      where,
      reasons: assessment.reasons,
      ...record,
    });
    ctx.ui.notify(`Repaired a suspicious ${goal.policy === "list" ? "list item" : "goal"} from ${proposal.source}; continuing with the recorded replacement.`, "warning");
    return true;
  }

  if (!hasQueuedObjectiveRepair(goal)) {
    const record = buildQueuedRepairRecord(goal, assessment, nowIso());
    appendObjectiveRepairRecord(goal, record);
    enqueueRepairTask(ctx, buildRepairTaskObjective(goal, assessment), {
      id: goal.id,
      objective: goal.objective,
      ...(goal.verificationContract ? { verificationContract: goal.verificationContract } : {}),
      reasons: [...assessment.reasons],
      source: where,
    });
    appendLedger(ctx.cwd, "faulty_objective_repair_queued", {
      goalId: goal.id,
      where,
      reasons: assessment.reasons,
      ...record,
    });
  }
  goal.status = "paused";
  goal.pauseKind = "blocked";
  goal.pauseReason = `Suspicious objective detected (${assessment.reasons.join(", ")}).`;
  goal.pauseSuggestedAction = `${activeGoalSurfaceCommand("tweak")} the objective if needed; /list next starts the preserved repair/replan task, then resume the original target after its confirmed task list is accepted.`;
  goal.pauseResumeAt = undefined;
  goal.updatedAt = nowIso();
  persistState(ctx);
  writeGoalMd(ctx.cwd, goal);
  ctx.ui.notify(`Paused the suspicious ${goal.policy === "list" ? "list item" : "goal"}; a repair task was queued instead of dispatching it.`, "warning");
  return false;
}

export function scheduleContinuation(ctx: ExtensionContext, force = false, delayMs?: number): void {
  if (mainModelRecoveryActive()) return;
  if (flags.sessionHandoffPending || flags.initialSessionLoadPending || flags.extensionApiStale || flags.staleTerminalDone || flags.zombieStoodDown) return;
  if (pendingContinuationDispatch) return;
  if (continuationDispatchStoodDown && !force) return;
  if (force) releaseContinuationDispatchStandDown();
  flags.abortedStandDown = false; // v0.29.5: any explicit schedule ends the stand-down
  if (!isActionableGoal()) return;
  if (!guardGoalBeforeContinuation(ctx, "schedule")) return;
  if (!isActionableGoal()) return;
  rememberCtx(ctx);
  const goalId = state.goal!.id;
  if (!force && continuationScheduledFor === goalId) return;
  clearContinuationTimer();
  let delay = 0;
  try {
    delay = delayMs ?? (ctx.isIdle() && !ctx.hasPendingMessages() ? 0 : BACKOFF_IDLE_RETRY_MS);
  } catch {
    return;
  }
  // v0.34.104 ([Image-#1]): the post-list-completion settle window delays
  // the first continuation after a queue auto-advance. Any real agent
  // activity during the window clears `postCompletionSettleUntil`, so a
  // wake-up cancels the deferred send and no double-dispatch happens.
  const settleRemaining = flags.postCompletionSettleUntil - Date.now();
  if (settleRemaining > 0) {
    delay = Math.max(delay, settleRemaining);
    appendLedger(ctx.cwd, "list_completion_settle_pending", { goalId, settleMs: LIST_COMPLETION_SETTLE_MS, remainingMs: settleRemaining });
  }
  continuationScheduledFor = goalId;
  continuationTimer = scheduleSessionTimeout(() => sendContinuation(goalId), delay);
}

export function sendContinuation(goalId: string): void {
  if (mainModelRecoveryActive()) return;
  if (flags.sessionHandoffPending || flags.initialSessionLoadPending || flags.extensionApiStale || flags.staleTerminalDone || flags.zombieStoodDown || continuationDispatchStoodDown || pendingContinuationDispatch) return;
  continuationTimer = null;
  continuationScheduledFor = null;
  if (!state.goal || state.goal.id !== goalId) {
    const stale = freshCtx();
    if (stale) appendLedger(stale.cwd, "faulty_objective_stale_attempt_fence", { expectedGoalId: goalId, currentGoalId: state.goal?.id ?? null, where: "sendContinuation" });
    return;
  }
  // Keep the settle fence authoritative even if a compatibility path calls
  // sendContinuation directly instead of going through scheduleContinuation.
  // Activity clears this flag through dispatchStartAcknowledged; otherwise a
  // premature timer callback is deferred for the remaining window.
  const settleRemaining = flags.postCompletionSettleUntil - Date.now();
  if (settleRemaining > 0) {
    const ctx = freshCtx();
    if (ctx) appendLedger(ctx.cwd, "list_completion_settle_pending", { goalId, settleMs: LIST_COMPLETION_SETTLE_MS, remainingMs: settleRemaining, source: "sendContinuation" });
    continuationScheduledFor = goalId;
    continuationTimer = scheduleSessionTimeout(() => sendContinuation(goalId), settleRemaining);
    return;
  }
  // The settle window expired (or was cleared by real activity). Reset it so
  // it cannot affect a later, unrelated continuation.
  flags.postCompletionSettleUntil = 0;
  if (!isActionableGoal()) return;
  const ctx = freshCtx();
  if (!ctx) {
    // v0.32.0: a stale handle must not spin a flat 50ms re-arm below every
    // watchdog — the heartbeat's terminal path does the theatre; we just stop.
    if (probeExtensionApiStale()) return;
    // No live ctx — retry shortly; the next session event will refresh it.
    continuationScheduledFor = goalId;
    continuationTimer = scheduleSessionTimeout(() => sendContinuation(goalId), BACKOFF_IDLE_RETRY_MS);
    return;
  }
  if (!guardGoalBeforeContinuation(ctx, "dispatch", goalId)) return;
  if (!isActionableGoal()) return;
  if (!ctx.isIdle() || ctx.hasPendingMessages()) {
    accountSendRearm(ctx, "continuation");
    continuationScheduledFor = goalId;
    // v0.28.29: backing-off cadence (was flat 50ms — 6,000 spins in 5m).
    continuationTimer = scheduleSessionTimeout(() => sendContinuation(goalId), sendRearmDelayMs(continuationRearmStreak));
    return;
  }
  if (!flags.extensionApi || flags.extensionApiStale) return;
  try {
    let resync = "";
    // v0.33.1: a builder throw (corrupt restored state) must not masquerade
    // as a transport failure — send without the block instead.
    if (flags.postCompactResyncPending) { try { resync = buildPostCompactResync(); } catch { resync = ""; } }
    const attempt = dispatchPrepare(ctx, {
      generation: flags.sessionGeneration,
      ownerSessionId: sessionManagerId(ctx),
      kind: "goal",
      goalId,
      marker: `[GOAL CHECKPOINT goalId=${goalId}]`,
      resync: Boolean(resync),
    });
    if (!attempt) return;
    flags.extensionApi.sendMessage({
      customType: GOAL_EVENT_ENTRY,
      content: resync + continuationPrompt(state.goal!),
      display: false,
    }, { triggerTurn: true, deliverAs: "followUp" });
    lastContinuationSentPayload = { content: resync + continuationPrompt(state.goal!), display: false }; // v0.34.88: verbatim retry payload
    if (!dispatchAccepted(ctx, attempt)) return;
    continuationRearmStreak = 0; continuationRearmSince = 0; // v0.28.5 (E3): an accepted dispatch clears the storm
    appendLedger(ctx.cwd, "goal_continuation_sent", { goalId, attemptId: attempt.id, generation: attempt.generation });
    if (pendingContinuationDispatch === null) return; // before_agent_start acked synchronously
    lastContinuationSentAt = attempt.sentAt;
    armQueueStuckProbe(lastContinuationSentAt);
  } catch (err) {
    if (pendingContinuationDispatch) dispatchFailed(ctx, pendingContinuationDispatch, err instanceof Error ? err.message : String(err));
    appendLedger(ctx.cwd, "goal_continuation_send_failed", { goalId, error: err instanceof Error ? err.message : String(err) });
    // v0.26.7: stale runtime = terminal (sends can never land); anything
    // else is transient — next agent_end/session_start reschedules.
    if (isStaleApiError(err)) {
      if (!attemptFreshSessionRecovery(ctx, "sendContinuation")) goStaleTerminal(ctx, "sendContinuation");
    }
  }
}

// v0.28.4 (P1): graduated escalation entry — sent at nudge 1 and 2, BEFORE
// the HEARTBEAT_MAX_NUDGES brake can pause the goal. Tells the model exactly
// what closes the turn: complete_goal if done, pause_goal if blocked, a tool
// call otherwise. display: true — the user should see the warning too.
export function sendStallEscalation(ctx: ExtensionContext, nudges: number): void {
  if (flags.sessionHandoffPending || flags.initialSessionLoadPending || !flags.extensionApi || flags.extensionApiStale || continuationDispatchStoodDown || pendingContinuationDispatch) return;
  if (!state.goal || !guardGoalBeforeContinuation(ctx, "stall-escalation")) return;
  const remaining = HEARTBEAT_MAX_NUDGES - nudges;
  const text = [
    `[STALL WARNING ${nudges}/${HEARTBEAT_MAX_NUDGES}] The last turn produced no tool calls.`,
    "If the goal is DONE, call complete_goal NOW — prose closes nothing; only an auditor-approved complete_goal call closes a goal.",
    "If you are BLOCKED, call pause_goal with the blocker and a suggested action.",
    "Otherwise make a tool call that advances the goal this turn.",
    remaining === 1 ? "ONE more unproductive turn pauses the goal." : `${remaining} more unproductive turns pause the goal.`,
  ].join(" ");
  appendLedger(ctx.cwd, "stall_escalation_nudge", { nudges, remaining });
  const attempt = dispatchPrepare(ctx, {
    generation: flags.sessionGeneration,
    ownerSessionId: sessionManagerId(ctx),
    kind: "stall",
    goalId: state.goal?.id,
    marker: `[STALL WARNING ${nudges}/${HEARTBEAT_MAX_NUDGES}]`,
    resync: false,
  });
  if (!attempt) return;
  try {
    flags.extensionApi.sendMessage({ customType: GOAL_EVENT_ENTRY, content: text, display: true }, { triggerTurn: true, deliverAs: "followUp" });
    lastContinuationSentPayload = { content: text, display: true }; // v0.34.88: verbatim retry payload
    if (!dispatchAccepted(ctx, attempt)) return;
    appendLedger(ctx.cwd, "stall_escalation_dispatched", { nudges, remaining, attemptId: attempt.id });
    if (pendingContinuationDispatch === null) return;
    lastContinuationSentAt = attempt.sentAt;
    armQueueStuckProbe(lastContinuationSentAt);
  } catch (err) {
    if (pendingContinuationDispatch) dispatchFailed(ctx, pendingContinuationDispatch, err instanceof Error ? err.message : String(err));
    appendLedger(ctx.cwd, "stall_escalation_nudge_failed", { error: err instanceof Error ? err.message : String(err) });
    if (isStaleApiError(err)) {
      if (!attemptFreshSessionRecovery(ctx, "sendStallEscalation")) goStaleTerminal(ctx, "sendStallEscalation");
    }
  }
}

// v0.27.2: send the truncation-continue nudge. Same guards as
// sendContinuation (stale api = terminal), independent of goal state —
// plain sessions truncate too.
export function sendLengthContinue(ctx: ExtensionContext, consecutive: number): void {
  if (flags.sessionHandoffPending || flags.initialSessionLoadPending || !flags.extensionApi || flags.extensionApiStale || continuationDispatchStoodDown || pendingContinuationDispatch) return;
  if (state.goal && !guardGoalBeforeContinuation(ctx, "length-continuation")) return;
  const attempt = dispatchPrepare(ctx, {
    generation: flags.sessionGeneration,
    ownerSessionId: sessionManagerId(ctx),
    kind: "length",
    marker: LENGTH_CONTINUE_TEXT.slice(0, 80),
    resync: false,
  });
  if (!attempt) return;
  try {
    flags.extensionApi.sendMessage({
      customType: GOAL_EVENT_ENTRY,
      content: LENGTH_CONTINUE_TEXT,
      display: true,
    }, { triggerTurn: true, deliverAs: "followUp" });
    lastContinuationSentPayload = { content: LENGTH_CONTINUE_TEXT, display: true }; // v0.34.88: verbatim retry payload
    if (!dispatchAccepted(ctx, attempt)) return;
    appendLedger(ctx.cwd, "length_continue_sent", { consecutive, attemptId: attempt.id });
    ctx.ui.notify(`Response hit the output-token cap — auto-continuing (${consecutive}/${LENGTH_CONTINUE_MAX})`, "warning");
  } catch (err) {
    if (pendingContinuationDispatch) dispatchFailed(ctx, pendingContinuationDispatch, err instanceof Error ? err.message : String(err));
    appendLedger(ctx.cwd, "length_continue_send_failed", { consecutive, error: err instanceof Error ? err.message : String(err) });
    if (isStaleApiError(err)) {
      if (!attemptFreshSessionRecovery(ctx, "sendLengthContinue")) goStaleTerminal(ctx, "sendLengthContinue");
    }
  }
}

/* ------------------------------------------------------------------ */
/* Cluster G — post-compact resync + continuation prompt               */
/* ------------------------------------------------------------------ */

/** v0.32.1: deterministic post-compaction re-anchor (pi-goal-x's #5) —
 * prepended to the first continuation/loop message after a compact. */
export function buildPostCompactResync(): string {
  const lines: string[] = [
    "[POST-COMPACTION RESYNC] The transcript was just compacted. Trust the artifacts on disk and .pi-glla/ state — NOT your memory of the prior chat. Re-read files before editing them.",
  ];
  if (state.goal) {
    lines.push(`Goal ${state.goal.id} — status ${state.goal.status}`);
    lines.push(`Objective: ${state.goal.objective.slice(0, 200)}`);
    const next = findNextPendingTask(state.goal.taskList?.tasks ?? []);
    if (next) lines.push(`Next pending task: \`${next.id}\` — ${next.title}`);
    const lastAudit = state.goal.auditHistory?.[state.goal.auditHistory.length - 1];
    if (lastAudit) lines.push(`Last audit: ${auditVerdictLabel(lastAudit).toUpperCase()} (${lastAudit.at})`);
  } else if (state.loop?.active) {
    lines.push(`Loop: ${state.loop.target.slice(0, 160)} — iteration ${state.loop.iteration}`);
  }
  return lines.join("\n") + "\n\n";
}

export function continuationPrompt(goal: Goal): string {
  // Read the .md file as the template, then substitute {{tokens}}.
  // For v0.1.0 we inline-substitute so we don't need fs at runtime.
  const next = findNextPendingTask(goal.taskList?.tasks ?? []);
  const nextBlock = next
    ? `**Next pending task**: \`${next.id}\` — ${next.title}${next.agentRole ? ` [${next.agentRole}]` : ""}`
    : "**Next pending task**: (none — only call complete_goal when the objective is satisfied)";
  const taskSummary = goal.taskList?.tasks.length
    ? buildTaskSummary(goal.taskList.tasks)
    : "(no task list)";
  const tmplPath = path.resolve(__dirname, "..", "prompts", "goal-loop-continuation.md");
  let tmpl: string;
  try {
    tmpl = fs.readFileSync(tmplPath, "utf-8");
  } catch {
    tmpl = "[template-not-found]";
  }
  // v0.25.0 (contract items 22/28): conditional directives — aggressiveMode
  // TODOs from the audit cap, and the full-audit fan-out directive when the
  // objective reads as a survey pivot.
  const directives: string[] = [];
  directives.push(`## ${LONG_RUNNING_JUDGMENT_POLICY}`);
  const requestedDesigner = goal.agentRole === "designer" || next?.agentRole === "designer";
  if (requestedDesigner) {
    directives.push(
      "## DESIGNER ROLE REQUESTED\n\nThis objective or the next pending task explicitly requests design review. Use the `Agent` tool with agent name `Designer` before implementation to produce a concise architecture, risks, affected files, and verification plan. If that agent is unavailable or its provider fails, continue inline with the same design checkpoint and record the fallback; do not wait for or infer a provider reset.",
    );
  }
  if (goal.repairTarget) {
    const target = goal.repairTarget;
    directives.push(
      `## REPLAN REQUIRED — DO NOT COMPLETE THIS REPAIR CARD\n\nThe saved objective below was reviewer/verification text and is preserved as the real target. Redraft a task list for the original target now. Call \`propose_task_list\` with a concise, concrete \`objective\` describing that target and the tasks needed to verify it. The user must confirm the new plan before work resumes. Do not call \`complete_goal\` until the task list is accepted.\n\nOriginal target: ${target.objective}\nOriginal contract: ${target.verificationContract || "(none recorded)"}\nDetected reasons: ${target.reasons.join(", ")}`,
    );
  }
  const effSettings = resolveEffectiveAggressiveSettings(loadSettings(freshCtx()?.cwd ?? process.cwd()));
  if (goal.pendingTasks && goal.pendingTasks.length > 0) {
    directives.push(
      `## AUDITOR TODO LIST (from ${goal.pauseReason?.includes("cap") ? "the disapproval cap" : "the last audit"})\n\nAddress these objections, in order, before re-calling complete_goal:\n${goal.pendingTasks.map((t, i) => `${i + 1}. ${t}`).join("\n")}`,
    );
  }
  // v0.34.72 (note.md 2026-08-07): the vision-assist directive — seeing is
  // an mmx vision CLI job, never a reason to switch models (preapproval
  // gate: forbiddenModels). Injected whenever the setting is not disabled.
  if (loadSettings(freshCtx()?.cwd ?? process.cwd()).visionAssist !== false) {
    directives.push(VISION_ASSIST_GUIDANCE);
  }
  if (effSettings.aggressiveMode && isFullAuditObjective(goal.objective)) {
    directives.push(
      "## FULL-AUDIT MODE (aggressiveMode + survey objective)\n\nThis objective is a survey, not a single fix. Spawn 3+ `Explore` subagents NOW — one per subsystem, in a single message so they run in parallel — synthesize their findings, and call `propose_task_list` with the result. Do not start fixing before the task list exists.",
    );
  }
  // v0.35.x: include the latest auditor disapproval/impossible/shield-blocked report so the agent
  // sees the actual objections instead of a generic instruction.
  const lastAudit = goal.auditHistory?.[goal.auditHistory.length - 1];
  if (lastAudit && lastAudit.report) {
    const report = lastAudit.report.trim();
    let label = "DISAPPROVAL";
    if (lastAudit.impossible) label = "IMPOSSIBLE";
    else if (lastAudit.approved && lastAudit.regressionShieldPassed === false) label = "REGRESSION SHIELD BLOCKED";
    else if (lastAudit.disapproved) label = "DISAPPROVAL";
    directives.push(
      `## LATEST AUDITOR ${label} (${lastAudit.at})\n\nThe auditor ${label.toLowerCase()} the last completion claim. Here is the full report:\n\n${report}`,
    );
  }
  
  // v0.35.x: detect stale revision rejection — auditor approved at old revision,
  // goal contract has since advanced. The approval was refused; agent must call
  // complete_goal again to trigger a fresh audit at current revision.
  const currentRevision = goal.revision ?? 0;
  const auditedRevision = lastAudit?.revision ?? 0;
  if (
    goal.status === "active" &&
    !goal.pendingCompletion &&
    lastAudit &&
    lastAudit.approved &&
    !lastAudit.disapproved &&
    !lastAudit.impossible &&
    lastAudit.regressionShieldPassed !== false &&
    currentRevision > auditedRevision
  ) {
    directives.push(
      "## STALE AUDITOR APPROVAL — REVISION MISMATCH\n\n" +
      "The auditor APPROVED the last completion claim at revision " + auditedRevision + ", but the goal contract has since advanced to revision " + currentRevision + ". The approval was REFUSED as stale.\n\n" +
      "**Action required:** Call `complete_goal` AGAIN with the same completion summary — this will trigger a fresh audit at the current contract revision (" + currentRevision + "). Do NOT pause or tweak; the work is done, the auditor just needs to re-verify at the new revision.",
    );
  }
  const dynamicDirectives = directives.length > 0 ? directives.join("\n\n") : "(no active directives)";
  // Use replacement callbacks: String.replace interprets `$&`, `$1`, `$'`,
  // and ``$``` inside replacement strings, which can corrupt perfectly valid
  // user objectives/contracts while the durable state remains intact.
  return tmpl
    .replace(/\$\{GOAL_ID\}/g, () => goal.id)
    .replace(/\$\{OBJECTIVE\}/g, () => goal.objective)
    .replace(/\$\{VERIFICATION_CONTRACT\}/g, () => goal.verificationContract || "(none — auditor will decide based on objective)")
    .replace(/\$\{TASK_LIST\}/g, () => taskSummary)
    .replace(/\$\{NEXT_PENDING_TASK_BLOCK\}/g, () => nextBlock)
    .replace(/\$\{LONG_RUNNING_JUDGMENT_POLICY\}/g, () => LONG_RUNNING_JUDGMENT_POLICY)
    .replace(/\$\{DYNAMIC_DIRECTIVES\}/g, () => dynamicDirectives);
}

/* ------------------------------------------------------------------ */
/* Accessors — goal.ts / sibling factories observe continuation-owned  */
/* state ONLY through these (never by reading the module lets).        */
/* ------------------------------------------------------------------ */

export function continuationTimerPending(): boolean {
  return continuationTimer !== null;
}
export function continuationStartTimerPending(): boolean {
  return continuationStartTimer !== null;
}
export function continuationTimerRef(): NodeJS.Timeout | null {
  return continuationTimer;
}
export function continuationStartTimerRef(): NodeJS.Timeout | null {
  return continuationStartTimer;
}
export function pendingContinuationDispatchRef(): ContinuationDispatch | null {
  return pendingContinuationDispatch;
}
export function setPendingContinuationDispatchRef(v: ContinuationDispatch | null): void {
  pendingContinuationDispatch = v;
}
export function continuationDispatchStoodDownRef(): boolean {
  return continuationDispatchStoodDown;
}
export function setContinuationDispatchStoodDownRef(v: boolean): void {
  continuationDispatchStoodDown = v;
}
export function lastContinuationSentAtRef(): number {
  return lastContinuationSentAt;
}
export function setLastContinuationSentAtRef(v: number): void {
  lastContinuationSentAt = v;
}
export function lastContinuationSentPayloadRef(): { content: string; display: boolean } | null {
  return lastContinuationSentPayload;
}
export function setLastContinuationSentPayloadRef(v: { content: string; display: boolean } | null): void {
  lastContinuationSentPayload = v;
}
export function clearQueueStuckProbe(): void {
  if (queueStuckProbe) { clearTimeout(queueStuckProbe); queueStuckProbe = null; }
}
export function setContinuationRearmStreak(v: number): void {
  continuationRearmStreak = v;
}
export function setContinuationRearmSince(v: number): void {
  continuationRearmSince = v;
}

/** Clear every in-memory and file-backed continuation dispatch artifact.
 * Destructive lifecycle commands use this rather than only clearing a timer:
 * a pending dispatch can otherwise resurrect after a reload from its sidecar.
 */
export function resetContinuationDispatchState(cwd: string): boolean {
  clearContinuationTimer();
  clearContinuationStartWatchdog();
  clearQueueStuckProbe();
  continuationDispatchStoodDown = false;
  continuationRearmStreak = 0;
  continuationRearmSince = 0;
  continuationRearmMilestone = 0;
  lastNoTurnStartedNotifiedAt = 0;
  continuationStartCompactionRearms.clear();
  continuationStartRecoveryRearms.clear();
  return clearDispatchRecord(cwd);
}
