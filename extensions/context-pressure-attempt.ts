import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { MainModelFailure } from './main-model-recovery.js';
import * as fs from 'node:fs';
import * as path from 'node:path';

type PressureContext = Pick<ExtensionContext, 'sessionManager' | 'isIdle' | 'hasPendingMessages' | 'compact' | 'abort'>;
let pressureTimeoutMs = 120_000;
export function __testOnlySetPressureTimeout(ms?: number): void { pressureTimeoutMs = ms ?? 120_000; }
export type PressurePhase = 'queued' | 'compacting' | 'held' | 'spent';
interface Attempt {
  phase: PressurePhase;
  failure: MainModelFailure;
  valid(): boolean;
  fallback(failure: MainModelFailure): void;
  record(event: string): void;
  timeout(): boolean | void;
  budget?: { file: string; key: string };
  timeoutMs?: number;
  timer?: ReturnType<typeof setTimeout>;
  admissionTimer?: ReturnType<typeof setInterval>;
}
// Owner identity is shared by event contexts, not by cwd: callbacks from an
// old session must never settle a successor's attempt.
const attempts = new WeakMap<object, Attempt>();
const exclusions = new WeakSet<object>();
type PressureOwner = { sessionManager?: object };
function owner(ctx: PressureOwner): object { return ctx.sessionManager ?? ctx; }

export function setPressureExclusion(ctx: PressureOwner, excluded: boolean): void {
  if (excluded) exclusions.add(owner(ctx)); else exclusions.delete(owner(ctx));
}
export function pressureExcluded(ctx: PressureOwner): boolean { return exclusions.has(owner(ctx)); }

/** A compaction success does NOT reset this one-attempt budget. Only a healthy
 * work turn/new request may do that, otherwise a failed retry can compact forever. */
export function claimPressureAttempt(ctx: PressureContext, options: Omit<Attempt, 'phase' | 'timer'>): boolean {
  const key = owner(ctx);
  const existing = attempts.get(key);
  if (existing) {
    if (existing.valid()) return existing.phase !== 'spent';
    clearPressureAttempt(ctx);
  }
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
  // The deadline owns the entire episode, including waiting for idle. Do not
  // extend it on repeated settled contacts or host-owned retry notifications.
  attempt.timer = setTimeout(() => {
    if (attempts.get(key) !== attempt || attempt.phase === 'spent' || !attempt.valid()) return;
    const cancelCompactor = attempt.phase === 'compacting';
    attempt.phase = 'held'; // Claim the terminal hold before callbacks can re-enter.
    if (attempt.admissionTimer) clearInterval(attempt.admissionTimer);
    attempt.record('timeout');
    // Cancel only the owned compaction before handing off. A cancellation
    // after handoff could abort the newly resumed provider request instead.
    if (cancelCompactor) try { ctx.abort(); } catch { /* safe recovery still owns the deadline */ }
    try { if (attempt.timeout() !== false) attempt.phase = 'spent'; }
    catch { /* Failed persistence retains the process-local terminal hold. */ }
  }, options.timeoutMs ?? pressureTimeoutMs);
  attempt.timer.unref?.();
  // Older hosts need not emit agent_settled. A bounded idle probe is a safe
  // admission backstop, not a second recovery owner or a provider retry.
  attempt.admissionTimer = setInterval(() => {
    if (attempts.get(key) !== attempt) { if (attempt.admissionTimer) clearInterval(attempt.admissionTimer); return; }
    if (!attempt.valid()) { clearPressureAttempt(ctx); return; }
    if (attempt.phase === 'queued') {
      try { flushPressureAttempt(ctx, { compactionInFlight: false }); }
      catch { /* Stale host probes defer safely until invalidation/deadline. */ }
    }
  }, 50);
  attempt.admissionTimer.unref?.();
  return true;
}
export function pressureBudgetClaimed(file: string, key: string): boolean {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')).key === key; }
  catch { return false; }
}
export function resetPressureBudget(file: string, key: string): void {
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (saved.key === key) fs.rmSync(file, { force: true });
  } catch { /* Conservative on unreadable storage. */ }
}
export function pressureAttemptPhase(ctx: PressureContext): PressurePhase | undefined {
  return attempts.get(owner(ctx))?.phase;
}
export function pressureAttemptPending(ctx: PressureContext): boolean {
  const attempt = attempts.get(owner(ctx));
  return !!attempt && attempt.phase !== 'spent' && attempt.valid();
}
export function retireSettledPressureAttempt(ctx: PressureContext): boolean {
  if (attempts.get(owner(ctx))?.phase !== 'spent') return false;
  clearPressureAttempt(ctx);
  return true;
}
export function clearPressureAttempt(ctx: PressureContext, resetBudget = false): void {
  const key = owner(ctx), attempt = attempts.get(key);
  exclusions.delete(key);
  if (attempt?.timer) clearTimeout(attempt.timer);
  if (attempt?.admissionTimer) clearInterval(attempt.admissionTimer);
  if (resetBudget && attempt?.budget) {
    try {
      const saved = JSON.parse(fs.readFileSync(attempt.budget.file, 'utf8'));
      if (saved.key === attempt.budget.key) fs.rmSync(attempt.budget.file, { force: true });
    } catch { /* A missing or unreadable budget stays conservative. */ }
  }
  attempts.delete(key);
}
export function settlePressureAttempt(ctx: PressureContext, outcome: 'success' | 'failure' | 'aborted' | 'retry-owned'): boolean {
  const attempt = attempts.get(owner(ctx));
  if (!attempt || attempt.phase === 'queued') return false;
  // v0.39.x audit: a success landing after the terminal hold is still
  // consumed as owned (fail-closed), but the attempt transcript must
  // distinguish "compact landed too late" from a timely settle.
  if (attempt.phase === 'spent' || attempt.phase === 'held') {
    if (outcome === 'success') attempt.record('late-success');
    return true;
  }
  if (outcome === 'retry-owned') return true;
  if (attempt.timer) clearTimeout(attempt.timer);
  if (attempt.admissionTimer) clearInterval(attempt.admissionTimer);
  attempt.phase = 'spent';
  if (!attempt.valid()) return true;
  attempt.record(outcome);
  if (outcome === 'failure') attempt.fallback(attempt.failure);
  return true;
}

/** Launch only after the failed request is idle. Never abort a healthy tool to
 * obtain idle, never contend with host-owned compaction, never send on success:
 * GLLA's session_compact resume debt owns that continuation. */
export function flushPressureAttempt(ctx: PressureContext, options: { compactionInFlight: boolean }): boolean {
  const key = owner(ctx), attempt = attempts.get(key);
  if (!attempt || attempt.phase === 'spent') return false;
  if (!attempt.valid()) { clearPressureAttempt(ctx); return false; }
  if (attempt.phase === 'compacting' || attempt.phase === 'held') return true;
  if (!options.compactionInFlight && (!ctx.isIdle() || ctx.hasPendingMessages())) return true;
  attempt.phase = 'compacting';
  if (attempt.admissionTimer) clearInterval(attempt.admissionTimer);
  attempt.record(options.compactionInFlight ? 'adopted' : 'started');
  if (options.compactionInFlight) return true;
  const settle = (outcome: 'success' | 'failure') => {
    if (attempts.get(key) === attempt) settlePressureAttempt(ctx, outcome);
  };
  if (typeof ctx.compact !== 'function') { settle('failure'); return true; }
  try { ctx.compact({
    // The callback alone cannot discharge resume debt. Keep dispatch blocked
    // until the authoritative session_compact event has been admitted.
    onComplete: () => { if (attempts.get(key) === attempt && attempt.phase === 'compacting' && attempt.valid()) attempt.record('callback-complete'); },
    onError: () => settle('failure'),
  }); }
  catch { settle('failure'); }
  return true;
}
