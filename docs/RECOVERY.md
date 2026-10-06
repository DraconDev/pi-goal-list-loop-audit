# Recovering and inspecting work

Start with `/glla status`. For full saved details, use `/goal status`,
`/list show`, or `/loop status`, depending on the work surface.

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

Manually selecting a model cancels the current automatic main-model recovery
episode. A recovery-held loop keeps its objective and iteration history,
stays visible, and offers `/loop resume` or `/glla resume` to continue using
the selected model. Changing the model alone does not resume loop supervision.

If an older loaded extension still hides the objective or shows an obsolete
retry countdown, update GLLA and run `/reload`, inspect `/loop status`, then
resume. Saved legacy recovery holds are supported from 0.39.8 onward.

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

## Project requirement blockers

Use `/loop blockers` for complete recorded reasons and the next action. These
are agent reports, not proof that a dependency is still unavailable. Ask the
agent to recheck against the current project, resolve what it can, and give an
exact command/location and expected result for any action that requires you.
The view is read-only and remains available on stale handles.

When evidence shows resolution, the agent calls `unblock_project_requirement`;
then `/loop resume` continues the saved project. Unblocking does not verify a
requirement. All-blocked projects retain their hold instead of repeatedly
dispatching work that cannot progress.

## Updating a running session

The npm package is also the Pi plugin; there is no separate Pi-only release.
Follow the [update instructions](../INSTALL.md), run `/reload` in existing
sessions, and use `/glla version` to check the version actually loaded.
Publishing a package does not replace code already loaded in a live session.
