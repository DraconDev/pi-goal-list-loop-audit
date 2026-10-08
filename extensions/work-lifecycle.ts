import type { Goal, State } from "./goal-loop-core.js";
import type { LoopState } from "./goal-loop-forever.js";

/** Lifecycle is control authority; activity is observed work, never consent. */
export type WorkLifecycle = "idle" | "running" | "waiting" | "paused" | "complete" | "cancelled";
export type WorkActivity = "unknown" | "researching" | "implementing" | "auditing" | "recovering" | "background" | "cadence";
export type DependencyOutcome = "pending" | "completed" | "failed" | "stopped" | "missing";

export interface WaitDependency {
  runId: string;
  /** Public companion artifact location observed at admission, not inferred. */
  asyncDir?: string;
  outcome: DependencyOutcome;
}

export interface BackgroundWait {
  version: 1;
  id: string;
  targetId: string;
  sessionId: string;
  createdAt: string;
  reason: string;
  dependencies: WaitDependency[];
  /** Legacy standby has no provable dependency ownership. Assess, do not guess. */
  legacy?: true;
  settledAt?: string;
}

export interface WorkView {
  lifecycle: WorkLifecycle;
  activity: WorkActivity;
  wait?: BackgroundWait;
}

const OUTCOMES = new Set<DependencyOutcome>(["pending", "completed", "failed", "stopped", "missing"]);
const text = (value: unknown, cap: number): string | undefined =>
  typeof value === "string" && value.trim() && value.length <= cap && !/[\u0000-\u001f]/.test(value)
    ? value.trim() : undefined;
const date = (value: unknown): string | undefined =>
  typeof value === "string" && value.length <= 40 && Number.isFinite(Date.parse(value)) ? value : undefined;

/** Strict durable boundary: invalid ownership cannot authorize a wake. */
export function sanitizeBackgroundWait(value: unknown, targetId: string): BackgroundWait | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const id = text(raw.id, 200), sessionId = text(raw.sessionId, 400), createdAt = date(raw.createdAt);
  if (raw.version !== 1 || !id || !sessionId || !createdAt || raw.targetId !== targetId) return undefined;
  if (!Array.isArray(raw.dependencies) || raw.dependencies.length > 32) return undefined;
  const dependencies: WaitDependency[] = [];
  const seen = new Set<string>();
  for (const candidate of raw.dependencies) {
    if (!candidate || typeof candidate !== "object") return undefined;
    const entry = candidate as Record<string, unknown>;
    const runId = text(entry.runId, 200);
    if (!runId || seen.has(runId) || !OUTCOMES.has(entry.outcome as DependencyOutcome)) return undefined;
    seen.add(runId);
    if (entry.asyncDir !== undefined && !text(entry.asyncDir, 4096)) return undefined;
    dependencies.push({ runId, outcome: entry.outcome as DependencyOutcome,
      ...(entry.asyncDir !== undefined ? { asyncDir: text(entry.asyncDir, 4096)! } : {}) });
  }
  if (dependencies.length === 0 && raw.legacy !== true) return undefined;
  // A forged settlement timestamp cannot release pending dependencies.
  const settledAt = date(raw.settledAt);
  if (settledAt && dependencies.some((dependency) => dependency.outcome === "pending")) return undefined;
  return { version: 1, id, targetId, sessionId, createdAt,
    reason: typeof raw.reason === "string" ? raw.reason.slice(0, 2000) : "Waiting for background work",
    dependencies, ...(raw.legacy === true ? { legacy: true } : {}), ...(settledAt ? { settledAt } : {}) };
}

/** Pure reducer: target + session + exact run identity are all required.
 * Caller persists this replacement before scheduling; duplicates do nothing. */
export function settleBackgroundDependency(wait: BackgroundWait, event: {
  targetId: string; sessionId: string; runId: string;
  outcome: Exclude<DependencyOutcome, "pending">; at: string;
}): BackgroundWait | undefined {
  if (wait.targetId !== event.targetId || wait.sessionId !== event.sessionId || wait.settledAt || !date(event.at)) return undefined;
  const index = wait.dependencies.findIndex((dependency) => dependency.runId === event.runId && dependency.outcome === "pending");
  if (index < 0) return undefined;
  const dependencies = wait.dependencies.map((dependency, i) => i === index ? { ...dependency, outcome: event.outcome } : dependency);
  return { ...wait, dependencies,
    ...(dependencies.every((dependency) => dependency.outcome !== "pending") ? { settledAt: event.at } : {}) };
}

export function backgroundWaitReady(wait: BackgroundWait): boolean {
  return !!wait.settledAt && wait.dependencies.every((dependency) => dependency.outcome !== "pending");
}

function frozen(state: Pick<State, "supervisorPausedAt" | "loadHoldAt">): boolean {
  return typeof state.supervisorPausedAt === "number" || typeof state.loadHoldAt === "number";
}

export function goalWorkView(goal: Goal, state: Pick<State, "supervisorPausedAt" | "loadHoldAt" | "mainModelRecovery">,
  observedActivity: WorkActivity = "unknown"): WorkView {
  if (goal.status === "complete") return { lifecycle: "complete", activity: "unknown" };
  if (goal.status === "aborted") return { lifecycle: "cancelled", activity: "unknown" };
  if (frozen(state)) return { lifecycle: "paused", activity: observedActivity, ...(goal.backgroundWait ? { wait: goal.backgroundWait } : {}) };
  if (goal.status === "paused" && goal.pauseKind !== "standby" && goal.pauseKind !== "wait") return { lifecycle: "paused", activity: goal.backgroundWait ? "background" : observedActivity, ...(goal.backgroundWait ? { wait: goal.backgroundWait } : {}) };
  if (goal.backgroundWait) return { lifecycle: "waiting", activity: "background", wait: goal.backgroundWait };
  if (goal.status === "paused" && goal.pauseKind === "standby") return { lifecycle: "waiting", activity: "unknown" };
  if (goal.status === "paused" && goal.pauseKind === "wait") {
    const scheduled = date(goal.pauseResumeAt) || date(goal.pendingCompletion?.recoveryRetryAt)
      || state.mainModelRecovery?.retryAt || state.mainModelRecovery?.pendingModelSwitch;
    return { lifecycle: scheduled ? "waiting" : "paused", activity: goal.pendingCompletion || state.mainModelRecovery ? "recovering" : "unknown" };
  }
  if (goal.status === "auditing") return { lifecycle: "running", activity: "auditing" };
  return { lifecycle: "running", activity: state.mainModelRecovery ? "recovering" : observedActivity };
}

export function loopWorkView(loop: LoopState, state: Pick<State, "supervisorPausedAt" | "loadHoldAt" | "mainModelRecovery">,
  observedActivity: WorkActivity = "unknown"): WorkView {
  if (loop.builder?.phase === "complete") return { lifecycle: "complete", activity: "unknown" };
  // A stopped loop is not made active by retaining an old dependency record.
  if (!loop.active) return { lifecycle: "paused", activity: observedActivity, ...(loop.backgroundWait ? { wait: loop.backgroundWait } : {}) };
  if (frozen(state)) return { lifecycle: "paused", activity: observedActivity, ...(loop.backgroundWait ? { wait: loop.backgroundWait } : {}) };
  if (loop.backgroundWait) return { lifecycle: "waiting", activity: "background", wait: loop.backgroundWait };
  return { lifecycle: "running", activity: loop.builder?.phase === "auditing" ? "auditing" : state.mainModelRecovery ? "recovering" : observedActivity };
}

/** Shared display/tool projection. Loop dispatch takes precedence when active;
 * terminal goals otherwise retain their own archive lifecycle. */
export function stateWorkView(state: State, observedActivity: WorkActivity = "unknown"): WorkView {
  if (state.loop?.active) return loopWorkView(state.loop, state, observedActivity);
  if (state.goal) return goalWorkView(state.goal, state, observedActivity);
  if (state.loop) return loopWorkView(state.loop, state, observedActivity);
  return { lifecycle: "idle", activity: "unknown" };
}

/** Ordinary work dispatch must not race dependency-owned waiting. */
export function backgroundDispatchHeld(state: Pick<State, "goal" | "loop">): boolean {
  const goal = state.goal;
  const goalHeld = !!goal && goal.status !== "complete" && goal.status !== "aborted"
    && (!!goal.backgroundWait || (goal.status === "paused" && goal.pauseKind === "standby"));
  return goalHeld || (!!state.loop?.active && !!state.loop.backgroundWait);
}
