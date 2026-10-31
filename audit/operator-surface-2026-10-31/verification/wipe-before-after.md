# /glla wipe — measured, no defect found

Contract item 3 asked for a measured before/after. The honest result is that
there is nothing to fix, so instead of a fabricated "before", this records the
**disproof of each candidate cause** plus the budget the new test pins.

Profile used: the live repo journal — `active.jsonl` 4.1 MB / 109 rows, 42 of
them `state` rows totalling 4.01 MB, largest single line 136 KB.

| candidate cause | measured | verdict |
| --- | --- | --- |
| `readState` on the live journal | 3.5 ms | not the cause |
| `readState`, artificial 1000 rows / 8.9 MB | 14.5 ms | size is not the driver (10x rows ≈ 3x time) |
| `appendLedger` | 0.4 ms | not the cause |
| `readQueueFromDisk` | 0.70 ms | not the cause |
| `queueItemSidecarCount` | 0.09 ms | not the cause |
| `refreshOwnershipStanding(force)` | 0.36 ms | not the cause |
| `loadSettings` | 0.01 ms | not the cause |
| `renderGoalMarkdown` (goal) | 0.20 ms | not the cause |
| archive render + write, 120 audits | 0.3 ms | not the cause |

There is no lock, sleep, retry loop, or network call in the wipe path after
`warnIfStaleAtEntry`'s ownership recheck.

The journal-size hypothesis — the one the objective flagged as "a hypothesis,
not a finding" — is **disproved**.

Corroborating evidence that the original observation was made against a stale
build: the same session's banner reported `v0.39.36` while the repo is
`0.39.54` (see item 6).

## What ships instead

- `glla_wipe_timing` ledger row: the real duration of the wipe's own work,
  written on every wipe, so the next report of slowness carries a number.
- `tests/glla-wipe-latency.test.ts`: per-leg budgets plus a scaling sanity
  check, so a genuine regression (e.g. a full journal scan per state write)
  fails with the offending leg named.
