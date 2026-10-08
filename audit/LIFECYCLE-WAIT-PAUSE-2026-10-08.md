# Work lifecycle and background-wait distinction — 2026-10-08

**Goal**: 20261008170504-6ki1on — *waiting ≠ paused, lifecycle/activity model*.

## Outcome

The lifecycle/activity projection is now the single source of truth for cards,
status line, `/goal`/`/list`/`/loop` status, and the resumable checkpoint.

- `WorkLifecycle` (idle | running | waiting | paused | complete | cancelled) is
  derived in `extensions/work-lifecycle.ts` and consumed by
  `extensions/goal-loop-display.ts`. The widget stays activity-first; the
  status line and dedicated background-wait card carry the lifecycle label.
- `wait_for_background({runIds, reason})` is the only owner of the new
  lifecycle. `pause_goal(kind=standby)` is a compatibility entry requiring the
  same ids; both reject unknown or uncorrelated run ids and never guess a
  worker from a prose reason.
- Dependency identity is `targetId + sessionId + runId`. A foreign session
  cannot settle an owned wait; duplicate or stale events no-op.
- A running artifact without a published deadline is reconciled at most
  ~30 minutes after admission; a published deadline expires at that time;
  dead local pids settle earlier. No busy polling.
- Reload: only identity-matching public status artifacts settle. Frozen
  sessions, supervisor pauses, load holds and pending audits all keep
  authoritative evidence but never grant automatic continuation. Explicit
  resume reconciles dependencies instead of blindly re-sending the main work.

## Cards and displays

- Status line: ⏳ waiting for owned background, ⏸ paused for frozen, the
  existing ⏳ auto-retrying badge for supervised recovery. Lifecycle
  segment is appended only when the projection disambiguates a state the
  badge does not already expose (owned background wait, observed
  researching/implementing activity), so existing activity-first cards
  retain their row budget.
- Background-wait widget: lists dependency ids and outcomes, names the
  owner, points to the next action (`/goal status`, `/list status`, or
  `/loop status`).
- `/goal status`, `/list show`, `/loop status`, `/glla status` print
  `Lifecycle: … · Activity: …` and surface the owned dependency evidence
  alongside the saved checkpoint. `cmdResume` reconciles a held wait
  instead of launching a duplicate main turn.

## Validation

- Behavioral: 31 host/runtime tests across `tests/background-wait-runtime.test.ts`,
  `tests/background-wait-host.test.ts`, and the four work-surface rows of
  `tests/work-lifecycle.test.ts`. They cover goal / list / metric / project,
  owned completion, freeze during wait, multiple dependencies, completion
  racing admission, replacement / cancel, supervisor/load hold, pending
  audit, reload, legacy standby, storage failure, and per-surface pause-then-resume.
- Schema: `schemas/goal.schema.json` now defines `backgroundWait` and
  `lastBackgroundWait` with their dependency contract. `tests/persistence-hardening.test.ts`
  schema-drift pin passes.
- Pins: `tests/loop-forever.test.ts` L6 (loopTimer clear first), `tests/process-state-reset.test.ts`
  composite (reset includes `__testOnlyResetBackgroundWaitRuntime`).
- Release gate: `npm run release:check` — 3,449 pass, 1 skip, 0 fail;
  types clean; inventory clean; `npm pack` + installed-package RPC + skill
  import smoke all green. Nothing was published.

## Files changed

Extensions: `extensions/background-wait-runtime.ts` (new), `extensions/work-lifecycle.ts`,
`extensions/goal-loop-core.ts`, `extensions/goal-loop-forever.ts`, `extensions/goal-loop-display.ts`,
`extensions/goal-commands.ts`, `extensions/goal-loop.ts`, `extensions/loops/goal.ts`,
`extensions/loops/goal-activation.ts`. Schema: `schemas/goal.schema.json`.
Docs: `docs/DESIGN-work-lifecycle.md`, `docs/RECOVERY.md`, `README.md`.
Tests: `tests/background-wait-runtime.test.ts`, `tests/background-wait-host.test.ts`,
`tests/work-lifecycle.test.ts`.

## Evidence locations

- `/tmp/glla-background-focused.log` — early host+runtime gates.
- `/tmp/glla-display-focused.log` — display regression cluster.
- `/tmp/glla-lifecycle-release.log` — full release:check output.
- `/tmp/glla-test-processes-Tt6cTh/` — failure diagnostics from the second
  release pass; only stash, all tests passed.
