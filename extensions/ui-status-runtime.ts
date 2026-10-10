import type { State, MainModelRecoveryRuntime } from './goal-loop-core.js';
import { uiStatusOwnerKey, type UiStatusContext, type UiStatusEvidence } from './ui-status.js';

/** Adapter observations carry identities captured at their owning boundary.
 * Do not fill these identities in from a new state when replaying old data. */
export interface UiRuntimeObservation {
  ownerKey: string;
  generation: number;
  observedAt: number;
  session: UiStatusEvidence['session'];
  lastActivityAt?: number;
  turnActive?: boolean;
  turnQueued?: boolean;
  recovery?: MainModelRecoveryRuntime;
  compaction?: UiStatusEvidence['compaction'];
}
export interface UiAuditObservation {
  ownerKey: string;
  generation: number;
  attemptId: string;
  observedAt: number;
  lastActivityAt?: number;
  tool?: UiStatusEvidence['tool'];
}

/** Select evidence for the current work/attempt, never invent worker
 * activity from a durable claim or substitute host chat for audit progress. */
export function uiStatusContextFromRuntime(state: State, now: number, generation: number,
  host?: UiRuntimeObservation, audit?: UiAuditObservation, workflowIssue?: string): UiStatusContext {
  const context: UiStatusContext = { now, generation, workflowIssue };
  const ownerKey = uiStatusOwnerKey(state);
  if (!ownerKey || !host || host.ownerKey !== ownerKey || host.generation !== generation) return context;
  const evidence: UiStatusEvidence = { ...host };
  if (host.compaction) context.compactionEvidence = {
    ownerKey: host.ownerKey, generation: host.generation, session: host.session,
    observedAt: host.observedAt, compaction: host.compaction,
  };
  const loopSelected = state.loop?.active || !state.goal;
  const claim = loopSelected ? state.loop?.builder?.audit : state.goal?.pendingCompletion;
  const auditing = loopSelected ? state.loop?.builder?.phase === 'auditing' : state.goal?.status === 'auditing';
  if (auditing) {
    // Main-host chat is not evidence that the detached auditor is alive.
    evidence.lastActivityAt = undefined;
    evidence.turnActive = false;
    evidence.turnQueued = false;
    if (audit && audit.ownerKey === ownerKey && audit.generation === generation
      && claim?.attemptId && audit.attemptId === claim.attemptId) {
      evidence.lastActivityAt = audit.lastActivityAt;
      evidence.tool = audit.tool;
      // A fresh adapter poll must not refresh stale worker observations.
      const tool = audit.tool;
      const withinBudget = tool && Number.isFinite(tool.startedAt) && tool.startedAt <= now
        && Number.isFinite(tool.budgetMs) && tool.budgetMs > 0 && now - tool.startedAt < tool.budgetMs;
      // The current generation still owns this bounded tool wait. Preserve
      // its old activity timestamp; do not manufacture a worker heartbeat.
      evidence.observedAt = withinBudget ? host.observedAt : Math.min(host.observedAt, audit.observedAt);
    }
  }
  context.evidence = evidence;
  return context;
}
