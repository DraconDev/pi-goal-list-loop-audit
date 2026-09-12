# Long-running supervision policy

**Decision record: v0.36.0 — 2026-08-28**

This document records the GLLA policy for work that can outlive one agent
turn, one provider session, or one day. It is a project decision record, not a
change to Pi core, `pi-subagents`, or `pi-memory`.

## Decision

GLLA automation is **event-driven and progress-aware**, not duration-guessed.

- A lifecycle event, durable state transition, child-progress signal, or
  process completion marker is the primary reason to inspect or advance work.
- If no public event signal exists, GLLA uses a short adaptive fallback poll
  (`250ms` backoff to the normal safety cadence) rather than sleeping for an
  estimated task duration. A five-second task must not inherit a ten-minute
  wait merely because the system guessed wrong.
- A live process remains eligible while real output, tool activity, durable
  markers, or child progress proves liveness. A silent or unreachable process
  may be classified as wedged only by the existing bounded safety watchdog.
  Detached auditors have no unconditional wall-clock expiry: legacy wall
  metadata is ignored, while confirmed silence and an individual tool timeout
  remain the bounded safety mechanisms.
- Project verification commands run in an owned process group. On Linux, GLLA
  also counts that group every 100ms and aborts it above 256 processes; this
  catches recursive test/helper launches before a long wall timeout can become
  a host-wide process or swap storm. The limit is a containment result, never
  an automatic retry.
- Timers remain useful for per-attempt backoff, watchdogs, and host safety. A
  timer is never evidence that work completed and is not the definition of a
  long-running process's lifetime. Detached-auditor first-event silence starts
  at the successful worker spawn boundary (with a return-time fallback for
  runtimes that deliver the spawn event too early), so dispatch setup cannot
  consume the worker's startup budget. Cancellation awaits the worker's
  TERM-to-KILL settlement before the attempt is classified or cleaned up.

The shared checker covers all GLLA-owned work planes: ordinary goals, list
items and their queue, metric/spec/audit loops, detached completion auditors,
tracked subagents, provider recovery, and lifecycle/session transitions.

Two Now requirements are enforced alongside the checker:

- **Keep checking, not waiting.** The checker is the primary reason to inspect
  work; a guessed task duration is never a wait. A 10 s task is picked up
  within the 250 ms → 15 s adaptive fallback, not after a 10 m estimate.
  `isMonitorGoal` (daemon / old-goal name or age > 1 h) remains shared for
  display parity (the dim 👁 MONITORING badge), but scheduling is event-driven
  for every plane — the legacy 120 s monitor throttle (`GLLA_MONITOR_INTERVAL_MS`)
  is retired and kept only as deprecated env-var compatibility (the checker
  already backs off to 15 s when idle).
- **Zero mid-execution questions — compensate up front.** Drafting batches 2–4
  sharp scope/acceptance questions with recommended defaults via a single
  `ask_user_question` invocation, so active execution needs no further
  clarification. During `active` execution the target is zero questions unless
  proceeding would cross an irreversible/destructive external boundary, require
  a missing permission/credential, or face two genuinely comparable options
  with materially different outcomes. `LONG_RUNNING_JUDGMENT_POLICY` encodes the
  durable-fix default; `ACTIVE_EXECUTION_QUESTION_GUIDANCE` encodes the
  drafting-only discipline; `buildSeedGrillMessage` enforces the floor
  (propose is blocked until the user has replied).

## Aggressive automation

Aggressive mode is the default effective keep-going policy unless the user
explicitly opts out. Its purpose is unattended long-running work:

- Recoverable provider, host, and auditor-infrastructure failures retry with
  bounded per-attempt backoff and durable owner/generation fences.
- In aggressive mode, a recovery episode has no wall-clock expiry. Legacy
  `autoRetryUntil` fields remain readable for compatibility, but new aggressive
  scheduling must not stop solely because that old horizon elapsed.
- A semantic auditor disapproval is actionable work: its extracted objections
  become a bounded durable TODO projection and the next continuation works them.
  Repeated identical objections with no new progress are a state-based stop,
  not an invitation to burn more turns.
- Automation stops on success, explicit user pause/cancel, a non-retriable or
  contradictory semantic result, ownership loss, persistence-integrity failure,
  or repeated no-progress. A cold-start consent/load hold still wins; aggressive
  mode does not silently turn an unattended fresh launch into user consent.
- A retry must be idempotent with respect to durable state. It must not create
  duplicate workers, overwrite a newer generation, duplicate TODOs, or erase a
  recoverable claim.

Conservative mode keeps the pre-v0.36 bounded recovery horizons and explicit
manual holds. This opt-out is retained for users who prefer a finite
unattended recovery envelope.

## User-facing completion summaries

Every archived terminal objective gets one full six-label recap:

```text
Outcome: ...
Changed: ...
Evidence: ...
Tests: ...
Unresolved: ...
Next: ...
```

This applies to complete, aborted/cancelled, auto-dropped, full-auditor-IMPOSSIBLE,
and already-shipped archive paths. A valid executor recap is preserved. A
partial IMPOSSIBLE verdict remains a decision pause in conservative mode (or
continues narrowing in aggressive mode); only a full impossible objective is
terminalized. A missing, generic, or incomplete recap is replaced at the
central archive boundary by a
fallback assembled only from recorded GLLA facts: the objective, terminal
status/reason, durable telemetry, captured audit verdicts, and known archive
path. It says `not recorded` when a changed-file manifest or test result is not
available. It never infers a passing test or invents a commit.

The full six-label recap lives verbatim in the archive (`## Completion summary`)
and the status/history surfaces. The human layer in chat, transcript, and the
archive's `## Terminal summary` renders the same facts as rich sections
(`## Done: <objective> — <outcome>`, duration line, Key Findings grouped by area
or tabulated at 4+ groups with per-finding `Test Results:` proof lines,
Verification Summary table — widened to Quality Gate | Scope | Status | Notes
with derived statuses when the agent supplies a gate inventory — Next, capped
and clipped
to fixed budgets). Width-bound and external surfaces (status line, widget card,
external notifies) use the compact single-line projection of all six labels.
Every terminal goal notification, including version-bearing already-shipped claims,
explicit goal/list cancellation, and `/glla wipe`, carries either the rich sections
or the compact projection; loop notifications do the same. The terminal
notification may use a compact excerpt. The executor recap and independent
auditor verdict stay separate: an approval is not manufactured from the
presence of a summary.

Metric-loop stops use the same six-label contract in their durable loop state
and `/loop status`, and every terminal loop notification carries a compact
projection of that recap. Lifecycle/recovery holds are not falsely presented
as terminal completion.

## Future decision checklist

Before adding a new long-running GLLA path, record answers to these questions:

1. What durable or lifecycle signal proves start, progress, recovery, and
   completion?
2. If the host has no signal, what is the adaptive fallback, and what bounded
   watchdog identifies confirmed silence without guessing task duration?
3. Which failures are recoverable, and which state-based conditions stop
   automation? Is the retry idempotent across reload and owner changes?
4. What exact six-label user recap is available after every terminal path? Which
   values are recorded facts, and which must explicitly say `not recorded`?
5. Does the change stay at GLLA's public boundary and preserve persistence,
   ownership, lifecycle, auditor, and user-stop semantics?

Do not solve an external Pi/core defect by widening GLLA's scope. Keep the
external-only issue as a documented observation or a separate upstream report.
