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
- Untried configured permitted main-model alternatives bypass the old same-model retry budget for a positive **quota-class** wall (rate-limit / plan-quota). When no alternative remains that class retries on a five-minute cadence; the persisted due time, not a caller's old eager delay, owns timer scheduling. Billing, auth and transient failures keep the operator's separately configured paced ladder — a 503 blip must not spend backup quota, and an account wall is not a quota wall.
- Provider auditor failures advance through permitted alternatives without sleeping inside the detached walker. Existing same-backend skipping and mandatory session-model fallback remain intact. Failure-to-persist cursor transitions still prevents launch.
- Auditor provider retries remain automatic beyond old attempt/elapsed windows in both normal and aggressive modes. Legacy expiry metadata no longer rejects a provider retry at dispatch. Non-provider worker failures retain their distinct conservative policy; disapproval is still a verdict, not a quota retry.
- `extensions/persistent-provider-recovery.ts` recognizes only a matching recovery-owned system wait. Reload keeps its future due time or admits one overdue attempt. Supervisor/user pauses, decisions, missing-input blocks, unrelated load holds, cancellation and replaced targets gain no retry authority.
- The cold-load consent hold stays authoritative for LIVE work: a reload never silently arms a main-model recovery timer the operator did not approve. A parked stored completion claim is the one exception, because its next step is a durable pending audit rather than a live turn; without that exception the hold silently converted an auditor retry wait into a "held for your decision" state.
- A historical system-attributed `compaction failure:` hold migrates only with matching durable main-model ownership and positive provider evidence. A user-attributed lookalike remains held. This is implementation behavior for a future owning-session restore, not a mutation of either source project during this task.
- A new restore regression test exposed an additional race: startup stage 9 could launch an overdue audit, then stage 12 demoted that same-generation worker as an interrupted old attempt. The later stage now excludes an already in-flight audit.
- The hourly `:00:30` ticker stays off for a quota-class wait. It is a backstop for legacy non-provider retries; letting it also fire would queue-jump the durable five-minute schedule with a second timer for the same claim.

## Verification progress

`npm run release:check` exits 0: 4459 passing tests across 475 files, plus the pack smoke steps (packed launcher RPC probe, `glla-delegate` skill load, installed import from the packed tarball). `npm run check` and `npm run check:inventory` both exit 0. The full command output is retained at `verification/release-check.log`, which shows the real gate chain (`test:all` → `check:inventory` → `npm pack --dry-run` → pack smoke) rather than a subset run.

That full gate is what produced this register's most important finding. An earlier checkpoint had `tests/persistent-provider-recovery.test.ts` green, but running the whole suite exposed six failures caused by over-broadening the fix rather than by stale pins: the five-minute cadence and the same-model bypass had leaked from the quota class onto billing/auth/503 failures and onto the unsupervised first-blip retry, overriding separately configured operator policy. The cold-load consent hold had also been weakened. Narrowing the source to `isQuotaHorizonExempt` plus a claim-only parked-claim exemption restored all six suites. A partial green is not evidence; only the full gate established this.

`tests/persistent-provider-recovery.test.ts` covers host ownership precedence, quota classification, the durable five-minute wait, duplicate-event coalescing, cold restore, strict legacy migration, hold/identity safety, both auditor stored-claim phases with future and overdue due times, consent resuming the same saved wait, retries beyond legacy expiry/attempt thresholds, eventual continuation (a quota wall that clears clears the episode and the parked work does not stay stranded), and the legacy migration's cadence for quota vs billing vs transient walls (26 cases). All fixtures are synthetic; inert subprocesses and configured fake models make no paid provider requests.

`controls.py` reproduces six isolated controls in disposable copies including the required Bun preload. `verification/controls.json` records baseline and harmless notification rewording exiting 0, and four regressions exiting nonzero: restoring quota-to-terminal-compaction behavior, reinstating the expired-audit dispatch gate, re-broadening the five-minute cadence onto billing/auth failures, and forcing that same cadence onto a non-quota wall in the legacy migration. The third guards this register's own earlier mistake; the fourth guards a defect the rehearsal reviewer found after the narrowing. Raw outputs are retained beside that JSON.

A rehearsal reviewer then audited the narrowed source against these claims. It confirmed claims 1–5 at source level (it executed no tests, and its own scope tooling could not resolve a diff, so its verdicts are source review, not runtime receipts) and raised one real defect: the one-time `restoreLegacyProviderCompactionWait` migration still derived its delay from `isRecoverableProviderError`, so a migrated billing/auth/transient hold inherited the quota cadence the live path deliberately withholds. That path now derives its delay through the same quota predicate and ladder as `setMainModelRecoveryPause`, and the `legacy-migration-cadence-regression` control proves the difference is load-bearing (it fails with `a non-quota failure does not inherit the five-minute quota cadence: 300002ms`).

Two further reviewer notes are recorded as accepted limitations rather than defects. The auditor provider lane treats a billing wall as an unbounded provider retry, unlike the main lane which parks billing; that is consistent with auditor provider policy as scoped, and changing it is out of scope here. `ownsParkedProviderClaim` infers authorship from `pauseSource`, which `updateGoal` defaults to `system`; no current pause site is affected, but a future site parking a claim without naming its source would need the stricter marker. The reviewer found no claim whose only evidence is source-string matching.

Exact historical provider availability is not established by journal error messages. Returning availability is exercised through controlled fake-provider/model outcomes, not assumed from account quota or from a source project's paused display.
