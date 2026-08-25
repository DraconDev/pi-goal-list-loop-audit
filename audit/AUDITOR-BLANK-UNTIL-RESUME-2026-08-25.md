# Auditor context held until resume — 2026-08-25

## Verdict

**Shipped in v0.35.63.** A cold session restore keeps the durable unfinished
goal/list objective and status visible, but suppresses only newly projected
previous-auditor feedback until a continuation consent path is admitted.

The existing Pi transcript is historical and is not edited. The gate prevents
GLLA from adding a fresh continuation prompt or stale auditor report to model
context before the user (or an explicitly enabled auto-resume policy) elects
to continue.

## Contract

- Cold restore with auto-resume off:
  - reloads the objective/list/queue state;
  - paints the objective and the held/resume status in the UI;
  - sends no continuation or user-message injection;
  - omits `LATEST AUDITOR` report text from new continuation context and the
    durable required-fixes feedback projection.
- `/goal resume`, `/list resume`, `/list next`, `/glla resume`, an admitted
  `/loop resume`, validated lifecycle continuity, and global `autoResume: true`
  release the surface gate only on consent paths that can continue work.
- A rejected or held scheduler attempt does not release the gate.
- Durable `auditHistory`, objective markdown, queue sidecars, and the prior
  transcript remain unchanged.

## Implementation

- `extensions/loops/goal-auditor-surface.ts` owns the dependency-free,
  process-local surface gate.
- `extensions/loops/goal-activation.ts` suppresses the surface at the cold
  load barrier and releases it only for admitted continuation consent.
- `extensions/goal-continuation.ts` gates the latest report in continuation
  and post-compaction context.
- `extensions/goal-loop-display.ts` gates only stale auditor feedback; the
  objective/status card remains visible.
- Explicit goal/list/glla/loop continuation commands release the gate after
  passing their existing foreign/stale guards. In particular, `/goal resume`
  now probes active-idle, paused, and main-model recovery paths before
  releasing; a stale paused/recovery resume still persists the existing
  `active + interrupted` recovery marker, but cannot expose old auditor
  context. Manual recovery holds, retry/pending-model-switch recovery, and
  primary-probe recovery each release only after that admission probe.

This is intentionally separate from the state-root work derived from PR #21:
state persistence and auditor-context consent are related lifecycle concerns,
but independent user-facing behaviors.

## Verification

- `tests/auditor-blank-until-resume.test.ts`: **5 pass / 0 fail**, including
  rejected stale `/goal resume` admission and admitted main-model recovery
  consent.
- `tests/stale-interrupt-resume.test.ts` and
  `tests/load-without-autostart.test.ts`: passed in the focused regression
  run; existing stale-resume persistence behavior remains covered.
- `npx tsc --noEmit`: **passed** (`/tmp/tsc-auditor-blank-repair3.log`).
- Fresh final `npm run release:check`
  (`/tmp/rc-auditor-blank-repair3.log`): **1584 pass / 0 fail / 2 skipped**,
  1586 tests across 146 files in 236.26s; Jiti smoke passed and
  `npm pack --dry-run` produced `pi-goal-list-loop-audit-0.35.63.tgz`.

## Post-audit repairs

The first completion claim was correctly disapproved because `/goal resume`
released the surface before its stale/foreign admission guard. The first
repair moved `releaseAuditorSurface()` after the admitted branches, added an
entry probe for active-idle resumes, and added the behavioral stale-resume
regression above. A rejected stale resume now leaves the gate suppressed,
sends no continuation, and preserves the durable stale-session recovery
marker.

The second completion claim exposed the same consent invariant in the
main-model recovery early-return branches. The second repair probes the
stale/foreign boundary before recovery handling and releases on all admitted
manual-hold, retry/pending-switch, and primary-probe branches. The new
behavioral recovery test proves the old auditor report returns only after an
admitted explicit resume; the stale regression also exercises the recovery
marker while that boundary is active. The third claim's final verification
re-ran the complete gate from the current main state. This final release gate
supersedes all earlier pre-repair evidence.
