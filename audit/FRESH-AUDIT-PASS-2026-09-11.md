# Fresh audit pass — 2026-09-11 (v0.38.48 → v0.38.49)

Goal `20260911190130-sshy0k`. Three parallel scout surveys on v0.38.48
(runtime/session/tasks, prompts/display/docs, tests/packaging/release), all
collected, every candidate re-verified against the tree by the orchestrator
before recording. Six new findings, all FIX, all fixed on `main`. No DECIDE
findings: every surviving candidate already had its direction set by a prior
recorded decision or by an explicit pending-guard contract in the tree.

## Fixed (all boxes checked in `.pi-glla/audit-loop/findings.md`)

1. **Continuation prompt drift (MEDIUM)** — `prompts/goal-loop-continuation.md`
   now names `update_task_batch`, documents the pending-task refusal-before-audit
   gate plus the `record_goal_judgment` deferral exemption, and matches the
   rich-section renderer budgets instead of the old ~90-char one-bullet rule.
2. **README verify path (MEDIUM)** — the `complete_goal` steps include the
   pending-task refusal before audit.
3. **Docs versions/voice (LOW)** — INSTALL updating examples show the current
   versions; the supervision design doc distinguishes the verbatim six-label
   archive record from the rich chat/transcript sections and the compact
   width-bound projection.
4. **Summary gate segmentation (LOW)** — `missingCompletionSummaryLabels`
   segments on the same last-occurrence positions as every projector
   (`labelPositions`), so a label named inside an earlier value can no longer
   pass the gate while rendering shifted; removed the now-dead `labelIndex`.
5. **Task-tool honesty (LOW)** — already-complete `complete_task` reports
   `already complete`; same-status `update_task_status` reports
   `already <status>` with no persist round-trip.
6. **Sidecar pending boundary (LOW)** — the approval-render outbox and the
   update-check refresh defer while sessionDir resolution is pending. The
   outbox was already tree-safe via `ensureDirs` (but latched the degraded
   flag spuriously); the refresh path ran a real `mkdir -p` of the fallback
   tree on npm success, which the guard now prevents.

## Disposed scout claims (not findings, rationale recorded)

- `updateGoal` RAM-before-durable ordering, transaction-journal wording, and
  the deferred-task self-exemption: documented design (persistence-hardening
  header; deferral is an explicit judgment with reason + follow-up + ledger).
- Tool-executor concurrency / cross-goal races: no evidence of concurrent
  tool execution in the tree; refused to add speculative locking.
- `MECHANICAL_GREP_FILTER` / grep-sidecar bypass, `Goal.usage` shape,
  `schemas/goal.schema.json` vs stale local test shape (pinned both
  directions by `persistence-hardening`), unit-suite shelling real `pi`
  (mandatory boundary check by design), `pkill -f sleep` narrow markers
  (CI is Ubuntu-only; children are tracked and SIGKILLed), skipped legacy
  stop-RPC test (legacy-compat probe), root `*.html` session captures
  (gitignored, unpackaged, unreferenced).
- Update-check raw cache write staying fail-silent: by design; only the
  pending-guard was missing.

## Fixture accounting (deliberate re-baselines, exact multiples verified)

- Prompt template +769 chars / +771 bytes (one new em dash) / +775
  serialized bytes per payload from the batch/gate/voice guidance.
- `tests/context-growth-measurement.test.ts`: 22_570 chars, 22_670 bytes;
  5/12/25-probe rows stay exact multiples of the single payload.
- `tests/context-checkpoint.test.ts`: 25_331 → 26_106 (the same +775).
- New pins: stolen-label gate/projector agreement, already-complete and
  no-op task messages, sidecar pending deferral (no spawn, no tree).

## Verification

- `tsc --noEmit` clean.
- Full gate (`bun run test:all`): **2121 pass / 2 skip / 0 fail** across
  209 files (`/var/tmp/glla-gate-0.38.49.log`).
- `release:check` green: pack 97 files + tarball smoke
  (`/var/tmp/glla-relcheck-0.38.49.log`).
