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

Confirmed observability gap: the caller currently receives only a boolean for most admission refusals (`maybeCompactTranscriptAtBoundary`), so a user cannot distinguish busy/pending/held/budget suppression from threshold behavior on status surfaces. The next list item should project a shared evidence-based eligibility reason, without starting compaction or claiming stale journal observations are live. A reported 400k case needs a timestamped usage observation plus matching work/owner/eligibility evidence before assigning a root cause.

## Mechanical reproduction and verification

`npm test -- tests/between-tasks-compaction.test.ts tests/compaction-settled-boundary.test.ts tests/compaction-target-settings.test.ts tests/quota-context-pressure-exclusion.test.ts tests/pressure-budget-late-success.test.ts`

Observed result: 35 pass, 0 fail across five files, exit 0. Log: `/tmp/glla-context-investigation.log` (ephemeral; command above is the durable reproduction). These test cases reproduce source-defined eligibility behavior, not the exact external 400k incident. No tests, types, or ownership guards were relaxed.
