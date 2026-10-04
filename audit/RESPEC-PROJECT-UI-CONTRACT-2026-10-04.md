# Respec project visibility and completion contract

Authorized scope: implement all three suggested improvements to the respec
builder, while preserving independent verification, lifecycle ownership and
durable project state. Version 0.39.0 remains prepared and unpublished.

1. Show actual auditor state (starting/running/retrying/waiting), model, elapsed
   time and last worker activity. A saved claim alone cannot imply a live worker.
   Claim-fence telemetry, remove it after settlement/cancellation, and refresh
   the actual project UI. Both the compact widget and status command must expose
   these details; narrow widths must remain bounded.
2. On independently verified completion, post a semantic, bold/no-italic summary
   of shipped capabilities, verified acceptance, evidence and archive location.
   Save the summary in the project journal and archive before sending it.
   Delivery failure must preserve a replayable summary, use the existing receipt
   deduplication protocol, and never rerun a completed audit for message delivery.
3. `/loop status` must show every adopted requirement, its status, acceptance,
   blocker when present and verification evidence, including paused projects.

## Implementation and verification

- `respec-builder-ui.ts` holds transient exact-claim telemetry and formats the
  proof-gated completion report. The runtime publishes worker/retry callbacks
  and clears telemetry in its finalizer. Parent startup timestamps are not
  presented as observed worker activity.
- Production callbacks refresh the existing UI and use `deliverTerminalSummary`.
  Completion writes the archive with its summary, journals terminal state, then
  delivers. Persisted receipt acknowledgement is journaled; unacknowledged
  summaries replay on session startup. Status retains the complete saved report.
- The status command lists all requirement entries and acceptance criteria,
  rather than only counts and blocked items.
- Actual detached-worker tests cover running/retrying telemetry, summary
  archival, production receipt dispatch, failure/replay and cancellation. State
  tests cover claim fencing, absent telemetry and rejection of unverified
  summaries. Actual themed renderers prove semantic headings, width bounds,
  bold and no italics. Command integration checks the full register output.
- Focused validation: 26 tests pass across five files. Oldest supported Pi
  (0.84.2) TypeScript check passes. Full release check is pending its terminal
  result; do not claim this gate passed before it finishes.
- Rendered 54 actual dark/light project and summary frames at 40/80/120 columns.
  Selected reviewed preview: `respec-project-ui-2026-10-04/respec-builder.png`.

Worker tests use bounded synthetic verdicts through the real detached protocol;
they do not claim a live-model assessment of this implementation. No production
project loop, external plugin or Pi core was modified during this task.
