# Report fragments became list work (2026-10-27 incident)

## Observed evidence

Source project (observed read-only):
`/home/dracon/Dev/browser-extensions-shared/extensions/standalones/auto-coupon`.
The source project's `.pi-glla/active.jsonl` and review report remain untouched.

- Journal line 257, 16:27:47Z: the research goal was archived as complete by **user acceptance with follow-ups after eight disapprovals**, not auditor approval. This does not establish that every original requirement passed.
- Lines 260, 263–265: `list_queue_disk_first` / `list_imported`, source `reviewer`, count 8; autoactivation held; `reviewer_fired` reports 10 findings, 8 enqueued, 2 proposed.
- Review `.pi-glla/reviews/20261027155359-giagel-2026-10-27T16-27-47-895Z.md` lists all ten extracted findings. Eight are raw evidence: numbered table rows, a contract `Item:` label, and numbered section headings. The other two are table rows classified architectural because of the word `rewrite`.
- Line 266 records all eight queued objectives verbatim. The first starts `28:| 3 | Popup + contextMenu quick-actions | V9 |`; the second starts `29:| 4 | Single-retailer price tracker (Amazon) | V8 |`.
- Lines 269–272, 16:49:28Z: an explicit `glla-resume` activated the first row as a list goal with no contract (`createdVia: list-cascade`).
- Lines 277–280: the worker raised a genuine contract-conflict decision because the row was not an actionable objective.
- Lines 284–287, 16:50:25Z: **user cancellation** archived that head as aborted and left seven queued entries. No false completion of that row is warranted.
- Lines 289–294, 20:04:03–07Z: reload with no active goal engaged `loadHoldAt`. This explains the screenshot's seven-item held queue. The screenshot includes earlier pause output above the current held-list widget; those are not simultaneous active-state snapshots.

## Causal paths confirmed in GLLA

`reviewer.ts` strips code spans and classifies report lines using trigger words.
Its existing skip rule recognizes table rows only at the beginning of a line;
`28:|` defeats it. Evidence headers also contain trigger vocabulary ("duplicate",
"follow-up"). Classification therefore turns evidence into new work.
Reviewer enqueue passes the extracted text unchanged to `enqueueItems`, then
`activateNextListItem` passes it to `createGoal`. The suspicious-objective guard
has no structural table-row rule, allowing a row to reach a worker.

The observed queue holds are intentional: reviewer autoactivation was disabled,
explicit resume started the row, a material decision paused it, user cancellation
ended it, and reload held remaining state. Fixing these holds by auto-advancing
would violate consent, not repair the defect.

## Boundaries and historical limitations

This investigation proves reviewer provenance and the subsequent lifecycle from
the retained journal and report. It does not independently re-audit the research
deliverable, assert that the eight original disapprovals were resolved, or infer
that the user intended the table rows as build requests. No state in the source
project is edited. Existing affected state must retain its text and require an
explicit correction/removal rather than silently completing or inventing work.
