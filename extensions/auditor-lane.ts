/**
 * pi-goal-list-loop-audit — extensions/auditor-lane.ts
 *
 * Which recovery lane owns a parked completion claim.
 *
 * v0.39.68 (field 2026-11-09): the audit lane already records a TYPED
 * failure class for every auditor failure — `no-verdict`, `timeout`,
 * `transport`, `provider`, `context-exhausted`
 * (`auditorResultFailureClass`, `extensions/goal-loop-auditor-process.ts`).
 * The class is persisted on the claim (`auditorFailureClass`) and is what
 * says whether the auditor produced nothing (`no-verdict`) or the provider
 * refused to answer (`provider`).
 *
 * The lane decisions re-parsed the RAW TEXT instead. v0.39.67 widened
 * `isRecoverableProviderError` to admit unclassified failures ("in fact all
 * errors"), which made the text test disagree with the recorded class:
 *
 *   "Error: worker exited with code 1"  → class `no-verdict`
 *                                     → text test says "recoverable provider"
 *
 * The consequence was that the audit lane's whole bound machinery was
 * switched off for the failures it was built for: the three-identical-
 * failure slowdown marker fires only when the plan is bounded, the 24h
 * dispatch horizon binds only for a non-recoverable diagnostic, and the
 * one-shot marker is bypassed only by a recoverable one. An auditor that
 * kept dying with its own crash text moved onto the provider lane's
 * unbounded five-minute cadence — a fresh detached auditor every five
 * minutes, forever, with no slowdown marker and no horizon.
 *
 * The class wins over the text. A claim whose last failure the auditor
 * owns (`no-verdict`, `context-exhausted`) stays on the auditor's own lane:
 * the bounded ladder, the slowdown marker, the horizon and the one-shot all
 * apply again. Everything else keeps v0.39.67's widened text test, so a
 * real provider wall — including an unparseable one like `provider returned
 * 503` — still retries with durable authority.
 *
 * Lives in a leaf module (it imports only the provider vocabulary and the
 * class vocabulary) so both the audit lane and the persistent-provider
 * ownership test can read one definition.
 */

import { isRecoverableProviderError } from "./main-model-recovery.js";
import { classifyMainModelFailure, quotaResetSleepMs } from "./main-model-recovery.js";

/** The classes the auditor owns outright: a retry reproduces the same wall.
 * `no-verdict` — the auditor produced nothing (crash, exit code, no output).
 * `context-exhausted` — resuming an already-overflowed transcript reproduces
 * the same wall, so it is not a provider outage to wait out. */
const AUDITOR_OWNED_CLASSES: ReadonlySet<string> = new Set(["no-verdict", "context-exhausted"]);

/** True when the recorded class says the auditor owns this failure. */
export function isAuditorOwnedFailureClass(value: unknown): boolean {
  return typeof value === "string" && AUDITOR_OWNED_CLASSES.has(value);
}

/**
 * Does this claim belong to the provider lane (unbounded durable retry), or
 * to the auditor's own lane (bounded ladder + slowdown marker + horizon)?
 *
 * The recorded class decides when it is present; the raw text decides when
 * it is not (a claim parked before the class existed, or by a host boundary
 * that produced no failure of its own).
 */
export function claimUsesProviderLane(
  claim: { auditorFailureClass?: string; providerErrorDiagnostic?: string } | undefined | null,
): boolean {
  if (!claim) return false;
  if (isAuditorOwnedFailureClass(claim.auditorFailureClass)) return false;
  return isRecoverableProviderError(claim.providerErrorDiagnostic);
}

/**
 * The pause reasons that mean "the audit lane parked this claim" — the only
 * ones an AUTOMATIC recovery may resume.
 *
 * A park that arms a retry timer and then writes a reason outside this
 * vocabulary strands its own claim: the recovery gate refuses it, the timer
 * fires into a refusal, and the claim waits for a human. That is how the
 * timeout park and the thrown-infrastructure park behaved (their reasons read
 * "completion audit timed out …" / "completion auditor infrastructure
 * failure …"), while the ladder parks ("auditor retry: …") recovered fine.
 *
 * A DELIBERATE stop stays outside: the cursor could not be persisted, the
 * candidate chain is exhausted, aggressive recovery is off, the recovery
 * horizon was reached — those are honest manual decisions, and an automatic
 * recovery must not paper over them.
 */
const AUDIT_PARK_PAUSE_REASON =
  /^(?:auditor retry:|auditor blocked:|completion audit (?:blocked|timed out|stopped)|completion auditor infrastructure failure)/;

/** True when this pause reason is an audit-lane park an automatic recovery
 * may resume. */
export function isAuditParkPauseReason(reason: string | undefined): boolean {
  return AUDIT_PARK_PAUSE_REASON.test((reason ?? "").trim());
}

/**
 * How long the provider told us to wait, if it said anything at all.
 *
 * v0.39.69 (field 2026-11-10): the audit lane ignored the reset hint
 * entirely — it re-armed a flat five minutes at every attempt, so a plan
 * that had quoted `resets <ISO>` hours or a week away was hammered twelve
 * times an hour for the whole outage, with the card repeating "Auditor still
 * failing — next auto-retry in 5m". The main lane has honoured the hint
 * since v0.38.69. Returns `undefined` when the provider quoted nothing, which
 * is the case the operator escalates instead of waiting forever.
 */
export function auditResetWaitMs(
  claim: { providerErrorDiagnostic?: string } | undefined | null,
  nowMs = Date.now(),
): number | undefined {
  const raw = claim?.providerErrorDiagnostic;
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  return quotaResetSleepMs(classifyMainModelFailure(raw), nowMs);
}

/** A no-verdict audit episode older than this stops retrying by itself and
 * asks the operator.
 *
 * Deliberately longer than every quota window a single audit can legitimately
 * eat (a five-hour plan quota straddling an audit start must be waited out,
 * not escalated), and deliberately shorter than a day, because the field
 * shape that motivated it sat 4h24m repeating "still failing" with no
 * actionable line. A quoted reset always outranks this bound: while the
 * provider has told us when it will answer, waiting is correct and the
 * escalation does not fire. */
export const AUDIT_NO_PROGRESS_ESCALATE_MS = 6 * 60 * 60_000;

/**
 * Has this parked audit used up its automatic patience?
 *
 * Returns the escalation reason, or `undefined` while automatic retries are
 * still the right answer. The two exemptions are deliberate:
 *
 * - **A quoted reset is being waited on.** The provider said when it will
 *   answer (even "next week"), so retrying is not a dead end — it is a
 *   scheduled wait. `resetAt`/`resetMs` are reported so the caller can say
 *   *when*, instead of "still failing".
 * - **The episode is younger than {@link AUDIT_NO_PROGRESS_ESCALATE_MS}.**
 *
 * `noProgressSince` must survive a cursor reseed: it is the age of the
 * *episode*, not of the current candidate chain. A claim with no recorded
 * start falls back to its first retry timestamp and then to `recoveryAt`.
 */
export function auditNoProgressEscalation(
  claim: {
    providerErrorDiagnostic?: string;
    auditorNoProgressSince?: string;
    retryFirstAt?: string;
    recoveryAt?: string;
    auditorFailureClass?: string;
  } | undefined | null,
  nowMs = Date.now(),
): { reason: "waiting"; resetMs: number; resetAt: string } | { reason: "no-progress"; sinceMs: number; hours: number } | undefined {
  if (!claim) return undefined;
  const resetMs = auditResetWaitMs(claim, nowMs);
  if (resetMs !== undefined) {
    return { reason: "waiting", resetMs, resetAt: new Date(nowMs + resetMs).toISOString() };
  }
  const since = [claim.auditorNoProgressSince, claim.retryFirstAt, claim.recoveryAt]
    .map((value) => (typeof value === "string" ? Date.parse(value) : Number.NaN))
    .find((value) => Number.isFinite(value));
  if (!Number.isFinite(since)) return undefined;
  if (nowMs - since! < AUDIT_NO_PROGRESS_ESCALATE_MS) return undefined;
  return { reason: "no-progress", sinceMs: since!, hours: Math.round((nowMs - since!) / 3_600_000) };
}
