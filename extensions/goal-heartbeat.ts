// ============================================================================
// goal-heartbeat.ts — decomposition step 4 (v0.34.112)
// ============================================================================
// The heartbeat/watchdog cluster extracted from extensions/loops/goal.ts:
//   - subagent-hang watchdog machinery (v0.34.85 + v0.34.102 + v0.34.105)
//   - heartbeatTick() — the orphan/stale/latch/refire/wedge watchdog
//   - startHeartbeat() — the production 15s cadence driver
//   - the 5 test-only heartbeat hooks
//
// Positioning invariants (docs/GLLA-POSITIONING-AND-DECOMPOSITION-2026-08-08.md):
//   - ZERO behavior change: moved function bodies are byte-identical except
//     mechanical `flags.X` accessor re-spellings for goal.ts-owned lets.
//   - One-way imports: this module NEVER imports from extensions/loops/goal.ts.
//   - Module-level flags stay owned by goal.ts (single mutable state object),
//     observed here through the HeartbeatFlags accessor (mirror-lets pattern,
//     same as goal-loop.ts's LoopFlags / goal-recovery.ts's RecoveryFlags).
//   - Ledger event names unchanged (heartbeat_refire, pending_latch_stuck,
//     wedge_alert, zombie_run_suspected, continuation_unanswered,
//     stranded_audit_recovered, subagent_hang_detected, ...).
// ============================================================================

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { state } from "./goal-state.js";
import {
  DEFAULT_STALL_ESCALATION_REFIRES,
  appendLedger,
  nowIso,
  resolveEffectiveAggressiveSettings,
  supervisorPaused,
  type Goal,
} from "./goal-loop-core.js";
import { loadSettings } from "./goal-settings.js";
import {
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_STALL_MS,
  PENDING_LATCH_STUCK_MS,
  WEDGE_ALERT_DEFAULT_MINUTES,
  shouldFirePendingLatchWatchdog,
  shouldHeartbeatRefire,
  shouldWedgeAlert,
} from "./goal-loop-backoff.js";
import { isLoopActive, loopTimerPending, scheduleLoopTick } from "./goal-loop.js";
import { mainModelRecoveryActive, markCompletionAuditRecoveryPending, probeMainModelRecovery } from "./goal-recovery.js";
import type { ContinuationDispatch } from "./goal-loop-dispatch.js";

/** goal.ts-owned module lets the heartbeat reads/writes through this accessor.
 * Getters/setters are wired by goal.ts at factory time (mirror-lets pattern). */
export interface HeartbeatFlags {
  get zombieStoodDown(): boolean;
  set zombieStoodDown(v: boolean);
  get initialSessionLoadPending(): boolean;
  get sessionGeneration(): number;
  get lastCtx(): ExtensionContext | null;
  get extensionApi(): unknown;
  get extensionApiStale(): boolean;
  set extensionApiStale(v: boolean);
  get completionAuditInFlight(): boolean;
  get completionAuditRecoveryArmed(): boolean;
  get lastActivityAt(): number;
  get staleTerminalDone(): boolean;
  set staleTerminalDone(v: boolean);
  get sessionHandoffPending(): boolean;
  set sessionHandoffPending(v: boolean);
  get compactionGraceUntil(): number;
  get continuationDispatchStoodDown(): boolean;
  get pendingContinuationDispatch(): ContinuationDispatch | null;
  get postCompactResumeOwed(): boolean;
  set postCompactResumeOwed(v: boolean);
  get postCompactResyncPending(): boolean;
  set postCompactResyncPending(v: boolean);
  get abortedStandDown(): boolean;
  get continuationTimer(): NodeJS.Timeout | null;
  get continuationStartTimer(): NodeJS.Timeout | null;
  get lastStreamActivityAt(): number;
  get lastContinuationSentAt(): number;
  get lastRealActivityAt(): number;
  get consecutiveStalls(): number;
  set consecutiveStalls(v: number);
  get heartbeatNudges(): number;
  get inFlightToolCalls(): ReadonlyMap<string, { name: string; arg?: string; at: number }>;
  get contextStarvedStreak(): number;
  get lastContextStarvedAt(): number;
  get heartbeatTimer(): NodeJS.Timeout | null;
  set heartbeatTimer(v: NodeJS.Timeout | null);
  get heartbeatStaleStreak(): number;
  set heartbeatStaleStreak(v: number);
}

/** goal.ts functions the heartbeat calls, injected as mirror-lets. */
export interface HeartbeatDeps {
  absorbStaleIfSuperseded(ctx: ExtensionContext): boolean;
  goStaleTerminal(ctx: ExtensionContext, where: string): void;
  probeExtensionApiStaleRaw(): boolean;
  tryAbsorbHostSuccessor(ctx: ExtensionContext, via: string): boolean;
  rememberCtx(ctx: ExtensionContext): void;
  freshCtx(): ExtensionContext | null;
  activeGoalSurfaceCommand(command: string): string;
  notifyExternal(ctx: ExtensionContext, message: string): void;
  updateGoal(patch: Partial<Goal>, ctx: ExtensionContext): void;
  /** Park durable completion debt without touching a retained stale context. */
  parkCompletionAuditRecovery(cwd: string, reason: string): boolean;
  isSupervising(): boolean;
  isActionableGoal(): boolean;
  scheduleContinuation(ctx: ExtensionContext, force?: boolean, delayMs?: number): void;
  noteActivity(real?: boolean): void;
  escalateStallNow(ctx: ExtensionContext, threshold: number): boolean;
  isContextStarvedRefused(): boolean;
  goalNoun(): string;
  continuationUnansweredMs: number;
  continuationUnansweredThrottleMs: number;
  /** Abort and durably park the owner of a confirmed zero-stream turn. */
  abortZombieRun(ctx: ExtensionContext, generation: number, goalId: string | undefined, lastStreamActivityAt: number): boolean;
}

let flags: HeartbeatFlags;
let absorbStaleIfSuperseded: HeartbeatDeps["absorbStaleIfSuperseded"];
let goStaleTerminal: HeartbeatDeps["goStaleTerminal"];
let probeExtensionApiStaleRaw: HeartbeatDeps["probeExtensionApiStaleRaw"];
let tryAbsorbHostSuccessor: HeartbeatDeps["tryAbsorbHostSuccessor"];
let rememberCtx: HeartbeatDeps["rememberCtx"];
let freshCtx: HeartbeatDeps["freshCtx"];
let activeGoalSurfaceCommand: HeartbeatDeps["activeGoalSurfaceCommand"];
let notifyExternal: HeartbeatDeps["notifyExternal"];
let updateGoal: HeartbeatDeps["updateGoal"];
let parkCompletionAuditRecovery: HeartbeatDeps["parkCompletionAuditRecovery"];
let isSupervising: HeartbeatDeps["isSupervising"];
let isActionableGoal: HeartbeatDeps["isActionableGoal"];
let scheduleContinuation: HeartbeatDeps["scheduleContinuation"];
let noteActivity: HeartbeatDeps["noteActivity"];
let escalateStallNow: HeartbeatDeps["escalateStallNow"];
let isContextStarvedRefused: HeartbeatDeps["isContextStarvedRefused"];
let goalNoun: HeartbeatDeps["goalNoun"];
let continuationUnansweredMs: HeartbeatDeps["continuationUnansweredMs"];
let continuationUnansweredThrottleMs: HeartbeatDeps["continuationUnansweredThrottleMs"];
let abortZombieRun: HeartbeatDeps["abortZombieRun"];

export function createGoalHeartbeat(flagsArg: HeartbeatFlags, d: HeartbeatDeps): void {
  flags = flagsArg;
  absorbStaleIfSuperseded = d.absorbStaleIfSuperseded;
  goStaleTerminal = d.goStaleTerminal;
  probeExtensionApiStaleRaw = d.probeExtensionApiStaleRaw;
  tryAbsorbHostSuccessor = d.tryAbsorbHostSuccessor;
  rememberCtx = d.rememberCtx;
  freshCtx = d.freshCtx;
  activeGoalSurfaceCommand = d.activeGoalSurfaceCommand;
  notifyExternal = d.notifyExternal;
  updateGoal = d.updateGoal;
  parkCompletionAuditRecovery = d.parkCompletionAuditRecovery;
  isSupervising = d.isSupervising;
  isActionableGoal = d.isActionableGoal;
  scheduleContinuation = d.scheduleContinuation;
  noteActivity = d.noteActivity;
  escalateStallNow = d.escalateStallNow;
  isContextStarvedRefused = d.isContextStarvedRefused;
  goalNoun = d.goalNoun;
  continuationUnansweredMs = d.continuationUnansweredMs;
  continuationUnansweredThrottleMs = d.continuationUnansweredThrottleMs;
  abortZombieRun = d.abortZombieRun;
}

// ----------------------------------------------------------------------------
// Heartbeat module state (moved from goal.ts — owned HERE, not by goal.ts)
// ----------------------------------------------------------------------------
let lastZombieAlertAt = 0;
let lastWedgeAlertAt = 0;
// A zero-stream warning is intentionally not an immediate abort: a long
// provider operation can be quiet briefly while its turn remains healthy.
// Once the bounded grace expires, the owner parks the goal and aborts the
// host turn exactly once. The key fences repeated heartbeat ticks and lets a
// later explicit resume start a fresh, independently bounded attempt.
let lastZombieAbortKey = "";
let zombieRunSilentMsOverride: number | null = null;
let zombieRunAbortGraceMsOverride: number | null = null;

const ZOMBIE_RUN_SILENT_MS = 20 * 60_000;
const ZOMBIE_RUN_ABORT_GRACE_MS = 10 * 60_000;
const ZOMBIE_RUN_ALERT_THROTTLE_MS = 10 * 60_000;

// v0.35.26 (issue #13): ONE shared name set for "the parent is legitimately
// stream-silent because it is blocked on a subagent call" — consumed by both
// the zombie stand-down and the wedge-alert hint so the two sites cannot
// drift apart again (that drift is exactly the bug). The legacy built-in
// names (Agent / get_subagent_result / steer_subagent) are joined by the
// pi-subagents extension's registrations: its foreground dispatch tool is
// named "subagent" and its blocking background wait is "subagent_wait"
// (field 2026-08-21: a healthy foreground child wrote Postgres records for
// 30 productive minutes while the parent was stream-silent on `subagent` —
// the watchdog aborted it at the grace boundary anyway).
const SUBAGENT_WAIT_TOOL_NAMES: ReadonlySet<string> = new Set([
  "Agent",
  "get_subagent_result",
  "steer_subagent",
  "subagent",
  "subagent_wait",
]);
const isSubagentWaitCall = (t: { name?: string }): boolean =>
  typeof t.name === "string" && SUBAGENT_WAIT_TOOL_NAMES.has(t.name);

// ============================================================================
// v0.35.28 (issue #16): due-wait backstop — the durable invariant that a
// pauseKind "wait" actually resumes when its pauseResumeAt lapses.
//
// Field report: a goal sat paused for 30+ minutes past its scheduled
// auto-resume while the agent narrated "the system should have auto-resumed
// by now". Investigation found auto-resume relied SOLELY on in-memory
// timers: agent-authored waits (pause_goal kind="wait") armed NO timer at
// all while their own copy promised automatic continuation; error-brake
// cooldowns were not re-armed on session_start; and every scheduled resume
// died with the session that created it. The heartbeat now compares wall
// time against pauseResumeAt on every tick and re-fires the route.
const WAIT_OVERDUE_GRACE_MS = 90 * 1_000;
/** One backstop attempt per (goalId:resumeAt) pair — the underlying route
 * rewrites pauseResumeAt when it re-parks, which re-arms the key. */
let lastOverdueWaitKey = "";

function overdueWaitDue(): boolean {
  const goal = state.goal;
  if (!goal || goal.status !== "paused" || goal.pauseKind !== "wait") return false;
  if (typeof goal.pauseResumeAt !== "string") return false;
  const dueMs = Date.now() - Date.parse(goal.pauseResumeAt);
  if (!Number.isFinite(dueMs) || dueMs < WAIT_OVERDUE_GRACE_MS) return false;
  // Manual /glla pause and the v0.35.23 load hold freeze ALL automatic
  // dispatch — an overdue wait under them stays frozen until an explicit
  // resume releases the hold (same consent boundary as session_start).
  if (supervisorPaused(state)) return false;
  return `${goal.id}:${goal.pauseResumeAt}` !== lastOverdueWaitKey;
}

function overdueWaitBackstop(ctx: ExtensionContext): void {
  if (!overdueWaitDue()) return;
  const goal = state.goal!;
  const reason = goal.pauseReason ?? "";
  lastOverdueWaitKey = `${goal.id}:${goal.pauseResumeAt}`;
  appendLedger(ctx.cwd, "wait_pause_overdue_resume", {
    goalId: goal.id,
    pauseResumeAt: goal.pauseResumeAt,
    overdueMs: Date.now() - Date.parse(goal.pauseResumeAt!),
    reason: reason.slice(0, 160),
    route: reason.startsWith("main model recovery") ? "main-model-probe" : "continuation",
  });
  if (reason.startsWith("main model recovery")) {
    void probeMainModelRecovery(ctx).catch(() => { /* re-parks with a fresh resumeAt on failure */ });
    return;
  }
  // Agent-authored waits and error-brake cooldowns alike: the stated wait
  // condition's deadline has passed — clear the park and re-dispatch, with
  // a recovery stamp so the continuation prompt tells the agent it was
  // ITSELF that was recovered (issue #16 part 2).
  updateGoal({
    status: "active",
    pauseKind: undefined,
    pauseResumeAt: undefined,
    pauseReason: undefined,
    pauseSuggestedAction: undefined,
    autoResumedAt: new Date().toISOString(),
    autoResumedEvent: `overdue wait resumed (${reason.slice(0, 80) || "time-gated wait"})`,
  }, ctx);
  scheduleContinuation(ctx, true);
}

/** Test-only: reset the due-wait backstop latch between isolated rigs. */
export function __testOnlyResetOverdueWaitBackstop(): void {
  lastOverdueWaitKey = "";
}

function zombieRunSilentMs(): number {
  return zombieRunSilentMsOverride ?? ZOMBIE_RUN_SILENT_MS;
}

function zombieRunAbortGraceMs(): number {
  return zombieRunAbortGraceMsOverride ?? ZOMBIE_RUN_ABORT_GRACE_MS;
}

/** Test-only: shrink the zero-stream windows without changing production
 * defaults. Passing null restores the 20m warning + 10m abort grace. */
export function __testOnlySetZombieRunWindows(silentMs: number | null, abortGraceMs: number | null = null): void {
  zombieRunSilentMsOverride = silentMs;
  zombieRunAbortGraceMsOverride = abortGraceMs;
  lastZombieAlertAt = 0;
  lastZombieAbortKey = "";
}

/** Test-only reset for the process-global watchdog state. */
export function __testOnlyResetZombieRunWatchdog(): void {
  zombieRunSilentMsOverride = null;
  zombieRunAbortGraceMsOverride = null;
  lastZombieAlertAt = 0;
  lastZombieAbortKey = "";
}

/** v0.35.17: release the one-shot abort latch when the bounded automatic
 * retry dispatches a fresh attempt. Without this, a retry whose send never
 * even starts (no agent_start to advance the stream clock) would reproduce
 * the exact abort key of its parent episode and the heartbeat could warn but
 * NEVER re-abort — a permanently BUSY-silent session. */
export function releaseZombieAbortKey(): void {
  lastZombieAbortKey = "";
}

let lastUnansweredAlertAt = 0;

// v0.35.4: one-shot-per-episode latch for the context-starved warning. The
// old second-precision timestamp gate re-emitted on every heartbeat tick
// that landed in a fresh second (~once per 15s tick while the 90s refusal
// window held — six re-fires per episode). Fires once per refusal episode
// and re-arms only after isContextStarvedRefused() clears (a real
// compaction or the window lapsing).
let starvedRefusedNotified = false;

// heartbeatStaleDebounce is overridable via __testOnlySetHeartbeatStaleDebounce.
const HEARTBEAT_STALE_DEBOUNCE = 3;
let heartbeatStaleDebounce = HEARTBEAT_STALE_DEBOUNCE;
// =================================================================
// v0.34.85 — subagent hang watchdog
// =================================================================
// note.md Screenshots 161019/161032: subagents frozen at 10697s (3h) with
// zero stream activity — repeated "BUSY with zero stream activity" warnings
// at 22/31/41 min. The auditor's detached worker has a heartbeat-without-
// progress watchdog (auditor-process.ts, 10m default); subagent sessions
// have NONE — a wedged subagent burns parent tokens for hours before anyone
// notices. This watchdog gives subagents the same fail-fast: a subagent
// whose pi-subagents record is still "running" but shows NO new progress
// (tool uses or assistant output tokens) for SUBAGENT_HANG_NO_PROGRESS_MS
// (5m default — SHORTER than the auditor's 10m, because a hung subagent
// costs parent tokens on every turn) is surfaced to the user and ledgered
// `subagent_hang_detected`. Detection + guidance only: the main session
// decides whether to abort — never an auto-kill.
const SUBAGENT_HANG_NO_PROGRESS_MS = 5 * 60_000;
// v0.34.102 (field: pully W161 rehearsal agent aac4ab1e, 2026-08-08T08:15
// → 10:13 — a 118-minute wedge where `subagent_hang_detected` NEVER fired
// because the manager record was unreachable and classifyHungSubagents
// skipped the probe at `if (!rec) continue`). When the pi-subagents record
// is ABSENT (manager not loaded, record pruned, or poll shape changed) the
// probe's own event-derived evidence — spawn time + compacted/steered
// refreshes — is the only liveness signal left. Long-wait threshold so a
// healthy child that merely lacks a pollable record isn't flagged as hung;
// a wedged child with NO event evidence at all trips this.
const SUBAGENT_HANG_EVENT_ONLY_MS = 20 * 60_000;
/** Re-alert throttle — one user-facing hang warning per streak window. */
const SUBAGENT_HANG_ALERT_THROTTLE_MS = 5 * 60_000;
/** Ended probes are pruned an hour after completion (HUD/final-state reads). */
const SUBAGENT_HANG_PRUNE_MS = 60 * 60_000;

function pruneEndedSubagentHangProbes(now = Date.now()): void {
  for (const [id, probe] of subagentHangProbes) {
    if (probe.endedAt !== undefined && now - probe.endedAt >= SUBAGENT_HANG_PRUNE_MS) {
      subagentHangProbes.delete(id);
    }
  }
}

function hasLiveSubagentHangProbes(now = Date.now()): boolean {
  pruneEndedSubagentHangProbes(now);
  for (const probe of subagentHangProbes.values()) {
    if (probe.endedAt === undefined) return true;
  }
  return false;
}

interface SubagentHangProbe {
  recordId: string;
  agentType?: string;
  summary?: string;
  spawnedAt: number;
  /** Last time the subagent delivered NEW progress (tool use / output tokens). */
  lastProgressAt: number;
  /** Last polled record.toolUses — progress when it increases. */
  lastToolUses: number;
  /** Last polled record.lifetimeUsage.output — progress when it increases. */
  lastOutputTokens: number;
  /** Throttle: last user-facing hang warning for this subagent. */
  hangAlertedAt?: number;
  endedAt?: number;
}

const subagentHangProbes = new Map<string, SubagentHangProbe>();

/** pi-subagents publishes a cross-package manager registry
 * (Symbol.for("pi-subagents:manager"), agent-manager.ts) exposing
 * getRecord(id) with LIVE toolUses / lifetimeUsage / status — the join that
 * lets the main session distinguish "working" from "wedged" without any
 * cross-extension stream event. Defensive: absent when pi-subagents isn't
 * loaded or the record shape changes (falls back to event-only evidence). */
const SUBAGENT_MANAGER_KEY = Symbol.for("pi-subagents:manager");
type SubagentRecordPoll = { toolUses?: number; lifetimeUsage?: { output?: number }; status?: string };
type SubagentManagerPoll = { getRecord?: (id: string) => SubagentRecordPoll | undefined };
function subagentManagerPoller(): SubagentManagerPoll {
  try {
    return ((globalThis as any)[SUBAGENT_MANAGER_KEY] ?? {}) as SubagentManagerPoll;
  } catch {
    return {};
  }
}

export function upsertSubagentHangProbe(recordId: string, agentType: string | undefined, summary: string | undefined, now = Date.now()): void {
  const existing = subagentHangProbes.get(recordId);
  if (existing) {
    // Re-observation (resume / re-run): fresh evidence + refreshed metadata.
    existing.lastProgressAt = now;
    existing.endedAt = undefined;
    if (agentType) existing.agentType = agentType;
    if (summary) existing.summary = summary;
    return;
  }
  subagentHangProbes.set(recordId, {
    recordId, agentType, summary,
    spawnedAt: now, lastProgressAt: now, lastToolUses: 0, lastOutputTokens: 0,
  });
}

export function markSubagentHangProgress(recordId: string, now = Date.now()): void {
  const p = subagentHangProbes.get(recordId);
  if (p) p.lastProgressAt = now;
}

export function endSubagentHangProbe(recordId: string, now = Date.now()): void {
  const p = subagentHangProbes.get(recordId);
  if (p) p.endedAt = now;
}

/** v0.34.85: which probes are hung right now? MUTATES the passed probes'
 * progress counters (advances lastToolUses/lastOutputTokens/lastProgressAt)
 * so a streak resets when progress resumes — the same driver semantics as
 * the auditor's heartbeat watchdog. A probe is hung when its record is
 * still running (or queued/steered) and it produced no NEW progress for ≥
 * SUBAGENT_HANG_NO_PROGRESS_MS. Records that vanished or ended are skipped
 * (the driver prunes ended probes). Exported pure for tests. */
export function classifyHungSubagents(
  probes: Array<{
    recordId: string;
    lastProgressAt: number;
    lastToolUses: number;
    lastOutputTokens: number;
    endedAt?: number;
  }>,
  getRecord: (id: string) => SubagentRecordPoll | undefined,
  now = Date.now(),
): Array<{ recordId: string; silentMs: number }> {
  const hung: Array<{ recordId: string; silentMs: number }> = [];
  for (const p of probes) {
    if (p.endedAt !== undefined) continue;
    const rec = getRecord(p.recordId);
    if (!rec) {
      // v0.34.102 event-only fallback: the manager record is unreachable.
      // Old behavior silently skipped (field: pully 118m wedge, zero
      // `subagent_hang_detected`). The probe's event-derived lastProgressAt
      // (spawn seed + compacted/steered refreshes) is the surviving liveness
      // evidence — classify against the longer event-only window instead of
      // vanishing. A record that ended normally sets endedAt above and never
      // reaches here.
      const silentMs = now - p.lastProgressAt;
      if (silentMs >= SUBAGENT_HANG_EVENT_ONLY_MS) hung.push({ recordId: p.recordId, silentMs });
      continue;
    }
    if (rec.status !== "running" && rec.status !== "steered" && rec.status !== "queued") continue;
    const toolUses = rec.toolUses ?? 0;
    const output = rec.lifetimeUsage?.output ?? 0;
    if (toolUses > p.lastToolUses || output > p.lastOutputTokens) {
      p.lastToolUses = toolUses;
      p.lastOutputTokens = output;
      p.lastProgressAt = now;
      continue;
    }
    const silentMs = now - p.lastProgressAt;
    if (silentMs >= SUBAGENT_HANG_NO_PROGRESS_MS) hung.push({ recordId: p.recordId, silentMs });
  }
  return hung;
}

function heartbeatTick(): void {
  if (flags.zombieStoodDown || flags.initialSessionLoadPending) return; // blank startup waits for pi to bind a real session
  // v0.35.15: a MANUAL `/glla pause` freezes the supervisor's automatic
  // machinery — re-arms, stale probes, zombie cleanup, refires, everything
  // this tick drives. The user explicitly asked for a hands-off window; no
  // heartbeat side-effect may fire inside it. `/glla resume` restores it.
  // v0.35.23 (note.md Next #2): the automatic LOAD HOLD is different — the
  // tick stays ALIVE under it because host-loss supervision is safety
  // machinery, not automation (a held plane must not become an unprobed
  // idle plane). Everything this tick could DISPATCH downstream checks the
  // same hold via supervisorPaused() and refuses; only probes/ledger run.
  if (typeof state.supervisorPausedAt === "number") return;
  // A completed/paused/held plane has no host-bound work to supervise. Do
  // not probe the retained ExtensionAPI in that idle state: pi may dispose a
  // session handle during an unrelated session transition, and reporting
  // that disposed handle as a host loss only creates the repeated
  // "session invalidated" warning after the work is already safe on disk.
  // Keep the probe for active goals/loops, detached completion audits,
  // recoverable stale debt, parked completion-audit recovery, and LIVE
  // tracked subagents, where a dead handle can strand live work. A normal
  // user pause does not count as host-bound work; stale interruption debt and
  // parked completion claims do, because same-process self-heal still needs a
  // heartbeat opportunity. Ended subagent probes remain in memory briefly for
  // HUD/final-state reads, but they no longer own the host and must not keep
  // this guard probing a disposed handle.
  const terminalGoal = state.goal?.status === "complete" || state.goal?.status === "aborted";
  const staleRecoveryDebt = (!terminalGoal && state.goal?.interruptedReason?.startsWith("extension api stale"))
    || state.loop?.stopReason?.startsWith("extension api stale");
  const parkedCompletionAuditRecovery = state.goal?.status === "paused"
    && state.goal.pendingCompletion?.phase === "recovery-pending";
  // v0.35.28 (issue #16): a lapsed wait-pause is host-bound work too — the
  // heartbeat owns its durable due-time backstop (see overdueWaitBackstop).
  if (overdueWaitDue()) {
    // fall through: the backstop below needs a heartbeat opportunity
  } else if (state.goal?.status !== "active"
    && state.goal?.status !== "auditing"
    && !isLoopActive()
    && !staleRecoveryDebt
    && !parkedCompletionAuditRecovery
    && !hasLiveSubagentHangProbes()) return;
  // Probe the ExtensionAPI BEFORE probing the captured context. When pi
  // invalidates both handles and emits no replacement session_start,
  // freshCtx() deliberately returns null; probing it first used to make the
  // orphan watchdog silently return forever, leaving the goal green without
  // a durable interruption marker. Keep the last context long enough for the
  // terminal path to persist the honest orphan state.
  const knownCtx = flags.lastCtx;
  // v0.34.80 (field: 2026-08-07 item-2 freeze): a latched-stale LIVE session
  // (transient heartbeat-probe failures tripping goStaleTerminal) freezes an
  // auditing goal with no in-flight audit: the completed verdict's apply path
  // silently bails on freshCtxForGeneration()=null and the full stranded-
  // recovery block below is unreachable while the latch holds — the queue sat
  // blocked ~30m+ while the worker's disapproval sat on disk. Park the stuck
  // claim via the kept last context. A heartbeat must still NEVER launch
  // another worker directly; the park is the durable recovery gate, and a
  // later healthy same-session heartbeat may hand it to the one-shot recovery
  // path. Explicit resume remains available when no healthy host returns.
  if (
    flags.extensionApiStale &&
    knownCtx &&
    state.goal?.status === "auditing" &&
    !flags.completionAuditInFlight &&
    state.goal.pendingCompletion &&
    Date.now() - flags.lastActivityAt >= 90_000
  ) {
    // The retained context is probe-only after a stale terminal. Never use it
    // for state/UI mutation: a stale ctx can throw halfway through the park.
    const current = freshCtx();
    if (current) {
      appendLedger(current.cwd, "stranded_audit_recovered", { goalId: state.goal.id, via: "stale-latch" });
      markCompletionAuditRecoveryPending(current, "stale-latch-recovery");
      try {
        current.ui.notify(`Completion audit blocked — no verdict (stale session). The stored claim is safe; ${activeGoalSurfaceCommand("resume")} starts exactly one fresh auditor.`, "warning");
      } catch {
        /* the ledger + park are durable; notification is best-effort */
      }
      return;
    }
    // A stale terminal intentionally makes freshCtx() return null. Recover the
    // durable claim through a context-free cwd bridge instead of passing the
    // retained stale ExtensionContext into updateGoal/persistState/UI.
    let cwd: string | null = null;
    try { cwd = knownCtx.cwd; } catch { /* no durable path available */ }
    if (!cwd) return;
    appendLedger(cwd, "stranded_audit_recovered", { goalId: state.goal.id, via: "stale-latch" });
    parkCompletionAuditRecovery(cwd, "stale-latch-recovery");
    return;
  }
  const rawApiStale = probeExtensionApiStaleRaw();
  const staleTerminalRecovered = flags.staleTerminalDone
    && !!knownCtx
    && flags.extensionApi !== null
    && !rawApiStale;
  if ((flags.extensionApiStale && !staleTerminalRecovered) || rawApiStale) {
    if (!flags.extensionApiStale) {
      // v0.34.62: debounce — ONE transient probe failure (pi mid-settle,
      // compaction settle, provider pause) must not park a live session.
      // Field: hegemon 2026-08-06T20:06Z — a single heartbeat probe failure
      // latched the terminal and held the session in "handing off to a fresh
      // pi context" for ~5h with NO session_start ever arriving (compaction
      // emits only session_compact); the only recovery was a restart.
      flags.heartbeatStaleStreak++;
      if (flags.heartbeatStaleStreak < heartbeatStaleDebounce) return;
    }
    if (knownCtx && tryAbsorbHostSuccessor(knownCtx, "heartbeat-probe")) return;
    if (knownCtx && !absorbStaleIfSuperseded(knownCtx)) goStaleTerminal(knownCtx, "heartbeat probe");
    return;
  }
  flags.heartbeatStaleStreak = 0;
  // v0.34.94 (host-session-lost self-heal): if the heartbeat's raw probe
  // says pi is fresh but the plugin is in stale-terminal (the gap between
  // goStaleTerminal and a session_start that may never arrive — the
  // silent_handle_death reason the user hit in darklord/hegemon
  // Screenshot_20260808_080109/080230/080248), the raw probe is evidence
  // pi has recovered. Clear the stale flags so a subsequent freshCtx()
  // call can return a non-null ctx; if tryAbsorbHostSuccessor lands (the
  // replacement session id matches this ctx), the goal plane re-binds.
  // If the absorb fails (still same session, no replacement), we just
  // proceed with the normal heartbeat — no sends are re-queued, so there
  // is no blind queue storm risk.
  if (flags.staleTerminalDone && knownCtx) {
    appendLedger(knownCtx.cwd, "stale_terminal_recovered_via_probe", { via: "heartbeat-self-heal" });
    // Try the real successor and same-session recovery gates while the stale
    // flags are still set. Clearing them first bypasses selfHealStaleSameSession
    // and leaves the durable interrupted marker behind.
    if (tryAbsorbHostSuccessor(knownCtx, "heartbeat-self-heal")) return;
    rememberCtx(knownCtx);
    // Reuse the same-session recovery gate as ordinary commands. It clears
    // the durable interrupted marker and rebinds the owner only after BOTH
    // the context and the captured ExtensionAPI are healthy. If that gate
    // refuses the contact, stay parked: clearing these flags here used to
    // announce a false recovery and immediately retry against the same stale
    // API every heartbeat tick.
    if (flags.staleTerminalDone || flags.extensionApiStale) return;
  }
  const ctx = freshCtx();
  if (!ctx) return;
  // v0.34.105 (field: 2026-08-08 16:18 — provider failure froze subagent
  // 74305f7e while the MAIN model was also in recovery; heartbeatTick
  // returned at the `mainModelRecoveryActive()` gate BELOW, so the
  // subagent hang scan never ran and the 12m+ wedge produced ZERO
  // `subagent_hang_detected`). The scan is detection + notify only
  // (never an auto-kill, never a send) — it MUST run even while the
  // main model is parked, because a shared provider failure can freeze
  // subagents and the main model at the same time.
  if (subagentHangProbes.size > 0) {
    const nowMs = Date.now();
    const poll = subagentManagerPoller();
    const hung = classifyHungSubagents([...subagentHangProbes.values()], (id) => poll.getRecord?.(id), nowMs);
    pruneEndedSubagentHangProbes(nowMs);
    for (const h of hung) {
      const p = subagentHangProbes.get(h.recordId);
      if (!p || (p.hangAlertedAt !== undefined && nowMs - p.hangAlertedAt < SUBAGENT_HANG_ALERT_THROTTLE_MS)) continue;
      p.hangAlertedAt = nowMs;
      const label = [p.agentType, p.summary].filter(Boolean).join(" ");
      const mins = Math.max(1, Math.round(h.silentMs / 60_000));
      // v0.34.102: classifyHungSubagents cannot tell us the evidence class
      // (record-poll vs event-only) — recompute: if the record is still
      // pollable this is the frozen-record case (tool/output counters
      // stopped); if not, the child vanished from the manager entirely and
      // only its event trail (spawn/compacted/steered) remains. Name it so
      // the user knows whether the Agents panel can still show a live child.
      const stillTracked = poll.getRecord?.(p.recordId) !== undefined;
      appendLedger(ctx.cwd, "subagent_hang_detected", {
        recordId: p.recordId,
        agentType: p.agentType,
        summary: p.summary,
        silentMs: h.silentMs,
        spawnedAt: new Date(p.spawnedAt).toISOString(),
        evidence: stillTracked ? "record-frozen" : "event-only",
        at: nowIso(),
      });
      const msg = `glla: subagent${label ? ` (${label})` : ""} shows no progress for ${mins}m — ${stillTracked
        ? "still running with no new tool calls or output"
        : "its manager record is unreachable and it produced no events (spawn/compaction/steer)"}. It may be hung; the main session can decide to abort it.`;
      ctx.ui.notify(msg, "warning");
      notifyExternal(ctx, msg);
    }
  }
  if (mainModelRecoveryActive()) {
    overdueWaitBackstop(ctx);
    return;
  }
  overdueWaitBackstop(ctx);
  let idle = false;
  let pending = false;
  try {
    idle = ctx.isIdle();
    pending = ctx.hasPendingMessages();
  } catch {
    return;
  }
  const sessionIdle = idle && !pending;
  // v0.28.24: post-compaction grace — the whole stall/refire/watchdog
  // machinery below stays quiet for 3 minutes while the replaced session
  // settles (latch watchdog, wedge alert, refire counting all resume after).
  if (Date.now() < flags.compactionGraceUntil) return;
  // v0.34.24: an accepted dispatch with no start proof owns the watchdog
  // until its bounded timeout. Do not let the generic heartbeat create a
  // second blind send underneath it; explicit resume or a fresh session
  // releases the stand-down latch.
  if (flags.continuationDispatchStoodDown || flags.pendingContinuationDispatch) return;
  // v0.33.1: nothing supervised → the compact debt/resync belong to a dead
  // goal/loop. Discharge here so a later goal can't inherit a bogus RESYNC
  // block or a spurious forced refire (the old in-guard `else` was
  // unreachable — isSupervising() ≡ isLoopActive() || isActionableGoal()).
  if (!isSupervising() && (flags.postCompactResumeOwed || flags.postCompactResyncPending)) {
    flags.postCompactResumeOwed = false;
    flags.postCompactResyncPending = false;
  }
  // v0.32.1: post-compaction resume debt — retry on every heartbeat tick
  // past grace until a turn actually starts. Fixed-offset settles alone
  // can both lose (pi busy at 2s AND at grace+2s = a dangling chain).
  if (flags.postCompactResumeOwed && isSupervising() && !flags.abortedStandDown) {
    try {
      if (ctx.isIdle() && !ctx.hasPendingMessages() && flags.continuationTimer === null && !loopTimerPending()) {
        if (isLoopActive()) {
          appendLedger(ctx.cwd, "compaction_resume_owed_refire", { kind: "loop" });
          scheduleLoopTick(ctx);
        } else if (isActionableGoal()) {
          appendLedger(ctx.cwd, "compaction_resume_owed_refire", { kind: "goal" });
          scheduleContinuation(ctx, true);
        } else {
          flags.postCompactResumeOwed = false; // nothing to resume — discharge
        }
      }
    } catch { /* next tick */ }
  }
  // v0.29.16/v0.35.x: zombie-run watchdog. pi reports BUSY (a run is
  // "active") but zero stream events for the warning window — the provider
  // stream has likely hung silently, and queued continuations cannot land.
  // Keep the first warning human-readable, then apply one bounded automatic
  // abort/cleanup after the grace window. A notification-only Esc instruction
  // left list items ACTIVE for 85–96 minutes in the field; the bounded abort
  // now parks the item and leaves /list resume + /list cancel as explicit,
  // truthful recovery choices.
  const streamSilentMs = Date.now() - flags.lastStreamActivityAt;
  const zombieWarningMs = zombieRunSilentMs();
  const zombieAbortMs = zombieWarningMs + zombieRunAbortGraceMs();
  if (isSupervising() && !idle && streamSilentMs >= zombieWarningMs) {
    const nowMs = Date.now();
    // v0.35.4: subagent-wait carve-out (field: 2026-08-01 — a 31-minute
    // Explore "thinking" with zero parent stream events tripped the bounded
    // abort and parked a run whose child was legitimately working). A parent
    // BUSY-waiting on Agent / steer_subagent / get_subagent_result is
    // EXPECTED to be stream-silent; child liveness is the subagent-hang
    // watchdog's detection+notify territory and the wedge alert names the
    // wait. Stand down the whole branch while a live probe or an in-flight
    // subagent tool call is recorded — the abort must not own that case.
    const subagentWaitInFlight =
      hasLiveSubagentHangProbes() ||
      [...flags.inFlightToolCalls.values()].some(isSubagentWaitCall);
    if (subagentWaitInFlight) {
      if (streamSilentMs >= zombieAbortMs && !flags.abortedStandDown) {
        appendLedger(ctx.cwd, "zombie_run_stood_down_subagent_wait", { streamSilentMs });
      }
      return;
    }
    const abortKey = `${flags.sessionGeneration}:${state.goal?.id ?? "loop"}:${flags.lastStreamActivityAt}`;
    if (streamSilentMs >= zombieAbortMs && !flags.abortedStandDown && abortKey !== lastZombieAbortKey) {
      // Claim the key only after the activation-owned abort succeeds. A
      // generation/stream/goal guard can legitimately reject this attempt
      // while the heartbeat is still observing the same silent run; latching
      // first strands that run in warning-only state forever.
      if (abortZombieRun(ctx, flags.sessionGeneration, state.goal?.id, flags.lastStreamActivityAt)) {
        lastZombieAbortKey = abortKey;
        return;
      }
    }
    if (nowMs - lastZombieAlertAt >= ZOMBIE_RUN_ALERT_THROTTLE_MS) {
      lastZombieAlertAt = nowMs;
      appendLedger(ctx.cwd, "zombie_run_suspected", { streamSilentMs, pending, abortDue: streamSilentMs >= zombieAbortMs });
      if (streamSilentMs >= zombieAbortMs) {
        ctx.ui.notify(`glla: the BUSY turn had zero stream activity for ${Math.round(streamSilentMs / 60000)} min and automatic cleanup was unable to claim it. Use ${activeGoalSurfaceCommand("resume")} or ${activeGoalSurfaceCommand("cancel")} after a fresh session rebind.`, "warning");
        notifyExternal(ctx, `glla: zombie cleanup needs a fresh session (${Math.round(streamSilentMs / 60000)}m busy-silent).`);
      } else {
        ctx.ui.notify(`glla: the session has been BUSY with zero stream activity for ${Math.round(streamSilentMs / 60000)} min — the provider stream is likely hung. Automatic cleanup will abort it after the bounded grace window.`, "warning");
        notifyExternal(ctx, `glla: zombie run suspected (${Math.round(streamSilentMs / 60000)} min busy-silent) — bounded cleanup is armed.`);
      }
    }
    return;
  }
  // v0.34.11: legacy unanswered-continuation diagnostics. The new
  // generation-bound dispatch watchdog returns above while a dispatch is
  // pending, so this branch is only a compatibility fallback for state that
  // predates the dispatch sidecar. It never initiates a second send.
  if (
    isSupervising() &&
    flags.lastContinuationSentAt > 0 &&
    flags.lastRealActivityAt < flags.lastContinuationSentAt &&
    Date.now() - flags.lastContinuationSentAt >= continuationUnansweredMs &&
    Date.now() - lastUnansweredAlertAt >= continuationUnansweredThrottleMs
  ) {
    lastUnansweredAlertAt = Date.now();
    appendLedger(ctx.cwd, "continuation_unanswered", { silentMs: Date.now() - flags.lastContinuationSentAt });
    const mins = Math.round((Date.now() - flags.lastContinuationSentAt) / 60_000);
    const msg = `glla: pi accepted the continuation ${mins}m ago but NO turn has started — no tool calls, no tokens, transcript frozen (the turn trigger is wedged). Re-sends do not unstick it. A fresh session_start will rebind the ${isLoopActive() ? "loop" : "goal/list item"}; if no replacement arrives, restart pi normally and restore the saved work.`;
    ctx.ui.notify(msg, "warning");
    notifyExternal(ctx, msg);
  }
  // v0.29.1: stranded-audit recovery. A goal left in "auditing" with NO
  // in-flight audit means the auditor's result never landed (wedged queue
  // ate the tool result; compaction/restart mid-audit). Field-observed in
  // pully: 12h+ stuck "auditing" while the model had already confabulated
  // the closure narrative. The audit silence is expected ONLY while
  // flags.completionAuditInFlight — its absence here means the run is orphaned.
  // Release a stranded completion claim to the MAIN as infrastructure/no-
  // verdict. A heartbeat must never silently launch another detached worker;
  // /goal resume (or the mode-correct list/loop resume route) is the explicit
  // one-fresh-dispatch gate.
  if (
    state.goal?.status === "auditing" &&
    !flags.completionAuditInFlight &&
    (!state.goal.pendingCompletion || flags.completionAuditRecoveryArmed) &&
    Date.now() - flags.lastActivityAt >= 90_000
  ) {
    appendLedger(ctx.cwd, "stranded_audit_recovered", { goalId: state.goal.id, via: state.goal.pendingCompletion ? "stored-claim" : "resume-active" });
    if (state.goal.pendingCompletion) {
      markCompletionAuditRecoveryPending(ctx, "heartbeat-recovery");
      ctx.ui.notify(`Completion audit blocked — no verdict. The stored claim is safe; ${activeGoalSurfaceCommand("resume")} starts exactly one fresh auditor.`, "warning");
    } else {
      updateGoal({
        status: "paused",
        pauseKind: "blocked",
        pauseReason: "completion audit interrupted — no verdict",
        pauseSuggestedAction: `The completion attempt was not evaluated. ${activeGoalSurfaceCommand("resume")} returns to the work so it can call complete_goal again.`,
      }, ctx);
      ctx.ui.notify(`Completion audit interrupted — no verdict. MAIN released; ${activeGoalSurfaceCommand("resume")} to continue.`, "warning");
    }
    return;
  }
  // v0.26.5: pending-latch watchdog — a queued continuation whose turn
  // trigger was dropped (field-observed post-compaction: continuation
  // ACCEPTED at compact+0s, then 22 minutes of silence). The stuck latch
  // keeps sessionIdle false, which suppresses the refire path AND the
  // stall escalation below — without this branch the session is silent
  // forever. We never re-send here (the message is already queued
  // pi-side; hegemon proved re-sends don't unstick a dropped trigger) —
  // count, notify, escalate to a loud stop.
  const latchSilentMs = Date.now() - flags.lastActivityAt;
  if (
    shouldFirePendingLatchWatchdog({
      supervising: isSupervising(),
      idle,
      pending,
      timerPending: flags.continuationTimer !== null || loopTimerPending(),
      silentMs: latchSilentMs,
      thresholdMs: PENDING_LATCH_STUCK_MS,
    })
  ) {
    flags.consecutiveStalls++;
    appendLedger(ctx.cwd, "pending_latch_stuck", { consecutiveStalls: flags.consecutiveStalls, silentMs: latchSilentMs });
    noteActivity(); // re-arm the 3-minute cadence; never resets the stall streak
    const stallEscalation = loadSettings(ctx.cwd).stallEscalationRefires ?? DEFAULT_STALL_ESCALATION_REFIRES;
    if (escalateStallNow(ctx, stallEscalation)) return;
    const msg = `Heartbeat: a queued continuation never started its turn for ${Math.round(latchSilentMs / 60_000)}m — pi's pending-message latch appears stuck (known post-compaction failure; stall ${flags.consecutiveStalls}/${stallEscalation > 0 ? stallEscalation : "∞"}). If this repeats, restart pi.`;
    ctx.ui.notify(msg, "warning");
    notifyExternal(ctx, msg);
    return;
  }
  const fire = shouldHeartbeatRefire({
    supervising: isSupervising(),
    sessionIdle,
    timerPending: flags.continuationTimer !== null || loopTimerPending() || flags.continuationStartTimer !== null || flags.pendingContinuationDispatch !== null,
    msSinceActivity: Date.now() - flags.lastActivityAt,
    stallMs: HEARTBEAT_STALL_MS,
    consecutiveStalls: flags.consecutiveStalls,
  });
  // Wedge alert (v0.23.2): session BUSY but silent for the threshold —
  // the classic hung-command case (a test suite that never exits holds
  // the entire goal hostage; field-observed at 5,056s and 6,800s on the
  // same wedged tool call). Independent of the refire path, which only
  // watches idle sessions.
  const wedgeMinutes = resolveEffectiveAggressiveSettings(loadSettings(ctx.cwd)).wedgeAlertMinutes ?? WEDGE_ALERT_DEFAULT_MINUTES;
  if (
    shouldWedgeAlert({
      supervising: isSupervising(),
      // v0.26.5: !idle, not !sessionIdle — an idle session with a stuck
      // pending latch is the watchdog's job above, not a "hung command".
      sessionBusy: !idle,
      silentMs: Date.now() - flags.lastActivityAt,
      msSinceLastAlert: Date.now() - lastWedgeAlertAt,
      thresholdMs: wedgeMinutes * 60_000,
    })
  ) {
    lastWedgeAlertAt = Date.now();
    // v0.34.5: a wedge while blocked on a subagent wait is a DIFFERENT animal
    // from a hung bash command (junk-runner 2026-08-01: 2 Explore agents
    // "thinking…" 31 minutes — working, but indistinguishable from hung
    // without this hint). Name the wait and give the liveness check: a child
    // whose tool-use counter stops moving is hung, not thinking.
    const subWaits = new Set(
      [...flags.inFlightToolCalls.values()]
        .filter(isSubagentWaitCall)
        .map((t) => t.name),
    );
    const subHint = subWaits.size > 0
      ? ` The in-flight call is a SUBAGENT WAIT (${[...subWaits].join("/")}) — check the Agents panel: a child whose tool-use/token counters have stopped moving between checks is hung, not thinking (hard failures surface as ✗ failed + the wait returns; a HANG is silent). Esc interrupts the wait — then collect the survivors with get_subagent_result and absorb the dead scope inline.`
      : "";
    const msg = `${goalNoun()} appears wedged: no activity for ${Math.round((Date.now() - flags.lastActivityAt) / 60_000)}m while the session is busy — likely a hung command (test/build/dev server without a timeout).${subHint} Check the session; Esc kills a stuck tool call.`;
    appendLedger(ctx.cwd, "wedge_alert", { silentMs: Date.now() - flags.lastActivityAt, subagentWait: subWaits.size > 0 });
    ctx.ui.notify(msg, "warning");
    notifyExternal(ctx, msg);
  }
  // v0.29.5: user-abort stand-down — the chain stays DOWN until the
  // user resumes. Without this guard the 60s heartbeat re-fired the
  // continuation and defeated the 0.29.4 stand-down within a minute.
  if (flags.abortedStandDown) return;
  if (!fire) return;
  // v0.34.82: when pi auto-compaction is absent (settings `compaction.enabled:false`
  // or otherwise no session_compact event has fired in the recent window),
  // the agent_end yield path correctly refuses to send a 1-token
  // length-continue. But the heartbeat's refire would still queue a full
  // turn against the same near-full context, draining sessions to 120%+
  // before the user notices. Refuse to schedule a new continuation while
  // we are starving; surface a one-shot "compaction needed" notify so the
  // user can either flip `compaction.enabled` back on or run `/compact`.
  // A real `session_compact` clears the streak and the heartbeat resumes
  // its normal refire (goal.ts:9411).
  if (isContextStarvedRefused()) {
    if (!starvedRefusedNotified) {
      starvedRefusedNotified = true;
      appendLedger(ctx.cwd, "continuation_refused_context_starved", { streak: flags.contextStarvedStreak, sinceMs: Date.now() - flags.lastContextStarvedAt });
      ctx.ui.notify(
        "glla: auto-compaction appears to be off (or not running) — context is starving and the next turn would just truncate again. Run `/compact` once, or set `compaction.enabled:true` in ~/.pi/agent/settings.json to let pi handle this automatically.",
        "warning",
      );
    }
    return;
  }
  // v0.35.4: the refusal cleared (compaction landed or the window lapsed) —
  // re-arm the one-shot so the NEXT episode gets its single warning.
  starvedRefusedNotified = false;
  // v0.26.6: the 0.25.0 "recent ship (<5m)" suppression was REMOVED. It fed
  // lastShippedAtMs, which read the state-file MTIME — and the heartbeat's
  // own suppressed-tick ledger writes refreshed that mtime every 15s,
  // making the suppression self-sustaining forever (field-observed in
  // darklord: 2,184 suppressed ticks over 9.1h after a post-compaction
  // send failure; the completed list item never closed). Under an
  // auto-committing daemon the git-head term self-sustains too. The legit
  // windows are already covered precisely — busy mid-turn, pending
  // messages, scheduled timers — plus the audit-in-flight flag below.
  if (flags.completionAuditInFlight) return;
  noteActivity();
  flags.consecutiveStalls++;
  appendLedger(ctx.cwd, "heartbeat_refire", { nudgesSoFar: flags.heartbeatNudges, consecutiveStalls: flags.consecutiveStalls });
  // v0.26.1: a refire streak means the continuation is NOT landing (wedged
  // message queue, stale API handle, dead turn trigger). Nudges can't catch
  // this — they count turns, and a zombie runs none. Escalate to a loud,
  // actionable stop instead of spinning silently forever.
  const stallEscalation = loadSettings(ctx.cwd).stallEscalationRefires ?? DEFAULT_STALL_ESCALATION_REFIRES;
  if (escalateStallNow(ctx, stallEscalation)) return;
  ctx.ui.notify(`Heartbeat: supervisor active but session stalled — re-firing continuation (stall ${flags.consecutiveStalls}/${stallEscalation > 0 ? stallEscalation : "∞"}).`, "info");
  if (isLoopActive()) {
    scheduleLoopTick(ctx);
  } else {
    scheduleContinuation(ctx, true);
  }
}

export function startHeartbeat(): void {
  if (flags.heartbeatTimer) return;
  flags.heartbeatTimer = setInterval(heartbeatTick, HEARTBEAT_INTERVAL_MS);
  flags.heartbeatTimer.unref?.();
}
// ----------------------------------------------------------------------------
// Test-only heartbeat hooks (moved from goal.ts)
// ----------------------------------------------------------------------------

/** Test-only lifecycle driver: exercise the orphan watchdog without waiting
 * for the production 15-second heartbeat interval. This never ships as a
 * runtime command; it only lets the mock host reproduce an invalidated
 * context with no successor session_start. */
export function __testOnlyHeartbeatTick(): void {
  const prev = heartbeatStaleDebounce;
  heartbeatStaleDebounce = 1; // v0.34.62: the hook keeps its single-tick terminal contract
  heartbeatTick();
  heartbeatStaleDebounce = prev;
}

/** Test-only: drive the PRODUCTION (debounced) heartbeat path — the orphan
 * watchdog with HEARTBEAT_STALE_DEBOUNCE applied. Never called by production
 * code. */
export function __testOnlyHeartbeatTickRaw(): void {
  heartbeatTick();
}

/** Test-only: override the heartbeat stale-probe debounce (null restores the
 * production HEARTBEAT_STALE_DEBOUNCE). Never called by production code. */
export function __testOnlySetHeartbeatStaleDebounce(n: number | null): void {
  heartbeatStaleDebounce = n ?? HEARTBEAT_STALE_DEBOUNCE;
}

/** Test-only: snapshot of the live subagent-hang probe registry. Returns
 * the LIVE probe objects (tests backdate lastProgressAt / read hangAlertedAt)
 * — read-only misuse is on the test author. Never called by production
 * code. */
export function __testOnlySubagentHangProbes(): SubagentHangProbe[] {
  return [...subagentHangProbes.values()];
}

/** Test-only: clear the subagent-hang probe registry (between tests). Never
 * called by production code. */
export function __testOnlyClearSubagentHangProbes(): void {
  subagentHangProbes.clear();
}
