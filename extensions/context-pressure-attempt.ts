import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { MainModelFailure } from './main-model-recovery.js';
import * as fs from 'node:fs';
import * as path from 'node:path';

export type PressurePhase = 'queued' | 'compacting' | 'spent';
interface Attempt {
  phase: PressurePhase;
  failure: MainModelFailure;
  valid(): boolean;
  fallback(failure: MainModelFailure): void;
  record(event: string): void;
  timeout(): void;
  budget?: { file: string; key: string };
  timer?: ReturnType<typeof setTimeout>;
}
// Owner identity is shared by event contexts, not by cwd: callbacks from an
// old session must never settle a successor's attempt.
const attempts = new WeakMap<object, Attempt>();
function owner(ctx: Pick<ExtensionContext, 'sessionManager'>): object { return ctx.sessionManager ?? ctx; }

/** A compaction success does NOT reset this one-attempt budget. Only a healthy
 * work turn/new request may do that, otherwise a failed retry can compact forever. */
export function claimPressureAttempt(ctx: ExtensionContext, options: Omit<Attempt, 'phase' | 'timer'>): boolean {
  const key = owner(ctx);
  const existing = attempts.get(key);
  if (existing) return existing.phase !== 'spent';
  if (options.budget) {
    try {
      if (fs.existsSync(options.budget.file)) {
        const saved = JSON.parse(fs.readFileSync(options.budget.file, 'utf8'));
        if (saved.key === options.budget.key) return false;
      }
      fs.mkdirSync(path.dirname(options.budget.file), { recursive: true });
      fs.writeFileSync(options.budget.file, JSON.stringify({ key: options.budget.key, claimedAt: new Date().toISOString() }), { mode: 0o600 });
    } catch { return false; } // Without a durable claim, use ordinary fallback.
  }
  const attempt: Attempt = { ...options, phase: 'queued' };
  attempts.set(key, attempt);
  attempt.record('queued');
  return true;
}
export function resetPressureBudget(file: string, key: string): void {
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (saved.key === key) fs.rmSync(file, { force: true });
  } catch { /* Conservative on unreadable storage. */ }
}
export function pressureAttemptPending(ctx: ExtensionContext): boolean {
  const attempt = attempts.get(owner(ctx));
  return !!attempt && attempt.phase !== 'spent' && attempt.valid();
}
export function clearPressureAttempt(ctx: ExtensionContext, resetBudget = false): void {
  const key = owner(ctx), attempt = attempts.get(key);
  if (attempt?.timer) clearTimeout(attempt.timer);
  if (resetBudget && attempt?.budget) {
    try {
      const saved = JSON.parse(fs.readFileSync(attempt.budget.file, 'utf8'));
      if (saved.key === attempt.budget.key) fs.rmSync(attempt.budget.file, { force: true });
    } catch { /* A missing or unreadable budget stays conservative. */ }
  }
  attempts.delete(key);
}
export function settlePressureAttempt(ctx: ExtensionContext, outcome: 'success' | 'failure' | 'aborted' | 'retry-owned'): boolean {
  const attempt = attempts.get(owner(ctx));
  if (!attempt || attempt.phase === 'queued') return false;
  if (attempt.phase === 'spent') return true; // callback + event share ownership
  if (outcome === 'retry-owned') return true;
  if (attempt.timer) clearTimeout(attempt.timer);
  attempt.phase = 'spent';
  if (!attempt.valid()) return true;
  attempt.record(outcome);
  if (outcome === 'failure') attempt.fallback(attempt.failure);
  return true;
}

/** Launch only after the failed request is idle. Never abort a healthy tool to
 * obtain idle, never contend with host-owned compaction, never send on success:
 * GLLA's session_compact resume debt owns that continuation. */
export function flushPressureAttempt(ctx: ExtensionContext, options: { compactionInFlight: boolean; timeoutMs?: number }): boolean {
  const key = owner(ctx), attempt = attempts.get(key);
  if (!attempt || attempt.phase === 'spent') return false;
  if (!attempt.valid()) { clearPressureAttempt(ctx); return false; }
  if (attempt.phase === 'compacting') return true;
  if (!ctx.isIdle() || ctx.hasPendingMessages()) return true;
  attempt.phase = 'compacting';
  attempt.record(options.compactionInFlight ? 'adopted' : 'started');
  attempt.timer = setTimeout(() => {
    if (attempts.get(key) !== attempt || attempt.phase !== 'compacting' || !attempt.valid()) return;
    attempt.phase = 'spent';
    attempt.record('timeout');
    // The owner durably parks before cancelling a wedged compactor. Late abort
    // callbacks are absorbed rather than rotating/sending into a busy host.
    attempt.timeout();
    try { ctx.abort(); } catch { /* the durable timeout hold remains */ }
  }, options.timeoutMs ?? 120_000);
  attempt.timer.unref?.();
  if (options.compactionInFlight) return true;
  const settle = (outcome: 'success' | 'failure') => {
    if (attempts.get(key) === attempt) settlePressureAttempt(ctx, outcome);
  };
  if (typeof ctx.compact !== 'function') { settle('failure'); return true; }
  try { ctx.compact({ onComplete: () => settle('success'), onError: () => settle('failure') }); }
  catch { settle('failure'); }
  return true;
}
