# Audit-job retention sweep (v0.38.72, 2026-09-20)

## Finding

`.pi-glla/audit-jobs/` held 207 job dirs: 115 with dead worker locks, 91
with no lock at all, 1 other. The v0.38.3 retention machinery
(`auditJobRetentionMs` + `cleanupDeadAuditJobs`) only ran via manual
`/glla audits health cleanup`, so nothing ever reaped in practice. The 91
lockless dirs were finished August audits (request + result on file) whose
locks predate the worker-role convention — classified "ambiguous" forever.

## Change

- `session_start` (admitted owner only, skipped while state-root
  resolution is pending) runs the existing `cleanupDeadAuditJobs` with
  the user's `auditJobRetentionMs`, ledgering `audit_jobs_retention_sweep`
  when it reaps. Fail-silent: wrapped so hygiene can never break startup.
- `inspectAuditJobHealth`: missing lock + `result.json` on file now
  classifies `dead` ("no worker lock; finished result on file") instead
  of ambiguous. A live audit always holds its lock, so this is provably
  finished — but a PRESENT-but-unparseable lock stays ambiguous (atomic
  lock writes make corruption genuinely weird).
- `cleanupDeadAuditJobs`: the pid re-verification now applies only to
  entries that carry a pid; pid-less dead entries are reachable only via
  the no-lock+result path and reap on age alone.
- No count cap: the time window (default 15m, max 7d) already bounds
  growth, and a newest-N cap could delete recent evidence. Ledger
  segments stay append-only by policy (DESIGN.md addendum v0.38.72).

## Verification

- New `tests/audit-job-retention.test.ts` (4 tests): old finished-lockless
  reaps / fresh finished kept / unfinished lockless kept / corrupt lock
  kept / dead pid reaps / live pid kept.
- Existing pins green: `auditor-process` + `persistence-recovery`
  (42 tests — no fixture is lockless+result, so the extension is purely
  additive).
- `tsc --noEmit` clean.
