# Tests

Run the current suite with:

```bash
npm test                 # runs: bun test
```

For the release gate (suite, typecheck, jiti regression, and the mandatory
hermetic auditor-extension boundary check), run:

```bash
npm run test:all
```

The suite is intentionally discovered by Bun rather than a hard-coded glob or
fixed test count; use the runner's summary for the current file and test
counts.

## What is covered

- **goal-loop-core.test.ts**: id generator, status labels, BFS next-pending-task,
  task summary, markdown rendering, file persistence, ledger append/read,
  token accumulation (`sumNewAssistantTokens` incl. dedup).
- **goal.schema.test.ts**: shape validation (lightweight; full JSON Schema
  validation would add a dependency — the schema itself is in `schemas/`).
- **extract-verification.test.ts**: contract extraction — line-start markers,
  inline one-liner markers, multi-line contracts.
- **list-queue.test.ts**: `/list` queue persistence + restore, v0.1.0-ledger
  upgrade compatibility.
- **regression-shield.test.ts**: `contractItems` parsing +
  `checkRegressionShield` accept/reject paths (evidence block, per-item
  coverage, bamboozle-style empty blocks).
- **loop-forever.test.ts**: metric parsing, improvement comparison, plateau /
  max-iteration termination, history cap, `/loop start` arg parsing,
  branch-name format.
- **task-list.test.ts**: proposal validation (20-task / 5-subtask caps) and
  hierarchical id assignment.
- **list-import.test.ts**: bulk list-import file parsing (checklists, bullets,
  numbered items; headings/comments skipped).
- **display.test.ts**: status-line + widget builders (pure, ANSI-free without
  a theme; elapsed formats; pause/auditing/loop branches).
- **goal-route.test.ts**: `/goal` argument routing (start/status/pause/…)
  and text-vs-command detection.
- **heartbeat.test.ts**: heartbeat/backoff predicates (nudge caps, refire
  windows, stall detection).
- **auditor-error-paths.test.ts**: auditor failure classification — infra
  errors are not disapprovals; verdict-quality failures are.
- **behavioral-orchestrator.test.ts**: registers the real `extensions/loops/goal.ts`
  handlers on `MockPi` and drives session/continuation behavior, including
  stale-handle and recovery branches.
- **loops/goal.test.ts**: registers the real goal-loop extension on `MockPi`
  and exercises the continuation-start watchdog and compaction re-arm paths.

The other test files cover the surrounding goal, list, loop, settings,
recovery, model, quota, auditor, persistence, and prompt behavior. The suite
is broader than a pure unit-test collection; its behavioral tests execute
extension handlers through the test harness.

## What is NOT covered by the Bun suite

- Live pi session behavior with the real host (commands, `agent_end` wiring,
  dialogs, session-manager handles, and detached auditor sessions). That is
  covered by the **live integration harness**:
  `scripts/smoke.sh [goal|list|draft|draft-reject|loop|bamboozle]` — drives real
  pi sessions in tmux under a hermetic `PI_CODING_AGENT_DIR` and asserts on the
  ledger.

## Conventions

- All file paths in tests use `path.join` (cross-platform).
- Tests use `node:test` + `node:assert/strict` (no test-framework dependency);
  **Bun is the supported test runner**.
- Pure logic lives in dependency-light modules (`goal-loop-core.ts`,
  `goal-loop-shield.ts`, `goal-loop-forever.ts`) for fast direct tests.
- Pi-dependent modules can be tested through `MockPi`; the behavioral suite
  registers the real extension handlers, while the smoke harness covers the
  remaining live-host boundary.
