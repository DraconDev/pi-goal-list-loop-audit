# Runtime-globals retirement, slice 1 (v0.38.77, 2026-09-20)

## Method

Scanned all 222 registry names for consumers across loops modules,
top-level extensions, tests, and scripts. 15 names are referenced in
exactly one loops module and nowhere else — pure registry debt:

- goal-session.ts (7): instanceStartedAt, SESSION_HANDOFF_VERSION,
  SESSION_HANDOFF_FRESH_MS, lastConfirmDialog, sessionHasConversation,
  ownerProbeLive, FOREIGN_SESSION_TOOL_MESSAGE
- goal-ui.ts (5): LIVE_STREAM_PROOF_MS, summarizeToolArg,
  displayActivityFor, lastContextPercent, clearContextStarvedStreak
- goal-auditor-hooks.ts (2): newCompletionAuditAttemptId,
  isAuditorTimeoutError
- goal-settings-ui.ts (1): promptModelRefs

## Change

Deleted each name's `defineGoalRuntimeGlobal` call, registry entry,
ambient `var` declaration, and typed interface entry where present
(52 lines, zero additions). Owning modules keep their locals; no
imports added, no import cycles risked, no runtime behavior change
possible — and `tsc` proves no reader survived (a bare identifier
without its ambient declaration fails compile).

Next slices (harder): two-module names need direct-import rewiring
with cycle analysis; `__testOnly*` names need test-file import
rewiring. The contract test pins registry↔ambient consistency, not
the count, so slices land cleanly.

## Verification

- `tsc --noEmit` clean (the strong check).
- Contract + touched areas green (102 tests); new-code slices green.
- Broad combo (behavioral + status-ux + display) shows 2 failures in
  v0.35.15 pause/resume notification counts — proven pre-existing via
  worktree comparison against the pre-retirement parent (identical
  failures, including file order). They pass file-alone and in the
  full suite; something between files resets the polluting state.
  Not caused by, and not widened by, this change. Left open.
