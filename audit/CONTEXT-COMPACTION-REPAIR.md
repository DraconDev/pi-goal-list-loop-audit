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
- Runtime integration and durable restart-budget handling remain pending; passing isolated controller tests are not a claim that production is repaired.
- Host SDK source confirms the public manual `ctx.compact()` entry aborts the active operation, so calling it during healthy tool work would violate scope. Existing idle admission must be retained.

## Verification ledger

- Pre-fix `timeout 180 bun test --timeout=60000 tests/context-pressure-recovery.test.ts`: 1 pass, 2 fail. Near-limit generic-error regression observes fallback before compact-first admission; explicit-overflow with unavailable usage observes no settled compaction. The low-context generic-error control passes with ordinary fallback. Output saved locally in `/tmp/glla-context-pressure-baseline.log` (not tracked).
- Initial pressure-policy test failed for a deterministic content-policy error classified as unknown; exclusion was added. Subsequent controller/policy run `timeout 90 bun test --timeout=60000 tests/context-pressure-recovery.test.ts -t 'pressure attempt|pressure policy'`: 6 pass, 0 fail (runtime integration regressions intentionally not included in this focused component gate and still fail pre-integration).
- `timeout 120 npm run check`: passed before the controller test additions; final types gate remains required.
- No full release gate run for this objective yet. Prior reliability-goal gates are not evidence for this repair.
