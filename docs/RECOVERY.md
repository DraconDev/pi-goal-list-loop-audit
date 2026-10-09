# Recovering and inspecting work

Start with `/glla status`. For full saved details, use `/goal status`,
`/list show`, or `/loop status`, depending on the work surface.

## Waiting is not paused

**⏳ waiting** yields the main agent to named background dependencies. The
saved goal/list item or loop/project remains supervised; exact terminal results
trigger a bounded assessment of the retained checkpoint. Waiting does not mark
tasks or project requirements successful. **⏸ paused** freezes automatic
continuation; children may still run, but their results cannot bypass the freeze.
Lifecycle is separate from activity such as researching, implementing, auditing
or recovering. Activity requires observed evidence, not the model's narration.

The agent uses `wait_for_background` with exact owned `runIds` and a reason.
`pause_goal(kind="standby")` is a compatibility entry requiring the same ids;
use a genuine pause for decisions, user holds or manual-action blockers. Unknown
worker ids are rejected. Legacy saved standby records have no provable ownership:
GLLA requests an assessment once eligible, rather than promising automatic wake.

Use `/goal status`, `/list show`, or `/loop status` to inspect the checkpoint.
On reload, GLLA reads only the saved identity-matching public status artifacts;
completed, failed, stopped or missing results are assessed without discarding
scope or progress. A running artifact with no deadline is assessed after at most
30 minutes; stale activity without a provably live local process is assessed
sooner. No busy polling or guessed worker adoption is performed. Load holds,
supervisor pauses and pending audits remain authoritative. Explicit resume
reconciles a dependency wait instead of blindly re-sending the main work.

See [the lifecycle/state reference](DESIGN-work-lifecycle.md).

## Which resume command?

| Command | Use it for |
| --- | --- |
| `/glla resume` | Broad recovery: release supervisor/load holds, retry saved model recovery, or resume the current goal, list item or eligible held loop. If a paused goal and held loop both qualify, the UI asks which one. |
| `/goal resume` | Resume the current goal through its goal recovery path. |
| `/list resume` | Resume the current list item, including recovery of its pending completion audit. |
| `/loop resume` | Resume an eligible held metric loop or project builder, retaining its target, iteration and audit claim. |

For a held project, `/glla resume` delegates to the same loop recovery as
`/loop resume`. Both retain blocker and branch checks. Neither overrides an
explicit `/loop stop` or declares unfinished work complete. Resume feedback
explains when work cannot restart.

After loading a session, **Loaded without starting** means the saved work is
restored but automation awaits your decision. Load the intended conversation,
inspect its state, then resume. Enable **Auto-resume** in `/glla` only if you
want automation to restart after future loads.

## Is an audit progressing?

Read the auditor rows, rather than the main session's spinner alone:

| Display | Meaning and next step |
| --- | --- |
| **Auditing**, recent activity | The detached auditor is producing events. Tool completions and changing evidence provide stronger progress evidence than elapsed time alone. A long duration alone does not establish a stall. |
| Waiting on a tool, elapsed/timeout | A tool is still running. Its ticking timer is a wait indicator; timeout handling remains automatic. |
| Waiting for dispatch | A saved claim exists, but no live worker activity is observed yet. Inspect status for restoration or recovery holds. |
| **Audit held** | Automation parked with a recorded reason. Inspect `/loop status`, resolve the cause, then resume through the command shown. |
| **Audit stopped** | The project was explicitly stopped. Resume is not offered for that stop. |
| Completion review disapproved | The auditor found an unmet contract. Read its required fixes; repair work can continue automatically. Rejection does not mean approval is stuck. |

If progress stops and the UI reports a wedged main session, follow its recovery
message: interrupt the stuck turn with Escape if needed, then resume. Use
`/glla bug <what you observed>` to capture GLLA diagnostics without changing
the saved objective. A process that has exited cannot reconcile an audit;
load/resume the original session before inspecting its pending claim again.

## Changing models during recovery

An allowed manual `set`/`cycle` selection resumes work held solely for
main-model recovery on the selected model. Goal/list work keeps its
objective, verification contract, telemetry and history; a recovery-held
loop keeps its objective and iteration history and restarts supervision.
Resume is scoped: restore/unknown/recovery events, nested
forbidden-selection reverts, internal recovery rotations, forbidden
models, stored audit claims, supervisor/load pauses, user/decision/
permission holds, and deterministic request refusals are never treated as
resume consent. Failed resume persistence restores the episode and holds
dispatch; repeated selection never duplicates continuation.

A manual switch never bypasses an unrelated hold and never authorizes an
upload, purchase, or other gated action.

## Same-model phase (v0.38.105)

Before rotating to a configured backup, GLLA spends its **same-model retry
budget** on the currently selected model (default 10; setting
`mainModelSameModelRetries`, 0..100, 0 = legacy immediate rotation). The
phase exists because most provider failures are transient: a 429 "rate limit
exceeded" rotating the session to a backup on the first turn spends a
different provider's quota to solve a five-second problem.

- The budget is **reason-agnostic** — the existing envelope cadence applies
  inside it: 5s for the eager transient window, then the short ladder;
  an explicit upstream reset hint still sleeps to reset; persistent walls
  ladder per `mainModelRetryMinutes`.
- A successful **rotation** resets the budget for the new model so the
  backup earns its own retries from zero.
- A **cycle reset** (return to the current model after the chain was
  visited) re-seeds the budget at 1.
- The status card shows the live counter (`Same-model retries: N`) so an
  operator can see how close the next failure is to triggering rotation.
- 0 keeps the legacy immediate rotation. Use it deliberately — for example
  a project with no time tolerance for a flaky primary benefits from
  rotating on the first blip; the default of 10 matches the
  `TRANSIENT_EAGER_ATTEMPTS` quantum ("enough to prove it is not a blip").

If an older loaded extension still hides the objective or shows an obsolete
retry countdown, update GLLA and run `/reload`, inspect `/loop status`, then
resume. Saved legacy recovery holds are supported from 0.39.8 onward.

## Persistent paced recovery (no elapsed-time give-up)

Main-model recovery retries with paced backoff for as long as the failure
remains recoverable, in every mode. There is no 24h automatic-recovery
horizon: legacy expiry metadata is discarded during normalization, while
retry cadence (`mainModelRetryMinutes`, doubling per attempt, 5h cap),
explicit upstream reset sleeps, eager-transient handling, and the
same-model/fallback policy stay intact. Explicit manual holds and
deterministic client errors still stop. Failed recovery-wait persistence
restores state, leaves dispatch held, and arms no timer.

Legacy already-manually-held horizon records rearm only after positive
restore completion plus resume consent, and only for the exact old
elapsed-time stop wording. Identity, counters, contract and history are
retained; generic manual, decision, audit, deterministic,
supervisor/load, and replaced-owner holds never migrate.

## Compaction-timeout handoff

A compact-first timeout (including the 120s budget) hands the original
provider diagnostic to paced automatic model recovery instead of parking
for manual resume. The saved goal/list/loop contract survives, the
compaction one-shot budget stays spent, owned compaction is cancelled
before the handoff, and late compactor callbacks cannot duplicate
dispatch. A persisted automatic wait is required before timers arm;
storage failure keeps fail-closed dispatch.

## Ownership cleanup and ordinary chat

Recovery follows a work identity (goal id, loop start, or explicit chat),
not whichever live slot exists when a delayed callback fires. Terminal
(`complete`/`aborted`), genuinely absent, or replaced owners retire
supervised markers and cancel both recovery and hourly timers immediately;
explicit cancellation does the same. Cleanup never runs during an
incomplete restore, and failed cleanup persistence restores the marker and
holds dispatch. Ordinary-chat recovery is explicit, never inferred from a
legacy orphan, and terminal goal archival neither adopts nor deletes it.
Late accepted/rejected model selections cannot cross a terminal, absent,
replaced, new-episode, or user-hold boundary.

## Protected holds and truthful displays

User stops, genuine decisions, permission gates, deterministic
nonrecoverable errors, and persistence-safety holds stay authoritative:
no timer, fallback, or model switch overrides them.

The saved `attempts` counter counts GLLA backoff steps, not provider
requests. Status labels it **Recovery steps** with **episode age**, and
explicitly denies that age proves continuous failure. A durable `retryAt`
alone renders execution as unconfirmed (`retry scheduled (unconfirmed)`);
live snapshots distinguish armed regular timers, hourly-only timers,
in-flight selections, active/queued host turns, absent timers, and
supervisor/load/context/stale-extension/persistence holds. Selection alone
is never reported as provider success.

## No objective to resume—but a recovery message remains

An objective, its completion claim, and provider recovery are separate state.
A retry/fallback record can belong to ordinary chat or remain after tracked
work has already settled. It is not evidence that the objective is still active.

If `/glla resume` says **No GLLA objective is paused** and clears an old recovery
marker, it clears that marker—not the conversation, archive or completed work.
Inspect `/goal archive` for goal history and `/loop status` for a saved project.
For ordinary chat, send `continue`; for additional work after an accepted result,
start a new goal. Resume does not reopen an archived objective.

Reloading refreshes extension code but does not repair provider access, credits
or credentials. A selected model and a responsive UI do not prove that the next
provider request will succeed. If a fallback is needed, select one you can use,
then inspect status and resume eligible unfinished work explicitly.

## When a project completes

Project completion requires independent verification of every adopted
requirement and a written archive. After completion, the project widget and
GLLA footer disappear; other unfinished work can still show its own UI.
The semantic completion summary, `/loop status` and archive retain the
verification evidence. There is no resume action for an already completed
project. Start a new project when its intended scope changes.

## Why context can exceed 200k

**200,000 tokens is the default opportunistic compaction target.** Configure
`compactionTokenThreshold` through the global settings; see [SETTINGS.md](SETTINGS.md).
GLLA checks at safe idle boundaries during supervised work. Active tools,
audits, queued messages and pauses can defer an attempt. An idle conversation
without active GLLA work does not start automation simply by crossing the target.

Pi's summarizer can fail, for example when its output hits the model's token
cap. GLLA records that failure and continues eligible work. It does not retry
the same failed compaction episode every turn. Failed or unknown episodes rearm
when a later safe check observes context below half the configured target. A
confirmed successful compaction rearms after its three-minute recovery grace,
yielding one normal work boundary before another attempt. This also recovers
older success markers from the durable completion timestamp. Pi's `/compact`
is available for a manual attempt; summarizer success is not guaranteed by
GLLA's scheduling. Compare current context with the recorded attempt time
before treating an older high-token sample as the current transcript size.
`/glla status` shows the configured target and last recorded completion time.

When a host-owned compaction failure parks a loop or project, its durable work
remains resumable. Use `/new` if the current transcript still cannot fit, then
`/loop resume` or `/glla resume` to continue the saved project. A saved
summarization-output failure is a hold, not completed work. Resume preserves
requirements and history; it does not approve the outstanding audit claim.

## Failed requests and context growth

GLLA filters obsolete error-only assistant replies from outgoing model input and
compaction input, retaining the latest failure for retry diagnosis. This applies
with or without an active goal, list or project. Adjacent GLLA dispatch and
automatic retry prompts disappear with their discarded failures. User requests,
tool calls and results, and user aborts remain intact.

Project dispatches also bound repeated audit reports and refer back to durable
evidence. Adopted acceptance criteria remain complete in the ordinary dispatch;
oversized contracts require scoped reads from durable state before work.

These projections leave the saved transcript intact. The host's context estimate
can therefore remain high until a successful compaction replaces the transcript
prefix, even though provider input has already shed obsolete failure pairs.
Filtering failed attempts does not restore an unavailable provider endpoint.

## Continuing work after a model fallback

Selecting a fallback does not finish or replace the task. Active goals, list items
and loops continue through their saved contracts and progress. For ordinary turns
and one-off blocker reviews, GLLA requests one continuation after the failed run
has settled, with a bounded excerpt of the original request and instructions to
use existing successful tool results. The complete conversation remains authoritative.

Once the ordinary request exhausts its configured fallback candidates, subsequent
recoverable failures use ordinary retry backoff. A passive record of the selected
model is not a fresh switch or a scheduled recovery owner. Delayed retries carry
the original request as well, while credential and deterministic failures retain
their manual-action rules.

A successful core retry consumes this handoff; repeated settlement cannot duplicate
it. Running or queued turns, explicit aborts, supervisor pauses and recovery waits
prevent automatic sends. A send failure retains the pending handoff and reports
that delivery failed. GLLA does not restart the project or unblock a dependency
just because the selected model changed.

## Project requirement blockers

New or changed project blockers automatically show a concise action card:
short obstacle, who can act, why the agent cannot continue, concrete next step
and expected result. Long measurements stay in the full-details view.
`block_project_requirement` distinguishes `kind="work"` from `kind="external"`.
For work, give `id`, diagnostic `reason` and a concrete `nextAction`. The
requirement stays open, the previous batch is retained as history, and the agent
replans and keeps building/refining. Failed tests, unrun checks, missing evidence
and unfinished implementation belong here; usually the agent can simply keep
working without calling this tool at all.

For external dependencies, also give `summary` (up to 240 characters), `owner`,
`expectedResult` and `whyAgentCannotProceed`. Incomplete reports are rejected
before changing durable state. Continue other open requirements; only all-blocked
projects hold. Classifying a mistaken blocker as work releases a blocker-only
hold and continues, while user pauses/stops, supervisor holds and exhausted
budgets stay held. Branch-mode holds still require the guarded resume command.
The classification and next step are journaled; no requirement becomes verified.
Put long diagnostic evidence in `reason`.

Older saved reports remain readable and are labelled **Needs clarification**.
They do not establish that the operator must intervene; ask the agent to explain
or continue fixing the work. GLLA does not infer external dependencies or shell
commands from unstructured test output. Unchanged reports do not repeat the card.
Displaying a card does not dispatch work, clear a blocker or verify a requirement.

Use `/loop blockers` to reopen complete recorded reasons and the next action. These
are agent reports, not proof that a dependency is still unavailable. Ask the
agent to recheck against the current project, resolve what it can, and give an
exact command/location and expected result for any action that requires you.
The view is read-only and remains available on stale handles.

For a held project, ordinary user turns receive its bounded durable contract as
per-turn context. A fresh conversation does not mean the project is complete or
that no objective exists. This context does not grant permission to resume and
is not appended repeatedly to transcript history.

Use `/loop recheck` to request one agent assessment of the saved blockers.
`/loop resume` does the same for an all-blocked project held solely by blockers.
The review can reclassify ordinary repair work with `kind="work"` and continue
building while preserving scope. Real dependencies remain blocked. Rechecks do
not silently reopen requirements, and a running or queued turn prevents duplicate
review dispatch. If sending fails, the saved hold remains intact.

When evidence shows resolution, the agent calls `unblock_project_requirement`;
then `/loop resume` continues the saved project. Unblocking does not verify a
requirement. All-blocked projects retain their hold instead of repeatedly
dispatching work that cannot progress.

## Updating a running session

The npm package is also the Pi plugin; there is no separate Pi-only release.
Follow the [update instructions](../INSTALL.md), run `/reload` in existing
sessions, and use `/glla version` to check the version actually loaded.
Publishing a package does not replace code already loaded in a live session.
