# Auditor stall diagnosis — 2026-09-29

Investigated the ten supplied screenshots (02:33–02:47 Europe/London), the corresponding projects' `.pi-glla/active.jsonl`, `audits.jsonl`, and detached workers' `result.json` / `progress.json`, and GLLA source. Times below are local British Summer Time; persisted timestamps are UTC.

## Findings

### 1. dracon-log: confirmed approval rejected by preamble parsing

The audit persisted at `2026-09-29T01:39:22.303Z` (02:39 local) has `approved: true`, `challenge: confirmed`, and `regressionShieldPassed: false`. Its missing items are:

- `true, and to stop pinning a line number that moves whenever the README grows.`
- `Every criterion below is otherwise the original, unchanged. 1: the truncation`
- `flag is spelled \`tail -n 40\` so the check can execute. 3: the original`
- `` `[ ! -e $D ]` can never hold because `mktemp -d` has already created `$D`, so ``

These are hard-wrapped fragments of an explanatory parenthetical preceding the eight numbered requirements. `extensions/goal-loop-shield.ts:26` splits on every newline and treats the fragments as independent checkable items. The recorded audit lasted 1,840,297 ms (30m 40s), after which GLLA requested another claim. A later detached job was still active during inspection. This explains the repeated approvals and reclaims in the latest screenshot; it is a GLLA parsing defect, not evidence that the auditor never finished.

Repair direction: parse logical contract items and preserve their continuation lines; distinguish the explanatory preamble from actual numbered requirements without dropping real unnumbered contracts or weakening evidence enforcement.

### 2. games, capture-anime-girls, freeport: failed attempts followed by timed retries

The saved attempts repeatedly use `openrouter/stealth/space-bunny-alpha`. Errors include `Provider returned an empty response`, a lone BEL (`U+0007`), and an OSC 777 terminal notification saying the agent stopped with an error. Freeport's candidate-exhaustion records explicitly contain only that one candidate and `fallbackExhausted: true`.

Freeport recorded failures at 02:09:46, 02:26:41, 02:43:22, and 02:52:01 local. The ledger records automatic audit dispatches between them and 900-second waits after failures. The retry timer is progressing; repeated attempts are failing. `extensions/loops/goal-auditor-hooks.ts:812` caps the ordinary retry wait at 15 minutes. A new retry has no alternate candidate in these recorded cycles.

The provider/Pi failure itself is external to GLLA. Available evidence cannot identify an HTTP cause for attempts whose errors were lost. Disposition: observe as an external failure; do not modify the provider or Pi core. GLLA can preserve diagnostics and use explicitly configured auditor fallback candidates.

### 3. GLLA discards meaningful diagnostics in favor of terminal noise

`scripts/goal-auditor-worker.mjs:1001` captures structured assistant errors into `streamError`, but its stderr data handler at line 1159 unconditionally replaces that same variable with any nonempty stderr chunk. A bell survives `trim()`, as does an OSC notification. This code path explains how saved errors can become only a bell or a terminal notification instead of a useful failure reason. The exact overwritten reason is not recoverable from those result files.

Repair direction: preserve structured RPC errors separately from stderr, strip terminal controls from stderr diagnostics, and avoid allowing notification-only chunks to replace meaningful failure information.

### 4. Other screenshots are not evidence of a universal deadlock

- eve's shown goal approved at 02:35:06 local.
- darklord's quality goal approved at 02:45:03 local; its subsequent state had advanced to active work.
- polis's shown release-gate work approved at 02:41:01 local after rework.
- football-forever's first attempt failed with `Auditor attempted unsupported tool: write`; a later attempt was issuing bash calls during inspection. The worker enforces the auditor tool allowlist at `scripts/goal-auditor-worker.mjs:1011`. This is an observed model/tool mismatch, not a proven dead worker.
- Some running workers were executing long commands: capture-anime-girls had a bash call with a 2,450-second tool timeout. A quiet display during such a call alone does not establish a stall.

## Scope and validation

This investigation read existing evidence and source; it did not run project tests, modify goal state, switch live models, restart sessions, or alter implementation. Repairs to preamble parsing and error retention belong to GLLA. Provider/Pi behavior remains outside this repository's repair scope.
