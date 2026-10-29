import type { State } from './goal-loop-core.js';
import { isRecoverableProviderError } from './main-model-recovery.js';
import { recoveryOwnership } from './recovery-ownership.js';

/** A saved recovery episode carries continuation authority only for its own
 * system wait. A paused-looking surface alone never establishes consent.
 * Explicit holds outrank this narrow restore exception. */
export function ownsPersistentProviderWait(state: State): boolean {
  if (state.supervisorPausedAt || state.loadHoldAt) return false;
  const goal = state.goal;
  const recovery = state.mainModelRecovery;
  if (recovery && !recovery.manualResumeRequired && recovery.owner
      && recoveryOwnership(recovery.owner, recovery.kind, state, true) === 'retained'
      && isRecoverableProviderError(recovery.providerErrorDiagnostic)
      && (recovery.retryAt || recovery.pendingModelSwitch)) {
    if (recovery.kind === 'goal') {
      return goal?.status === 'paused' && goal.pauseSource === 'system'
        && goal.pauseKind === 'wait' && !goal.pendingCompletion
        && (goal.pauseReason ?? '').startsWith('main model recovery')
        && goal.pauseResumeAt === recovery.retryAt;
    }
    return !!state.loop && !state.loop.active
      && (state.loop.stopReason ?? '').startsWith('main model recovery —');
  }
  const claim = goal?.pendingCompletion;
  return goal?.status === 'paused' && goal.pauseSource === 'system'
    && goal.pauseKind === 'wait' && !!goal.pauseResumeAt
    && (goal.pauseReason ?? '').startsWith('auditor retry:')
    && claim?.phase === 'retry-waiting' && !!claim.attemptId
    && !!claim.recoveryEpisodeKey && isRecoverableProviderError(claim.providerErrorDiagnostic);
}
