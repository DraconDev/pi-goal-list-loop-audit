# Saved goal projections, restore-as-new, and the contract round trip (GitHub #62)

> **Shipped under `Unreleased` (no version bump, no tag).** `glla version` reports
> the loaded build; this work needs a release commit before it reaches npm.

## The report

A field report from a downstream project, on installed `0.39.61`:

1. A saved standalone-goal state **A** had `policy: "goal"`, a full
   objective/verification contract and a five-task/fifteen-subtask plan. Its
   markdown projection remained in `.pi-glla/goals/` saying `**Status**: active`.
2. Later work **B** had the same scope but `policy: "list"`,
   `createdVia: "list-cascade"`.
3. B was archived `aborted` with `stopReason: "list cancelled"`; the next state
   snapshot had `goal: null` and the list was empty.
4. `list_status()` said `Active: (none)` / `List: empty.`; `resume_goal` said
   `No active goal.` Reading `goals/A.md` alone suggested a goal was active.
5. Recovery required manual ledger inspection, a hand-built `/goal start`, and
   `propose_task_list` afterwards. The recreated contract gained an extra
   leading `Done when: ` (11 characters) even though every criterion survived —
   naive export/recreate is non-idempotent.
6. The report explicitly is **not** a claim that `/goal resume` should
   resurrect cancelled work, or that GLLA converted a goal into a list.

## What was actually wrong (verified in this tree)

| Claim | Verified | Where |
| --- | --- | --- |
| A projection can outlive the live slot | yes — `finalizeArchiveIntent` unlinks `goals/<id>.md` only AFTER the archive publishes, and `archiveCurrentGoal` clears the live slot in a separate step | `extensions/goal-loop-core.ts`, `extensions/loops/goal-orchestrator.ts` |
| Nothing named a saved record's relation to live state | yes — no surface classified `goals/*.md` at all | (absent before this change) |
| `/goal resume` / `resume_goal` mention the saved records | no — both answered only `No active goal` | `extensions/goal-commands.ts`, `extensions/loops/goal-tools.ts` |
| A contract round trip accumulates markers | yes — reproduced: `Done when: run tests` → `Done when: Done when: run tests` → … because the line-start path retained the marker line while the inline fallback consumed it | `extractVerificationContract` |
| Restore loses the task plan | yes — `/goal start` creates a goal with no `taskList`; the plan must be re-proposed | `createGoal` |

Reproduction of the marker accumulation, before this change:

```text
round 0: "- alpha renders\n- beta persists"            items: [alpha renders, beta persists]
round 1: "Done when: - alpha renders\n- beta persists" items: [alpha renders, beta persists]
round 2: "Done when: Done when: - alpha renders…"      items: ["Done when: - alpha renders", beta persists]
```

Note round 2: the shield's `contractItems` then treats `Done when: - alpha
renders` as one criterion, so the accumulation does not merely look untidy — it
changes what the auditor is asked to cite.

## What changed

### 1. `extensions/goal-recovery-inventory.ts` (new, pure renderer)

`collectSavedGoalRecords` reads `goals/*.md` and `archive/*.md`, `parseSavedGoalMarkdown`
parses a `renderGoalMarkdown` projection back into status/policy/stop reason/
objective/contract/plan size, `classifySavedRecord` compares it against the LIVE
slot, and `formatRecoveryInventory` renders `/goal recover`.

The classification rule is the whole fix: **only live state grants `CURRENT`.** A
file's own `**Status**: active` is reported, never promoted. Archive presence
decides `HISTORICAL`; a terminal marker with no archive is `TERMINAL,
UNARCHIVED` (cleanup debt). No `**Status**` marker is `UNREADABLE`, never a goal.

`buildRestoreRecipe` emits the `/goal start` command only when the parsed
objective and criteria set are identical to the saved ones, and reports
`criteriaIn`/`criteriaOut` so the surface can say `N criteria in, N out`. An
objective whose own `## ` heading makes its saved boundary unrecoverable gets no
command at all.

### 2. `/goal recover [id]` (`extensions/goal-commands.ts`)

Read-only. Notifies the inventory and journals `goal_recovery_inventory`
(`saved`, `stale`, `historical`, `recipes`, `orphanQueue`). It never resumes,
activates, archives, rewrites a projection or clears a sidecar — journaling what
it showed is the only durable effect. `savedRecordsNote` feeds the same summary
into `/goal status` and `/goal resume` when nothing is live.

Routing (`routeGoalArgs`) accepts a bare `recover` or exactly ONE id token.
`/goal recover the deleted fixtures from the backup` is an objective, not a
filter — a read-only verb must never swallow a start command.

### 3. Symmetric introducer handling (`extensions/goal-loop-core.ts`)

`CONTRACT_MARKER_PATTERN` is now the single introducer definition shared by
extraction, the dedup guard and the inventory preview. `stripContractIntroducers`
consumes repeated leading introducers; `extractVerificationContract` keeps ONE
marker line on the line-start path and collapses duplicates in front of captured
criteria. Criteria text is never rewritten, so a mid-sentence occurrence
(`the report says Done when: twice`) survives verbatim.

### 4. The recipe names the plan, and the receipt is not proof

The rendered recipe says the plan is recreated with `propose_task_list`, all
tasks pending, and that `/goal status` plus `list_status` must show the new goal
active with the same objective/contract/plan before recovery counts as done.

### 5. Docs

`docs/RECOVERY.md` gains "Saved records that disagree with live state" (the
label table), "Restore as NEW" (the five steps and the loss boundary) and
"Contract round trips are fixed points". `README.md` and `docs/INDEX.md` list
the new verb.

## Acceptance checks (§ Suggested checks of the issue)

| Issue check | Evidence |
| --- | --- |
| 1. Leftover projection + `goal: null` is not presented as running | `recovery-projection-truth.test.ts` ×3: classification `stale-projection`, `/goal status` and `/goal resume` replies name it and never echo `(active)` |
| 2. Paused goal / cancelled list / unrelated live work / history separately; no silent cross-mode switch or revived approval/timer | ×5: `CURRENT`, `HISTORICAL`, `TERMINAL, UNARCHIVED` separated; `/goal recover` deep-equals `readState` before/after; the recreation asserts `policy: "goal"`, `createdVia: "user"`, no `taskList`, no `auditHistory` |
| 3. Recover-as-new preserves objective/criteria/plan; history not accepted as current proof | ×4: criteria preserved, objective verbatim, plan size read back, completed rows labelled historical, `nothing pre-completed` |
| 4. Absent/inline/line-start/already-present introducers; no marker accumulation, no dropped criteria | ×5 parameterised fixed-point tests over 4 rounds each + a `stripContractIntroducers` unit set |
| 5. `accepted: true` is not activation evidence | ×2: the recipe text demands durable confirmation; the recreation test asserts the new goal in `readState`, not the command's return value |

## Loss boundary (unchanged, and now written down)

Restore-as-new does **not** revive: the goal id, checkpoints, audit history,
approvals, comparison baselines, armed timers, pause/deferral stamps, or any
completed task state. It recreates objective, contract and plan STRUCTURE
through public controls. Old tests and audit reports describe the old goal.

## Verification

```text
bun test tests/recovery-projection-truth.test.ts                → 28 pass / 0 fail
bun test tests/extract-verification.test.ts                     → 10 pass / 0 fail
bun test tests/contract-text-semantics.test.ts                  → 11 pass / 0 fail
bun test tests/goal-route.test.ts                               → 28 pass / 0 fail
bun test tests/list-parallel.test.ts                            → 10 pass / 0 fail
bun test tests/draft-readiness.test.ts                          → 13 pass / 0 fail
bun test tests/list-subtasks.test.ts                            → 22 pass / 0 fail
bun test tests/command-registration-collisions.test.ts           →  8 pass / 0 fail
bun test tests/replace-resume-intent.test.ts                    →  5 pass / 0 fail
bun test tests/mode-command-guidance.test.ts                    →  8 pass / 0 fail
bun test tests/ui-command-view-audit.test.ts                     →  3 pass / 0 fail
bun test tests/stale-interrupt-resume.test.ts                    → 18 pass / 0 fail
bun test tests/list-queue.test.ts                                → 15 pass / 0 fail
bun test tests/completion-trailing-space.test.ts                 →  6 pass / 0 fail
bun test tests/resume-rekick.test.ts                             →  4 pass / 0 fail
bun test tests/doc-index.test.ts                                 →  3 pass / 0 fail
bun test tests/doc-parity.test.ts                                → 13 pass / 0 fail
bun test tests/glla-ui-command-audit.test.ts                     → 29 pass / 0 fail
bun test tests/resume-goal-tool.test.ts                          → 10 pass / 0 fail
bun test tests/gettick-tool-visibility.test.ts                   →  1 pass / 0 fail
bun test tests/goal-loop-core.test.ts                            → 37 pass / 0 fail
bun test tests/goal-state.test.ts                                →  4 pass / 0 fail
bun test tests/goal-state-drift.test.ts                          →  7 pass / 0 fail
bun test tests/task-list.test.ts                                 →  9 pass / 0 fail
bun test tests/task-list-persistence.test.ts                     →  2 pass / 0 fail
bun test tests/disk-first-queue.test.ts                          → 18 pass / 0 fail
bun test tests/faulty-objective-recovery.test.ts                 → 46 pass / 0 fail
bun test tests/contract-resolution-runtime.test.ts               → 17 pass / 0 fail
bun test tests/suspicious-draft-contract.test.ts                 →  3 pass / 0 fail
bun test tests/goal-timeline.test.ts                             →  6 pass / 0 fail
bun test tests/lifecycle-recovery.test.ts                        →  7 pass / 0 fail
bun test tests/persistence-recovery.test.ts                      →  8 pass / 0 fail
bun test tests/objective-loss-lifecycle.test.ts                  →  4 pass / 0 fail
bun test tests/list-invisible-restart.test.ts                    →  6 pass / 0 fail
bun test tests/ui-status-projection.test.ts                      → 11 pass / 0 fail
bun test tests/state-root.test.ts                                →  5 pass / 0 fail
bun test tests/state-root-consumers.test.ts                      →  4 pass / 0 fail
bun test tests/state-root-failure.test.ts                        →  6 pass / 0 fail
bun test tests/recovery-lifecycle-regression.test.ts             → 30 pass / 0 fail
bun test tests/fresh-session-auto-recovery.test.ts                →  7 pass / 0 fail
bun test tests/load-hold-release.test.ts                         →  3 pass / 0 fail
bun test tests/behavioral-orchestrator.test.ts                   → 159 pass / 0 fail
npx tsc --noEmit                                                 → clean
node scripts/check-no-project-names.mjs                          → clean (778 new lines vs 14 watched names)
node scripts/generate-inventory.mjs --check                      → exit 0
npm run release:check (Bun 1.3.14)                               → 4635 pass / 1 skip / 0 fail (490 files, 991 s)
```

### The release gate ran, and it is green

The whole `npm run release:check` contract passes on the release tree:
**4635 pass / 1 skip / 0 fail across 490 files** (991 s), plus `tsc --noEmit`,
`check:inventory`, `check:names`, `npm pack --dry-run` and the pack smoke
(packed launcher RPC probe, packed skill load, installed-import probe).

The gate needs Bun ≥ 1.3.14 for `--parallel` / `--path-ignore-patterns`; this
host's system Bun is 1.3.3, so the run used a 1.3.14 binary placed first on
`PATH`. It was **not** run through a partial or file-by-file substitute.

An earlier draft of this document reported two "pre-existing failures"
(`tests/regression-shield.test.ts` and `tests/audit-lifecycle-surfaces.test.ts`
timing out at 5 s). That was wrong in an instructive way: those were bare
`bun test` runs using Bun's own 5 s per-test default, while the project runner
sizes a 120 s per-test budget (`DEFAULT_TEST_TIMEOUT_MS`) for exactly these
child-process tests. Both pass in the real gate. The observation is kept here
only as the correction — a test that needs a child boot is not a broken test.

## Not changed

- No automatic projection cleanup. A stale `goals/<id>.md` is reported, not
  deleted: the reconciliation surface exists to show the drift, and deletion
  would destroy the only remaining provenance of the cancelled work.
- No Confirm-gated restore helper. The issue lists it as a *consideration*;
  this change ships the preview plus the public-control recipe, and a
  Confirm-gated creator would be a new activation surface with its own
  consent/loss tests.
- No release. The changelog entries sit under `Unreleased`.
