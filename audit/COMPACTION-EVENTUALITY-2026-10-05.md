# Do projects eventually compact above 200k?

## Fleet evidence

Read-only terminal/journal survey of 20 roots represented by the live terminal
panes. `fleet.json` contains the observation timestamp and exact displayed
context percentages, marker files, recent compaction events and durable
last-compaction timestamps. Percentages are terminal observations, not fresh
API token measurements. Recent event sampling uses active.jsonl; historical
rotated events were not fully replayed, so missing events do not prove no past
attempt occurred. No live host, settings or journal was changed.

The effective global GLLA compaction-token threshold is the default **200,000**;
the global settings file does not override it. This is an opportunistic target,
not a maximum context size. Busy tools, queued messages, audit ownership,
supervisor pauses, aborts and lack of active GLLA supervision can defer it.

There is direct evidence of both outcomes:

- **Polis:** GLLA fired at 200,566 tokens at 07:49:12 UTC on October 5;
  session_compact and compactor_transcript_done landed at 07:51:59. A later
  attempt at 224,079 failed on the summarization output cap at 09:35.
- **Capture Anime Girls:** fired at 204,012 at 08:16:24 and completed at
  08:17:51. A later attempt at 207,050 failed on an empty turn-prefix summary
  response at 09:23.
- **Football Forever:** the October 5 attempt at 206,356 failed at 07:48
  because summarization reached its output cap. The observed footer displayed
  40.6% of a 1M window (approximately 406k), so crossing the target had not
  guaranteed successful compression.
- Neonbreak, Endless TD and Darklord also have recorded summarization-cap
  failures. Some high-context roots, including Chat and Studio, had no active
  GLLA loop/goal owning the observed snapshot; an idle transcript above 200k
  does not by itself start GLLA automation.

Thus: **some do compact near 200k, but eventual success is not guaranteed.**

## GLLA-owned scheduling gap and correction

Goal/list sends checked compaction at idle dispatch. Loop sends did not. Loop
agent_end also returns through runLoopTick before the goal continuation
boundary check. The agent_settled callback can cover that gap, but relying on
it does not cover a host that lacks or misses that callback.

0.39.4 adds the same check immediately before an idle loop turn is prepared.
Metricless/metric loops and project drafting/building/replanning now get that
opportunity without requiring agent_settled. Project auditing still dispatches
its auditor before this branch and owns the wait; the shared project-audit
guard remains in force. Goal audit, pause, busy and pending-message guards
also remain in force. Failed optional compaction re-arms the same active loop
through a fresh owner context, without repeated attempts in the same episode.

Two actual loop-dispatch reproductions failed before the change: one requiring
a compact trigger, one requiring failure to resume work. Both passed afterward.

## Failure policy and external boundary

The summarizer's output-cap and empty-response failures are recorded external
Pi/provider behavior. GLLA can schedule the public compact hook and safely
contain failure; this repository does not modify Pi core, provider code or the
provider/model's output limit. Its brief worker is separate from the transcript
summarizer and cannot establish that the transcript compacted.

After a failed opportunistic attempt GLLA deliberately continues work and keeps
the episode marker, rather than repeatedly calling a failing summarizer every
turn. The marker rearms when a later safe check observes context below half
the configured target. Subsequent native/manual compaction, a smaller fresh
session or sufficient context shrink can supply that new episode. Until then,
the current transcript may exceed 200k substantially. GLLA does not claim that
a trigger guarantees success or that the target is a hard cap.

## Verification

Final targeted checks, TypeScript for current/minimum host versions, Jiti state
binding, inventory and actual 0.39.4 tarball installation/RPC checks are being
recorded in this directory. The complete 0.39.3 release gate passed immediately
before this patch; the full gate is not claimed for 0.39.4 without a new run.

0.39.4 is prepared, not published. Existing hosts retain their loaded code until
reload. This investigation did not force compaction, resume held work or modify
external projects.
