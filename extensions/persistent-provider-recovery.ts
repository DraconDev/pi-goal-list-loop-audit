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
  if (goal?.status !== 'paused' || goal.pauseSource !== 'system'
    || !claim?.attemptId || !claim.recoveryEpisodeKey
    || !isRecoverableProviderError(claim.providerErrorDiagnostic)) return false;
  return (goal.pauseKind === 'wait' && !!goal.pauseResumeAt
    && (goal.pauseReason ?? '').startsWith('auditor retry:') && claim.phase === 'retry-waiting')
    || ((goal.pauseKind === 'wait' || goal.pauseKind === 'blocked')
      && !!claim.recoveryRetryAt && claim.phase === 'recovery-pending'
      && /^(?:auditor retry:|auditor blocked:|completion audit blocked)/.test(goal.pauseReason ?? ''));
}

/** The claim-shaped test without the load-hold clause. A stored completion
 * claim is already parked work, not a live turn: the cold-load hold freezes
 * AUTOMATION of live goals, and must not silently convert a durable auditor
 * retry wait into a "held for your decision" state that drops its due time.
 * Explicit user/supervisor pauses, decisions and foreign ownership still
 * outrank this exception. */
export function ownsParkedProviderClaim(state: State): boolean {
  if (state.supervisorPausedAt) return false;
  // Only a STORED COMPLETION CLAIM is parked work with nothing left to
  // dispatch. A main-model recovery wait belongs to a live goal whose next
  // turn is real automation, so the cold-load hold still applies to it.
  if (!state.goal?.pendingCompletion) return false;
  return ownsPersistentProviderWait({ ...state, loadHoldAt: undefined });
}
