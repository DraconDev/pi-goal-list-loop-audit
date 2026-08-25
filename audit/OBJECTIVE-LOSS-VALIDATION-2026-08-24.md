# Objective-loss validation — 2026-08-24

## Verdict

The reported objective loss is **not a separate data-loss bug in the current
repository**. It has two distinct cases:

1. A bounded fresh-process restart boundary preserves state after the writer
   exits and a new process reads the ledger. This does not claim to simulate a
   Wez crash during a filesystem write; no crash-only deletion was reproduced.
2. A cwd switch under the historical default `workingDir` intentionally selects
   a different `<cwd>/.pi-glla` root. The old objective remains on disk, but it
   is invisible from the new cwd. This is the cwd-coupling reproduced in the
   PR #21 investigation, not deletion or corruption.

The corrected opt-in `sessionDir` root is the repository-owned remedy when
objective visibility must survive cwd changes: the admitted production
`session_start` registers pi's canonical `getSessionDir()`, and both cwd
values resolve to the same top-level session `pi-glla` directory. Child
workers may use the explicit `PI_SESSION_FILE` fallback. No additional
migration or implicit root switch is safe because cwd remains the documented
default and old roots must remain untouched.

## Bounded evidence

`tests/objective-loss-state-root.test.ts` provides three state-root behavioral
cases, and `tests/objective-loss-lifecycle.test.ts` covers the production
lifecycle plus a fresh-process boundary:

- `workingDir default: cwd switch makes old objective invisible from new cwd
  (expected)` writes an active objective under `cwdA`, reads it from `cwdA`
  and `cwdB`, and proves `cwdB` has an empty independent root while `cwdA`
  still contains the objective.
- `sessionDir opt-in: same cwd switch keeps objective visible via shared
  sessionDir` writes under `cwdA`, reads through `cwdB`, and proves the same
  selected session root and objective are used.
- `evidence: no destructive migration and pending defers writes` proves an
  old cwd tree remains intact while session-root resolution is pending and
  that later writes land in the selected session root.

- `production session_start registers the host session root before restore`
  drives the real `registerGoalRuntime` event handler with a file-backed
  session manager. It proves `getSessionDir()` is registered before restore
  writes, wins over a deliberately different session-file parent, and does
  not create a cwd `.pi-glla` tree.
- `fresh processes reload session-root state across a cwd switch` starts a
  fresh Bun writer and then a fresh Bun reader with separate process memory.
  The reader uses `PI_SESSION_FILE` as the supported worker fallback and
  recovers the objective from a different cwd.

The preceding core/consumer tests also cover pending writes,
queue/dispatch/reviewer/audit paths, and no raw cwd-root consumer joins. The
version-switch wording is intentionally bounded: no specific Wez version
migration was reproduced, but the persisted root-selection behavior is
independent of the in-process module instance.

## Conclusion and boundary

The report is closed with a durable lifecycle fix plus bounded evidence:
there is no evidence that a crash alone deletes an objective, the fresh-process
restart boundary passes, and cwd switch loss is explained and covered by the
state-root port. Follow-up v0.35.59 also makes `/glla cancel`, `/glla wipe`,
`/list cancel`, `/list clear`, and shared archive paths fail closed while
sessionDir resolution is pending, so a breaking root change cannot falsely
clear RAM or mutate an ambiguous cwd tree. Users who need cross-cwd continuity must explicitly select
`sessionDir`; silently changing the default would be a destructive
compatibility change. A crash in the middle of a filesystem write and a
specific version migration remain outside this reproduction. The subsequent
gettick, list-reload, and subagent-visibility reports remain separate queued
items.
