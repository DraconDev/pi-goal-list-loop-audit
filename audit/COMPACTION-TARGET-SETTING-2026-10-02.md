# Opportunistic compaction target in /glla — October 2, 2026

## Contract

The operator accepted adding a `/glla` control for compaction above a token
target, opportunistically rather than immediately. This is GLLA-owned
settings/UI/trigger behavior. The existing idle-boundary fix is retained.

Requirements and observed implementation:

- `/glla` → Compactor exposes **Compaction token target**, distinct from the
  emergency handoff-brief model. The row displays the effective count,
  source, and next-idle-boundary policy.
- The editor persists global `compactionTokenThreshold`, accepts whole
  counts, comma grouping, and `k`/`m` shorthand, rejects invalid/unsafe values,
  preserves cancellation, and resets to the 200000 default on empty input.
  No external user's settings file was modified: behavioral tests use the
  per-process temporary settings file installed by the test preload.
- Project copies cannot override this global policy. Settings provenance,
  headless `/glla`, and the settings reference include the key. Invalid
  hand-edited values fall back safely in the runtime and display.
- The actual public-hook trigger reads the configured count. A 300k target
  skips at 250k, waits while the host is busy at 320k, and compacts when idle.
  Changing the setting never invokes compaction immediately. Rearming uses
  half the chosen target, tested at 140k for a 300k target (which would not
  rearm under the former hardcoded 200k rule).
- Existing tool/audit/pending-message ownership, pause, abort, unknown-usage,
  and once-per-episode guards remain covered. Settings editing does not
  rewrite transcript history or modify Pi/providers/other plugins.

## Verification evidence

- Settings/menu/editor, boundary, and settled-entrypoint suites:
  **93 passed, 0 failed** across five files. An initial run caught the missing
  settings-reference row; after the documentation update the full focused
  group passed.
- Final editor-to-runtime test plus compactor handoff, continuation payload,
  and list settings routing: **32 passed, 0 failed** across four files.
- TypeScript passed. Import singleton consistency passed (the jiti regression).
  Runtime inventory regenerated and its check passed. `git diff --check`
  passed.

Logs are in `compaction-target-evidence-2026-10-02/`. The positive runtime
verification uses real GLLA editors/loaders and a mock public `ctx.compact`
hook, not a live provider-backed summarization. This proves configuration and
dispatch policy; it does not claim a live strategy session compacted.
Existing sessions must reload to expose the new row. No release was published.
