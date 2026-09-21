# Lifecycle map (v0.38.83, 2026-09-21)

## Premise correction

This item assumed each loop wired its own lifecycle handling (×3
duplication to unify). Evidence says otherwise: one extension entry
(`extensions/loops/goal.ts`), one `registerGoalRuntime`, exactly one
`session_start` registration. The 17 handlers each gate differently
on purpose (worker/subagent/foreign/host-successor planes with
different absorb-vs-return semantics — the comments say why), and the
800-line callback's structure is intentionally source-pinned
(including a 30k-char window pin with active curation history).
Unifying the gates would be wrong; fully extracting the callback
would fight load-bearing pins. So: navigate, don't restructure.

## What changed

Three stages extracted verbatim from the `session_start` callback
into nested helpers (same scope, same indentation, moved statements
byte-identical):

1. `admitSessionStart` — the foreign/worker gate. Returns null on
   refusal, else the admission facts (only `hostLifecycleStart` and
   `recordedOwner` are read later — verified by use analysis).
2. `claimSessionRootOrNotify` — admitted-root registration plus
   claim-or-refuse. Returns false after the read-only notify.
3. `retentionSweepAuditJobs` — the closed best-effort sweep.

All 12 stages carry `[lifecycle N/12]` banners; helpers live before
the `session_compact` registration (insertions before the window
pin's anchor, which is slice-relative and unaffected).

## Pin discipline

Pre-extraction audit classified every pin on the moved text:
whole-file presence pins (last-wins, stall-handling, owner-fence)
hold because moved text is identical; the 30k window pin holds
because extraction shrinks text above its targets (banners add ~300
chars against ~1.5k headroom). One pin needed a minimal update:
recovery-restore-after-restart's v0.34.63 guard pins the literal
`... return;` of the foreign-session refusal, which is `return null;`
inside the helper — the regex now allows both. The pinned contract
(the barrier-completing gate wired into the refusal condition) is
unchanged, and the adjacent behavioral refusal tests pass.

No new tests: this is a behavior-preserving refactor and the
behavioral suites are the net (durable-collateral: refactors ship
without new collateral).

## Verification

- `tsc` clean.
- Pin suites: hourly-quota-probe, last-wins, stall-handling (64).
- Lifecycle batch (233): behavioral-orchestrator (148),
  recovery-restore-after-restart, compaction-survival,
  compaction-containment, stale-interrupt-resume, host-session-lost,
  lifecycle-recovery, owner-fence, state-root-owner,
  subagent-host-boundary, audit-job-retention,
  future-sidecar-freshness — 232 pass + the 1 pin updated above,
  then its file re-run 4/4.
