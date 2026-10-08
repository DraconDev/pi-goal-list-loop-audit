import { createHash, randomUUID } from 'node:crypto';
import type { State } from './goal-loop-core.js';

export type ProgressPhase = 'building' | 'verification' | 'retry-recovery' | 'waiting';
export interface ProgressReceipt {
  schemaVersion: 1;
  receiptId: string;
  runtimeId: string;
  generation: number;
  rootId: string;
  kind: 'state' | 'ended' | 'iteration';
  runId: string;
  family: 'goal' | 'loop' | 'project';
  mode: string;
  version: string;
  at: string;
  iteration?: number;
  cycle?: number;
  revision?: number;
  attemptId?: string;
  phase?: ProgressPhase;
  reasonCode?: string;
  interval?: { phase: ProgressPhase; milliseconds: number; tokens?: number; provenance: 'inferred-between-state-observations' };
  tokensUsed?: number;
  deltas?: { id: string; from?: string; to: string; attemptId?: string; reason?: string }[];
  deltasTruncated?: boolean;
  signals?: { fileWrites: number; gitCommits: number; specItemProgress: number; currentHead?: string };
}
const redact = (value: string | undefined): string | undefined => value?.replace(/Bearer\s+\S+|\bsk-[\w-]+|(?:api[_-]?key|token|password|secret)\s*[:=]\s*\S+/gi, '[redacted]').slice(0, 160);
const count = (value: number | undefined): number | undefined => Number.isSafeInteger(value) && value! >= 0 ? value : undefined;
interface Baseline { phase: ProgressPhase; at: number; tokens?: number; generation: number; requirements: Map<string, string>; receipt: ProgressReceipt }

/** Observational cache only. Nothing here makes a lifecycle decision. */
export class ProgressObserver {
  private roots = new Map<string, Map<string, Baseline>>();
  private sequence = 0;
  readonly runtimeId = randomUUID();
  constructor(readonly version: string, private generation: () => number) {}
  private identity(root: string, runId: string, family: ProgressReceipt['family'], mode: string, kind: ProgressReceipt['kind'], at: number): ProgressReceipt {
    return { schemaVersion: 1, receiptId: `${this.runtimeId}:${++this.sequence}`, runtimeId: this.runtimeId,
      generation: this.generation(), rootId: createHash('sha256').update(root).digest('hex').slice(0, 20),
      runId, family, mode, kind, version: this.version, at: new Date(at).toISOString() };
  }
  snapshot(root: string, state: State, emit: (receipt: ProgressReceipt) => void, at = Date.now()): void {
    try {
      if (!Number.isFinite(at)) return;
      const previous = this.roots.get(root) ?? new Map<string, Baseline>();
      const next = new Map<string, Baseline>();
      const targets: { id: string; family: ProgressReceipt['family']; mode: string; active: boolean; phase: ProgressPhase; tokens?: number; requirements?: NonNullable<State['loop']>['builder']; iteration?: number }[] = [];
      if (state.goal) {
        const goal = state.goal;
        targets.push({ id: goal.id, family: 'goal', mode: goal.policy === 'list' ? 'list-goal' : 'goal', active: goal.status === 'active' || goal.status === 'auditing',
          phase: goal.status === 'auditing' ? 'verification' : goal.status === 'paused' ? 'waiting' : state.mainModelRecovery ? 'retry-recovery' : 'building', tokens: count(goal.usage.tokensUsed) });
      }
      if (state.loop) {
        const loop = state.loop, builder = loop.builder;
        targets.push({ id: builder?.projectId ?? loop.startedAt, family: builder ? 'project' : 'loop',
          mode: builder ? 'requirement-builder' : loop.measureCmd ? 'metric-loop' : 'metricless-loop', active: loop.active,
          phase: !loop.active ? 'waiting' : state.mainModelRecovery ? 'retry-recovery' : builder?.audit?.retryAttemptStarted ? 'retry-recovery' : builder?.phase === 'auditing' ? 'verification' : 'building',
          tokens: count(loop.tokensUsed), requirements: builder, iteration: loop.iteration });
      }
      for (const target of targets) {
        const key = `${target.family}:${target.id}`, before = previous.get(key);
        const phase = state.supervisorPausedAt || state.loadHoldAt || !target.active ? 'waiting' : target.phase;
        const receipt = this.identity(root, target.id, target.family, target.mode, 'state', at);
        receipt.phase = phase;
        receipt.reasonCode = state.supervisorPausedAt ? 'supervisor-paused' : state.loadHoldAt ? 'load-held' : !target.active ? 'inactive' : phase;
        receipt.tokensUsed = target.tokens;
        receipt.iteration = target.iteration;
        receipt.cycle = target.requirements?.cycle;
        receipt.revision = target.requirements?.revision;
        receipt.attemptId = target.requirements?.audit?.attemptId ?? target.requirements?.history?.at(-1)?.attemptId;
        // Epoch boundaries never bridge a replacement/offline session gap.
        if (before && before.generation === receipt.generation && at >= before.at && at - before.at <= 86400000) {
          receipt.interval = { phase: before.phase, milliseconds: at - before.at, provenance: 'inferred-between-state-observations',
            ...(before.tokens !== undefined && target.tokens !== undefined && target.tokens >= before.tokens ? { tokens: target.tokens - before.tokens } : {}) };
        }
        const requirements = new Map<string, string>();
        const deltas: NonNullable<ProgressReceipt['deltas']> = [];
        for (const requirement of (target.requirements?.requirements ?? []).slice(0, 1024)) {
          requirements.set(requirement.id, requirement.status);
          if (before?.requirements.get(requirement.id) !== requirement.status) deltas.push({ id: requirement.id.slice(0, 200), from: before?.requirements.get(requirement.id), to: requirement.status,
            attemptId: requirement.evidence?.attemptId ?? receipt.attemptId, reason: redact(requirement.blockedReason) });
        }
        for (const [id, status] of before?.requirements ?? []) if (!requirements.has(id)) deltas.push({ id: id.slice(0, 200), from: status, to: 'removed', attemptId: receipt.attemptId });
        receipt.deltas = deltas.slice(0, 128);
        receipt.deltasTruncated = deltas.length > 128 || (target.requirements?.requirements.length ?? 0) > 1024;
        next.set(key, { phase, at, tokens: target.tokens, generation: receipt.generation, requirements, receipt });
        emit(receipt);
      }
      for (const [key, before] of previous) if (!next.has(key)) {
        const ended = this.identity(root, before.receipt.runId, before.receipt.family, before.receipt.mode, 'ended', at);
        ended.reasonCode = 'target-no-longer-present';
        emit(ended);
      }
      if (!this.roots.has(root) && this.roots.size >= 16) this.roots.delete(this.roots.keys().next().value!);
      this.roots.set(root, next);
    } catch { /* Best-effort telemetry must never poison accepted state. */ }
  }
  iteration(root: string, loop: NonNullable<State['loop']>, signals: NonNullable<ProgressReceipt['signals']>, emit: (receipt: ProgressReceipt) => void, at = Date.now()): void {
    try {
      const receipt = this.identity(root, loop.builder?.projectId ?? loop.startedAt, loop.builder ? 'project' : 'loop', loop.builder ? 'requirement-builder' : loop.measureCmd ? 'metric-loop' : 'metricless-loop', 'iteration', at);
      receipt.iteration = loop.iteration;
      receipt.cycle = loop.builder?.cycle;
      receipt.signals = { fileWrites: count(signals.fileWrites) ?? 0, gitCommits: count(signals.gitCommits) ?? 0, specItemProgress: count(signals.specItemProgress) ?? 0,
        currentHead: /^[a-f0-9]{7,64}$/i.test(signals.currentHead ?? '') ? signals.currentHead : undefined };
      emit(receipt);
    } catch { /* No feedback into iteration success/repetition decisions. */ }
  }
}
let runtime: ProgressObserver | undefined;
export function configureProgressRuntime(version: string, generation: () => number): void {
  runtime = new ProgressObserver(/^\d+\.\d+\.\d+(?:[-+][\w.]+)?$/.test(version) ? version : 'unknown', generation);
}
export function observeProgressState(root: string, state: State, emit: (receipt: ProgressReceipt) => void, at?: number): void { runtime?.snapshot(root, state, emit, at); }
export function observeProgressIteration(root: string, loop: NonNullable<State['loop']>, signals: NonNullable<ProgressReceipt['signals']>, emit: (receipt: ProgressReceipt) => void, at?: number): void { runtime?.iteration(root, loop, signals, emit, at); }
