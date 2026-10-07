import type { MainModelFailure } from './main-model-recovery.js';

// Relative pressure is deliberately independent of the opportunistic absolute
// token target: even a small-window model can overflow below 200k tokens.
export const CONTEXT_PRESSURE_RATIO = 0.9;
export interface PressureUsage { tokens?: number | null; contextWindow?: number; percent?: number | null }

/** Explicit prompt overflow only. Output-cap errors and incidental uses of
 * "context" are not evidence that the input transcript needs compaction. */
export function isExplicitPromptOverflow(raw: string): boolean {
  return /maximum context (?:length|window)(?:\s+(?:is|was))?\s*(?:exceeded|reached)|context[_ -](?:length|window)[_ -]exceeded|(?:input|prompt|context)\s+(?:is\s+)?too (?:large|long)|too many (?:input|prompt) tokens|exceeds? (?:the )?(?:maximum |model.s )?context (?:length|window)/i.test(raw);
}

export function compactFirstEligible(failure: MainModelFailure): boolean {
  return failure.nonRecoverableReason !== 'prompt-policy'
    && !/user (?:interrupt|abort)|cancelled by user|content policy violation/i.test(failure.raw);
}

export function shouldRecoverContextPressure(failure: MainModelFailure, usage?: PressureUsage): boolean {
  if (!compactFirstEligible(failure)) return false;
  if (isExplicitPromptOverflow(failure.raw)) return true;
  // A credential or deterministic refusal is not healed by a smaller prompt.
  if (failure.kind !== 'unknown' && failure.kind !== 'transient') return false;
  const tokens = usage?.tokens, window = usage?.contextWindow;
  if (typeof tokens !== 'number' || !Number.isFinite(tokens) || tokens <= 0
    || typeof window !== 'number' || !Number.isFinite(window) || window <= 0) return false;
  return tokens / window >= CONTEXT_PRESSURE_RATIO;
}
