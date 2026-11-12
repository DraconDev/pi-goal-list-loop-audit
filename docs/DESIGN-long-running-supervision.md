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
and the status/history surfaces. After a rejected claim is corrected, the latest
approved claim alone supplies the final headline, structured Summary and change
details. Earlier claim text remains verbatim in the forensic archive/history;
it must not override corrected counts or be concatenated into the human recap.
Executors should supply a full objective-level recap on each corrected claim,
not depend on a rejected predecessor to fill in omitted work.
The human layer follows two different purposes:

- Chat, transcript and archive all read as **one end-of-task report**
  (field 2026-11-11 — "more like opencode's end-of-task summary"):
  `## Done — <result>` headline, a prose lede carrying the rest of the
  `Outcome` sentence, `## Summary` with the structured Outcome body and one
  `What changed · <area>` subsection per `findingGroups` entry, an
  always-visible `## Verification` gate inventory (chat compact
  `Gate | Command | Result`, archive wide
  `Quality Gate | Command | Scope | Status | Notes` plus its review row),
  `## Follow-up items` (`Unresolved` and the deliberate `leftOut`, with a
  resolving action inline as `→ Next:`), `## Next steps` (standalone actions),
  the archive-only `Final Repository State`, and ONE closing receipt line
  (`completion audit approved (N reviews) · record: <path>`).
  Status words in the inventory are derived from the gate notes, never claimed:
  `PASS` only on a complete pass parse with zero failures, `FAIL` on any
  failure evidence, otherwise the row keeps its honest `REPORTED` shape.
- Chat headings are depth 2 (the Pi TUI renders them without the `##`
  prefix); the archived markdown keeps `###`/`####`. Below the narrow-table
  threshold the chat verification section renders as
  `- <gate> — <command> — <result>` bullets, because Pi prints a Markdown
  table's raw pipe rows when the width cannot fit it.
- The section vocabulary lives in one leaf module (`extensions/card-sections.ts`)
  consumed by the composer, the collapsed receipt projection and the terminal
  renderer. Legacy section names (`What Changed`, `Remaining`, `Next`,
  `Verification Evidence`) stay recognized so a receipt queued by an older
  build still collapses, colors, and keeps its review qualification and record
  link; their durable text is never rewritten.
- The default terminal view previews structured results and a few primary
  changes; expansion retains the complete saved message. Required actions,
  follow-up limitations, review qualifications and the saved record link are
  not lost to that preview. Evidence-only recap fields are not reclassified as
  changes. Legacy incomplete recaps may supply useful human fields, but a
  missing result stays explicitly missing: telemetry is not a substitute for
  an explanation.
- The archive's `## Terminal summary` remains forensic and complete: detailed
  findings grouped or tabulated at 4+ groups, per-finding proof, the full
  Verification table (Quality Gate | Command | Scope | Status | Notes when
  supplied), and Final Repository State.

Both surfaces retain the independent completion review and access to the full
six-label machine recap in the saved record. The verdict is stated once, in
that closing receipt line, rather than as an archive banner above a second
headline. Goal-approval external notifications use the short human outcome,
not telemetry or a projection of every machine label.
Every terminal goal notification, including version-bearing already-shipped
claims and explicit cancellation, carries the change-first human view or the
compact projection; loop notifications do the same. The executor recap and
independent completion review stay separate: an approval is not manufactured from
the presence of a summary.

Metric-loop stops use the same six-label contract in their durable loop state
and `/loop status`, and every terminal loop notification carries a compact
projection of that recap. Lifecycle/recovery holds are not falsely presented
as terminal completion.

## Human-facing pauses and waits

Write the unmet prerequisite in one or two plain sentences. Put concrete human
steps, the relevant document or exact command in `suggestedAction`; put the
investigation in supporting evidence. A resume command does not itself resolve
a prerequisite. Legacy verbose reasons are marked previews, not invented
paraphrases; expansion preserves the original reason and diagnostics.

Emit one primary card, not another full-reason transcript notification. The
intentional turn-stop notice points back to the card; external notifications
retain the concrete action or framed consent question. The compact blocked
card is a glance, not a second report: action first (at most two lines), a
short reason preview, a one-line conditional resume, and `/glla status`.
Internal judgment taxonomy and compaction diagnostics stay in detailed status.
GLLA's shared one-line status segment is capped at 96 cells even on wide
terminals because other extensions share that bar; successful pause tools
render a short receipt pointing to the card, while expanded/partial/error
results keep their full content.

A completion rejection is agent-owned rework, not a raw report handed to the
user. The default notice previews the final Required-fixes section, excludes
quoted evidence/command blocks, and links to the full report. Compact cards
name the agent's task and the person's action separately: observed work needs
no intervention; an unconfirmed restart offers `continue` in the same session.
A saved workflow is not rendered as working when execution is unconfirmed.
Detailed/interrupted renderers retain their feedback and precise recovery
commands; scheduler, permission, persistence and cold-restore consent fences
are not weakened to make the card look active.

A wait names the condition, a readable UTC progress-check time and whether
human action is needed. A check is not a promise of completion, and a saved
deadline is not evidence of a registered wake. Current-owner, generation and
heartbeat evidence still determine whether automatic checking is live. These
presentation rules do not alter pause, scheduler or independent-audit policy.

See [the human-handoff implementation evidence](https://github.com/DraconDev/pi-goal-list-loop-audit/blob/28c9fb1a53ba6d0ac3047cb394052a87acdda96b/audit/human-handoff-2026-10-18/README.md)
and [the blocked-card compactness evidence](https://github.com/DraconDev/pi-goal-list-loop-audit/blob/28c9fb1a53ba6d0ac3047cb394052a87acdda96b/audit/blocked-ui-2026-10-19/README.md)
for rendered examples, regression controls and verification boundaries.

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
