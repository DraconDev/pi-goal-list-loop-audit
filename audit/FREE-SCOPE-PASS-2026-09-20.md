# Free-only scope pass (v0.38.78, 2026-09-20)

## Rule

Remove only what is provably free: zero references across extensions,
tests, and scripts, verified by scan — plus `tsc` and the affected
slices. Anything load-bearing, platform-defensive, or merely
suspicious-looking stays.

## Removed (6 consts)

`DEFAULT_HOURLY_RETRY_PROBE` (goal-loop-core),
`EXPLORE_DEFAULT_DESCRIPTION` / `EXPLORE_DEFAULT_SYSTEM_PROMPT` /
`EXPLORE_DEFAULT_TOOLS` (goal-loop-subagents, dead aliases),
`MAX_AUTOMATIC_QUOTA_RETRY_SEC` and `isSubagentQuotaResult`
(quota-retry, dead aliases). Unused exported functions (≈40) were
left alone: deleting bodies needs per-function analysis, which is
not free.

## Incident: first sweep was wrong, caught before release

The initial script excluded the defining file from its reference
scan and dropped 55 consts, 49 of them used in their own files. The
deletions were auto-committed (never versioned, never released),
spotted on review, fully restored via worktree-only checkout, and
redone with the correct predicate. Final state verified: `tsc`
clean, quota/subagent/hourly slices green, release-contract green.

## Hourly pin window 28k → 30k

Unrelated find during verification: the v0.38.73 run-to-done consent
block pushed both schedule calls in the session_start handler to
~28.2k/28.5k chars past the handler anchor, past the pin's 28k slice
window. Calls unchanged and correctly placed; widened per the test's
own documented convention (v0.35.21 → v0.38.12 → now).
