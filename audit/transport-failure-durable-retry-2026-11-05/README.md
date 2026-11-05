# A dropped connection now earns the durable retry a 429 already had

**Trigger.** `Screenshot_20261105_172401.png` plus `note.md`, both raised in the
same session:

> ## timed out shoudl be retried too and connection error
> ## Error: 429 "Rate limit exceeded" — this too
> so we shoudl be agressively retrying any error
> ## Error: Request timed out.

The screenshot itself is the *paused* half of the story: it shows
`Rate limit exceeded`, `Connection error.` and `Error: Request timed out.` in the
scrollback while the status bar reads
`main model recovery: retrying openrouter/stealth/crouton-alpha (same-model retry 2/10)`
and the list item is parked `RETRY ARMED · 3/6`. Something was retrying those
errors. The question this register answers is why one of the three still parked
the work with no wake.

## Reproduced

The operator's own journal (`.pi-glla/active.jsonl`) records what the live lane
did with each string:

| Journal entry | kind | retries at the 5s eager quantum |
| --- | --- | --- |
| `Request timed out.` | `transient` | 19 |
| `Connection error.` | `unknown` | 13 |
| `terminated` | `unknown` | 3 |

So `Connection error.` *was* retried aggressively — thirteen times. The retry
lane was never the defect. The defect is that two predicates in
`extensions/main-model-recovery.ts` disagree about the same string:

```
isEagerRetryFailure(failure)        -> true    // live lane: hammer it
isRecoverableProviderError(raw)     -> false   // durable lanes: refuse it
```

`isRecoverableProviderError` is the single gate behind **every** durable path:

- `classifyCompactionFailure` (`extensions/compaction-failure.ts:71`) — a
  `false` here classifies a host compaction failure as `other-terminal` instead
  of `provider-recovery`;
- `goal-activation.ts` then parks the goal **blocked** with no model-recovery
  owner (`compaction failure: <text>`), instead of arming the durable wait;
- `persistent-provider-recovery.ts` — a recovery-owned wait whose diagnostic
  fails this gate cannot restore across a reload, so an overdue retry freezes
  as a manual pause;
- `auditorRetryPlan` (`goal-auditor-hooks.ts:895`) — the detached-auditor claim
  loses the unbounded provider envelope and caps at the conservative 24h
  horizon.

`verification/predicates.txt` is the real predicate table. The relevant rows
before the fix:

```
Error: Connection error.      kind=unknown  eager=true  recoverable=false  compaction=other-terminal
Provider returned an empty…   kind=unknown  eager=true  recoverable=false  compaction=other-terminal
Error: Request timed out.     kind=transient eager=true recoverable=true   compaction=provider-recovery
Error: 429 "Rate limit…"      kind=unknown  eager=true  recoverable=true   compaction=provider-recovery
```

`verification/compaction-park.txt` replays the real `session_compact_failed`
hook through the shipping extension. After the fix all four transport/empty
strings produce `failureKind=provider-recovery`, `pauseKind=wait` and a real
`mainModelRecovery.retryAt`; the refusals produce `other-terminal`, `blocked`,
`(none — no durable retry)`.

## Root cause: vocabulary, not policy

The classifier's transient branch was:

```ts
/overload|temporarily unavailable|service unavailable|timeout|timed? ?out|network|
 fetch failed|socket|econn|gateway|upstream|internal server/
```

Every one of those words is a *description* of a network failure. The strings
that actually arrive are the SDK's own message text, and pi's bundled clients
word them differently:

| Source | Literal message |
| --- | --- |
| `@anthropic-ai/sdk` / `openai` `APIConnectionError` | `Connection error.` |
| Bun/undici fetch | `Failed to fetch`, `fetch failed` |
| undici socket teardown | `premature close`, `other side closed`, `UND_ERR_SOCKET` |
| Node DNS | `EAI_AGAIN`, `getaddrinfo ENOTFOUND …` |
| TLS/socket close | `connection closed before message completed` |

`network` and `socket` are not substrings of any of them. So the most common
transport failure in the field — the one whose message is a bare
`Connection error.` — fell through to `unknown`, and `unknown` carries no
durable authority anywhere in the recovery stack.

The same latent hole covered the empty-response family, which
`isEagerRetryFailure` has trusted since v0.38.104 and which the auditor lane
already classifies as a provider failure. It too was refused by the durable
gate: ten 5s retries, then a park with no wake.

## Fix

Two changes in `extensions/main-model-recovery.ts`, both narrow.

```ts
// 1. named transport vocabulary (TRANSPORT_FAILURE), used where the old ad-hoc
//    alternation lived. The previously-matched words are all retained.
connection (?:error|reset|refused|closed|lost|aborted|dropped|failure|terminated)
| connection was (?:reset|refused|closed|lost|aborted|dropped)
| (?:error|reset|refused|closed|lost|dropped) (?:the )?connection
| failed to connect | unable to connect | could not connect
| failed to fetch | premature close | other side closed | und_err_socket
| econn\w* | epipe | eai_again | getaddrinfo | enotfound
| stream (?:ended|closed) (?:without|before|prematurely)

// 2. the durable gate accepts the empty-response family too
export function isRecoverableProviderError(raw) {
  ...
  return failure.kind !== 'non-recoverable' && failure.kind !== 'context-overflow'
    && !isDeterministicProviderError(raw)
    && (quotaSignal(raw) !== undefined
      || ['rate-limit', 'quota', 'billing', 'auth', 'transient'].includes(failure.kind)
      || isEmptyProviderResponse(raw));       // <- agreement with isEagerRetryFailure
}
```

### Why not simply fail open on `unknown`

That is the tempting one-line fix and it is wrong. `isRecoverableProviderError`
gaining `unknown` would hand durable retry authority to
`auditor produced no verdict marker`, `auditor worker exited without an atomic
result` and `worker exited without an output` — three strings that
`tests/rework-round-scope.test.ts` pins to the **no-verdict** branch, whose
whole point is that a dead worker is not a provider blip. Failing open would
convert that branch into an aggressive re-audit loop, and the same widening
would let arbitrary tool output ("expected an empty array, got 3 items") arm
provider retries. The correct seam is the classifier's vocabulary: name the
transport failures exactly, leave unclassified prose unclassified.

The refusal list is pinned as a regression, not left implicit:
`connection pool exhausted (style guide note)` stays prose, `Error: kablam`
stays `unknown`, and aborts/context/deterministic errors keep their own
owners.

## Verification

`tests/transport-failure-durable-retry.test.ts` (6 cases) pins the agreement
between the two predicates rather than the wording of either regex — the
property is "any failure the live lane hammers is a failure the durable lanes
wait on", so a future rewrite of the pattern cannot silently re-split them.

- 21 transport strings classify `transient`, read eager, and reach
  `provider-recovery` in the compaction classifier.
- the empty-response family agrees the same way.
- the refusal set is unchanged (no-verdict workers, aborts, context overflow,
  deterministic 400s, ordinary prose).
- the real `session_compact_failed` hook produces `pauseKind: wait` with a
  durable `retryAt` for `Connection error.` and `Request timed out.` (previously
  `blocked` with no recovery), and the pause/recovery due times agree.
- `auditorRetryPlan` keeps the persistent envelope (not the 24h horizon) for a
  transport diagnostic and for an empty response.

Full fast suite: see `verification/full-suite.txt`.

```
npm run check                                   # tsc --noEmit, clean
npm test -- tests/transport-failure-durable-retry.test.ts \
            tests/main-model-recovery.test.ts \
            tests/transient-retry-cadence.test.ts \
            tests/empty-provider-response.test.ts \
            tests/compaction-failure.test.ts \
            tests/persistent-provider-recovery.test.ts \
            tests/rework-round-scope.test.ts \
            tests/retry-bounds.test.ts \
            tests/unsupervised-error-retry.test.ts \
            tests/model-selector.test.ts \
            tests/quota-retry.test.ts \
            tests/auditor-fallback-unification.test.ts \
            tests/auditor-polish.test.ts \
            tests/quota-wall-engagement.test.ts \
            tests/same-model-retry-window.test.ts \
            tests/same-model-retry-before-fallback.test.ts \
            tests/hintless-token-plan-retry.test.ts \
            tests/quota-sleep-until-reset.test.ts
```

## What did NOT change

- `isEagerRetryFailure` and the 5s eager window are untouched. The live lane
  already did the right thing; this fix extends that verdict to the durable
  lanes instead of inventing a new cadence.
- The durable cadence is unchanged: an empty/transport failure still lands on
  the eager-then-short-ladder path (`TRANSIENT_EAGER_ATTEMPTS` × 5s, then a 1m
  base doubling to a 30m cap). No new sleep, no new horizon.
- Quota walls keep their five-minute steady cadence and explicit upstream reset
  hints keep outranking eager retry.
- No new setting. The operator's request ("aggressively retry any error") was
  already the configured policy; the bug was that one failure family never
  reached it.
