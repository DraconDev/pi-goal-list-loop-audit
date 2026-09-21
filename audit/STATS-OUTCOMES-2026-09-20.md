# `/glla stats outcomes` (v0.38.74, 2026-09-20)

## Rationale

The ledger records every completion, abort, audit round, and token
count, but nothing aggregated it — process changes (including v0.38.73
run-to-done mode) could only be judged on belief. This extends the
existing `/glla stats` rollup with an outcomes view rather than
inventing new telemetry.

## Change

- `GoalOutcomes` aggregation in `goal-loop-stats.ts`: done/aborted from
  `goal_archived` statuses, open from unarchived non-terminal state
  snapshots, mean audit rounds / wall-clock hours / tokens over
  completed goals with data, and the run-to-done vs supervised
  completion split (flag rides the last non-null state snapshot).
- Unknowns stay unknown: a goal without timing data is skipped from
  means. Caught in test: the archive event itself is a ledger sighting,
  so zero-delta durations are excluded (unknown, not instant).
- `/glla stats outcomes` (composes with `json` and `project=`), with
  matching table + JSON formatters. Existing stats output untouched.

## Verification

- New `tests/stats-outcomes.test.ts` (4 tests, pure `rollupEntries`
  over fabricated entries): counts + split, means over known data
  only, unknown-status/empty handling, formatter schema parity.
- Existing `goal-loop-stats` suite green (11/11 combined). `tsc` clean.
- Live smoke on this repo: 248 done / 26 aborted / 4 open, 91% rate,
  1.3 rounds, 1.1 hrs, 97,419 tok/done — consistent with 275 archive
  records (274 terminal + 1 in flight).
