# Risk-tiered auditing (v0.38.81, 2026-09-21)

## What

Every audit dispatches at a risk tier. Full tier is today's behavior
(audit plus the falsification round); light tier is the same
single-round audit with the same brief, shield, and tool floor — only
round 2 is skipped. Worst-case approval latency roughly halves for
light claims; the auditor still verifies everything.

## Resolution (escalation-only)

`resolveAuditTier` (pure, in goal-loop-auditor-process.ts) accumulates
full-tier reasons; nothing pushes a claim down:

1. Draft-time `fullAudit` consent (Goal flag, single-goal drafts only —
   same guards/Confirm-notice/ledger pattern as runToDone).
2. `complete_goal requestFullAudit` ("check me carefully"; rides the
   persisted claim to both dispatch paths).
3. Any prior disapproval (rework proved risky once).
4. Missing telemetry (unknown activity → conservative floor) or
   activity above the v1 ceilings (12 writes / 20 bash / 80 turns,
   inclusive).
5. High-stakes vocabulary in objective/contract/claim text (tight v1
   list: deploy/migration/auth/secrets/payments/destructive phrases).

Light claims then draw against `auditSpotCheckRate` (default 0.1):
hits run full and are marked `spotCheck` (the light population only —
a claim already full is never marked). `resolveClaimAuditTier` maps
goal + claim onto the resolver so both dispatch sites (complete_goal
launch, stored-claim retry) tier identically. Computed per dispatch:
stable across fallback candidates, re-resolved on re-dispatch.
Decisions ledger as `audit_tier_decided` with reasons.

## Mechanics

- `runDetachedGoalCompletionAuditor` is now a thin wrapper: the inner
  run is untouched, the wrapper stamps `auditTier`/`spotCheck` onto
  every result. Legacy callers (no tier args) see byte-identical
  results.
- Light sends `challenge: false` in request.json (omit-when-default —
  full requests hash byte-identically to pre-feature; old workers
  ignore the flag and always challenge). The worker skips round 2 and
  records `skipped: light-tier audit`.
- Verdicts carry `auditTier` + `spotCheck` (both settle sites, schema
  covered, T6 green). The challenges view gains the light count and
  spot flip rate — the calibration signal for ceilings/vocabulary.

## Verification

- `tests/audit-tier.test.ts` (16): resolver matrix, claim mapper,
  rate normalize/default, settings-menu row.
- `tests/audit-tier-record.test.ts` (6, real worker + fake pi): light
  verdict, spot verdict, claim escalation, draft consent + ledger,
  batch/list refusals.
- Worker + wrapper: light request skips round 2 with a recorded skip;
  tier/spot stamp on, legacy absent.
- Stats: light/spot counters, table + JSON mirror.
- Affected areas green: auditor-process/error-paths/eager-retry/
  challenge/challenge-record, run-to-done, completion-summary-quality,
  list-audit, objection-pinning, behavioral-orchestrator (148),
  settings editors/menu/postaudit/parked/overrides, stats suites,
  delegate-skill, release-contract; `tsc` clean; pack smoke green.
