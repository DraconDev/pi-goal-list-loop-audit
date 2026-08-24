# PR #21 state-root investigation — 2026-08-24

## Verdict

**Still valid, but PR #21 is not a merge-as-is fix.** The current `main`
(v0.35.54) still resolves the glla state directory from the active process
cwd. A session/cwd change can therefore make an existing goal/list appear
missing even though its durable files remain in the old cwd. PR #21 is useful
prior art, but its base is v0.35.49 and its implementation needs to be ported
and hardened against current lifecycle/state-path rules.

## Evidence

- GitHub PR #21 (`247fab49d1`, base `f172c167` / v0.35.49) is still OPEN,
  mergeable, and its two checks pass (`quality`, `GitGuardian Security Checks`).
- Current package version is v0.35.54. PR #21 is not present on current main.
- Current `extensions/goal-loop-core.ts:1017` implements
  `piGlaDir(cwd)` as `<cwd>/.pi-glla`.
- Minimal reproduction against current main (no production mutation): write a
  state ledger containing one queued item under `old-cwd`, then read state under
  `new-cwd`. Result:

  ```json
  {"oldRoot":".../old-cwd/.pi-glla","newRoot":".../new-cwd/.pi-glla","oldList":1,"newList":0}
  ```

  This proves the underlying cwd-coupling is real; it does not by itself prove
  that every historical Wez/version-switch screenshot followed that path.

## What PR #21 gets right

- Provides an explicit `workingDir` default and opt-in `sessionDir` root.
- Resolves the top-level Pi session directory rather than a per-session UUID.
- Attempts to route core ledger, goal, queue, owner, auditor-job, reviewer, and
  dispatch paths through the selected root.
- Adds focused state-root and cold-auditor-surface tests.

## Porting gaps found before coding

1. **Pending write hole:** PR #21 guards `ensureDirs`, ledger append, dispatch,
   owner, reviewer, and project settings writes while the session root is
   unresolved, but leaves `writeQueueItemFile` (current
   `extensions/goal-loop-core.ts:1081`) as a direct mkdir/write path. A queued
   `/list` item during that window could still recreate `<cwd>/.pi-glla`,
   contradicting the proposed no-cwd-tree contract.
2. **Missed consumers:** PR #21 does not update the project stats scanner
   (`extensions/goal-loop-stats.ts:146,175`) or the audit findings path and
   generated measure commands (`extensions/goal-loop-forever.ts:511,528,555,
   567`). Those would continue reading/writing cwd state in `sessionDir` mode.
3. **Lifecycle ordering:** the PR registers a process-global runtime session
   directory before the host/foreign-session admission gate. The port must prove
   that a subagent session cannot overwrite the host's state-root registration.
4. **Auditor-surface scope:** the PR bundles a separate "blank until resume"
   behavior. Its `scheduleContinuation` release is placed before the pause,
   recovery, stale-handle, and load-hold gates, so a rejected automatic schedule
   can release the surface without an actual continuation. This needs its own
   lifecycle test or separation from the state-root port.
5. **No migration:** switching roots intentionally starts empty and leaves the
   old root untouched. That is safe from deletion, but does not recover an
   already-missing objective automatically; the UI/status contract must make
   this explicit and avoid presenting an empty new root as proof of no work.

## First-item disposition

The Now finding remains open and should be addressed by two short follow-ups:
(1) port the state-root core/settings behavior to current main, then (2) wire
and test every consumer/lifecycle boundary above. Do not merge PR #21 verbatim.
No production code was changed by this investigation.
