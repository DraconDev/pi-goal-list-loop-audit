# Reliability, measurements, and canaries

`/glla stats reliability` reports ledger-derived audit starts, retries, open
failure age, and challenge outcomes. Add `json` for structured output.
A semantic verdict or terminal archive resolves an earlier infrastructure
failure. Missing or future timestamps produce unknown age. Counts deduplicate
attempts; challenge elapsed time is the entire recorded attempt, not isolated
round-two time or billed provider cost. The existing status card shows current
work, real progress, pause/retry reason, and the available action without
additional polling. `/glla stats challenges` remains the detailed flip/skip view.

The global `auditorStrictChallenge` setting defaults to false. For full-tier
contracts, enabling it requires confirmed challenge approval; a failed/skipped
challenge cannot close the goal. Light contracts keep their existing policy.
Skipped challenges appear in completion evidence with the policy reason.
[SETTINGS.md](SETTINGS.md) is the authoritative settings reference.

Run `node scripts/measure-runtime.mjs --output <file>` for the synthetic runtime
baseline, and `bun scripts/measure-context-growth.mjs` for context measurements.
The runtime fixture records versions, source digest, load, sample count, median,
and p95 for fresh Node/jiti load, idle heartbeat, 500 queued items, audit prompts,
owner mutation, 8 MiB ledger rotation, and a roughly 3 MiB receipt outbox. It
checks state preservation after rotation and deduplication after receipt replay.
The unbound heartbeat fixture measures local bookkeeping, not a live host/model.
Context usage is synthetic; neither measurement establishes paid token savings.
The [saved baseline](../audit/improvement-evidence-2026-09-30/runtime-performance.json)
was recorded under heavy machine load; compare like-for-like environments.

`node scripts/real-host-canary.mjs` emits an explicit skip by default. Opt in
with `GLLA_RUN_REAL_CANARY=1` and an explicit `GLLA_CANARY_MODEL`; optionally set
`GLLA_CANARY_MAX_USD` (default 0.10, maximum 1). The host canary uses a temporary
state root, loads GLLA through the actual Pi host, disables tools and unrelated
extensions, and requests one short reply. It permits exactly one provider
request, at most 32 output tokens and 8192 payload bytes, and a 45-second child
deadline. Unsupported provider cap fields, unknown prices, repeated requests,
and estimates exceeding the configured budget are refused before dispatch.
The metadata estimate is a guard, not a billing guarantee; usage is recorded
when the provider returns it. Fixture tests use a stub host and do not count as
live-provider success.

The weekly/manual real-host workflow runs only when repository variable
`ENABLE_GLLA_REAL_CANARY=true`, with an explicit model and configured provider
secret. It is separate from hermetic release validation. No paid provider
canary was requested or executed for this implementation; the saved outcome is
an opt-in skip. A future real run must retain its versions, caps, usage, and
outcome rather than converting a skipped run into a pass.
