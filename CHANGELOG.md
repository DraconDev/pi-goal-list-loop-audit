# Changelog

All notable changes to pi-goal-loop-audit are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0] — 2026-07-20

The third loop. All three loops now ship on one state machine.

### Added

- **Loop 3: `/loop`** — metric-driven forever loop:
  `/loop start "<target>" measure="<cmd>" direction=min|max [window=5] [max=50]`,
  `/loop status`, `/loop stop`. The **orchestrator** runs the measure command
  after every agent turn (the agent never self-reports) and stops on plateau
  (`window` consecutive non-improving iterations), iteration cap, or
  `/loop stop`. This is the anti-doorknob design: the loop only believes a
  number. No auditor in loop 3 — the metric is the verdict. Pure logic in
  `extensions/goal-loop-forever.ts` (22 unit tests).
- **`propose_task_list` tool** — the agent can break a goal into milestones
  after a Confirm dialog. Anti-drift caps: 20 top-level tasks,
  **5 subtasks per task** (pi-goal-x flaw #4). Validation/ids in core,
  8 unit tests. Makes the existing `complete_task` / `update_task_status`
  tools actually usable.
- **`notify=<cmd>` setting** — config-gated push: shells out on goal complete,
  goal pause, and loop stop; message passed as `$1`.
  `/goal-settings notify='echo $1 >> /tmp/log'` — the settings parser is now
  quote-aware (a naive whitespace split mangled quoted commands to `"'echo"`).

### Fixed

- `/goal-settings` key=value parsing handles quoted values with spaces.
- Smoke harness is hermetic: all scenarios run under a bare
  `PI_CODING_AGENT_DIR` with a readiness wait — global extensions (including
  older npm installs of this package) can no longer collide with the dev
  build under test, and commands can't race the REPL into the agent.

### Verified live (2026-07-20, `scripts/smoke.sh`)

- `goal`: 5/5 — auditor approval, shield, archive.
- `list`: 4/4 — two queued items auto-advanced through audit, queue drained.
- `loop`: 5/5 — metric 5→0 with per-iteration stall accounting, plateau stop
  at window, `loop_stopped` in ledger, notify fired.
- `draft`: 3/3 — grill → Confirm dialog → audited approval.

## [0.2.0] — 2026-07-20

Second loop, the anti-bamboozle hardening, and drafting.

### Added

- **Loop 2: `/list`** — queue of goals: `/list add|show|next|remove <n>|clear`.
  Each item is a full goal (objective + verification contract). Completing or
  aborting a list-sourced goal auto-activates the next queued item; a session
  restart with a non-empty queue resumes automatically.
- **regression_shield** — when a goal has a verification contract, the auditor
  MUST produce an `<evidence>` block quoting raw tool output per contract item;
  the orchestrator converts `<approved/>` without complete evidence into a
  disapproval. Kills the "auditor ran `bash true` and approved" hole that
  pi-goal-x's author documented as unfixable-cheaply. Pure logic lives in
  `extensions/goal-loop-shield.ts` (dependency-free, fully unit-tested).
- **Drafting** — `/goal` with no args starts a clarification turn; the agent
  grills one focused question at a time, then `propose_goal_draft` opens a
  real Confirm dialog (Yes/No). Nothing activates before confirmation.
  `/goal "<objective>"` still skips drafting.
- **Escape dialog** — aborting the auditor (Esc) now asks: complete WITHOUT
  audit (user takes verification responsibility) or continue working.
- **Provider warning** — at `session_start`, if no auditor model is configured
  and the session model's provider is not a confirmed built-in, warn once with
  the exact `/goal-settings` fix.
- **Inline contract extraction** — one-liner objectives like
  `Create x.txt. Done when: grep -q ok x.txt` now extract the contract
  (previously only line-start markers worked, silently skipping the shield).
- **Integration harness** — `scripts/smoke.sh [goal|list|draft]` drives a real
  pi session in tmux and asserts on the ledger.

### Fixed

- State functions (`setGoal`/`archiveCurrentGoal`) no longer wipe the queue.
- `readState` restores `list` from the ledger; v0.1.0 ledgers upgrade cleanly.

### Verified live (2026-07-20)

- `/list`: two queued items auto-advanced through work → auditor → archive.
- regression_shield: auditor produced a verbatim `<evidence>` block;
  `shield=True` recorded in history.
- Drafting: grill → sharpened contract → Confirm dialog → audited completion.
- Provider warning fired exactly once on a kilocode session.
- `scripts/smoke.sh goal`: 5/5 assertions.

## [0.1.0] — 2026-07-20

First live-verified release. Everything in alpha.1, plus the fixes found by
running the loop end-to-end in a real pi session.

### Fixed (all found by live smoke testing)

- **Stale-ctx crash**: timers captured `ExtensionContext` which throws after
  session replacement. All timers now read a `lastCtx` refreshed by every
  event/command handler; stale ctx is detected and dropped safely.
- **API surface**: imports moved to the public entrypoint
  (`@earendil-works/pi-coding-agent`) with `Model` from `pi-ai` and
  `ThinkingLevel` from `pi-agent-core`. `sendMessage` is called on the `pi`
  API object, not `ExtensionContext`.
- **Tool contract**: tool results include `details`; command handlers are
  async; the tool event is `tool_call` (not `before_tool_call`).
- **Auditor "no model" failure**: auditor now defaults to `ctx.model` when no
  auditor model is configured, matching pi-goal-x's `resolveAuditorModel`.
- **Auditor model setting works**: `/goal-settings model=provider/id` resolves
  through the model registry (was a placeholder storing an unresolved id).
- **Audit-history pollution**: only non-empty auditor reports are recorded as
  verdicts (infrastructure failures surface via `pauseReason` instead);
  history capped at 20 entries; entries now carry an `error` field.
- **Objective quoting**: `/goal "..."` strips one layer of surrounding quotes.

### Added

- **Command-collision detection** (`warnOnCommandCollision`): pi never throws
  on duplicate command names (first registrant keeps the bare name, later ones
  get `:2`), so we detect duplicates at `session_start` and warn once.
- **Built-in-provider rule documented**: the auditor session has no extensions,
  so it can only use built-in providers. `/goal-settings` warns on save;
  INSTALL.md shows how to verify a model works extension-less.

### Verified live (2026-07-20)

- Full loop: `/goal` → agent works → `complete_goal` → isolated auditor
  (extension-less session, separate model) approves → archived with clean
  1-entry history and a real evidence-based auditor report.
- 5-consecutive-error auto-pause (triggered by a live provider 403 storm).
- Esc during audit: aborts the pi turn; loop recovers via `agent_end`.
  (pi-goal-x's Escape dialog is v0.2.0 scope.)

## [0.1.0-alpha.1] — 2026-07-19

### Added

- **Loop 1 (single goal)**: single ordered goal with isolated auditor.
  - `/goal "<objective>"` — bypass drafting, start now.
  - `/pi-gla-status` — show state + iteration counter + audit history.
  - `/pi-gla-pause` — pause with reason.
  - `/pi-gla-resume` — resume.
  - `/pi-gla-cancel` — abort + archive.
  - `/goaltings` — configure auditor model + thinking level.
  - `complete_goal` tool — spawns isolated auditor.
  - `pause_goal` tool — pause with reason.
  - `complete_task` tool — task tracking helper.
  - `update_task_status` tool — task tracking helper.
- **Isolated auditor** (`goal-loop-auditor.ts`): runs in fresh session, no extensions, no skills, no prompts, read-only tools.
- **JSONL state** (`.pi-gla/active.jsonl`): every state transition persisted.
- **Markdown goal file** (`.pi-gla/goals/<id>.md`): structured rendering replaces pi-goal-x's hand-concat.
- **Hard 5-min backoff cap** (`goal-loop-backoff.ts`): kills the 1-hour wait pathology.
- **Verification contract extraction**: `Done when:`, `Verify:`, `Verified when:` markers split objective from contract.
- **Schema** (`schemas/goal.schema.json`): JSON Schema for goal state.
- **Test suite**: 14 unit tests across 3 files (`tests/`).
- **Example** (`examples/example-objective.md`): worked walkthrough.

### Not included (deferred)

- Drafting phase with structured Q&A → v0.2.0.
- regression_shield auditor requirement (must include raw output) → v0.2.0.
- Loop 2 (list) → v0.2.0.
- Loop 3 (loop) → v0.3.0.
- Native TUI form widget → v0.2.0.
- Live pi session tests → v0.2.0.
- Telegram push → v0.3.0.

### Architecture notes

We deliberately **fork pi-goal-x 0.19.0** as the architectural basis. We **do not** support interop with `pi-goal-x`'s `.pi/goals/` directory. This is a clean break.

We **copy and adapt** the isolated auditor pattern (it's the architectural part that matters), but reduce the per-loop file count (no per-loop plugin files) and replace the hand-concat markdown renderer with structured JSON.

## [Unreleased] → v0.2.0 plan

- Drafting with structured Q&A (`/pi-gla`).
- regression_shield auditor.
- Native TUI form widget.
- Loop 2 (list).
- Live integration tests.
