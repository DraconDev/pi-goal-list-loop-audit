# Work lifecycle and activity

Implementation contract for the confirmed lifecycle repair. This document
specifies intended behavior; it is not a claim that each seam is implemented yet.

## Why this exists

The 2026-10-08 passkey checkpoint incident left a goal `paused` with
`pauseKind=standby` after the parent consumed the scout report and marked its
checkpoint complete. The UI promised automatic wake but neither the companion
completion event nor the parent's new turn cleared the durable pause. Waiting
was expressed as a freeze and the completion observer only updated telemetry.

## Separate dimensions

Lifecycle describes permission/ownership; activity describes observed work.
Do not store a new flat enum combining every possible pair.

| Lifecycle | Meaning | Automatic main-agent dispatch |
|---|---|---|
| idle | No unfinished target owns supervision | None |
| running | Target is eligible for ordinary supervised work | Existing scheduling rules |
| waiting | Target yields to an identified dependency or scheduled recovery | Only settlement/reconciliation or due recovery |
| paused | Explicit freeze, decision, load hold or manual-action blocker | None until authorized resume |
| complete | Accepted result durably settled | None |
| cancelled | Explicitly retired target | None |

Activity is a projection: researching, implementing, auditing, recovering,
background work, scheduled cadence, or unknown. Do not label an activity solely
because the model narrated it. Task progress, audit claims, recovery records,
wait dependencies and observed tool activity are evidence. Missing evidence
stays unknown. An explicit freeze can coexist with still-running tools/children;
it prevents future automatic main-agent dispatch, not their execution.

## Durable control versus legacy storage

Existing goal `status` and loop `active` fields have consumers in archives,
settlement and historical reports. Preserve their compatibility while introducing
an authoritative owned background-wait record on the target. Shared projection
and dispatch predicates interpret that record as lifecycle=waiting, not paused.
New background waits must not write goal status=paused or loop active=false.

Goal/list ownership uses the goal id; loop/project ownership uses the saved
loop start identity (and project identity where applicable). A wait also has
its own unique identity, originating session, creation time and bounded list
of explicitly named dependency run ids. Persist any observed public async status
artifact location needed for reconciliation. Never discover workers by scanning
arbitrary directories or attach every currently visible child to a wait.

An activity projection is not a second mutable state machine. Replacing a goal
or loop invalidates the old wait even if its worker later completes.

## Admission and settlement

- Expose explicit background-wait intent with dependency ids. Keep legacy
  `pause_goal(kind=standby)` as a compatibility entry, not a genuine pause.
- Admit only dependencies correlated to this owning session/target through
  observed public lifecycle or tool-result evidence. Unknown ids cannot
  authorize automatic continuation. Do not guess from a prose reason.
- Save the wait before yielding. On storage failure, retain a dispatch hold
  and report failure; never promise a durable wait that did not land.
- Suppress ordinary continuation, loop iteration accounting and completion
  submission while the background wait owns work.
- Matching terminal evidence settles only its dependency. A multi-dependency
  wait settles when all dependencies terminate; success does not verify tasks.
- Persist removal/settlement before dispatch. Duplicate events see no remaining
  wait to settle. Stale sessions, wrong targets and unrelated workers cannot wake it.
- Completion requests one bounded parent assessment, not a blind assumption
  that a report is correct. Failure/stopped/missing evidence likewise requests
  assessment of the obstacle and retained results; it never silently verifies work.
- User pause, supervisor pause, load hold, cancellation and pending audit
  settlement outrank wake. Preserve the wait/result evidence under a freeze;
  explicit resume can subsequently consume it.
- Running/queued parent turns suppress duplicate sends. Native companion delivery
  may start the parent before GLLA dispatch; settle the wait first and let the
  existing active turn consume the result.

## Reload and old records

A wait survives in the authoritative state projection. On restore, reconcile
only its saved dependencies through public, identity-matching status artifacts.
Completed/failed dependencies can settle; absent/unreadable/mismatched artifacts
must not be described as still running indefinitely. Request one bounded
assessment once continuation consent exists. No restart bypasses a load hold or
explicit pause. Local generation fences rebind through the admitted owner rather
than granting arbitrary old callbacks authority.

Legacy `paused/standby` contains no run identity. Treat it as a legacy wait
requiring assessment, not as proof of a running child. Preserve reason/objective
and migrate durably; do not attach a random live worker. Eligible reconciliation
produces a bounded assessment; frozen sessions retain the saved record until
resume. A failed migration write must retain the conservative hold.

## Work surfaces and integration seams

- Goal and list item: shared goal control, canonical state transaction and
  continuation gates. Queue promotion/terminal archive must not retain an old wait.
- Metric/spec loop: wait retains active supervision but suppresses iteration
  dispatch and measurement/plateau accounting during yielded turns.
- Project builder: wait does not verify requirements, discard batch history,
  clear blockers or override pending project audit settlement.
- Public `subagent:async-started`, `subagent:async-complete` and terminal events:
  correlate identities, then settle waits separately from watchdog telemetry.
- Durable async status: retain the public event's artifact identity for reload;
  no imports or modifications of companion internals.
- Display: shared lifecycle/activity projection for cards, footer and status;
  waiting gets a distinct waiting indicator, paused gets the freeze indicator.
  Name the dependency and next owner action; never promise automatic wake without
  an admitted owner. Archived work remains terminal, not resumable.

## Verification matrix

Behavioral tests must cover goal, list, metric loop and project surfaces;
matching/multiple/duplicate/unrelated completion; failed/stopped/missing workers;
completion racing wait admission and parent turn delivery; replacement/cancel;
explicit goal/loop/supervisor pause; reload/load consent; persistence failure;
legacy standby; task/requirement and pending-audit preservation. Pure projection
and reducer tests support—but do not replace—host integration tests of dispatch.

Finish with clean TypeScript and the bounded full release gate. Publishing and
changes to Pi core, companion plugins or external projects are outside this goal.
