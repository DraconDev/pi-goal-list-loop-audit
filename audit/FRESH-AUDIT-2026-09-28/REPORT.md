# Fresh project audit — 2026-09-28 (v0.38.103, branch main)

One survey pass over the whole project, run to completion. Objective: leave the
project in a known state, with the UI explicitly in scope.

## How the pass ran

Five read-only `scout` children launched together in a single workflow
(`64ff107c-5abc-412f-b570-9043e9292bb9`), one per subsystem, each with a ~35
tool-use budget, a ~150-line report cap and a mandatory `BLOCKERS` section:

| Area | Files surveyed | Raw report | Findings kept |
|---|---|---|---|
| loop engine | goal-loop.ts, goal-loop-core/dispatch/forever/repetition/stats/backoff/shield/subagents, orchestrator | `loop-engine.md` | 2 (1 HIGH, 1 MEDIUM) |
| continuation / recovery | goal-continuation, heartbeat, recovery, compactor, context-*, length-continue, start-context, main-model-recovery, quota-retry | `continuation-recovery.md` | 3 (2 MEDIUM, 1 LOW) |
| auditor | goal-loop-auditor-process, goal-loop-auditor, audit-lifecycle, auditor-extensions, reviewer, goal-auditor-hooks, worker script | `auditor.md` | 2 LOW |
| UI | goal-loop-display, goal-commands, settings-menu, goal-settings, goal-settings-ui, goal-ui, pickers, agents-panel, completion-summary, vision-assist, drafting | `ui.md` | 4 (1 MEDIUM, 3 LOW) |
| tools / state / docs | goal-tools, goal-activation, goal-orchestrator, goal-list-queue, goal-session, state roots, task-batch, prompt-layers | `tools-state-docs.md` | 2 (1 MEDIUM, 1 LOW) |

Every candidate was re-read and confirmed against the current tree by the
orchestrator before it was recorded; duplicates and disproved claims were
dropped. The five reports are the unmodified scout output.

## Result

- 13 findings recorded: **1 HIGH, 5 MEDIUM, 7 LOW** — all FIX, all fixed,
  all ticked with their fix commit in `.pi-glla/audit-loop/findings.md`.
- **No DECIDE findings.** Nothing in this pass was a direction or trade-off
  call: each candidate was a defect with one durable fix, so there was nothing
  to raise with the user. This is stated plainly here rather than left implied.
- The HIGH finding was silent data loss, not a cosmetic issue.

## The HIGH finding, in one paragraph

`commitPendingTerminalWork` — the helper that commits a loop's last iteration
before `finishLoopGit`'s destructive `git reset --hard` — was a closure inside
`runLoopTick`. But `/loop stop`, `/loop finish` and `/glla wipe` reach
`finishLoopGit` without passing through the tick at all, so the v0.35.4
guarantee ("a terminal stop never destroys the last iteration's work") applied
to exactly the routes that could not take a terminal stop. A user stopping a
branch-mode loop while the tick sat in `runMeasure` (up to a 10-minute measure
timeout) lost the in-flight iteration's uncommitted diff, and was then told the
work was waiting on the scratch branch. The helper is now at module scope and
`finishLoopGit` commits at its head, so every terminal route is covered by
construction and the reset can only discard what git already recorded.

## Gate

`npm run test:all`: **2786 pass, 2 skip, 0 fail** across 303 files, plus
`tsc --noEmit` clean, the jiti state-split repro, and the offline auditor
extension verification.

The first full run was red in 7 places. Three were caused by this pass (the
deliberate reset-hint ordering change and the module-scope hoist invalidated
four stale expectations — all updated to the new contract) and four were
already red at `3d7d4cab`, the commit before this pass began. Those four are
recorded in the ledger's final-gate follow-up section, root-caused, and fixed
in `8110b39a`; they are attributed as pre-existing rather than claimed as
scout findings.

## What this pass did not cover

Recorded so a later pass does not read silence as cleanliness:

- `goal-loop-auditor-process.ts` (2388 lines) and `loops/goal-auditor-hooks.ts`
  (2425 lines) were grep-sampled, not read end to end. `countTrailingComparableDisapprovals`,
  the fallback candidate walker and the settlement outbox were not traced.
- The docs/packaging half of the tools-state-docs brief (schemas vs runtime
  writes, `.github/workflows/publish.yml`, `prompts/*.md` tool-grant claims,
  the `tests/` vacuity scan) did not run — that scout spent its budget on the
  code half and said so in its `BLOCKERS` section.
- The machine was under heavy external load (load ~90 on 16 cores, 2 GB free
  RAM) throughout; no finding was dropped for flakiness, but any future pass
  should re-check the timing-sensitive suites.
