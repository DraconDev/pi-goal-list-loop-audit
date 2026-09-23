# Code Context

## Files Retrieved
1. `extensions/loops/goal-tools.ts:2924-3008,3111-3195,3430-3457,3654-3730` — draft/loop/task proposals and completion-gate consumers.
2. `extensions/loops/goal-list-queue.ts:678-827,847-968` — queue activation, drafting lifecycle, sidecar ordering.
3. `extensions/loops/goal-orchestrator.ts:1099-1416` — terminal archive, list cascade, audit fan-out, revision/persistence seams.
4. `extensions/loops/goal-activation.ts:649-725,785-1000,1342-1400` — watchdog, lifecycle admission, shutdown/rebind transitions.
5. `extensions/loops/goal-session.ts:529-601,770-839,1423-1505,1819-1924` — owner lock, handoff persistence, carryover, context fencing.
6. `extensions/goal-loop-auditor-process.ts:1462-1935` and `scripts/goal-auditor-worker.mjs:429-1042` — detached worker protocol, result identity, timeout/challenge paths.
7. `extensions/goal-loop-auditor.ts:28-266` and `extensions/goal-loop-subagents.ts:180-332` — prompt trust boundary and managed-agent filesystem sync.
8. `tests/list-subtasks.test.ts`, `tests/draft-staging.test.ts`, `tests/completion-communication.test.ts`, `tests/auditor-process.test.ts`, `tests/auditor-dispatch-horizon.test.ts`, `tests/task-atomicity-gate.test.ts` — directly relevant coverage inspected.

## Key Findings (fresh, deduplicated against inspected `.pi-glla/audit-loop/findings.md` history)

### F-1 — HIGH: agent-controlled shell runs before the user accepts a loop proposal
- **Site:** `extensions/loops/goal-tools.ts:3272-3284` (`propose_loop_draft`) and `:3392-3400` (`propose_loop_refine`).
- **Scenario:** the model supplies a measure command such as `rm -rf ...`, a credential/secret exfiltration command, or a mutating build command. The orchestrator executes it with `extensionApi.exec("bash", ["-c", p.measureCmd])` *before* the Confirm dialog (`:3304-3324` / `:3411-3425`); rejecting the proposal cannot undo the side effect.
- **Missing test:** a behavioral test should put a filesystem sentinel in the command and assert zero execution on reject/cancel (and require an explicit sandbox/consent boundary). Existing loop tests cover parsing/baselines, not pre-confirm side effects.

### F-2 — HIGH: task milestone commands are hidden from the task-list confirmation, then executed
- **Site:** `extensions/loops/goal-tools.ts:3658-3661` and `verifyTaskMilestone` at `:473-490` (invoked by `complete_task`/batch at `:2739-2750` and `:2833-2839`).
- **Scenario:** the proposal preview prints only task titles, agent role, and subtasks; it omits each task’s `verificationContract`. A user can confirm a seemingly harmless breakdown containing `verificationContract: "rm -rf ..."`, then completing that task runs the command with the main host’s authority.
- **Missing test:** a test must assert every command-bearing contract is visible before consent and that a rejected list cannot execute it. Current tests only assert command failure and batch atomicity, not disclosure/consent.

### F-3 — MEDIUM: `list_activate` rejects a disk-recovered queue before hydration
- **Site:** `extensions/loops/goal-tools.ts:3517-3535`; hydration is deferred to `activateNextListItem` at `extensions/loops/goal-list-queue.ts:709-712`.
- **Scenario:** after a stale-handle/restart window, RAM has `state.list=[]` but durable `.queue.json` sidecars exist. `list_activate` calls `visibleListPosition(listQueue(), p.n)` first and returns “n must be a visible list position”; it never reaches the hydration in `activateNextListItem`, so the user cannot activate recoverable work. `/list next` can succeed through a different path, making the surfaces disagree.
- **Missing test:** seed only sidecars, invoke the registered `list_activate` tool, and assert the item is hydrated and activated. Existing recovery tests exercise command/list/audit paths, not this pre-hydration tool lookup.

### F-4 — MEDIUM: a failed parent-sidecar delete can turn a completed group into a runnable parent
- **Site:** `extensions/loops/goal-orchestrator.ts:1343-1361,1383-1385`.
- **Scenario:** the last child completes and `groupOpenChildren(parentId)===0`, but `deleteQueueItemFileResult` fails. The code warns that the group remains queued, leaves the parent in `state.list`, then immediately calls `activateNextListItem`. With no open children, the parent is no longer recognized as a group and can be activated as ordinary work, while its stale sidecar remains durable.
- **Missing test:** inject a parent-sidecar unlink failure on last-child completion and assert no parent activation plus a retryable blocked state. `tests/list-subtasks.test.ts` has source/pure coverage but no failed sidecar lifecycle case.

### F-5 — MEDIUM: repair replan changes the contract without a revision bump
- **Site:** `extensions/loops/goal-tools.ts:3680-3691`; `updateGoal` at `extensions/loops/goal-orchestrator.ts:917-935` does not increment `revision`; the completion revision gate is `:698-718`.
- **Scenario:** a repair card is accepted with a new objective/verification contract while the goal has an older approved audit. Because the repair path never calls `bumpGoalRevision`, the old verdict has the same revision as the new contract. A later `complete_goal` can pass the revision gate and apply the stale approval to the redrafted objective.
- **Missing test:** seed a repaired goal with an approval at revision N, accept a repair that changes the objective, then assert revision N+1 and refusal of the old audit. Current revision tests cover other mutation paths, not repair-task-list mutation.

### F-6 — MEDIUM: a failed repair-sidecar delete leaves a source item permanently un-repairable
- **Site:** `extensions/loops/goal-tools.ts:3680-3730`.
- **Scenario:** the code first persists the repaired goal with `repairTarget: undefined`, then tries to delete the original queued source. If deletion fails (`:3719-3726`), it returns without restoring the repair target. The source remains queued, no active repair card points to it, and later activation treats it as a fresh suspicious item, producing another repair incarnation instead of a retryable completion.
- **Missing test:** inject source-sidecar deletion failure after the goal update and assert the repair target remains attached (or the source is atomically retained with its repair metadata). Existing subtask/repair tests do not exercise this post-update failure.

### F-7 — MEDIUM: loop refinement mutates RAM before spec persistence and can return “applied” after a partial write
- **Site:** `extensions/loops/goal-tools.ts:3430-3457`.
- **Scenario:** `applyRefinement(loop, ...)` mutates the live loop before the optional spec-file writes. If `writeFileSync` fails, the function returns at `:3452-3454` without `persistState`; the target/measure change is only in RAM (and an append can have partially changed the file), despite the message saying the refinement was applied. A restart silently restores the old loop, or preserves a half-written spec.
- **Missing test:** inject read-only/append failure and assert either an atomic rollback or a durable, explicitly resumable partial state. `tests/refine-spec-rebaseline.test.ts` covers successful writes only.

### F-8 — MEDIUM: empty goal drafts can be confirmed and activated
- **Site:** `extensions/loops/goal-tools.ts:3024-3050,3192-3195` (no non-empty check; `createGoal` accepts the resulting text).
- **Scenario:** after the interview floor, a model proposes `objective: "   "`. The Confirm body can be blank and `autoAcceptDrafts` accepts it; `createGoal`/`setGoal` then create an active goal with no objective, schedule continuation, and leave the loop auditing an empty target. List drafts have a later activation/repair screen, but the single-goal path has no equivalent refusal.
- **Missing test:** assert whitespace-only goal proposals are rejected before Confirm/auto-accept and leave no goal/transaction. Draft tests cover zero-reply/session fences, not empty objective validation.

### F-9 — MEDIUM: “already shipped” phrase matching ignores negation and can abort valid work
- **Site:** `extensions/loops/goal-tools.ts:735-840`.
- **Scenario:** a truthful summary such as “This is not already shipped in v0.38.97; this turn fixes it” contains the positive phrase plus a version. The regex has no negation/quotation guard, enters the version-bearing branch, archives the goal as `aborted`, and never launches the auditor.
- **Missing test:** negative-context cases (`not already shipped`, quoted historical claim, “previously shipped but now fixed”) should remain on the normal completion-audit path. Current tests cover phrase/version extraction, not semantic negation.

### F-10 — MEDIUM: carryover archives the old goal before the replacement goal is durably written
- **Site:** `extensions/loops/goal-tools.ts:3111-3115,3192-3195`.
- **Scenario:** a confirmed draft resolves a paused carryover first. `resolveCarryover` archives the paused objective, then `setGoal` can fail its transaction/write. The handler reports that the current objective remains open, but the old objective is already durably archived and the new one was never persisted; a storage blip loses the user’s work.
- **Missing test:** fail only the new-goal transaction after a successful carryover archive and assert rollback/recovery preserves the old goal. Existing carryover tests cover archive failure, not failure of the subsequent replacement write.

### F-11 — MEDIUM: managed subagent names are not path-validated
- **Site:** `extensions/goal-loop-subagents.ts:209-236,267-286`.
- **Scenario:** `prevWritten` comes from `.glla-subagent-sync.json` and `overrides` comes from settings; both are inserted into `path.join(agentDir,"agents",`${name}.md`)`. A name such as `../../outside` can resolve outside the agents directory. An existing file carrying the managed marker can be unlinked (`:234-237`, `:267-270`), and known-name writes are similarly redirected.
- **Missing test:** reject path separators/`..` and symlink escapes for every sync input, including corrupted state JSON. Current tests cover marker ownership and model resolution, not filename containment.

## Architecture / flow
`goal-tools.ts` is the state-mutating tool boundary: it screens proposals, runs confirms, writes queue sidecars, and calls `createGoal`/`setGoal` or the detached auditor. `goal-list-queue.ts` owns queue activation and group scanning. `goal-orchestrator.ts` owns archive transactions and the completion-to-next-item/fan-out cascade. `goal-activation.ts`/`goal-session.ts` fence host/session generations and persist handoff/owner state. The detached worker protocol is fail-closed on identity/verdict/tool mismatches, but its command-bearing proposal surfaces above are outside that isolated protocol.

## Start Here
Open `extensions/loops/goal-tools.ts:3272-3284` and `:3392-3400` first: the pre-confirm shell execution is the broadest security impact and has the clearest missing behavioral test. Then inspect `:3680-3730` for the repair durability/revision chain.

BLOCKERS: none
