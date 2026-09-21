# Audit metrics: challenge outcomes recorded (v0.38.80, 2026-09-21)

## What

v0.38.76's challenge round recorded its outcome in `result.challenge`
and the parent ignored it ("forensics and future surfacing"). This
release does the surfacing: the outcome threads through the parent
boundary onto every recorded `AuditVerdict`, and `/glla stats
challenges` reports the flip rate per project.

## Recording path

- `AuditorResultFile.challenge` declared (the worker already wrote it).
- `GoalAuditorResult.challenge` threaded at all four semantic return
  sites in the parent poll loop (generic verdict, shield pass, shield
  block, approve-without-tool demotion), bounded to 140 chars.
- Both verdict-construction sites record it: the detached settle path
  (goal-auditor-hooks.ts) and the `/goal verify` path (goal-tools.ts).
- `AuditVerdict.challenge` + `schemas/goal.schema.json` (T6 drift test
  covers the pair).

Semantics preserved: single-round verdicts record `not-applicable`
(explicitly challenged-system-N/A); legacy verdicts lack the field
(unknown). The final-line rule already composed the challenge into
approved/disapproved — the field is measurement, never verdict input.

## Stats

`ChallengeOutcomes` counts over every verdict in every final goal
snapshot: challenged (= confirmed + flipped), confirmed, flipped,
skipped (`skipped*` prefix). Flip rate = flipped / challenged, `—`
when zero. Skipped challenges never ran and legacy verdicts never
recorded — neither joins the denominator. New `challenges` view on
`/glla stats` (table + JSON, composes with `project=`); the main
rollup table and outcomes view are untouched.

## Verification

- New `tests/stats-challenges.test.ts` (3 tests): counts, empty-ledger
  zeros, table/JSON mirror.
- New `tests/auditor-challenge-record.test.ts` (2 tests, real worker +
  fake pi): confirmed approval records `confirmed` (via the
  shield-blocked path so the goal stays live), disapproval records
  `not-applicable`.
- `tests/auditor-process.test.ts` +2: threading through, absent stays
  undefined for legacy workers.
- Affected areas green: auditor-process, auditor-challenge,
  stats-outcomes, goal-loop-stats, release-contract, run-to-done,
  auditor-eager-retry, auditor-error-paths (112 tests), `tsc` clean.
