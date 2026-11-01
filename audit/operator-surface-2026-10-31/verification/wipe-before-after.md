# /glla wipe — reproduced, measured, fixed

A previous revision of this file concluded "no defect found". That conclusion was
wrong, and this file replaces it.

## What the earlier probe missed

It measured the operations inside `cmdWipe` (`readState`, the queue scan, the
ownership recheck, `appendLedger`) and found them all sub-millisecond. They still
are. The freeze was never in those operations — it was in the **full-history
ledger scan** that the state/depth/status surfaces perform, which reads every
ledger byte.

## The real profile (observed, not inferred)

`.pi-glla` on this machine at the time of measurement:

| Path | Size |
| --- | --- |
| `ledger-segments/` (32 files) | **269 MB** (largest single segment 29 MB) |
| `ledger-segments` total bytes | **287,721,820** |
| `active.jsonl` | 5.9 MB |
| `audits.jsonl` | 3.2 MB |
| `.pi-glla` total | 292 MB |

The objective's hypothesis (`active.jsonl` ~3.9 MB, `audits.jsonl` ~3.1 MB) was
pointing at the small files. The mass is the rotated segments.

## Before — the cause, reproduced

Measured against a copy of that exact profile:

| Operation | Time |
| --- | --- |
| `scanLedgerRecords` (reads all 287 MB, 61,297 rows) | **4841 ms** |
| `readLedgerTail(50)` (reverse, bounded) | 32 ms |
| `readState` | 7.5 ms |
| `appendLedger` | 0.44 ms |
| `ledgerFiles` (readdir + stat) | 22 ms |

4.84 s of synchronous main-thread work is the "looks frozen, then normal after
waiting" signature exactly. `computeListDepthFromLedger` — used by `/list depth`
and the status surfaces — called that scan on every read.

## After — bounded, and converged to the same answer

The fix keeps a durable index of the per-goal finals these reads need
(`.pi-glla/list-depth-index.json`), maintained at append time, with history that
predates the index backfilled a bounded 4 MB slice per call. Same profile:

| Measurement | Before | After |
| --- | --- | --- |
| One read of the depth surface | **4841 ms** | **77 ms** first call |
| Per-call backfill slices to full coverage | n/a | 51 calls, 0.7 s total |
| Steady-state read | 4841 ms | **11.1 ms** |
| Answer vs full scan | — | **identical** (`durationSamples` 10, `avgDurationMs` 7252824) |

No single call ever blocks for seconds, and the converged answer is byte-for-byte
the answer the full scan produced. The bind is pinned by
`tests/wipe-ledger-scan.test.ts` (bounded first read, convergence to the exact
full-scan result, cheap warm reads); reverting to the full scan fails the warm-read
budget.

## Honest scope note

`cmdWipe`'s own body remains free of the freeze; the reproduced multi-second block
was the ledger rescan reached from the depth/status reads that a wipe triggers as
the surface re-renders. Both are now bounded. No wipe code was changed on an
unproven cause, and no timing here is estimated.
