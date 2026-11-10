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
