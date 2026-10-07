# Context compaction and recovery repair — 2026-10-07

Status: investigation started; no repair or verification gate claimed yet.

## Scope

GLLA-owned compaction admission and recovery ordering only. Keep the configured 200k threshold opportunistic, preserve healthy in-flight tools, and attempt one bounded compact-first recovery for explicit overflow or measured near-limit provider errors before fallback. Ordinary low-context provider errors retain the normal fallback ladder. No upstream edits or release publication.

## Incident evidence

Source: local session `2026-10-07T08-36-44-398Z_01a11582-02ed-70eb-b0fc-8504732b2679.jsonl`, `.pi-glla/active.jsonl`, and screenshot `Screenshot_20261007_151302.png` (runtime files and image are not copied into git).

- 14:03:48 UTC: context sample 232819 tokens / 272000 (85.595%). Codex returned a generic provider error, classified by GLLA as `unknown`; `main_model_failover` switched to MiniMax. This is not proof of explicit context overflow.
- 14:12:45 UTC: manual selection restored the primary Codex model.
- 14:12:48 UTC: `compaction_input_projection` and `compaction_inflight_start` recorded an actual compaction. The screenshot shows auto-compaction active and context at 101.2% of 272k.
- 14:13:28 UTC: `session_compact` recorded successful compaction.
- 14:16:26 UTC: context sample 55829 tokens / 272000 (20.525%). Another generic Codex provider error triggered fallback to MiniMax. This low-context failure must not be misrepresented as overflow or forced into compact-first recovery.

## Initial code trace

- `goal-compactor.ts:maybeCompactTranscriptAtBoundary` admits compaction only when supervising, not paused/auditing, idle, with no pending messages, known usage and a satisfied token threshold. Its durable episode marker suppresses repeated attempts.
- `loops/goal-activation.ts` checks preventive compaction on `agent_end` and `agent_settled`; settled checks are skipped while main-model recovery is active. Exact runtime event ordering and admission reasons require regression evidence before attributing the missed opportunity.
- `goal-recovery.ts:recoverFromContextOverflow` currently observes a compaction failure and rotates through `tryMainModelFallback`; caller-specific compact-first ownership must be traced to avoid double compaction or changing established failed-compaction fallback.

## Confirmed recovery-ordering defect

`loops/goal-orchestrator.ts:handleMainModelAgentEnd` calls `tryMainModelFallback` immediately for a recoverable error, before the preventive compaction checks later in `agent_end`. Once recovery is active, the `agent_settled` preventive check is skipped. Thus an error can both rotate the primary and exclude the subsequent safe compaction opportunity. This is a GLLA-owned ordering defect, not proof that the provider error itself was overflow.

## Implementation in progress

- `context-pressure-recovery.ts` separates explicit input-overflow evidence from broad legacy output/context regexes, and uses a 90% relative window threshold for generic unknown/transient errors. The 232819-token incident sample is above the preventive 200k target but below emergency pressure; it must be addressed by missed preventive admission, not mislabeled as overflow. Auth, cancellation and prompt-policy errors remain excluded.
- `context-pressure-attempt.ts` implements owner-bound queued/compacting/spent states. Only safe idle admission launches compaction; an existing host compaction is adopted. Event/callback failure contacts coalesce to one fallback, stale ownership suppresses callback effects, and compact success cannot reset the one-attempt budget. A bounded timeout delegates durable parking to the runtime owner before cancelling a wedged compactor.
- Runtime integration now intercepts recoverable main-model errors before fallback. Both measured emergency pressure and a due preventive target on generic unknown/transient errors claim compact-first ownership; the latter addresses the 232819-token missed opportunity without classifying it as overflow. Only the failed request is aborted to suppress host retries; `agent_settled` admits real compaction at idle. Success reuses existing session_compact resume debt, while terminal failure falls through to the established fallback selector with the original failure classification.
- Goal/list and loop scheduling plus already-armed timer dispatch now yield to pending pressure recovery. Host compaction outcomes settle the same owner-bound attempt; manual input and shutdown invalidate live callbacks.
- A per-work-target budget in `.pi-glla/context-pressure-budget.json` prevents an error retry/reload from repeatedly compacting. It is consumed before the host boundary and reset only by healthy work/new input, not successful compaction itself. Runtime journals/budget remain machine-local, not tracked.
- The 120s deadline now covers both queued idle admission and active compaction. Expired queued admission parks without aborting healthy work; a wedged active compactor is cancelled only after durable parking. A generation/owner-bound 50ms idle admission probe supports hosts that omit agent_settled; it is retired on launch, cancellation or expiry. Host session_before_compact adopts an already-running compaction, including willRetry ownership, without another manual launch.
- Pressure and preventive paths now share the consumed budget, preventing failed pressure recovery from entering a second optional compaction. A success callback alone cannot release dispatch: session_compact is authoritative for resume debt.
- Behavioral coverage now includes goal/list/loop safe idle admission, the configured threshold below/at 200k during healthy busy work, duplicate event/callback failures, queued/active expiry, unavailable/throwing compaction, manual input/pause/shutdown, real successor-session callbacks, tool artifact/loadout preservation, unknown usage, and a failed post-compaction retry. No completion claim yet.
- Host SDK source confirms the public manual `ctx.compact()` entry aborts the active operation, so calling it during healthy tool work would violate scope. Existing idle admission must be retained.
- Independent review found two P1 blockers: (1) preventive admission could still bypass policy exclusions above 200k; (2) timeout parking could release dispatch when durable storage failed. Shared `compactFirstEligible` predicate and owner-scoped `pressureExcluded` now gate both preventive and emergency paths; the runtime timeout enters a `held` phase first and only transitions to `spent` after parking succeeds, retaining process-local stand-down with operator notification on persistence failure.
- The idle admission probe now catches captured-context exceptions, and a successor-session regression asserts that late predecessor callbacks cannot dispatch against a fresh owner.

## Verification ledger

- Pre-fix `timeout 180 bun test --timeout=60000 tests/context-pressure-recovery.test.ts`: 1 pass, 2 fail. Near-limit generic-error regression observes fallback before compact-first admission; explicit-overflow with unavailable usage observes no settled compaction. The low-context generic-error control passes with ordinary fallback. Output saved locally in `/tmp/glla-context-pressure-baseline.log` (not tracked).
- Initial pressure-policy test failed for a deterministic content-policy error classified as unknown; exclusion was added. Subsequent controller/policy run `timeout 90 bun test --timeout=60000 tests/context-pressure-recovery.test.ts -t 'pressure attempt|pressure policy'`: 6 pass, 0 fail (runtime integration regressions intentionally not included in this focused component gate and still fail pre-integration).
- `timeout 120 npm run check`: passed before the controller test additions; final types gate remains required.
- First integration types gate failed on a missing supervisorPaused import and overly broad controller context type requiring mock UI capabilities. Corrected with the existing import and a narrow capability type; subsequent `timeout 120 npm run check` passed.
- `timeout 180 bun test --timeout=60000 tests/context-pressure-recovery.test.ts`: 9 pass, 0 fail after initial integration. This includes both previously failing runtime regressions and the low-context fallback control.
- `timeout 180 bun test --parallel=1 --max-concurrency=1 --timeout=60000 tests/context-pressure-recovery.test.ts tests/compaction-settled-boundary.test.ts tests/compaction-failed-recovery.test.ts tests/main-model-recovery.test.ts`: 42 pass, 0 fail. Existing preventive holds, optional failure behavior, host-retry ownership and ordered fallback tests remain passing.
- Expanded fault-injection run initially failed 3 cases: both failure-order variants exposed a second preventive compaction; manual-input fixture sent message_end without the message_start lifecycle contact GLLA uses. Shared budget suppression repaired the real duplicate-compaction defect; the fixture now sends both real lifecycle contacts. Subsequent fault run: 19 pass, 0 fail. Later coverage increased to 26 passing tests, then 29 with missing usage and opportunistic threshold controls.
- `timeout 180 bun test --parallel=1 --max-concurrency=1 --timeout=60000 tests/context-pressure-recovery.test.ts tests/compaction-settled-boundary.test.ts tests/compaction-failed-recovery.test.ts tests/main-model-recovery.test.ts tests/between-tasks-compaction.test.ts`: 75 pass, 0 fail across 5 files.
- `timeout 120 npm run check`: passed after runtime/controller integration.
- After review fixes: `timeout 180 bun test --timeout=60000 tests/context-pressure-recovery.test.ts` returned 37 pass, 0 fail then 38 pass, 0 fail after the pending-tool artifact regression. Output: `/tmp/glla-pressure-review-fixes2.log`, `/tmp/glla-context-final-focused.log`.
- Final-tree release gate `timeout 1200 npm run release:check`: clean tsc, `Ran 3372 tests across 355 files`, `3371 pass / 0 fail` (one pre-existing skip), pack dry-run + launcher RPC probe + import path OK. Log: `/tmp/glla-context-final-release.log`. Inventory regenerated; new version `0.39.15`. Prior reliability-goal gates are not evidence for this repair.
