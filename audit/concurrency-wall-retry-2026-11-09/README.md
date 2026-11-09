# A concurrency wall that arrives as HTTP 400, and "in fact all errors"

**Trigger.** Operator report with the raw failure text:

```
Error: 400: {"code":"tier_limit_exceeded","message":"[code=tier_limit_exceeded]
membership concurrency limit exceeded: 11/10 resets 2026-11-09T15:27:00Z",
"type":"tier_limit_exceeded"}
```

> "such error too we should be retrying, in fact all errors"

Shipped in **v0.39.67**.

## What the string actually is

Not a client error. The account is allowed 10 simultaneous requests and an 11th
was attempted, so the wall lifts as soon as any in-flight request finishes. The
provider quotes `resets 2026-11-09T15:27:00Z`, which is the guarantee — not the
expected wait.

Two properties made it dangerous to classify:

- **`400`** — the deterministic-client-error bucket (`BadRequestError`,
  `invalid_request_error`, `"code":"400"`) is never retried, because an identical
  retry cannot succeed. A wall that merely *arrives* as 400 looks identical to
  that bucket until the body is read.
- **`limit exceeded`** — the plan-quota vocabulary already matched this phrase,
  so the string sat one provider rewording (`tier_limit`) away from falling into
  `unknown`.

## What was broken

### 1. The provider's deadline was discarded

`parseQuotaError` understood `resets at <date>` and `available at <date>`. This
provider writes **`resets <ISO>`** with no preposition, so the explicit instant
fell through to the flat 3600 s default:

```
before: {"retryAfterSec":3600,"fromUpstream":false,"signal":"plan-quota"}
after:  {"retryAfterSec":8820,"fromUpstream":true,"resetAt":"2026-11-09T15:27:00.000Z"}
```

Any downstream `quotaResetSleepMs` therefore had no hint to honour.

### 2. No dedicated vocabulary for an admission limit

`CONCURRENCY_WALL` / `isConcurrencyWall` now name it — `tier_limit_exceeded`,
`concurrency limit`, `concurrent requests`, `too many parallel/in-flight`,
`in-flight request limit` — and `quotaSignal` maps it into the quota family before
the plan-quota branch, so it can never reach `unknown` or the deterministic
bucket.

### 3. The timing policy would have been wrong in the other direction

Once the reset parsed, the shared policy would have slept until `15:27Z` — hours
of idling a healthy rig behind a limit that clears in seconds. A concurrency wall
is therefore the one wall where the quoted reset is an **upper bound**:
`isEagerRetryFailure` and `mainModelFailureDelayMs` probe at the 5 s eager quantum
and then the minutes ladder, never the reset. A non-concurrency quota wall still
sleeps to its reset, unchanged (pinned).

### 4. "In fact all errors" — the durable gate disagreed with the live lane

The live lane has failed open to `unknown` since v0.38.104: ten eager attempts at
5 s, then a minutes ladder. `isRecoverableProviderError` — the single gate behind
compaction classification, parked-claim restore and the auditor retry plan —
accepted only positive families. The same string could be hammered in the live
lane and still park work as if it were terminal. That is precisely the
v0.39.63 rule ("a failure the live lane is willing to hammer is a failure the
durable lanes must be willing to wait on"), so `unknown` is admitted.

**Not** "no exceptions". Refused and pinned: user aborts, prompt-policy refusals,
context overflow, deterministic client errors (the 12-images-vs-4-cap case), and
auditor no-verdict prose (which has its own retry plan and would otherwise be
replaced by main-model recovery).

## The two-predicate split that keeps this honest

Widening the durable gate created four regressions in the gate run, and each one
had the same shape: a caller was using "is retryable" as a proxy for "is a
recognized provider wall". Those callers now use
`hasPositiveProviderEvidence` — the strict predicate — while the durable lanes use
the widened one:

| Caller | Predicate | Why |
| --- | --- | --- |
| `classifyCompactionFailure` | strict | a compaction failure is host-owned; unclassified text must stay terminal, so `provider returned 503` still parks there |
| auditor fallback fast-advance | strict | decides whether a same-ref retry is worth it; the `provider` bucket is the default for unrecognized text, so an ambiguous worker death must still get its retry |
| `completionAuditParkAction` / card cause | strict | otherwise "the auditor produced nothing" would be relabelled "the provider failed" — the false diagnosis that module exists to remove |
| `scheduleHourlyProbe` backstop | strict | a recognized wall already has the five-minute ladder; arming the `:00:30` ticker too would queue-jump the same claim |
| `isRecoverableProviderError` (durable lanes) | widened | every provider failure keeps retry authority ("in fact all errors") |

## Evidence

Full release gate on the shipped tree (Bun 1.3.14 on `PATH`; this host's system
Bun is 1.3.3 and the runner requires ≥ 1.3.14):

```text
npm run release:check → exit 0
  run-tests --all      → 4643 pass / 1 skip / 0 fail across 491 files (2763 s)
  tsc --noEmit         → clean
  repro-jiti-state-split + verify-auditor-extensions-offline → pass
  check:inventory      → exit 0
  check:names          → clean (153 new lines vs 14 watched names)
  npm pack --dry-run + release-pack-smoke → OK (packed launcher RPC probe,
                                              packed skill load, installed-import)
```

A first gate attempt on this host failed on **five wall-clock timeouts**
(`test-runner-lifecycle` ×3 at 23–35 s, `recap-preservation` at 93 s,
`impossible-list-drop` at 75 s) with load average 85 on 16 cores. Each failing
file was then run alone: 13/1/7 tests pass, so those were contention budgets, not
regressions. The second run — same tree, load ≈ 42 — is the green one above. Worth
recording because a timeout-shaped failure is exactly what a real stall looks
like; the distinguishing move is running the file alone on an idle-ish host.

Targeted coverage for this change:

```text
bun test tests/concurrency-wall-retry.test.ts      →  8 pass / 0 fail (new)
bun test tests/quota-retry.test.ts                 → 26 pass / 0 fail
bun test tests/transport-failure-durable-retry.test.ts →  6 pass / 0 fail
bun test tests/compaction-failure.test.ts          →  4 pass / 0 fail
bun test tests/hourly-quota-probe.test.ts          → 17 pass / 0 fail
bun test tests/auditor-fallback-unification.test.ts → 37 pass / 0 fail
bun test tests/behavioral-orchestrator.test.ts     → 159 pass / 0 fail
bun test tests/completion-audit-park.test.ts       →  8 pass / 0 fail
```

## Not changed

- Deterministic client errors are still never retried: an identical request that
  cannot succeed must change, not repeat.
- A spent plan quota still sleeps to its reset. Only the *concurrency* class
  probes eagerly.
- The auditor's `:00:30` backstop keeps its original scope (failures no ladder
  owns), and starts honouring the strict predicate rather than the widened gate.
