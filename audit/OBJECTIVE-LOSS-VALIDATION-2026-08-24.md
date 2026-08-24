# Objective-loss validation — 2026-08-24

## Verdict

The reported objective loss is **not a separate data-loss bug in the current
repository**. It has two distinct cases:

1. A Wez/Pi crash or restart in the same cwd preserves the durable state files;
   the current state/ledger and lifecycle handoff paths can reload them.
2. A cwd switch under the historical default `workingDir` intentionally selects
   a different `<cwd>/.pi-glla` root. The old objective remains on disk, but it
   is invisible from the new cwd. This is the cwd-coupling reproduced in the
   PR #21 investigation, not deletion or corruption.

The corrected opt-in `sessionDir` root is the repository-owned remedy when
objective visibility must survive cwd changes: both cwd values resolve to the
same top-level session `pi-glla` directory. No additional migration or
implicit root switch is safe because cwd remains the documented default and
old roots must remain untouched.

## Bounded evidence

`tests/objective-loss-state-root.test.ts` provides three behavioral cases:

- `workingDir default: cwd switch makes old objective invisible from new cwd
  (expected)` writes an active objective under `cwdA`, reads it from `cwdA`
  and `cwdB`, and proves `cwdB` has an empty independent root while `cwdA`
  still contains the objective.
- `sessionDir opt-in: same cwd switch keeps objective visible via shared
  sessionDir` writes under `cwdA`, reads through `cwdB`, and proves the same
  selected session root and objective are used.
- `evidence: no destructive migration and pending defers writes` proves an
  old cwd tree remains intact while session-root resolution is pending and
  that later writes land in the selected session root.

The preceding core/consumer tests also cover `PI_SESSION_FILE` worker
resolution, pending writes, queue/dispatch/reviewer/audit paths, and no raw
cwd-root consumer joins.

## Conclusion and boundary

The report is closed with evidence rather than a forced production change:
there is no evidence that a crash alone deletes an objective, while cwd
switch loss is explained and covered by the state-root port. Users who need
cross-cwd continuity must explicitly select `sessionDir`; silently changing
the default would be a destructive compatibility change. The subsequent
gettick, list-reload, and subagent-visibility reports remain separate queued
items.
