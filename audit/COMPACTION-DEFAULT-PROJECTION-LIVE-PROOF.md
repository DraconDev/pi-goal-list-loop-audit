# Default compaction projection — live proof

- **Result:** PASS
- **Run (UTC):** 2026-09-25T03:45:12.301Z
- **GLLA revision:** `16426056294745fa4895606c092057cd0771cde6` (package `0.38.98`)
- **Global-context revision:** `dc28c0efc1946899c6b9774cc5930e182ebcb241` (package `1.1.0`)
- **Pi revision:** `0.87.1` (fresh child process)
- **Provider/model:** `openrouter` / `stealth/space-bunny-alpha`
- **Child PID:** `3492384`
- **Loaded local extensions:** GLLA `extensions/loops/goal.ts`; explicit cap `extensions/context-compaction-cap.ts`.

## Isolation and source integrity

- Source session: `/home/dracon/.pi/agent/sessions/--home-dracon-Dev-pi-plugins-extensions-pi-global-context-limit--/2026-09-24T15-51-02-709Z_01a0d41c-f535-73f7-98a3-594c165c0946.jsonl`
- Source size: `9179180` bytes
- SHA-256 before: `6431ba4b9fc3d13830349a8214b5605b177c38fc7e94fce2f5cc606cdf265307`
- SHA-256 after: `6431ba4b9fc3d13830349a8214b5605b177c38fc7e94fce2f5cc606cdf265307`
- Checksum match: **yes**; the original was not opened for writing.
- Temporary copy: `/tmp/glla-compaction-live-OaAJFZ/historical-session.jsonl` (removed in the verifier's outer cleanup).
- Pi ran with a private temporary `PI_CODING_AGENT_DIR`; the source session and real agent directory were not used.
- GLLA used isolated settings with automatic resume disabled.
- Credentials were resolved by Pi from a private temporary copy of its configured auth store; the credential file was copied without inspection, logged, or written outside the disposable root.
- No raw prompt, summary, environment value, or provider diagnostic is included in this report or verifier stdout.

## Automatic host compaction

- Attempts: `1`; start reason: `threshold`; terminal aborted: `no`; terminal willRetry: `no`; in-memory summary characters: `14385`; persisted summary characters: `14385`.

- GLLA bounded preparation projection: **observed**.
- Estimated preparation characters: `40079` before → `13319` after (budget `16000`).
- Projection scale: `0.42250000000000004`; bounded messages: `8`; bounded fields: `8`; replaced images: `0`; hard bound applied: `no`.
- Pi remained authoritative for the threshold/overflow trigger, cut point, default summarizer, retries, persistence, and result.

## Manual host compaction

- Attempts: `1`; start reason: `manual`; terminal aborted: `no`; terminal willRetry: `no`; in-memory summary characters: `13496`; persisted summary characters: `13496`.

- The verifier seeded `120119` deterministic input characters after the automatic recovery, called Pi RPC `compact`, and required a fresh ordered `compaction_start`/`compaction_end` pair plus a newly persisted non-empty session record. Command success alone was not accepted.

## Usable next turns

- Automatic-compaction continuation: **passed**; assistant text characters: `36`.
- Manual-compaction continuation: **passed**; expected marker: `GLLA_MANUAL_COMPACTION_CONTINUATION_OK`.
- Both paths left Pi able to accept and answer a new prompt after its persisted compaction.

## Reproduction

```sh
PI_CODING_AGENT_DIR="$(mktemp -d)" node scripts/verify-compaction-live.mjs --session "/home/dracon/.pi/agent/sessions/--home-dracon-Dev-pi-plugins-extensions-pi-global-context-limit--/2026-09-24T15-51-02-709Z_01a0d41c-f535-73f7-98a3-594c165c0946.jsonl" --provider openrouter --model stealth/space-bunny-alpha
```

## Scope and remaining risk

This is one real provider-backed run against the selected model, copied historical session shape, and installed Pi version. It is not a provider-wide guarantee. The verifier never supplies a custom compaction result, recursively retries a failed summary, edits model/provider/reserve settings, or writes the source session.
