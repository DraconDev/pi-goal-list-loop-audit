// pi-goal-list-loop-audit — blank-until-resume auditor surface
//
// A cold session load may restore an unfinished objective without granting the
// supervisor permission to continue it. Keep the durable objective/list card
// visible, but do not re-surface the previous auditor report in newly built
// continuation context or feedback UI until a continuation consent path is
// admitted. The existing transcript is historical and is intentionally not
// edited.
//
// This module is dependency-free because the display, continuation, command,
// and lifecycle slices all need the same process-local gate.

let suppressedAfterColdRestore = false;

/** Hide only newly projected auditor feedback after a no-consent cold load. */
export function suppressAuditorSurfaceAfterColdRestore(): void {
  suppressedAfterColdRestore = true;
}

/** Release the gate after an actual explicit/automatic continuation consent. */
export function releaseAuditorSurface(): void {
  suppressedAfterColdRestore = false;
}

export function auditorSurfaceSuppressed(): boolean {
  return suppressedAfterColdRestore;
}

/** Test hook: prevent module state leaking between co-resident fixtures. */
export function __testOnlyResetAuditorSurface(): void {
  suppressedAfterColdRestore = false;
}
