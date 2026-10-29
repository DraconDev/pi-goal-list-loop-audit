# Persistent quota recovery — incident trace and verification register

## Scope and acceptance

GLLA only. AI Chat Toolkit and ai-auto-writer are read-only evidence sources; no goals, contracts, project code or credentials in either project are changed. Objective-confirmation rendering and release publication are excluded.

The confirmed policy is prompt selection of configured permitted fallback models, followed by persistent five-minute recovery when all candidates are unavailable, without an attempt-count cutoff. Recovery-owned holds must remain recoverable across reload without overriding genuine user/supervisor pauses, decisions, missing-input blockers, unrelated cold-load holds, cancellation or foreign ownership. Verification must use fake providers/controlled time, not paid live requests.

## Observed incidents

Screenshots inspected natively:
- `/home/dracon/Pictures/Screenshots/Screenshot_20261029_111812.png`: AI Chat Toolkit shows repeated MiniMax 429 plan-quota responses and `Retry failed after 15 attempts`, while GLLA reports a restore hold. The screenshot alone does not establish who originally created the hold.
- `/home/dracon/Pictures/Screenshots/Screenshot_20261029_112120.png`: ai-auto-writer shows the same repeated quota errors and final retry exhaustion, a paused goal with provider-error presentation, and a configured Codex fallback. The current paused state is not evidence of an intentional user pause.

Read-only journal observations from each project's `.pi-glla/active.jsonl`:

| Project | Observed transition | Consequence |
| --- | --- | --- |
| ai-auto-writer | At 2026-10-28T16:53:50.000Z `model_fallback_select` selected `openai-codex/gpt-6-luna` from MiniMax. At 16:53:53.044Z recovery recorded Codex usage-limit failure. | Contrary to an initial screenshot-only impression, a configured fallback was actually attempted. |
| ai-auto-writer | At 16:53:59.810Z `session_compact_failed` recorded `Auto-compaction failed: Summarization failed: Codex error: The usage limit has been reached`, `failureKind: other-terminal`, `willRetry: false`. The following durable goal was `paused`, `pauseKind: blocked`, `pauseSource: system`, with `pauseReason: compaction failure: ...`; `mainModelRecovery` still existed. | At 16:54:00.840Z automatic error recovery refused work as `goal-blocked-paused`. Later repeated refusals persisted. |
| AI Chat Toolkit | At 2026-10-29T00:00:17.893Z the same Codex summarization usage-limit error was classified `other-terminal` with `willRetry: false`. The following durable state had the same system-owned blocked compaction-failure pause and still retained main-model recovery. | Later observations show `supervisor-paused` retry refusals. The subsequent restore hold must be distinguished from the original quota-induced compaction block. |

Both projects have repeated compaction-failure events, so duplicate-event handling is a required lifecycle test, not permission to dispatch multiple recoveries.

## Initial ownership finding

`extensions/compaction-failure.ts` falls through to `other-terminal` for provider quota failures. `extensions/loops/goal-activation.ts` handles terminal host compaction failure by parking an active goal as blocked; only context overflow enters its model-recovery path. That GLLA-owned transition explains how a recoverable provider failure becomes a block that later recovery refuses. Pi/provider quota availability and the host's internal 15-attempt retry output are external observations, not repair targets.

Current main-model orchestration already retires legacy elapsed recovery windows in `withMainModelRecoveryWindow`; therefore increasing a retry count alone cannot resolve the observed compaction-to-blocked transition. Existing shared helpers also include long reset sleeps and older retry/backoff policy that must be reconciled with the newly confirmed five-minute persistent policy at the appropriate recovery ownership boundary.

## Verification status

Investigation in progress. No implementation or gate result is claimed by this register yet. Exact historical provider availability is not established by journal error messages; returning availability will be tested with controlled fake providers.
