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

## Verification ledger

No implementation tests or full release gate run for this objective yet. Prior reliability-goal gates are not evidence for this repair.
