import type { Goal } from './goal-loop-core.js';

/** Includes already-persisted holds from older sessions; no migration needed. */
export function isCompactionRecoveryHold(goal: Pick<Goal, 'status' | 'pauseKind' | 'pauseReason'> | null | undefined): boolean {
  return goal?.status === 'paused' && goal.pauseKind === 'error'
    && /^context compaction failure:/i.test(goal.pauseReason ?? '');
}
export function compactionResumeAction(policy: Goal['policy']): string {
  const command = policy === 'list' ? '/list resume' : '/goal resume';
  return `Run ${command} to retry saved work on the selected model. If compaction fails again: /model, then /compact, then ${command}.`;
}
