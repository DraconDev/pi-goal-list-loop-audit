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
- `extensions/goal-commands.ts`: goal/glla shared status projection and on-demand read-only fleet command integration.
- `extensions/completion-summary.ts`: concise chat projection versus complete durable archive.
- `extensions/goal-recovery.ts`: recovery evidence and ownership fencing; preserve retry policy and permission gates.

## Glance contract

Four to six meaningful lines: actionability/workflow, objective/progress, runtime evidence, blocker, next action. Preserve the older cohesive rail (`●`, `│`, `├─`, `└─`), semantic color, primary/fallback model context and progress meter rather than flattening the card into independently labeled lines. Required actions precede historical diagnostics; automatic-work actions close the rail. Model/history detail yields to prerequisites when space is tight. Wide headers retain useful saved work-age, token and role facts without claiming active execution duration. Terminal outcomes omit unrelated worker uncertainty and duplicate terminal-phase labels. Glyph and color always have a text equivalent. `/glla status` retains details and provenance. Narrow painted rows use Pi's ANSI-aware width helper; uncertainty and actual action commands must survive clipping.

## Fleet boundary

`/glla fleet` explicitly invokes `extensions/fleet-health.ts`; there is no background scanner. Configure `fleetHealthRoots` in the normal global or project settings JSON, for example `{"fleetHealthRoots":["/home/dracon/Dev"]}`. Paths relative to the invoking project resolve from that project. Without this setting only the current project is inspected. Empty roots mean no scan. Only roots containing `.pi-glla/active.jsonl` in their project directories are discovered; sessionDir state roots outside these trees must be explicitly included, not inferred from conversations.

Safety ceilings: 16 roots, depth 4 (root depth 0), 2000 directories, 100 projects, 2000ms, 512KiB per active-journal tail, 8MiB total artifact bytes and 200 diagnostic rows. Directory entries are streamed; symlinks are skipped, and `.git`, `.pi`, `node_modules`, `.pi-glla` and `vendor` are excluded from traversal. Only `active.jsonl` and up to 4KiB of `session-owner.json` are read. Regular-file checks and nonblocking/no-follow opens prevent special-file waits. Async filesystem waits share the overall deadline; late-opened handles are closed without dispatch or mutations.

A bounded journal tail omits history and explicitly makes the report partial. No unreadable, malformed, missing, truncated or depth-skipped observation is silently promoted to healthy. Invalid newest records invalidate an earlier saved projection until a subsequent valid state record appears. Explicit `shutdownAt` after the snapshot can establish dormant execution; a PID, absent owner file, saved retry deadline or old claim cannot establish running or dead execution. Manual holds still take precedence over closure. Each project exposes artifact path, saved/observed timestamps, source and partial status in the structured report; terminal rows avoid printing objectives, journal text or conversation contents. The report does not run the lifecycle state loader, probe processes, write sibling files, restart sessions or dispatch work.

## Verification matrix

Projection/runtime: owner and generation replacement, restart, manual/load/persistence holds, missing timer versus armed retry, hourly-only retries, simultaneous workflow rejection and quota recovery, quiet observations versus confirmed closure, in-budget tools, terminal/settling precedence.

Surfaces: all modes, compact and detailed cards, footer, status, notifications, narrow and wide widths, action visibility and semantic color without color dependence.

Fleet: configured-root limits, symlinks, malformed and oversized journals, partial results, closed versus unconfirmed sessions, immutable sibling artifacts and zero dispatch.

Summary: outcome-first grouped changes, one instance of each limitation, one next action, full archive evidence and truthful audit/challenge caveats.

Captures: reproducible actual terminal renderer output for running, quota recovery, workflow rejection, user-blocked, dormant/unconfirmed audit, settling and completed summary at narrow/wide widths. See [native capture inspection](../audit/UI-CAPTURE-INSPECTION.md) for reproduction commands, real private-xterm screenshots and the disposition of the user's older/newer style comparison. These fixtures demonstrate production rendering, not live session execution; final integration gates remain open in the implementation register.
