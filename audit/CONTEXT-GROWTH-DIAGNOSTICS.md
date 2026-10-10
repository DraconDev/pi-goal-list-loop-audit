# Context-growth investigation

## Scope and evidence quality

Read-only inspection of Freeport's `.pi-glla/active.jsonl` at `/home/dracon/Dev/dracon-platform/web/games/wip/freeport`, plus GLLA source and focused behavioral tests. No external project or upstream component was changed. Journals describe historical observations, not proof that a session is currently running. The screenshots show installed 0.39.24; current repository code cannot prove which implementation was loaded at each historical event.

## Confirmed observations

| Journal event | Timestamp (UTC) | Evidence |
|---|---|---|
| compactor_transcript_firing | 2026-10-10T05:37:22.754Z | 252717 tokens, threshold 200000 |
| session_compact / compactor_transcript_done | 05:40:13.378Z / 05:40:13.388Z | First preventive compaction completed |
| context_pressure_recovery | 16:12:12.364Z / 16:12:12.391Z / 16:13:44.846Z | queued, started, success for goal 20261010155146-13u7g9 |
| session_compact | 16:13:44.859Z | Second successful compaction contact |
| context_usage_sample | 17:14:10.017Z | 156593 tokens, 1000000 window |
| context_usage_sample | 19:42:07.868Z | 215767 tokens, 1000000 window |
| context_usage_sample | 21:27:00.029Z | 316213 tokens, 1000000 window |
| state | 21:27:00.040Z | goal paused: main model recovery, retrying in 60m, transient provider error |

These samples include observations later than the supplied screenshots. They establish real growth past 200k and successful prior compactions, not a reproduced 400k incident. The final recovery pause explains why that boundary is ineligible, not why every preceding eligible boundary may have failed to fire. No `compactor-boundary.json` was present when inspected; absence now cannot establish its historical state. No explicit compactionTokenThreshold or stateRoot key was found in the current global GLLA settings file; historical or environment-overridden settings remain unknown.

## Source-grounded eligibility and suppression

| Condition | Source | Interpretation |
|---|---|---|
| Default 200000; positive override supported | extensions/goal-loop-core.ts:2001; extensions/goal-compactor.ts:84 | Token target, not percentage or hard cap. A 1M model can legally receive a request above it. |
| Unsupervised, audit in flight, paused, pressure excluded | extensions/goal-compactor.ts:144 | Preventive compaction refuses unsafe/ineligible contacts. |
| Respec audit or spent per-work pressure budget | extensions/goal-compactor.ts, maybeCompactTranscriptAtBoundary | Prevents competing owners and repeated compaction of a failed request. |
| Busy host, pending messages, unknown/nonfinite usage | same function before threshold lookup | Wait for a safe observed boundary; unknown usage never triggers blindly. |
| Prior boundary marker | extensions/goal-compactor.ts:170–201 | Failures remain one-shot until usage falls below half target. Proven successes rearm after 180s grace; the rearming contact itself returns without firing. |
| Missing compact API or synchronous/callback failure | same function, launch/callback handling | Preserves original transcript and normal/automatic continuation instead of grinding. |
| Busy agent_end, settled contact | extensions/loops/goal-activation.ts:3282,3332 | Existing settled-boundary recheck addresses host non-idleness. No evidence here of a missing settled event in the reported session. |
| Recovery owns agent_end | extensions/loops/goal-orchestrator.ts:675 | Eligible transient/unknown errors have compact-first admission; quotas and other excluded failures must retain provider recovery ownership. |
| Durable pressure budget | extensions/context-pressure-attempt.ts:33–95 | Compaction success alone does not reset the one-attempt failed-request budget; healthy work must reset it. |

Deferral is not itself a defect. A healthy long tool/turn can overshoot the target before a safe boundary. Audits and pauses deliberately cannot be interrupted merely to enforce a number.

## Defect disposition and follow-up

No new GLLA lifecycle defect is confirmed by this bounded evidence. Existing tests reproduce and cover settled-boundary firing, override validation, success rearming, failed-attempt suppression, unknown usage, and safe-boundary holds. Do not invent a lifecycle change to explain an unobserved 400k case.

The investigation identified an observability gap: admission returns only a boolean for most refusals (`maybeCompactTranscriptAtBoundary`). The subsequent status item implements a shared observational explanation, described below, without changing dispatch or compaction behavior. A reported 400k case still needs a timestamped usage observation plus matching work/owner/eligibility evidence before assigning a root cause.

## Implemented status projection

`extensions/compaction-status.ts` defines `CompactionStatus`: `reason` (stable reason code), optional `tokens` (current transcript usage, not cumulative work usage), `threshold` (effective positive global token target or default 200000), `observedAt` (host sample time), and `note` (human explanation). This is a presentation observation, never a dispatch permission.

`currentUiStatusContext` samples only the admitted current-generation host. Sources are host `getContextUsage`, `isIdle`, `hasPendingMessages`, compact API availability, current GLLA supervision/audit/hold/recovery ownership, and two metadata files. Metadata reads are bounded to 4097 bytes per regular file, reject symlinks/nonregular/oversized/invalid files, and never clear a marker or claim an attempt. Matching pressure-budget keys use the selected work owner. Marker rearming uses recorded completion or durable lastCompactionAt and the existing success grace/hysteresis conditions.

The pure projection names unknown usage, below target, busy/pending/unknown boundary, audit, pause, provider recovery, in-flight compaction, unsupervised work, prior boundary attempt, failed-request budget, rearming, unavailable API and unreadable metadata. It reports the most relevant current hold; it does not assert every condition simultaneously or explain historical boundaries from present metadata. Eligibility means observed conditions permit a future boundary check, not that compaction has fired. An audit hold is shown before generic unsupervised state for explanatory clarity.

`UiStatus.compaction` is accepted only with a fresh open host observation matching the current owner and generation, and a fresh nonfuture sample (30-second observation window). Saved/fleet-only, replaced, closed or stale hosts yield `unconfirmed`, with no invented token count. Host compaction evidence is distinct from detached-worker activity: an admitted host can report an audit hold without asserting a stale auditor is alive.

The shared display builder supplies detailed `/glla status` and `/goal status`, compact/detailed widget cards, and footers. Detailed status always carries the observation for nonterminal selected work; glance cards and footer chips include it when known usage meets/exceeds the target, avoiding routine below-target clutter. Reason text precedes token counts on cards. Colors remain neutral diagnostics, not success claims. Inspection starts no compaction, timers, workers or writes, and never scans journals. Existing admission logic remains authoritative and unchanged.

Behavioral reproduction: `npm test -- tests/compaction-status.test.ts tests/ui-status-projection.test.ts tests/ui-status-runtime.test.ts tests/ui-status-surfaces.test.ts tests/between-tasks-compaction.test.ts tests/compaction-settled-boundary.test.ts` — 54 pass, 0 fail across six files. `npm run check` exits 0 (exit recorded in `/tmp/glla-compaction-status-types.log`). Regression cases cover all reason codes, override normalization, bounded read-only metadata, owner/generation/freshness fences, stale detached-audit observations and the production card/footer builders. An independent fresh-context review found that an unrelated paused goal incorrectly deferred diagnostics for a selected active loop. The goal-specific pause check now follows the selected owner; a production `currentUiStatusContext` regression covers an active loop alongside a paused goal and verifies that inspection launches no compaction. Global supervisor/persistence/audit holds remain intact. The same independent reviewer rechecked the ownership correction and production regression after the fix: original P1 resolved, no issues found, BLOCKERS: none (follow-up run 17544ad7-179b-4601-8c42-8bd949f58d38). Review inspected source and recorded validation logs rather than rerunning commands.

## Lifecycle defect disposition

The lifecycle follow-up confirms **no newly reproduced GLLA-owned compaction lifecycle defect** from the bounded context investigation. This is not a claim that every historical 400k incident has been explained. No compaction/continuation/admission behavior was changed merely to make the token count smaller.

| Reported or confirmed issue | Disposition | Regression/evidence |
|---|---|---|
| Context grows past 200k | Target is opportunistic, not a hard cap; safety holds and bounded-attempt guards are intentional. No new defect reproduced. | `tests/between-tasks-compaction.test.ts`, `tests/compaction-settled-boundary.test.ts` |
| Unobserved 400k sessions | Remains unknown; do not assign a root cause without matching timestamped host/owner/admission evidence. | Historical Freeport observations above establish 316213 tokens, not the exact reported 400k case. |
| Paused unrelated goal falsely labels selected-loop compaction held | Confirmed **diagnostic ownership defect**, repaired and audited in the preceding status item; not a compaction dispatch defect. | `tests/compaction-status.test.ts`: production active-loop + paused-goal regression, inspection launches zero compactions. |
| Busy-boundary deferral, prior-attempt rearming, compact failure and provider-recovery handoff | Existing ownership-safe behavior retained; no new failing reproduction in these suites. | Existing compaction/recovery suites, including pressure-budget and quota-exclusion cases. |

Lifecycle validation command: `timeout 300 npm test -- tests/*compaction*.test.ts tests/*compactor*.test.ts tests/*context-pressure*.test.ts tests/*recovery*.test.ts tests/pressure-budget-late-success.test.ts tests/quota-context-pressure-exclusion.test.ts`.

Observed: **389 pass, 0 fail across 34 files**, exit 0. Log `/tmp/glla-compaction-lifecycle-disposition.log` records the runner output and exit. `timeout 100 npm run check` exits 0, recorded in `/tmp/glla-compaction-lifecycle-types.log`. Coverage retains pause/cancel/owner-generation fences, healthy tool boundaries, bounded failure/retry budgets and automatic post-compaction continuation; no test standards or types were relaxed. External projects, Pi core and providers remain unchanged.

## Mechanical reproduction and verification

`npm test -- tests/between-tasks-compaction.test.ts tests/compaction-settled-boundary.test.ts tests/compaction-target-settings.test.ts tests/quota-context-pressure-exclusion.test.ts tests/pressure-budget-late-success.test.ts`

Observed result: 35 pass, 0 fail across five files, exit 0. Log: `/tmp/glla-context-investigation.log` (ephemeral; command above is the durable reproduction). These test cases reproduce source-defined eligibility behavior, not the exact external 400k incident. No tests, types, or ownership guards were relaxed.
