# Auditor challenge round (v0.38.76, 2026-09-20)

## Rationale

Single-pass approvals plus fuzzy shield matching were the weakest link
in "hard to fake finished". A second adversarial pass in a fresh
session (no anchoring on round-1 reasoning) is the cheapest structural
strengthening available.

## Change (worker-level, parent untouched)

- `scripts/goal-auditor-worker.mjs`: the linear single-shot RPC flow is
  now `startRound()`, run once for the audit brief and — iff round 1
  settles ok with a final-line `<approved/>` — again with the
  falsification brief. Outputs concatenate with a separator; the
  final-line rule composes verdicts (challenge disapproval flips,
  re-confirm preserves). The shield keeps reading round-1's evidence
  block (first match wins).
- Fail-open, recorded: any round-2 failure truncates to byte-identical
  round-1 output with `result.challenge: skipped:<reason>`. Values:
  `confirmed` / `flipped` / `not-applicable` / `skipped:*`. Parent
  ignores the field (verdict comes from output); it exists for
  forensics and future surfacing.
- Cancellation wins outright: SIGTERM finishes `ok:false` even
  mid-challenge — never the round-1 fallback.
- New `challenging` progress phase (unions + HUD labels in the three
  TS files); same timeouts, tool allowlist, and process-group caps per
  round. Inspection `--session` is reused as-is; the brief carries full
  context either way.
- Tradeoff: worst-case approval latency roughly doubles. Parent
  wall-timeout + retry machinery absorbs overruns as infrastructure
  retries (existing behavior, no change).

## Verification

- New `tests/auditor-challenge.test.ts` (5 tests, real worker +
  prompt-branching fake pi): confirm preserves, flip composes,
  disapproval stays single-round, crash falls back byte-identical with
  `skipped:`, round-1 crash still fails without challenging.
- Existing worker suites green (auditor-process 36, error-paths +
  unmatched 16) — round 1 is behavior-identical to the old flow.
- `release-pack-smoke` worker probe updated: it now pins the challenge
  (`challenge: confirmed` on the packed worker). `tsc` clean.
