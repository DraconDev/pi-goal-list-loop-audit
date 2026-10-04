import type { State } from "./goal-loop-core.js";

/** GLLA-owned work planes covered by the single continuous checker. */
export type SupervisionPlane =
  | "goal"
  | "list"
  | "loop"
  | "auditor"
  | "subagent"
  | "provider-recovery"
  | "queue";

export type SupervisionSignalKind = "start" | "progress" | "complete" | "recover" | "block";

export interface SupervisionSignal {
  plane: SupervisionPlane;
  kind: SupervisionSignalKind;
  source: string;
}

export type SupervisionCycleCause = "event" | "durable-state" | "fallback";

export interface SupervisionCycle {
  /** Work planes visible at the instant of the check. */
  planes: SupervisionPlane[];
  /** Why this check was scheduled. */
  cause: SupervisionCycleCause;
  /** Signals consumed by this check; callers route them to plane handlers. */
  signals: SupervisionSignal[];
  /** Zero for an event/state reaction, otherwise the adaptive fallback slot. */
  pollMs: number;
} 

function durableStateSignature(state: State, liveSubagentCount: number): string {
  const goal = state.goal
    ? {
      id: state.goal.id,
      policy: state.goal.policy,
      status: state.goal.status,
      revision: state.goal.revision,
      updatedAt: state.goal.updatedAt,
      pendingPhase: state.goal.pendingCompletion?.phase,
      pendingAttemptId: state.goal.pendingCompletion?.attemptId,
    }
    : null;
  const list = (state.list ?? []).map((item) => ({
    id: item.id,
    objective: item.objective,
    verificationContract: item.verificationContract,
  }));
  const loop = state.loop
    ? {
      active: state.loop.active,
      target: state.loop.target,
      iteration: state.loop.iteration,
      stopReason: state.loop.stopReason,
      bestValue: state.loop.bestValue,
      builder: state.loop.builder ? {
        phase: state.loop.builder.phase, revision: state.loop.builder.revision,
        cycle: state.loop.builder.cycle, attemptId: state.loop.builder.audit?.attemptId,
        requirements: state.loop.builder.requirements?.map(r => ({ id: r.id, status: r.status })),
      } : undefined,
    }
    : null;
  const recovery = state.mainModelRecovery
    ? {
      kind: state.mainModelRecovery.kind,
      retryAt: state.mainModelRecovery.retryAt,
      pendingModelSwitch: state.mainModelRecovery.pendingModelSwitch,
      attempts: state.mainModelRecovery.attempts,
    }
    : null;
  return JSON.stringify({ goal, list, loop, recovery, liveSubagentCount });
}

export const SUPERVISION_MIN_POLL_MS = 250;
export const SUPERVISION_MAX_POLL_MS = 15_000;

/**
 * Derive the work planes that need supervision from durable state. This is a
 * projection only: it does not infer completion from elapsed time and it does
 * not treat a queued list item as an active goal.
 */
export function activeSupervisionPlanes(state: State, liveSubagentCount = 0): SupervisionPlane[] {
  const planes: SupervisionPlane[] = [];
  const goal = state.goal;
  if (goal) {
    if (goal.policy === "list" && (goal.status === "active" || goal.status === "auditing")) planes.push("list");
    if (goal.policy === "goal" && (goal.status === "active" || goal.status === "auditing")) planes.push("goal");
    if (goal.status === "auditing" || !!goal.pendingCompletion) planes.push("auditor");
  }
  if (state.loop?.active) planes.push("loop");
  if (state.loop?.builder?.phase === "auditing" && state.loop.builder.audit && !planes.includes("auditor")) planes.push("auditor");
  if ((state.list?.length ?? 0) > 0) planes.push("queue");
  if (state.mainModelRecovery) planes.push("provider-recovery");
  if (liveSubagentCount > 0) planes.push("subagent");
  return planes;
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

/**
 * Small stateful policy core for the production heartbeat. A real lifecycle
 * or durable-state signal resets the fallback poll backoff; absent signals
 * back off from 250ms to the 15s safety cadence. The caller still decides
 * which safe recovery action each signal permits.
 */
export class ContinuousSupervisor {
  private pollAttempt = 0;
  private lastStateSignature = "";
  private planes: SupervisionPlane[] = [];
  private readonly lastSignals = new Map<SupervisionPlane, SupervisionSignal>();
  private readonly pendingSignals = new Map<SupervisionPlane, SupervisionSignal>();

  signal(signal: SupervisionSignal): void {
    this.lastSignals.set(signal.plane, signal);
    // Coalesce bursts from the same plane without losing the newest lifecycle
    // kind/source. The next check consumes the event and reacts immediately.
    this.pendingSignals.set(signal.plane, signal);
    this.pollAttempt = 0;
  }

  observeState(state: State, liveSubagentCount = 0): SupervisionPlane[] {
    const planes = activeSupervisionPlanes(state, liveSubagentCount);
    // A durable revision/queue/loop/recovery change is a signal even when the
    // set of active planes stays the same. Conversely, include planes that
    // disappeared so a goal/list completion is not invisible just because
    // the new state has no active plane to enumerate.
    const signature = durableStateSignature(state, liveSubagentCount);
    if (signature !== this.lastStateSignature) {
      const affected = unique([...this.planes, ...planes]);
      this.lastStateSignature = signature;
      for (const plane of affected) this.signal({ plane, kind: "progress", source: "durable-state" });
    }
    this.planes = planes;
    return planes;
  }

  /**
   * Run one real checker cycle. Lifecycle events and durable changes are
   * consumed before fallback scheduling; only a signal-less active state gets
   * an adaptive poll slot. Production heartbeat uses this same stateful
   * primitive, while tests can exercise it without peeking at source text.
   */
  check(state: State, liveSubagentCount = 0): SupervisionCycle {
    const planes = this.observeState(state, liveSubagentCount);
    const signals = [...this.pendingSignals.values()];
    this.pendingSignals.clear();
    const hasEvent = signals.some((signal) => signal.source !== "durable-state");
    const cause: SupervisionCycleCause = signals.length === 0
      ? "fallback"
      : hasEvent
        ? "event"
        : "durable-state";
    return {
      planes: [...planes],
      cause,
      signals,
      pollMs: cause === "fallback" ? this.nextPollMs(planes.length > 0) : 0,
    };
  }

  /** Advance the fallback poll schedule after a check with no new signal. */
  nextPollMs(active = this.planes.length > 0): number {
    if (!active) {
      this.pollAttempt = 0;
      return SUPERVISION_MAX_POLL_MS;
    }
    const delay = Math.min(
      SUPERVISION_MAX_POLL_MS,
      SUPERVISION_MIN_POLL_MS * (2 ** Math.min(this.pollAttempt, 6)),
    );
    this.pollAttempt = Math.min(this.pollAttempt + 1, 6);
    return delay;
  }

  snapshot(): {
    planes: SupervisionPlane[];
    pollAttempt: number;
    lastSignals: Partial<Record<SupervisionPlane, SupervisionSignal>>;
    pendingSignals: SupervisionSignal[];
  } {
    return {
      planes: [...this.planes],
      pollAttempt: this.pollAttempt,
      lastSignals: Object.fromEntries(this.lastSignals.entries()),
      pendingSignals: [...this.pendingSignals.values()],
    };
  }
}

/** Stable list helper for tests and status projections. */
export function uniqueSupervisionPlanes(planes: SupervisionPlane[]): SupervisionPlane[] {
  return unique(planes);
}
