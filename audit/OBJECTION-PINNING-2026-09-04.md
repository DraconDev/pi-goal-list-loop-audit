# Objection-attached retries + PR #43 disposition (v0.38.21, 2026-09-04)

## The seed

Item 2 from the Antigravity survey discussion ("sounds good, but why didn't
we do it before — maybe there is more here") plus PR #43 (Bjynt,
detached-auditor observability): review the PR, decide for/against it, and
decide whether item 2 is an add. User grilled upfront (scope / depth /
defaults); answers: combined goal, full+supersede depth, PR defaults kept
(off + 15m, with the reasoning recorded in the goal thread).

## What the code already had (the "why didn't we" answer)

The prompt half of item 2 shipped in **v0.35.x** and nobody remembered:
`## LATEST AUDITOR DISAPPROVAL` already carries the full latest report
(content-embedded from `auditHistory`, fenced as untrusted data), plus the
TODO extraction and the blank-until-resume consent gate. Disapprovals were
rare, the TODO list looked sufficient, and no incident forced the question —
until the trilogy disapproval exposed what TODOs lose: the diagnostic
context, and any distinction between settled and live objections across
rounds. The real remainder was **round scoping**, not report surfacing.

## What this slice adds

- `AuditVerdict.superseded` / `supersededBy` (`extensions/goal-loop-core.ts`).
- `liveDisapproval(history)` selector + `markSupersededObjections(history, byRef)`.
- `appendAuditVerdict(history, entry)` — the single shared push path both
  verdict sites (detached `goal-auditor-hooks.ts`, manual `goal-tools.ts`)
  now call; the duplicated hand-rolled blocks are gone. New disapproval
  retires older live rounds; any clean approval (shield state irrelevant)
  clears the pin; errors/impossibles never touch flags; 20-cap preserved.
  `durationMs` promoted from `as any` to a typed field along the way.
- Continuation prompt argues the latest LIVE disapproval and appends the
  settled-rounds line (`Settled rounds (superseded, do not relitigate)`).
  Impossible/shield/approval paths behave exactly as before (guarded by
  `!live`).
- The pin embeds content already in `auditHistory` — never a path into a
  job dir, so PR #43's retention reaping cannot rot the link. This
  decoupling is why the 15m default stands.

## PR #43 disposition: MERGED

Reviewed (spawn-spec diff, survival-fix consume/reap paths, retention
threading), merged `origin/main` into the branch with union resolution on
three files (CHANGELOG + both approval notifies: v0.38.20 voice kept,
inspection pointer appended), targeted tests 105/105 green, merged to main
as `cb4a65f8` (GitHub marks the PR MERGED). Defaults kept: inspection off,
15m retention — quiet-by-default, disk-bounded, legacy parity.

## Verification

- `tests/objection-pinning.test.ts`: behavioral two-round MockPi drive
  (R1 → R2 → flags + prompt) with **true fail-before** (fails on the
  pre-prompt code, passes after), plus helper pins for
  approval/shield-clear/error-transparency and a no-job-dir-paths check.
  3/3 stable runs.
- `npx tsc --noEmit` clean; full `release:check` + publish per contract
  (see goal close).
