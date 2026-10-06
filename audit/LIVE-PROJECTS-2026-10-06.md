# Running-project bug-hint audit

Read-only observations at 13:22, 13:23 and 13:26 UTC on October 6 covered
19 interactive Pi project roots. Later auditor child processes shared project
roots and are not additional projects. Only evidence in this repository was
written; no project, provider configuration, live session or process was changed.

## Confirmed GLLA diagnostic defect

`classifyMainModelFailure` searches the whole raw error string for bare `401`,
`403` and `5xx` digit patterns. Provider request IDs can therefore become HTTP
status evidence. For the same live plan-limit 429, Capture Anime Girls, Polis
and Darklord classify as transient with their request IDs present and unknown
with those IDs removed. A controlled reproduction changes only the request ID:
`abc123` gives unknown, `abc503` gives transient, `abc401` and `abc403` give auth.

This explains inconsistent UI labels; it does not prove a different retry policy.
The current generic recovery policy deliberately avoids selecting special
quota/billing escalation from provider wording. Do not change that policy merely
to fix the labels. A focused follow-up should normalize structured status/message
fields and require actual HTTP status context for numeric matching, retaining raw
diagnostics separately. Regression acceptance: changing an opaque request ID
cannot change the failure class or recovery decision.

## Long-running project command and containment opportunity

Endless TD has an unfinished bash tool call from 10:39:15 UTC, with `timeout`
set to **180,000 seconds**, or fifty hours. At 13:26:33 the census process had
run 10,037 seconds and used 98.8% CPU. Its terminal displayed over two hours
forty minutes of elapsed time. It is computing, not an idle auditor.

The prior GLLA loop was explicitly wiped on October 5; current durable state
has no active GLLA objective. Old held-project cards in scrollback are not its
current status. The tool call and census belong to the project/Pi invocation,
not a GLLA implementation defect. Possible GLLA improvement: surface unusually
large declared timeouts and long-running tools through public hooks, including
ordinary sessions, without silently assuming units or cancelling legitimate work.
Do not modify the census or Pi core as part of this repository audit.

## Current fleet disposition

| Project | Observed state | Evidence / disposition |
| --- | --- | --- |
| Hellhunter | Project auditing | Progressed from building; auditor completed 33 tools in about 216 seconds with fresh activity. |
| Eve | Goal auditing | Progressed from active work; auditor reached round 2 with 25 completed tools and fresh activity. |
| Freeport | Project building | New session messages; current bash has a 900-second timeout. Earlier journal token sample is stale. |
| Deathrun | Loop active | 66 additional transcript entries during the window. |
| Football Forever | Project building | 27 additional transcript entries; adopted progress remains 4/8 verified. |
| Doomtap | Project building | 31 additional transcript entries; adopted progress remains 4/12 verified. |
| Junk Runner | Recovery hold | Current failure is provider plan-limit 429; retry scheduled 14:04 UTC. Project remains replanning with fifteen open requirements. |
| Hegemon | Recovery hold | Same provider plan-limit error; retry scheduled 14:12 UTC. |
| Capture Anime Girls | Recovery hold | Same provider plan-limit error; retry scheduled 18:00 UTC. |
| Neonbreak | Recovery hold | Same provider plan-limit error; retry scheduled 18:00 UTC. |
| Polis | Recovery hold | Same provider plan-limit error; retry scheduled 18:00 UTC. |
| Darklord | Recovery hold | Same provider plan-limit error; retry scheduled 18:12 UTC. |
| Endless TD | Ordinary tool running | Fifty-hour declared timeout and CPU-intensive census; no active GLLA objective. |
| Chat | Ordinary work | Nine additional transcript entries; previous GLLA goal archived. |
| Studio | Ordinary session | Previous GLLA goal archived; no active objective. |
| Clean Web | Ordinary session | No active GLLA objective; latest successful input approximately 463k tokens. |
| Dracon Platform root | Ordinary session | No active GLLA objective; older warnings are not current audit ownership. |
| AI Auto Music | Ordinary session | No active GLLA objective; older provider failures remain in transcript history. |
| AI Auto Video | Ordinary session | No active GLLA objective; missing installed Pi bundle module is an external-only report. |

The six provider holds have future retry timestamps; this snapshot does not show
an overdue recovery timer. Plan-limit exhaustion cannot be repaired in GLLA.
No stalled independent audit was confirmed. Completed job directories containing
results were not counted as running auditors.

## Context and visibility observations

Automatic 200k opportunistic compaction requires active supervision and a safe
idle boundary. Ordinary sessions without GLLA work can exceed that target by
design; an opt-in idle-compaction feature would broaden coverage, but this is a
feature proposal rather than a broken current contract. Long tool calls and
live audits can legitimately defer compaction.

Stored journal usage can lag live activity during a long turn. Freeport's older
449k sample predates its fresh session; newer successful provider usage was
about 118k input plus cache-read tokens. Do not label it stuck from that old
sample. The separate starvation handoff marker `compactor-fired.json` is not
the automatic boundary marker `compactor-boundary.json`; old handoff markers
alone cannot establish suppressed automatic compaction.

Useful follow-ups: request-ID-safe classification; unusual-timeout diagnostics;
and, if wanted, opt-in safe-boundary compaction for ordinary sessions. Audit
evidence is in `audit/live-projects-2026-10-06/`, including three snapshots,
controlled classifier reproduction and live auditor/process health measurements.
