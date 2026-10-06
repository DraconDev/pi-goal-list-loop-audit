# Main fallback thinking selection

The main-agent fallback selector previously saved only ordered model refs.
The main recovery switches therefore inherited one session thinking level,
and the settings row displayed that shared level for every candidate.

Prepared 0.39.12 offers a supported thinking-level choice for each reasoning
model after chain selection. Non-reasoning models resolve to off. Inherit clears
an individual pin; dismissing its thinking prompt preserves the previous pin.
Cancelling model selection does not change configuration. Clearing the chain
also clears its thinking overrides, including through `/glla fallbacks clear`.

The global-only `mainModelFallbackThinkingLevels` map uses lowercase model refs
and removes invalid levels and entries outside the current bounded chain.
The settings row and save notice show the per-model levels. Configuration
does not change the live session's thinking while the operator edits it.

The runtime applies thinking after an accepted automatic switch and after
checking the generation and pending switch identity. Immediate fallback,
scheduled recovery and preferred-primary failback paths are covered. Before
the first switch, the primary thinking level is retained in the durable recovery
record; unpinned fallbacks inherit it and failback restores it. Candidate model
capabilities bound the effective level. Older hosts without a thinking setter
retain their existing behavior.

Verification: 96 tests passed across six files, including the real settings
picker, independent pins, inheritance and clearing, global-only normalization,
durable primary-level sanitization, immediate switching, scheduled probing and
failback restoration. TypeScript, generated inventory and whitespace checks
passed. Logs are in `audit/main-fallback-thinking-2026-10-06/`.
The change is prepared in 0.39.12 and has not been published by this work.
Auditor and drafting role-wide thinking settings retain their existing behavior.
