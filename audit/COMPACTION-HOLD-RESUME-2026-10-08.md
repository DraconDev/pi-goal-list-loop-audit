# Compaction hold / optional failback resume repair — 2026-10-08

## Report and ownership

User screenshot `Screenshot_20261008_105534.png` shows Deathrun paused on `context compaction failure: compact-first recovery exceeded its 120s budget`, several historical MiniMax 429 quota responses, a cancelled compaction, a `Probing the preferred primary now` notification, and an overlong clipped GLLA footer. Those old errors do not establish current provider availability. No provider API was probed during this investigation.

Read-only inspection of Deathrun's last 8 MiB of its journal confirmed: goal paused/error on the compaction timeout; `mainModelRecovery.primaryProbeInFlight: true`; active model equal to preferred primary; no retryAt, supervisor pause or load hold. Pressure attempt queued/started at 02:49:55Z and timed out at 02:51:55Z. No Deathrun source, state, owner marker or running process was changed. This is a GLLA resume-routing/display defect, not a MiniMax quota repair target.

## Root cause

`cmdResume` routed the optional preferred-primary probe before normal paused-goal activation. `probePreferredPrimary` reconciled the already-selected primary and called `scheduleSupervisedPrimaryProbe`; that helper intentionally dispatches only ACTIVE goals. The paused goal was never reactivated. Repeated resume therefore printed a probing notification while scheduling nothing. This is separate from actual provider health: a new real request is needed to test health.

## Repair

- `extensions/compaction-resume.ts`: shared legacy-compatible recognition of the compaction error hold and concrete recovery instructions.
- `extensions/goal-commands.ts`: optional failback does not consume manual resume for a compaction hold. Normal admission/persistence/reactivation and continuation scheduling run; the primary's health-verification marker remains until a real response settles it. Ordinary recovery, stale admission and other pauses retain their previous paths.
- `extensions/loops/goal-orchestrator.ts`: new timeout pauses name `resume`, `/model` and `/compact`, not undefined `Inspect compaction` work.
- `extensions/goal-loop-display.ts`: compaction-hold footer is short and action-first; the card projects actionable instructions for already-persisted old holds without rewriting journals. Does not alter Pi's footer renderer or provider-error transcript.
- `tests/compaction-hold-resume.test.ts`: actual registered goal/list commands reproduce the hold with optional probe metadata, assert durable ACTIVE transition and a dispatched request, retain pending health verification, and check the narrow footer/legacy-card instructions.

## Verification

- `timeout 180 bun test --timeout=60000 tests/compaction-hold-resume.test.ts`: 3 pass, 0 fail.
- `timeout 240 bun test --timeout=60000 tests/compaction-hold-resume.test.ts tests/main-model-recovery.test.ts tests/context-pressure-recovery.test.ts tests/compaction-failed-recovery.test.ts tests/paused-status-action-first.test.ts tests/display.test.ts`: 189 pass, 0 fail. `/tmp/glla-compaction-resume-focused.log`.
- `timeout 120 npm run check`: exit zero. `/tmp/glla-compaction-resume-types.log`.
- Runtime inventory regenerated; `git diff --check` clean.
- `timeout 1200 npm run release:check`: exit zero; 3393 pass, 1 pre-existing environment-gated skip, 0 fail across 360 files in 737s. Types, inventory, offline auditor-extension check and packed-package smoke pass. `/tmp/glla-compaction-resume-release.log`.
- No release tag/publication authorized or performed. Source/evidence committed by the repository's existing sync daemon on `main`; history and git identity unchanged.

## Live use

Global Pi package settings point to this local GLLA checkout. The operator can run `/reload`, then `/goal resume` in Deathrun (or `/list resume` for a list item). Reload is needed to load the repaired runtime; the existing running process is not hot-patched. This is operator guidance, not a claim that Deathrun has resumed or that MiniMax is currently healthy.
