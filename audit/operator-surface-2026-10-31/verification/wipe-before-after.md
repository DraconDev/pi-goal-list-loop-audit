# `/glla wipe` — reproduced at the real profile and fixed

Two earlier revisions of this file were wrong in different ways, and both are
recorded here rather than quietly overwritten:

1. The first concluded "no defect found" after measuring the operations *inside*
   `cmdGllaWipe` (`readState`, the queue scan, the ownership recheck,
   `appendLedger`). They are all sub-millisecond — and they were never where the
   time went.
2. The second credited an index on `computeListDepthFromLedger`. That index is a
   real fix for a real defect, but it fixes `/list depth`, not `/glla wipe`:
   `cmdGllaWipe` never calls it, and `extensions/goal-commands.ts:1711` is its only
   caller.

What follows is the measurement that finally located the cost, taken by driving
the real command end to end.

## The real profile (observed)

| Path | Size |
| --- | --- |
| `ledger-segments/` | **31 files, 281,553,674 bytes** (largest single segment 28 MB) |
| `active.jsonl` | 7.5 MB |
| `audits.jsonl` | 3.2 MB |
| `.pi-glla` total | 295 MB |

The objective's hypothesis (`active.jsonl` ~3.9 MB, `audits.jsonl` ~3.1 MB) was
pointing at the small files. The mass is the rotated segments.

## Before — the cause, located by tracing the call

Driving `pi.command("glla", "wipe", ctx)` against a hardlinked copy of that exact
profile, with `scanLedgerRecords` instrumented to dump its stack:

```
cmdGllaWipe (goal-commands.ts:2824)
  → archiveCurrentGoal (goal-orchestrator.ts:1652)
    → fireReviewer (goal-auditor-hooks.ts:2907)
      → scanLedgerRecords                       ← one pass over 280 MB
```

| Leg | Before |
| --- | --- |
| `/glla wipe` end-to-end | **912 ms** (repeat runs 653 / 642 ms) |
| `scanLedgerRecords` (all 280 MB) | **749 ms** |
| full-history scans during one wipe | **1** |
| `readState` | 0.2 ms |
| `ledgerFiles` | 0.1–0.2 ms |
| `readQueueFromDisk` | 0.2 ms |
| `appendLedger` (first / warm) | 0.1 / 0.0 ms |

The motive is disproportionate: `fireReviewer` streams months of history to
answer two questions that are both bounded to *today* — "did a review fire in the
last 5 minutes" (`REVIEWER_REFIRE_WINDOW_MS`) and "how many fired today"
(`reviewsToday`, a UTC day).

## After — bounded to the question actually asked

`scanLedgerRecordsSince(cwd, sinceMs, onRecord)` visits segments newest-first and
stops at the first segment contributing no row at or after `sinceMs`; every older
segment is older than it, so it cannot contain a qualifying row either. A row with
no parseable timestamp is delivered rather than dropped.

`fireReviewer` uses a 24-hour lookback, a provable superset of both predicates:
the UTC day start is never more than 24 h before `now`, and the 5-minute refire
window sits inside that.

| Leg | After |
| --- | --- |
| `/glla wipe` end-to-end | **71 ms** (≈9–13× faster) |
| full-history scans during one wipe | **0** |
| segments read for the reviewer | live tail + 1 boundary segment |

Same profile, same command, same state.

## The test that pins it

`tests/glla-wipe-real-path.test.ts` drives the real `cmdGllaWipe` against a
>20 MB historical fixture and asserts:

- the wipe really ran (goal archived as aborted, not short-circuited);
- `scanLedgerRecords` was invoked **zero** times — the deterministic pin;
- the wipe stayed under a host-scaled wall-clock ceiling — secondary only.

Reverting `fireReviewer` to the full scan fails it with "the wipe performed a
full-ledger scan — the reviewer is reading all history again". A wall-clock
ceiling alone was rejected as the pin because a loaded host can let a rescan slip
under one; that is precisely how an earlier version of this control passed while
still being wrong.

## Separate defect found while measuring: `/list depth`

Not the wipe, and not reported as the wipe. `computeListDepthFromLedger` scanned
all history to answer a per-goal depth question, costing 3.1–4.8 s at this
profile. It now uses a durable per-goal finals index with bounded backfill:

| | Before | After |
| --- | --- | --- |
| `/list depth` first read | 3100–4841 ms | 77 ms |
| steady state | 3100–4841 ms | 11.1 ms |
| converged answer | full scan | byte-identical |

`tests/wipe-ledger-scan.test.ts` pins that one: a warm depth read must fold 0
ledger bytes and must not call `scanLedgerRecords`.
