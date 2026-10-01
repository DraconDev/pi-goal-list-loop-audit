# Task-Audit Cycle Loop — Respec (2026-10-01)

> Status: SPEC ONLY — no implementation in this round (scope vote 2026-10-01:
> Draft+UI first, loop respec as a spec doc). This document is the contract
> the implementation must satisfy.

## 1. Problem

The current `/loop` (Loop 3) only believes a number: the orchestrator runs a
`measure` command per iteration and stops on plateau / bounds. That law
killed doorknob-churn, but field experience (note.md, Oct 2026) is that the
loop "doesn't seem to achieve much at all" for goal-shaped work:

- No task structure: an iteration is an unbounded agent turn, not a plan.
- No per-increment verification: metricless loops have no verdict at all;
  metric loops verify the number, never the work behind it.
- No replanning: findings, drift, and dead ends never feed back into a plan.

## 2. Proposal: the task-audit cycle

A new loop kind, `task-audit`, that repeats one cycle until the contract is
complete or a bound hits:

```
propose tasklist → work the tasks → detached audit → replan from findings → …
```

Every cycle ends in an audit (scope vote 2026-10-01: task-audit cycle, not
periodic audits). The audit verdict is the cycle's only exit signal; the
replan step turns findings into the next cycle's tasklist.

## 3. Non-goals

- Replacing the metric loop: `measure`/`direction` loops keep working
  unchanged (anti-doorknob law stands for polish work).
- Replacing `/goal`: a goal is ONE supervised objective with ONE completion
  audit; a task-audit loop is N cycles over an evolving tasklist.
- Parallel task execution: cycles run serially (same constraint as `/list`).

## 4. Contract

### 4.1 State

Extend `LoopState` (goal-loop-forever.ts) with:

- `kind: "audit" | "task-audit"` (`undefined` stays metric/metricless).
- `objective: string` — the loop's contract (what "complete" means).
- `verificationContract?: string` — extracted `Done when:` clauses; the
  auditor verifies against this every cycle.
- `cycle: number` — completed cycles (parallel to `iteration`).
- `taskList: Array<{ text: string; status: pending|active|complete }>` —
  the CURRENT cycle's list only; history lives in the ledger.
- `cycleFindings: string[]` — required-fixes excerpts from each cycle audit
  (bounded: last 5, tail-truncated like `auditFeedbackExcerpt`).

### 4.2 Cycle protocol

1. **Propose.** The orchestrator prompts the agent for a tasklist via the
   existing `propose_task_list` tool (cap: `max_subtasks_per_task`, default
   5 — reuse, don't reinvent). No Confirm gate: the loop's start command
   already carried consent; the audit gates quality instead.
2. **Work.** The agent works tasks with `complete_task` /
   `update_task_status` (existing tools). One `agent_end` per cycle max
   without task progress → stall accounting (reuse `stallCount` semantics:
   a cycle with zero completed tasks is a stall).
3. **Audit.** The orchestrator runs the EXISTING isolated auditor over the
   cycle's claimed tasks (same extension-less session, same `<evidence>`
   regression-shield rule). The claim is synthesized from completed tasks;
   disapproval returns required fixes, never a re-ask of the agent.
4. **Replan.** Required fixes + incomplete tasks become cycle N+1's seed.
   The agent proposes the next tasklist; the orchestrator does NOT carry
   tasks over silently — dropped tasks are ledger-recorded (`loop_task_dropped`
   with reason) so scope can't evaporate.

### 4.3 Stop conditions (checked after every audit)

- **Complete**: auditor approves ALL `verificationContract` items → archive
  with the audit history (same settlement path as `/goal`, not a new one).
- **Plateau**: `stallCount >= plateauWindow` (default 5) consecutive cycles
  with zero newly-approved tasks → stop, reason `plateau — …`.
- **Bounds**: `maxIterations` (cycles), `timeLimitHours`, `tokenBudget` —
  existing fields, unchanged semantics.
- **Manual**: `/loop stop` (existing).

### 4.4 Display

Reuse the paused/active card rows; the loop status line gains the cycle
position: `loop ⇄ cyc 3 · tasks 2/5 · last audit: approved 2 / fixes 1`.
No new widget surfaces — the existing card + `/loop status` carry it.

## 5. Command surface (proposed)

```
/loop task-audit start "<objective>. Done when: <clauses>"
/loop status        (existing — renders cycle rows for task-audit loops)
/loop stop          (existing)
```

No separate draft interview: without `Done when:` the start routes through
the SAME dynamic basic-draft gate as `/goal` (seed-sufficiency, 2026-10-01)
— rich seeds activate, thin seeds interview, `/loop plan` forces the draft.

## 6. Trust boundaries (unchanged)

- The auditor stays isolated (no extensions/skills) and evidence-bound
  (`<evidence>` shield applies to every cycle audit).
- The orchestrator synthesizes the cycle claim from tool-observed task
  completions — the agent never self-reports progress.
- Dropped-task ledgering is mandatory; a cycle that drops tasks without
  reasons is a displayable anomaly, not silent scope loss.

## 7. Implementation order (for the build round)

1. `LoopState` extension + ledger records + unit tests (pure core first).
2. Cycle state machine in goal-loop.ts behind the new kind (metric path
   untouched — every new branch asserts `kind === "task-audit"`).
3. Auditor reuse: synthesize cycle claims through the existing detached
   completion path (no second auditor implementation).
4. Display rows + `/loop status` cycle rendering + display tests.
5. `task-audit start` command + dynamic-draft routing + docs (README/
   COMMANDS) + CHANGELOG.

## 8. Open questions

1. Should a task-audit loop auto-convert an approved `/goal` follow-up
   ("resume to fix X") into cycle 1 instead of parking? (Screenshot
   2026-10-01 suggests yes — decide in build round.)
2. Cycle audit model: same auditor-model ladder as completion audits, or a
   cheaper default with escalation? Cost vs rigor tradeoff.
3. Max consecutive disapprovals before the loop parks for a user decision
   (vs grinding through the stall window)? Suggest 3, confirm in build.
