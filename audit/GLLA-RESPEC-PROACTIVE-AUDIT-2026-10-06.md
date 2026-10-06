# Current audit: /glla, respec and the proactive goal

Objective: lets audit /glla and respect and the proactive goal. In this thread,
respect refers to respec. This register preserves the whole objective. Publication
of 0.39.13 was progress, not proof that this broader audit is complete.

## Requirements and current evidence

| Id | Required outcome | Authoritative evidence and current disposition |
| --- | --- | --- |
| A1 | /glla inspection/settings/control routes are discoverable, coherent, and preserve command ownership and state | Current goal-activation registration and goal-commands handlers; command audit 2026-10-05; 0.39.13 exact-source full gate. Recheck new routes and edge cases against current handlers; historical prose alone is insufficient. |
| A2 | Respec researches intended capabilities, drafts/adopts scope, plans mapped increments, builds substantively and verifies independently | prompts/goal-loop-respec-builder.md, respec-builder transitions/runtime and eight requirements in RESPEC-BUILDER-CONTRACT-2026-10-04.md. Wiring, worker and scope tests exist. Need final requirement-by-requirement current-state reconciliation. |
| A3 | Proactive goal/audit loops generate and execute appropriate task queues, preserve unfinished work, and replan rather than park ordinary failures | Current continuation prompts, goal task tools, loop auditing and respec repair paths; published work-vs-external transitions. Verify proactive decision defaults, task/acceptance fidelity and true completion gates across modes. |
| A4 | Provider errors, model changes, transcript compaction and restarts continue the same authorized work without losing scope, duplicating actions or bypassing holds | Current goal-recovery and activation hooks plus recovery tests. Request-metadata classification fixed in Unreleased with 36 focused passing tests. Next suspected gap: ordinary-request fallback exhaustion versus supervised-only parking and settled handoff; needs a behavior reproduction and repair if confirmed. |
| A5 | UI and docs accurately show progress, blocked actor/action, pending verification and terminal completion with semantic colors/bold | Current display/action renderers, README, RECOVERY, SETTINGS and settings tables. 0.39.13 tests and earlier rendering evidence cover much of this; reconcile changed surfaces and current command guidance before completion. |
| A6 | Every current defect has a reproduction, scoped disposition, durable tracked evidence and suitable verification; releases are verified actual artifacts | Tracked audit records and 0.39.13 hosted gate/registry verification. New classification correction is not yet released. Overall audit remains active until all rows are proven against final current state. |

## Scope and next work

Repository scope is GLLA. External provider quota, host capacity, long-running
project tools and npm processing can be observed but are not implementation targets.
Feature proposals (ordinary-session idle compaction, long-timeout diagnostics) do
not count as fixes required by the existing contract without supporting evidence.
Do not alter external projects to make an audit outcome look complete.

The fallback-exhaustion code path merits next inspection: tryMainModelFallback
can leave a passive recovery episode after selecting a backup; ordinary requests
are not supervising, so parkMainModelAfterFailure returns early. The agent-end
handler can still claim recovery ownership merely because that episode exists,
and the settled ordinary-request handoff may send again without a fresh successful
model selection. This is a hypothesis backed by current control flow, not yet a
verified runtime finding. Reproduce with one backup failing after its first handoff.

No complete status is claimed. Historical audit documents describe earlier builds;
the current worktree, current behavior tests and actual artifacts remain authoritative.
