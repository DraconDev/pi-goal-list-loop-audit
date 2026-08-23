// pi-goal-list-loop-audit — blank-until-resume auditor-surface gate 
//
// A genuinely fresh session (cold pi start, no resume consent) must stay
// BLANK of the previous session's auditor result: no LATEST AUDITOR block in
// injected continuation context, no last-auditor paint in the TUI. Durable
// state (active.jsonl / auditHistory) is untouched — an explicit resume in
// this session (or any continuation consent: auto-resume, handoff, rebind,
// stale-rearm) releases the gate and the report is available again from disk.
//
// Rationale (recorded 2026-08-23): strict "blank until /glla resume" would
// break unattended rigs whose auto-resume legitimately continues work and
// needs the auditor report to fix gaps. So the gate releases on ANY
// continuation consent, not just the manual command — default installs
// (auto-resume off) get exactly the user-visible behavior they asked for.

let suppressedAfterColdRestore = false;

/** Called on a fresh session_start with NO resume consent: hide last-auditor
 * surfaces until something in this session resumes/continues the work. */
export function suppressAuditorSurfaceAfterColdRestore(): void {
  suppressedAfterColdRestore = true;
}

/** Release the gate — any explicit resume or continuation consent. */
export function releaseAuditorSurface(): void {
  suppressedAfterColdRestore = false;
}

export function auditorSurfaceSuppressed(): boolean {
  return suppressedAfterColdRestore;
}

/** Test hook: reset module state so tests are order-independent. */
export function __testOnlyResetAuditorSurface(): void {
  suppressedAfterColdRestore = false;
}
