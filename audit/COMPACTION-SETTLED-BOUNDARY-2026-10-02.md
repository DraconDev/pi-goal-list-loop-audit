# Missing preventive compaction — October 2, 2026

The operator reports compaction remains unfixed, following the named-root
audit discussion (platform and strategy). The exact failure symptom was
requested; investigation proceeded with the demonstrated missing 200k trigger.

## Field evidence and scope

Read-only inspection of the latest root session transcripts found no
persisted compaction in strategy's session starting October 1 at 22:47 UTC,
despite its latest assistant usage exceeding 315k tokens. GLLA's own
`context_usage_sample` confirms a host estimate of **315718** tokens at
07:18:30 UTC on October 2 (31.5718% of a 1M window). Earlier samples show
246065 and 279643 tokens, also beyond the configured-in-code 200k trigger.
Neither `compactor-boundary.json` nor `compactor-fired.json` exists there.

Platform's previous session likewise contains no compaction entry; GLLA
recorded 349172 tokens at 05:07:47 UTC. A fresh platform session started at
07:18 UTC and was below the trigger (~59k tokens) at inspection.

Older September journals contain real compactions and summarizer output-cap
failures; those historical provider failures are not proof of the current
trigger's health. No project journals, owner files, processes, upstream
packages, or transcript history were modified.

GLLA owns where it invokes the public `ctx.compact` hook. Pi owns transcript
summarization and provider behavior. This change repairs GLLA's trigger
placement; it does not repair Pi or a provider's summarizer.

## Reproduced causes and repair

The trigger ran in `agent_end` but required `ctx.isIdle()`. The installed Pi
source emits extension `agent_end` while its run is still active; it clears
that activity in `_emitAgentSettled` before emitting `agent_settled`. Thus a
productive turn could skip the 200k check every time. GLLA now rechecks at
`agent_settled`, yields the queued continuation when compaction starts, and
retains ordinary post-compaction continuation ownership.

A detached final audit can advance the list after that settled event. The
next item then has no new `agent_end` or settled event before its first
continuation. GLLA also checks the idle pre-dispatch boundary, before preparing
or sending that continuation. The trigger decision is synchronous (its
optional brief worker remains asynchronous), avoiding an ownership race
between the send's guards and dispatch preparation.

The token threshold, marker hysteresis, tool/audit ownership, pending-message
guard, supervisor freeze, recovery, stale-host guards, and abort stand-down
remain in force. A brief is not used as evidence that the transcript compacted.

## Verification

The final two positive regressions were run unchanged against a temporary
archive of pre-fix commit `d7b89c3a`; both fail because no compaction starts.
No git history was rewritten. The temporary archive was removed.

Current focused checks: **55 passed, 0 failed** across eight files covering
both new cases, between-task thresholds and guards, real-worker compaction
survival, containment, failed-compaction recovery, continuation payloads,
revision fences, and answered-decision dispatch.

Additional actual settled/send entrypoint checks cover paused, auditing,
supervisor-frozen, and user-aborted work: **6 passed, 0 failed** in the final
boundary file. Broader behavioral lifecycle: **151 passed, 0 failed**.
TypeScript passed; runtime inventory was regenerated for shifted source
references and its check passed. Selected logs are in
`compaction-settled-evidence-2026-10-02/`. No release was published.

This is a tested implementation fix. The live strategy session has not yet
loaded and demonstrated the new code producing a durable compaction entry.
Existing hosts need to reload the updated extension; no live compaction was
forced during this investigation. A provider/host compaction failure remains
distinct from failure to invoke the trigger.
