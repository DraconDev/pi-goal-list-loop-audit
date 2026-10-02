# Control UI + recent-changes audit — 2026-10-02

## Scope (inspected, not assumed)

- Recent changes: `respecSpecComplete` + incomplete-spec respec branch
  (`extensions/goal-loop-forever.ts`, `extensions/goal-loop.ts`),
  heartbeat workerless gate + `auditorWorkerLiveForAttempt`
  (`extensions/goal-heartbeat.ts`, `extensions/goal-loop-auditor-process.ts`),
  new tests in `tests/respec-draft-phase.test.ts` and
  `tests/completed-audit-recovery.test.ts`.
- Display paths behind Screenshot_20261001_120159 (paused card):
  `pausedNextTransition`, `pausedLifecycleLines`, the kind banner rows,
  `wrap`/`truncateCells`, suggested-action rendering
  (`extensions/goal-loop-display.ts`), widget width source
  (`extensions/loops/goal-ui.ts:805`).
- Import-direction check for the new heartbeat → auditor-process edge.
- Field triage of the three 2026-10-02 11:02 screenshots plus live
  `.pi-glla/audit-jobs` + journal reads in clean-web, dracon-strategy,
  and dracon-platform (read-only; findings reported separately —
  platform approved, strategy stalled-then-retried by design, clean-web
  pre-spawn hang fixed by the workerless gate).

Not audited: full suite, worker script internals, provider/recovery
ladders, settings UI. No release published.

## Findings

### F1 (FIXED this pass): liveness probe ran on healthy audits

The workerless check evaluated `auditorWorkerLiveForAttempt` (readdir +
lock reads) on every 15s heartbeat tick for any auditing + in-flight
goal, even with fresh activity. Gated on the same 90s grace as the
recovery itself — a healthy dispatch creates its job dir in
milliseconds, so the probe now runs only when recovery is possible.
Verified: 32/32 `completed-audit-recovery`, `tsc` clean.

### F2 (DECIDE): draft handoff marker is exact-match brittle

`respecDraftReady` requires the literal line `[RESPEC DRAFT COMPLETE]`
(case-sensitive, no trailing punctuation, nothing else on the line).
An agent writing `[respec draft complete]`, appending a period, or
trailing whitespace beyond `\s*` stays in draft forever with no card
hint that the file is ready and only the marker is missing. Options:
(a) keep strict and surface "draft complete — waiting for handoff
marker" in the loop card; (b) match case-insensitively and tolerate
trailing punctuation. Either needs a test pinning the accepted set.

### F3 (FIX): `##  Rules` (two spaces) fails the spec gate

The Rules regex requires exactly one space (`^## Rules`). A
human-valid `##  Rules` (or tab) reads as structurally incomplete, so
respec keeps drafting against a finished spec. Allow `##\s+Rules`
in both the capture and the heading scan.

### F4 (FIX, low): workerless reconcile leaves no stranded trace

When the workerless path reconciles a saved verdict it returns before
the `stranded_audit_recovered` ledger write, so the ledger shows only
`audit_completed_result_recovered` — indistinguishable from an
ordinary restore. Add the workerless origin to that event or emit a
debug ledger line so field triage can tell them apart.

### F5 (DECIDE): Windows CIM cost on the heartbeat path

`workerProcessMatches` shells to PowerShell CIM (1s timeout) per job
dir. After F1 this runs only for auditing + quiet-90s + in-flight
goals, but a Windows host with several stale job dirs could still
block a heartbeat tick for seconds. Acceptable as-is, or cache
negative matches per tick. Document the choice.

### U1 (FIX): blocked card contradicts itself

Kind `blocked` renders body row "blocked — waiting for manual action"
(`goal-loop-display.ts:2331`) while `next:` renders bare `/goal
resume` (`pausedNextTransition`). The manual action is never named,
so the user cannot tell whether to do something unspecified or just
resume. Name the action or drop the row when resume is the path.
See the rethink for the language table.

### U2 (FIX): card budget can exceed the real render width

Widget width comes from `process.stdout.columns || 80`
(`goal-ui.ts:805`). `wrap()` output fits its budget by construction,
yet the screenshot shows mid-word clipped lines with no ellipsis
("on the co", "and/or giv") — the budget exceeded pi-tui's actual
widget width, and pi cuts (never wraps) the tail. Clamp the budget
to a verified width source and add an 80-column golden test.

### U3 (FIX): startup banner soup

One restore produced "Error: This operation was aborted" +
"Warning: Loaded without starting…" + "Resumed session" ×2. Three
senders, no ordering, no single answer to "what do I do". Collapse
to one ordered startup summary; errors only when user action is
required. See the rethink.

### U4 (FIX): footer duplicates the card verbatim

The footer repeats the same lifecycle/transition/tally strings as
the card body. The persistent footer should carry liveness +
next-action only. See the rethink.

### U5 (DECIDE): telemetry rows read as guidance

"lifecycle: safely parked · owner: main-model recovery" and "last
host activity not available" are operator telemetry, not user
guidance, but they sit on the two most prominent card rows. Decide:
move to `/goal status` verbose and keep the card to what / why /
next. Many tests pin these strings, so the migration is deliberate.

## Verification

- `tests/completed-audit-recovery.test.ts`: 32 pass, 0 fail.
- `tests/respec-draft-phase.test.ts`: 7 pass, 0 fail (re-run same day).
- `tsc --noEmit`: clean. No import cycle (auditor-process and core
  never import heartbeat; heartbeat already reached auditor-process
  transitively via goal-loop).
