# Opportunistic compaction failure — 2026-10-03

Field report: at 205,508 tokens, the configured 200,000-token boundary
triggered compaction. Pi reported an incomplete, output-capped summary.
GLLA then parked the loop and issued conflicting manual-resume instructions.

The summarizer failure belongs to Pi/provider behavior. The optional trigger,
parking decision, continuation, and GLLA notification belong to this repo.
Only the GLLA behavior was changed.

## Contract and correction

The configured token target is an opportunistic compaction preference.
Failure of an attempt initiated at that boundary keeps durable work active
and resumes the existing transcript. It must not turn the target into a hard
stop or retry compaction on every turn.

The boundary now records ownership of its actual attempt by the live session
manager. Its public failure event and error callback share a settlement,
independent of callback order or the event's optional `fromExtension` field.
One settlement schedules one normal continuation or branch-loop tick. The
callback is deferred until the firing boundary has cleared its eager timers,
including when `compact` calls `onError` synchronously.

A synchronous launch throw returns control to the ordinary continuation
path. The durable episode marker remains after failures, preserving existing
retry suppression and rearming below half the configured target. Ownership
clears on success, the next real agent start, or admitted session start.
Host-owned retries and aborts retain their precedence. The existing generic
handler for blocking compaction failures retains its prior behavior.

The GLLA warning now says it is continuing with the current transcript.
No model rotation, durable pause, forced new session, or fake successful
compaction is introduced for an optional attempt.

## Verification

Evidence: `opportunistic-compaction-2026-10-03/`.

- `red.log`: both failure-event/error-callback orderings reproduce an active
  goal becoming paused before the implementation fix (two failing tests).
- `tests.log`: 39 tests pass across six compaction files, zero failures.
  New regressions prove an actual next goal dispatch in both callback orders,
  an actual next branch-loop dispatch with an event alone or synchronous
  error callback, retained retry suppression, and synchronous-throw fallback.
  Branch-loop coverage uses a configured 300,000-token target; goal coverage
  reproduces the reported 205,508-token usage at the default target.
  Existing successful compaction, containment, survival, fallback, terminal
  parking, target-setting, and hysteresis checks also pass.
- `typecheck.log` and `inventory.log`: TypeScript and inventory gates pass.

No full release gate or publication was performed for this bounded fix.
No upstream plugin, provider, Pi implementation, or live session was changed.
Tracked source, documentation, and evidence are checkpointed by the sync
daemon; no git history was rewritten.

## Version checkpoint

Bumped package and both root lockfile version fields to 0.38.109. Promoted
the pending compaction and audit follow-up notes into its dated changelog
entry, retained the Unreleased slot, and advanced the docs index.
`version-tests.log`: 20 version/release-contract tests pass, zero failures.
`version-inventory.log`: inventory verification passes. This updates source
release metadata; no package publication or release tag was created.
