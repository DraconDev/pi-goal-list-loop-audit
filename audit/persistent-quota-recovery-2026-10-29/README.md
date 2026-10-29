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

In the pre-fix path, `extensions/compaction-failure.ts` fell through to `other-terminal` for provider quota failures. `extensions/loops/goal-activation.ts` parked an active goal as blocked on that terminal host compaction attempt; only context overflow entered its model-recovery path. That GLLA-owned transition explains how a recoverable provider failure becomes a block that later recovery refuses. Pi/provider quota availability and the host's internal 15-attempt retry output are external observations, not repair targets.

Current main-model orchestration already retires legacy elapsed recovery windows in `withMainModelRecoveryWindow`; therefore increasing a retry count alone cannot resolve the observed compaction-to-blocked transition. Existing shared helpers also include long reset sleeps and older retry/backoff policy that must be reconciled with the newly confirmed five-minute persistent policy at the appropriate recovery ownership boundary.

## Implemented recovery boundaries

- Positive provider-outage evidence now routes host compaction failures into the existing durable model-recovery owner. Host retries, aborts, extension-owned attempts, output truncation and actual prompt overflow retain their separate ownership/remedies. Duplicate events do not renew the episode or its due time.
- Untried configured permitted main-model alternatives bypass the old same-model retry budget for positive provider failures. When no alternative remains, the persisted due time is five minutes; that due time, not a caller's old eager delay, owns timer scheduling. Ambiguous local failures retain their separately configured retry policy.
- Provider auditor failures advance through permitted alternatives without sleeping inside the detached walker. Existing same-backend skipping and mandatory session-model fallback remain intact. Failure-to-persist cursor transitions still prevents launch.
- Auditor provider retries remain automatic beyond old attempt/elapsed windows in both normal and aggressive modes. Legacy expiry metadata no longer rejects a provider retry at dispatch. Non-provider worker failures retain their distinct conservative policy; disapproval is still a verdict, not a quota retry.
- `extensions/persistent-provider-recovery.ts` recognizes only a matching recovery-owned system wait. Reload keeps its future due time or admits one overdue attempt. Supervisor/user pauses, decisions, missing-input blocks, unrelated load holds, cancellation and replaced targets gain no retry authority.
- A historical system-attributed `compaction failure:` hold migrates only with matching durable main-model ownership and positive provider evidence. A user-attributed lookalike remains held. This is implementation behavior for a future owning-session restore, not a mutation of either source project during this task.
- A new restore regression test exposed an additional race: startup stage 9 could launch an overdue audit, then stage 12 demoted that same-generation worker as an interrupted old attempt. The later stage now excludes an already in-flight audit.

## Verification progress

`tests/persistent-provider-recovery.test.ts` passes with twenty behavioral cases at this checkpoint: host ownership precedence, quota classification, durable five-minute wait, duplicate-event coalescing, cold restore, strict legacy migration, hold/identity safety, both auditor stored-claim phases with future and overdue due times, and retries beyond legacy expiry/attempt thresholds. All fixtures are synthetic; inert subprocesses and configured fake models make no paid provider requests.

`controls.py` reproduces isolated baseline/rewording/regression controls in disposable copies including the required Bun preload. `verification/controls.json` records baseline and harmless notification rewording exiting 0, and quota-to-terminal-compaction plus expired-audit-dispatch regressions exiting nonzero. Raw outputs are retained beside that JSON. The first regression fails durable wait-state assertions; the second prevents the overdue stored claim from launching.

An early independent read-only reviewer found no concrete correctness defects in the inspected source. It did not execute tests, so its report is supporting source review, not a runtime receipt. Typecheck and regenerated inventory checks have passed. Full release verification and final rehearsal remain outstanding; no completion claim is made here.

Exact historical provider availability is not established by journal error messages. Returning availability is exercised through controlled fake-provider/model outcomes, not assumed from account quota or from a source project's paused display.
