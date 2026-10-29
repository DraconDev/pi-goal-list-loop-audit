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

/** True when the owned recovery wait's durable due time has already arrived.
 * A due wait is automation the operator's policy already scheduled; a future
 * wait is still a pending decision. Only the DUE case is exempt from the
 * cold-load consent hold — the wait never manufactures consent by itself. */
export function recoveryWaitIsDue(state: State, now = Date.now()): boolean {
  if (state.supervisorPausedAt || state.loadHoldAt) return false;
  if (!ownsPersistentProviderWait({ ...state, loadHoldAt: undefined, supervisorPausedAt: undefined })) return false;
  const due = [
    state.goal?.pendingCompletion?.recoveryRetryAt,
    state.goal?.pauseKind === 'wait' ? state.goal?.pauseResumeAt : undefined,
    state.mainModelRecovery?.retryAt,
  ]
    .map((value) => typeof value === 'string' ? Date.parse(value) : Number.NaN)
    .filter((value) => Number.isFinite(value));
  return due.length > 0 && due.some((value) => value <= now);
}
