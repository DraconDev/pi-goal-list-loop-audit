# Tests

Run with:

```bash
npm test
```

The test script is:
```
node --experimental-strip-types --test tests/*.test.ts
```

## What is covered (v0.21.1 — 168 unit tests)

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

## What is NOT covered by unit tests

- Live pi session behavior (commands, `agent_end` wiring, dialogs, auditor
  sessions). That is covered by the **live integration harness**:
  `scripts/smoke.sh [goal|list|draft|draft-reject|loop|bamboozle]` — drives real pi sessions in tmux
  under a hermetic `PI_CODING_AGENT_DIR` and asserts on the ledger.

## Conventions

- All file paths in tests use `path.join` (cross-platform).
- `node:test` + `node:assert/strict` (no test-framework dependency).
- Pure logic lives in dependency-free modules (`goal-loop-core.ts`,
  `goal-loop-shield.ts`, `goal-loop-forever.ts`) so tests never import pi.
- Pi-dependent modules (`loops/goal.ts`, `goal-loop-auditor.ts`) are covered
  by the smoke harness, not node tests.
