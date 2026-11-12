# Truthful UI status redesign

## Design checkpoint

The original Designer run failed before producing findings; its checkpoint was recorded inline. The current implementation and screenshot follow-up are documented in [the objective/audit status register](https://github.com/DraconDev/pi-goal-list-loop-audit/blob/main/audit/OBJECTIVE-AUDIT-STATUS-2026-10-11.md).

## Architecture

`extensions/work-lifecycle.ts` owns lifecycle/control authority. Its `stateWorkView` distinguishes lifecycle from observed activity; it must not be changed to authorize dispatch based on display evidence.

The pure presentation projection (`extensions/ui-status.ts`) sits alongside that authority. Inputs are durable workflow state plus explicitly supplied runtime observations. Outputs separate workflow, execution, actionability, provenance, blocker and next action. Render adapters must consume the same projection rather than infer execution independently.

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

## Wait evidence

Scheduled external assessments expose `checkAt` and `wakeOwner`. WAITING is
shown only with fresh current-owner/current-generation heartbeat registration;
a saved deadline without live evidence remains EXECUTION UNCONFIRMED. A
registered owned dependency wait is WAITING with unknown/stale activity, or
RUNNING when its attributed worker activity timestamp is fresh. Parent-host
chat is not worker evidence. Cards retain the full check deadline and wrapped
wake owner even at 40 columns; detailed status retains provenance and activity
age. The saved workflow remains distinct from execution: scheduled/background
wait labels do not turn a manual-action blocker into an automatic wait.

See [external-check recovery](RECOVERY.md#checking-authorized-external-work) and
[the incident/capture register](https://github.com/DraconDev/pi-goal-list-loop-audit/blob/main/audit/WAITING-WAKE-LIFECYCLE-2026-10-12.md).

## Surface map

- `extensions/goal-loop-display.ts`: compact/detailed cards and footer, including project-builder branch.
- `extensions/loops/goal-ui.ts`: production compact-card caller, runtime evidence adapter and notifications.
- `extensions/goal-commands.ts`: goal/glla shared status projection and on-demand read-only fleet command integration.
- `extensions/completion-summary.ts`: the end-of-task report card (headline, prose lede, per-area `What changed` subsections, always-on verification, follow-ups, next steps, one receipt line) versus the complete durable archive. Section vocabulary is shared through the leaf module `extensions/card-sections.ts`, which also owns the narrow-width table-to-bullet fallback.
- `extensions/goal-recovery.ts`: recovery evidence and ownership fencing; preserve retry policy and permission gates.

## Glance contract

Four to six meaningful lines for ordinary work; audit cards may use eight to retain tool budget, elapsed and activity facts. Actionability/workflow, objective/progress, runtime evidence, blocker and next action remain the priorities. Preserve the older cohesive rail (`●`, `│`, `├─`, `└─`), semantic color, primary/fallback model context and progress meter rather than flattening the card into independently labeled lines. Required actions precede historical diagnostics; automatic-work actions close the rail. Model/history detail yields to prerequisites when space is tight. Wide headers retain useful saved work-age, token and role facts without claiming active execution duration. Terminal outcomes omit unrelated worker uncertainty and duplicate terminal-phase labels. Glyph and color always have a text equivalent. `/glla status` retains details and provenance. Narrow painted rows use Pi's ANSI-aware width helper; uncertainty and actual action commands must survive clipping.

## Color semantics

Matches the established card/footer vocabulary — color emphasizes, never replaces, the text state:

- `success` (green): live or terminal-ok — running activity, completed work, fresh evidence. Icon plus execution word only.
- `warning` (amber): needs the user — blocked, dormant, unconfirmed; blocker/reason rows. Required-action rows ride `dim` (position carries the emphasis; only hard errors shout), exactly like legacy pause actions.
- `accent` (primary highlight): informational in-flight progress — registered waiting, tool waits, queued starts, decision prompts, recommended options.
- `dim` (grey): everything secondary — mode/phase words, saved metrics, evidence lines, model provenance, closers and secondary automatic-retry details. Registered waiting execution words use `accent`; their ownership/detail rows remain `dim`.
- `error` (red): error pauses and stalled audit observations beyond the silence bound, never ordinary blocks. Silence is not proof of process death; the UI says that no worker responds, not that a PID was verified dead.

Headers and footers are segmented: only the execution word (and, in the footer, the required user action) carries the tone. Painting a whole line in the tone washed every blocked card orange (field 2026-10-10). Objectives render as plain body text; closers stay `dim`.

## Objective and audit identity

Cards explicitly identify Goal, List item, or Loop. Project builders are **Loop / Project**; project is a workflow within a loop, not an unrelated execution owner.

Compact and detailed audit cards share the same owner/status heading. Both use worker activity, not a busy parent host's heartbeat. Footer phase and unknown-worker inspection commands precede host decoration so narrow layouts cannot hide execution uncertainty. A saved/workerless claim clears inherited parent timestamps. Fresh audit activity is green; in-budget tool waits and queued starts are accent; unknown or quiet activity is amber; stalled observations are red. These tones agree across heading, phase row and footer. Tree branches are neutral decoration, never an extra liveness signal.

Audit elapsed time, last activity and the complete tool elapsed/budget pair have dedicated rows where needed for narrow layouts. Unknown audit execution points to inspection rather than promising automatic review. Persistence and explicit admission holds, including an observed closed host, override cached live progress. An explicitly stopped project does not advertise an unavailable `/loop resume`; `/loop status` inspects it and `/loop respec` starts new work.

Reproduce the narrow/wide audit fixtures with `timeout 30 bun scripts/audit-status-capture.ts` followed by `timeout 90 python3 scripts/capture-ui-status.py --audit-status`. Compact `40`/`120` and detailed `40-detailed`/`120-detailed` PNG/ANSI/JSON outputs are in `audit/audit-status-captures/`. They exercise production renderers on private xterm/Xvfb, not a full live Pi viewport or real provider execution.

## Fleet boundary

`/glla fleet` explicitly invokes `extensions/fleet-health.ts`; there is no background scanner. Configure `fleetHealthRoots` in the normal global or project settings JSON, for example `{"fleetHealthRoots":["/home/dracon/Dev"]}`. Paths relative to the invoking project resolve from that project. Without this setting only the current project is inspected. Empty roots mean no scan. Only roots containing `.pi-glla/active.jsonl` in their project directories are discovered; sessionDir state roots outside these trees must be explicitly included, not inferred from conversations.

Safety ceilings: 16 roots, depth 4 (root depth 0), 2000 directories, 100 projects, 10000ms, 512KiB per active-journal tail, 8MiB total artifact bytes and 200 diagnostic rows. Directory entries are streamed; symlinks are skipped, and `.git`, `.pi`, `node_modules`, `.pi-glla` and `vendor` are excluded from traversal. Only `active.jsonl` and up to 4KiB of `session-owner.json` are read. Regular-file checks and nonblocking/no-follow opens prevent special-file waits. Async filesystem waits share the overall deadline; late-opened handles are closed without dispatch or mutations.

A bounded journal tail omits history and explicitly makes the report partial. No unreadable, malformed, missing, truncated or depth-skipped observation is silently promoted to healthy. Invalid newest records invalidate an earlier saved projection until a subsequent valid state record appears. Explicit `shutdownAt` after the snapshot can establish dormant execution; a PID, absent owner file, saved retry deadline or old claim cannot establish running or dead execution. Manual holds still take precedence over closure. Each project exposes artifact path, saved/observed timestamps, source and partial status in the structured report; terminal rows avoid printing objectives, journal text or conversation contents. The report does not run the lifecycle state loader, probe processes, write sibling files, restart sessions or dispatch work.

## Verification matrix

Projection/runtime: owner and generation replacement, restart, manual/load/persistence holds, missing timer versus armed retry, hourly-only retries, simultaneous workflow rejection and quota recovery, quiet observations versus confirmed closure, in-budget tools, terminal/settling precedence.

Surfaces: all modes, compact and detailed cards, footer, status, notifications, narrow and wide widths, action visibility and semantic color without color dependence.

Fleet: configured-root limits, symlinks, malformed and oversized journals, partial results, closed versus unconfirmed sessions, immutable sibling artifacts and zero dispatch.

Summary: the completion report opens with a short result headline over its prose lede, groups the changes by work area, always states the derived verification inventory (bullets when the width cannot hold the table), carries one instance of each limitation and one next action, and closes with a single receipt line; the archive keeps the wide evidence and truthful audit/challenge caveats.

Captures: reproducible actual terminal renderer output for running, quota recovery, workflow rejection, user-blocked, dormant/unconfirmed audit, settling and completed summary at narrow/wide widths. See [native capture inspection](https://github.com/DraconDev/pi-goal-list-loop-audit/blob/main/audit/UI-CAPTURE-INSPECTION.md) for reproduction commands, real private-xterm screenshots and the disposition of the user's older/newer style comparison. These fixtures demonstrate production rendering, not live session execution; final integration gates remain open in the implementation register.
