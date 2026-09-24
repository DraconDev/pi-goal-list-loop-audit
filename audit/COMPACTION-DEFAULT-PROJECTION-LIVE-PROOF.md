# Default compaction projection — live proof

- **Result:** PASS
- **Run (UTC):** 2026-09-24T17:46:29.535Z
- **GLLA revision:** `0aec66ccef60eed019090335af34281d3727d6c8` (package `0.38.98`)
- **Pi revision:** `0.87.1` (fresh child process; only GLLA was explicitly loaded)
- **Provider/model:** `openrouter` / `stealth/space-bunny-alpha`
- **Child PID:** `2790938`

## Isolation and source integrity

- Source session: `/home/dracon/.pi/agent/sessions/--home-dracon-Dev-pi-plugins-pi-goal-list-loop-audit--/2026-09-24T10-47-59-244Z_01a0d307-800b-73f2-84e3-62460f7d57d5.jsonl`
- Source size: `25235287` bytes
- SHA-256 before: `6a443c1dd8bce42bec86358c5f91de139205784b09b805c6f595f50af7827657`
- SHA-256 after: `6a443c1dd8bce42bec86358c5f91de139205784b09b805c6f595f50af7827657`
- Checksum match: **yes**; the original was not opened for writing.
- Temporary copy used for the run: `/tmp/glla-compaction-live-GZo2AN/historical-session.jsonl` (removed after verification).
- The copy's session header was redirected to an isolated temporary working directory; its historical entries were otherwise retained.
- The verifier uses isolated GLLA settings with automatic resume disabled; the real working-directory state root and real session file were not used.
- No credentials or raw transcript/summary text are included in this report or verifier stdout.

## Compaction path and bounded hook evidence

- Automatic compaction start: `overflow`.
- Compaction ended successfully: **yes**; aborted: `no`; Pi-reported retry: `yes`.
- Summary length observed in memory: `18123` characters (content intentionally not recorded).
- Summary length-stop/incomplete error: **none**. Pi 0.87+ rejects a summarizer response with `stopReason=length`; a successful non-aborted `compaction_end` is therefore the live proof that the default summarizer did not stop for length.
- GLLA hook projection: **observed**.
- Estimated preparation characters: `189094` before → `13201` after (budget `16000`).
- Projection scale: `0.04902227890625002`; bounded messages: `65`; bounded fields: `104`; replaced images: `3`; bounded GLLA payloads: `0`; retained GLLA payloads: `0`.
- Structural boundedness: hard bound applied: `no`; retained messages: `68`; omitted messages: `0`; retained tool groups: `13`; omitted tool groups: `0`; omitted tool calls: `0`; omission markers: `0`.
- The hook returned no custom compaction result; Pi remained responsible for cut-point selection, summarization, persistence, retries, and the final result.

## Continuation

- Post-compaction continuation: **passed**.
- Continuation marker returned by the model: `GLLA_POST_COMPACTION_CONTINUATION_OK` (only a boolean/length check was retained).
- A second prompt after compaction also completed and returned a non-empty assistant response.

## Reproduction

```sh
node scripts/verify-compaction-live.mjs --session "/home/dracon/.pi/agent/sessions/--home-dracon-Dev-pi-plugins-pi-goal-list-loop-audit--/2026-09-24T10-47-59-244Z_01a0d307-800b-73f2-84e3-62460f7d57d5.jsonl" --provider openrouter --model stealth/space-bunny-alpha
```

## Scope and remaining risk

This is one real provider-backed run against the selected model and the copied historical session. It demonstrates the fixed path for that model/context shape; it is not a provider-wide guarantee. Other providers/models can have different context accounting, output caps, or transient availability, so the same verifier should be rerun when the selected model or Pi runtime changes. The verifier does not change provider/model/reserve/thinking settings, does not retry compaction recursively, and does not tag or publish anything.
