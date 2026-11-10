# The audit that never completes

**Trigger.** Operator report: "if the model runs out then the audit never
completes, so we would need to be checking for very long not progressing
cases."

The screenshot that came with it:

```
Warning: Auditor still failing — next auto-retry in 5m (your completion claim
         is stored; it retries automatically …)
Auditor provider retry is due — starting a detached retry with your stored
         completion claim (no agent turn needed).
…
list item · paused by GLLA · EXECUTION UNCONFIRMED · age 4h 24m
  next: /glla status to inspect execution
```

The plan quota was gone for good, and the audit had been re-arming a five
minute timer ever since.

Shipped in **v0.39.69**.

## What was actually wrong — three separate defects

### 1. The audit lane ignored the provider's quoted reset

The main lane has honoured a provider's own deadline since v0.38.69:
`quotaResetSleepMs` turns `resets <ISO>` into a sleep, bounded by the shared
per-attempt envelope, so a "retry in 1 week" wall sleeps the envelope and
re-evaluates instead of parking blind.

The audit lane never asked. `auditorRetryPlan` computed

```js
const requestedSec = persistentProvider ? PERSISTENT_PROVIDER_RETRY_MS / 1000 : …
```

so every provider wall — five-minute quota or weekly plan reset — re-armed
**300 s**, twelve times an hour, for the whole outage. Measured before the fix:

| wall | main lane | audit lane |
| --- | --- | --- |
| `resets <ISO>` 5 h away | sleeps 5.00 h | **300 s** |
| `resets <ISO>` 6 days away | sleeps 5.00 h, re-evaluates | **300 s** |
| attempt 1 / 6 / 36 / 501 | — | 300 s, `unbounded`, at every attempt |

The operator's read was exact: "we are never waiting for weekly reset".

### 2. There was no no-progress stop at all

`unbounded: true` held at attempt 501. A wall that names no reset time retried
forever and never asked the operator anything — the card could only ever say
"still failing".

### 3. The five-minute retry re-walked the burned cursor

`beginCompletionAudit` reseeded the candidate chain only for
`manual | agent | session-recovery`. The `provider-retry` origin — the five
minute timer — took `claimForAttempt = claim`, i.e. the burned cursor, so the
model that was out of quota (or retired) was retried *by name* every five
minutes even when a configured fallback existed. That is the operator's third
point: "if we have a fallback model we should be using that too."

The walker itself already falls back correctly inside one run (a quota wall is
an `isAuditorAccountFailure`, so it advances and skips same-provider rungs).
The gap was that the next run started from the dead chain again.

## The fix

- **Wait for a quoted reset.** `auditorRetryPlan` takes the reset wait from
  `auditResetWaitMs` and treats an explicit reset as exempt from
  `AUDITOR_RETRY_WAIT_CAP_SEC` — undercutting the provider's own deadline is
  exactly the churn being fixed. The wait is still bounded by the shared
  per-attempt envelope, so "next week" sleeps the envelope and re-evaluates.
- **Stop when it stops progressing.** A new durable claim stamp,
  `auditorNoProgressSince`, records when the current no-verdict episode began.
  It is written once per episode and survives every later attempt **and** every
  cursor reseed, because it measures the audit rather than the candidate.
  `auditNoProgressEscalation` then decides:

  | situation | behaviour | why |
  | --- | --- | --- |
  | provider quoted a reset | keep waiting, no escalation | the wait is scheduled, not stalled |
  | no reset hint, episode < 6 h | keep retrying | a five-hour plan quota can legitimately swallow a whole audit |
  | no reset hint, episode ≥ 6 h | decision card: pick another auditor model / fresh bounded window / cancel | a quota exhausted for good or a retired model is a person's problem |
  | model does not resolve, ≥ 30 min | decision card, `dead-model` | waiting cannot produce a model the provider no longer serves |

  The gate sits in `retryStoredCompletionAudit`, the single dispatch entry, so
  every automatic origin (timer, hourly backstop, session recovery,
  main-model recovery) is covered while manual/agent resume always dispatches.
  The escalation is journaled as `audit_no_progress_escalated`.
- **Use the fallback.** `provider-retry` now takes a cursor-only reseed
  (`reseededAuditorCursorClaim`): candidate lists, the attempt cursor, the
  identical-failure streak and the exhausted flag are cleared so candidates are
  re-resolved and a newly configured fallback is used; the episode stamp, the
  attempt count and the provider diagnostic survive so the reset wait and the
  no-progress bound keep their clocks. **Evicted refs stay evicted** — a ref
  proven unresolvable must not return just because the cursor was reseeded.

## Evidence

Before/after on the same claim (`auditorRetryPlan` owns the cadence):

| wall | before | after |
| --- | --- | --- |
| `resets <ISO>` 5 h away | 300 s, no reset named | 5.00 h, `resetAt` named |
| `resets <ISO>` 6 days away | 300 s | per-attempt envelope, `resetAt` named |
| bare quota (no hint) | 300 s forever | 300 s, then escalate at 6 h |
| retired model | 300 s forever | escalate at 30 min |

Regression coverage (`tests/audit-no-progress.test.ts`, 6 tests) pins the wait,
the escalation bounds, the episode-stamp survival and the wiring. The
pre-existing suites that own the retry plan, the schema and the parked-claim
path pass unchanged:

```text
bun test tests/audit-no-progress.test.ts         →  6 pass / 0 fail (new)
bun test tests/auditor-lane.test.ts              →  8 pass / 0 fail
bun test tests/auditor-park-recovery.test.ts     →  3 pass / 0 fail
bun test tests/auditor-eager-retry.test.ts + 6 more → 74 pass / 0 fail
bun test tests/goal-schema-parity.test.ts + 4 more  → 187 pass / 0 fail
tsc --noEmit                                     → clean
```

## Not changed

- Manual/agent resume always dispatches: the escalation governs automation, not
  an explicit decision.
- A quoted reset is never overridden by the no-progress bound.
- Eviction is still proof, not cycle state.
