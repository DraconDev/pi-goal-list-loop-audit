# Truthful UI status redesign

## Design checkpoint

The requested Designer run failed before producing findings (provider quota error). This checkpoint is the explicitly authorized inline fallback, based on source inspection. Implementation and verification remain pending.

## Architecture

`extensions/work-lifecycle.ts` owns lifecycle/control authority. Its `stateWorkView` distinguishes lifecycle from observed activity; it must not be changed to authorize dispatch based on display evidence.

Add a pure presentation projection (`extensions/ui-status.ts`) alongside that authority. Inputs are durable workflow state plus explicitly supplied runtime observations. Outputs separate workflow, execution, actionability, provenance, blocker and next action. Render adapters must consume the same projection rather than infer execution independently.

Reuse `extensions/audit-lifecycle.ts` for stored claim phase/settlement facts, not as proof that a worker survives. Reuse `mainModelRecoveryRuntimeStatus()` for observed timer/turn/hold facts. Durable `retryAt` alone means a saved schedule, not an armed timer. The runtime recovery adapter must additionally bind observations to the current owner and generation before advertising execution.

## Evidence precedence

1. Terminal settlement/state is not resurrected by historical worker activity.
2. Explicit manual, supervisor, load and persistence holds remain authoritative.
3. Confirmed owner replacement or session closure removes live-execution claims, without deleting saved work.
4. Observed current-owner tool execution within budget is a tool wait, not a silence-induced stall.
5. Observed current-owner armed recovery is automatic retry; show regular versus hourly-only observations honestly.
6. Recent worker/host observations can establish observed activity; UI ticks and parent polling cannot.
7. Stored timestamps or unsupported ownership are execution unconfirmed. Age alone never proves death.

Represent independent workflow rejection and provider recovery together. Requirement coverage counts must be labelled as requirement counts, not execution-blocker counts. A missing user prerequisite takes precedence over a generic resume hint.

## Surface map

- `extensions/goal-loop-display.ts`: compact/detailed cards and footer, including project-builder branch.
- `extensions/loops/goal-ui.ts`: production compact-card caller, runtime evidence adapter and notifications.
- `extensions/goal-commands.ts`: status and future on-demand fleet command integration.
- `extensions/completion-summary.ts`: concise chat projection versus complete durable archive.
- `extensions/goal-recovery.ts`: recovery evidence and ownership fencing; preserve retry policy and permission gates.

## Glance contract

Four to six meaningful lines: actionability/workflow, objective/progress, runtime evidence, blocker, next action. Required action precedes historical diagnostics. Glyph and color always have a text equivalent. `/glla status` retains details and provenance.

## Fleet boundary

Explicit configured roots; bounded depth, project count, per-journal bytes/lines and total time. Read GLLA runtime artifacts only. No conversation reads, symlink escape, sibling writes, ownership claims or dispatch. Unknown, malformed, unreadable and truncated observations remain visible as partial results. A saved auditing record is unfinished work, not proof of a live stalled session.

## Verification matrix

Projection/runtime: owner and generation replacement, restart, manual/load/persistence holds, missing timer versus armed retry, hourly-only retries, simultaneous workflow rejection and quota recovery, quiet observations versus confirmed closure, in-budget tools, terminal/settling precedence.

Surfaces: all modes, compact and detailed cards, footer, status, notifications, narrow and wide widths, action visibility and semantic color without color dependence.

Fleet: configured-root limits, symlinks, malformed and oversized journals, partial results, closed versus unconfirmed sessions, immutable sibling artifacts and zero dispatch.

Summary: outcome-first grouped changes, one instance of each limitation, one next action, full archive evidence and truthful audit/challenge caveats.

Captures: reproducible actual terminal renderer output for running, quota recovery, workflow rejection, user-blocked, dormant/unconfirmed audit, settling and completed summary at narrow/wide widths. Capture implementation and native inspection are pending.
