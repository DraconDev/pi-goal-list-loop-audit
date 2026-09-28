# Goal continuation dispatch / heartbeat / recovery / compaction & context budgeting — 2026-09-28

Scope surveyed: extensions/goal-continuation.ts, goal-heartbeat.ts, goal-recovery.ts,
main-model-recovery.ts, quota-retry.ts, compaction-input.ts, context-growth.ts,
compaction-failure.ts, length-continue.ts, continuous-supervision.ts, compactor-model.ts,
context-checkpoint.ts, context-hygiene.ts, start-context.ts, goal-compactor.ts.
Dedupe: `rg -n` over `.pi-glla/audit-loop/findings.md` for every finding keyword
(observedSubagentRpc, mainModelFailureDelayMs, quotaResetSleep, retryContinuationDispatch,
retryCount, persistDispatchRecord, "attempt <= 1", eager) returned zero hits — none of the
three findings below is in the 364-entry ledger.

## Findings

### F1 [SEVERITY: MEDIUM] The eager `attempt <= 1` return short-circuits the upstream reset-hint branch its own comment says must come first — a rate-limit wall with an explicit reset is retried after 5 s
- Where: extensions/main-model-recovery.ts:330-338 (branch), extensions/main-model-recovery.ts:369-378 (`quotaResetSleepMs`), extensions/goal-recovery.ts:846-851 (`requestedDelayMs` consumer)
- What breaks: `mainModelFailureDelayMs(failure, 1, …)` returns `5_000` at line 331 before
  `quotaResetSleepMs` is ever evaluated. Input: a first-attempt failure whose text carries both a
  quota signal and an upstream hint, e.g. `HTTP 429 … Retry-After: 14400` or
  `rate limit reached, resets at 2026-09-28T12:00:00Z`. `quotaResetSleepMs` would return 4 h
  (capped by `MAIN_MODEL_MAX_RETRY_DELAY_MS`), but the actual timer is armed 5 s later and
  `probeMainModelRecovery` fires immediately against the wall the provider just named — exactly the
  hammering the comment at 332-336 says the branch exists to prevent. The comment's ordering claim
  ("Checked BEFORE the eager rule, never after") is false for attempt 1, so this is also a
  code/comment contradiction. (Attempt 2+ takes the intended 4 h path, so the retry actually
  self-corrects only after one wasted probe.)
- Fix: move the `attempt <= 1` fast path after the `quotaResetSleepMs` check (or guard it with
  `isEmptyProviderResponse(failure.raw)` like the attempt 2-3 eager branch does), so an explicit
  upstream reset hint always wins over the eager quantum.
- Confidence: high — the branch order is unambiguous in the file and the failure text shapes are
  exactly the ones `parseQuotaError`/`quotaResetSleepMs` already accept (verified at
  quota-retry.ts:427-431 and main-model-recovery.ts:371-378).

### F2 [SEVERITY: MEDIUM] The one automatic continuation retry mutates the live pending dispatch in RAM and ignores its persistence result, so a failed sidecar write leaves durable `retryCount = 0` and the reload path re-sends the continuation
- Where: extensions/goal-continuation.ts:900-904; contrast extensions/goal-continuation.ts:585
  (`if (!persistDispatchRecord(...)) { continuationDispatchStoodDown = true; … }`) and
  extensions/goal-continuation.ts:931-934 (`dispatchAccepted` checks the same call)
- What breaks: `retryContinuationDispatch` has already called `sendMessage(...)` (line 892) —
  the duplicate-send side effect is committed — then sets `record.retryCount = 1`,
  `retrySentAt`, `timeoutMs = continuationRetryBackoffMs()` on the same object that is
  `pendingContinuationDispatch` (the guard at line 869 requires identity) and discards
  `persistDispatchRecord`'s boolean. Input: `.pi-glla` sidecar not writable (read-only mount, full
  disk) during the 60 s retry backoff, then a host restart / `session_start` restore. The reload
  reads the sidecar record with `retryCount` still 0 and `phase: "accepted"`, re-arms the start
  watchdog, and at timeout `armContinuationStartWatchdog` → `!record.retryCount` is true again →
  `retryContinuationDispatch` re-sends the identical payload. The durable record therefore
  understates what pi has already been sent, exactly the "RAM mutated as if the append succeeded"
  class; RAM and disk also disagree in the opposite direction (`continuation_retry_sent` is
  ledgered as sent while the sidecar says un-retried).
- Fix: check the `persistDispatchRecord` result; on failure revert the in-place mutation
  (`record.retryCount = 0` etc. — the object is frozen-by-convention, so build a spread copy and
  assign `pendingContinuationDispatch`) and fall through to `dispatchStartUnacknowledged` so the
  stand-down state is durable, matching the `dispatchPrepare` contract.
- Confidence: medium — the unchecked return and the identity aliasing are certain; the duplicate
  re-send on restore depends on the restore path re-arming the watchdog for an `accepted` record,
  which I did not trace end-to-end within the tool budget.

### F3 [SEVERITY: LOW] `observedSubagentRpcBuses` is add-only for the life of the process — every observed event bus is retained even after `releaseSubagentRpcHost` drops the binding and the paired map entry
- Where: extensions/goal-heartbeat.ts:681-692 (`observeSubagentRpcReadiness`, the `has()` early
  return proves multiple distinct bus objects are expected), extensions/goal-heartbeat.ts:737-738
  (`releaseSubagentRpcHost` deletes only `readySubagentRpcBuses`), extensions/goal-heartbeat.ts:721
  and 1838-1843 (the module's other `currentSubagentObservations` / `subagentHangProbes` clear sites)
- What breaks: `observeSubagentRpcReadiness` adds a bus and registers two `events.on(...)`
  listeners on it; the module never deletes from that Set. The sibling registry is cleaned on
  release (`readySubagentRpcBuses.delete(boundEvents)`), and the module's own reset helper clears
  `subagentHangProbes` + `currentSubagentObservations` but not this Set. Input: a long-lived pi
  process that rebinds sessions (`/new`, `newSession()` recovery, the `generation` change that
  `bindSubagentRpcHost` at 719-720 explicitly handles) — each new bus object is retained forever
  by the Set, keeping the bus, its listeners and whatever they close over alive, while the
  ready-protocol Map entry is deleted. Growth is one entry per bus, but it is the only
  session-keyed registry in this file without a clear site.
- Fix: delete from `observedSubagentRpcBuses` in `releaseSubagentRpcHost` alongside the existing
  `readySubagentRpcBuses.delete(boundEvents)` (or drop the bus from the Set when the binding is
  released), so readiness observation and readiness state have the same lifetime.
- Confidence: medium — the missing clear site is verified by exhaustive `grep -n '\.delete|\.clear'`
  over the file; the severity is capped at LOW because the per-process count is small (one entry
  per rebind, not per turn) and a leaked bus is inert once its binding is released.

## Checked and clean
- `continuationStartCompactionRearms` / `continuationStartRecoveryRearms` (goal-continuation.ts:320,335)
  are now cleared at both terminal cleanups (`clearContinuationStartWatchdog` 517-526) and by the
  destructive reset (1824-1825) — the historical unbounded-growth finding stays fixed.
- The start watchdog cannot fire after settlement: every arm callback re-checks
  `pendingContinuationDispatch !== record || record.phase !== "accepted"` (806) before any branch,
  and both `dispatchStartAcknowledged` (724) and `dispatchStartUnacknowledged` (763) settle through
  `clearContinuationStartWatchdog()`.
- Compaction and post-recovery re-arm caps fall through directly to
  `dispatchStartUnacknowledged` (820-822, 848-851) with the comment to match — no re-send is added
  after the cap (the earlier drift finding stays fixed).
- `queueStuckProbe` is generation/self-fenced: it re-checks `lastContinuationSentAt !== sentAt`,
  idle state, and pending-message consumption before notifying (goal-continuation.ts:955-967).
- `isContextStarvedLengthStop` and `decideLengthExhaustion` guard their percentage math against
  `contextWindow === 0` and non-finite percent before the `>= 90` comparison
  (length-continue.ts:99-125, 137-142) — no division by zero or NaN promotion.
- `projectCompactionPreparation` terminates its scale-descent loop on a fixed `scale > 0.01` bound
  (compaction-input.ts:791-796) and then drops whole semantic units via `selectBoundedUnits`, so
  the char budget is honored even when the per-field projection cannot reach it.
- `normalizeProviderErrorText` cycles via an object-identity `seen` set (quota-retry.ts:43,60-61)
  and caps output at 4 000 chars (91); the whole-value Retry-After numeric/date split
  (427-434) keeps the earlier date-parsing fix intact.

## BLOCKERS
- none (survey stopped at the tool budget; goal-compactor.ts, compactor-model.ts,
  context-checkpoint.ts, context-hygiene.ts and start-context.ts were mapped but not
  line-read, so no claim is made about them)
