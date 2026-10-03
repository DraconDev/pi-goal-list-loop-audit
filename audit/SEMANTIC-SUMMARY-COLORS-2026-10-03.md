# Semantic summary colors — 2026-10-03

Prepared version: 0.38.114. The published release remains 0.38.113.

Terminal completion summaries now use the active Pi theme's existing semantic
palette: green for completed outcomes and explicitly passed checks; amber for
remaining work, aborted/paused outcomes and reported/skipped checks; red for
failed checks; accent for changes and next actions; dim for supporting labels
and repository details. Unrecognized evidence stays neutral. Zero passed and
zero failed does not imply success. A failed check does not recolor unrelated
audit approval or archive references red. Text labels retain the meaning.

The renderer is registered by the actual extension installer and is fenced to
terminal receipts carrying `terminalApprovalGoalId`. Other `goal-event`
messages retain the host renderer. Durable Markdown, archives, receipt identity,
delivery replay and headless output are unchanged. Structural splitting respects
code fences, and terminal control sequences are stripped from display input.
Verification remains opt-in under the existing summary policy.

Validation:

- 73 tests passed across the renderer, terminal delivery, approval rendering,
  completion communication and rich summary suites; zero failures.
- TypeScript checks passed with current Pi 0.99.1 and the oldest supported
  Pi 0.84.2, including the new renderer and its actual installer registration.
- Jiti extension loading passed; packed 0.38.114 installed/imported successfully,
  completed its bounded RPC worker probe and loaded its skill without diagnostics.
- Actual canonical summaries rendered in dark/light themes at 40/80/120 columns,
  with passed/failed/reported verification: 18 recorded frames. Reviewed the
  raster preview. Renderer tests also cover widths 0/1/20 and control sequences.
- Generated inventory and Git whitespace checks passed.

Preview: [semantic-summary.png](semantic-summary-2026-10-03/semantic-summary.png).
Frames: [rendered-frames.json](semantic-summary-2026-10-03/rendered-frames.json).
