# Task atomicity + pending-task completion gate — v0.38.48 (2026-09-11)

Goal `20260911161806-nhc6xh` (second cross-harness adoption item): atomic
task-batch updates plus a pending-task completion gate that refuses the
claim before the auditor with open items named; recorded deferrals exempt.

## What changed

- **Pure core** (`extensions/task-batch.ts`, new): `findTask` (BFS over
  top-level + subtasks), `validateTaskBatch` (empty batch, duplicate id,
  unknown id, illegal status all reject with the offender named; zero
  mutation on any path), `applyValidatedBatch` (deep-copy + apply, input
  never mutated), `withTaskStatus` / `patchTaskCopy` (single-update
  copy-swap), `collectOpenTasks` (BFS order, skips `complete` and
  `deferred`), `formatOpenTaskRefusal` (one `- <id>: "<title>" (<status>)`
  line per open task plus the resolve-or-defer pointer).
- **Tool rewiring** (`extensions/loops/goal-tools.ts`): `complete_task`
  and `update_task_status` keep their pinned messages but persist via
  copy-swap + a single `updateGoal`. New `update_task_batch` tool:
  Phase 1 validates the whole batch, Phase 2 verifies every `complete`
  milestone's `verificationContract` (failures named, nothing persisted),
  Phase 3 copies, applies, and persists once. Mid-batch kill leaves state
  untouched (pinned by a `test -f /nonexistent…` contract test).
- **Deferral stamp** (`record_goal_judgment` + `taskId`): only with
  `choice=deferred` and a resolvable id; stamps `task.deferred =
  { reason, followUp, at }` in the same `updateGoal` persist that writes
  the `durable_defer_choice` ledger entry (which now carries
  `taskId`/`taskTitle`). `inline` + `taskId` and unknown ids are refused
  with no ledger change — no accidental exemptions.
- **Completion gate** (`complete_goal`, before `newObjective`): any open
  committed task refuses the claim with `complete_goal REFUSED — N open
  committed tasks… NOT sent to the auditor`, each item named, plus a
  `complete_goal_tasks_refused` ledger entry. Deferred tasks are exempt.
  Refusal mutates nothing. Placed before the pivot branch so a
  `newObjective` cannot silently orphan committed tasks.
- **Schema** (`extensions/goal-loop-core.ts`): `Task.deferred` +
  `TaskDeferral{ reason, followUp, at }` (both required, non-empty).

## Tests

`tests/task-atomicity-gate.test.ts` — 7 pure-core pins + 10 MockPi pins:
batch apply/report, unknown-id byte-identical reject, mid-batch kill
untouched, single-tool pinned messages, judgment stamp/ledger, unknown-id
and inline+taskId refusals, claim-refused-naming-each (ledger has
`complete_goal_tasks_refused`, goal stays `active`, tool `details` `{}`,
no `AUDIT PENDING`), gate pass-through after batch-complete + deferral.
`tsc --noEmit` clean.

## Test-hygiene finding (pre-existing, not fixed here)

Files share one worker process with per-file module realms, but the
extension's ownership plane (live + dead owner) is process-global:
`session_shutdown` nulls the live owner yet preserves the dead identity,
so a successor file whose `session_start` is non-lifecycle (reason
`test`, in-memory manager) is refused as foreign BEFORE tool
registration — surfacing as `tool not registered` in the NEXT file.
Reproduced minimal (bare start+shutdown probe breaks the next file;
`__testOnlyResetOwnerSession()` after fixes it) and observed between two
pre-existing files (`completion-communication` → `durable-choice-ledger`
fails on unmodified code). Convention adopted for the new file: reset
trio at each harness start (successor-immune) + a trailing
`zzz successor-plane reset` test (predecessor-clean; an `after()` hook
does NOT run in the tests' realm under bun and does not fix it). Fixing
the pre-existing pair is out of scope for this goal.
