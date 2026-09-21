# Compaction survival + cost-ceiling review (v0.38.75, 2026-09-20)

## Cost ceiling: already exists, verified by inspection

- Goals: `agent_end` token accounting pauses with notice when
  `tokensUsed > tokensLimit` (opt-in: limit 0/unset never pauses;
  raised via Token limit in /glla settings).
- Loops: `tokenBudget` stops with a `token budget exhausted` reason at
  two checkpoints. Nothing to build; nothing changed.

## Gap closed: end-to-end compaction survival

Existing coverage was unit-level (checkpoint projection shape and
prefix-cache stability, in-flight send suppression, settle probes,
overflow routing). Nothing fired genuine `session_compact` events
mid-run and proved the goal still completes.

New `tests/compaction-survival.test.ts` (2 tests):

1. Three mid-run compacts (ledger, resync arming, settle timers),
   goal still active, then full detached-audit completion with an
   approving fake auditor → archived `complete`.
2. A compact fired around an in-flight audit → still archives.

Both green. `tsc` clean. No production code touched.
