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

## Implemented behavior

- A shared structural classifier recognizes raw or `grep -n`-prefixed table
  rows, numbered source headings, and report `Item:` labels before reviewer
  trigger-word classification. The incident rows no longer enqueue work or
  propose architectural goals; a real adjacent TODO still enqueues normally.
- Legacy bare rows/source headings cannot activate via the queue or
  `list_activate`. Their original text and positions remain durable; the
  warning offers exact removal/correction commands and no repair is invented.
  A persisted active head instead stops before dispatch with a durable hold
  and policy-correct tweak/cancel instructions. Repeated retries and reloads
  neither complete it nor multiply repairs.
- Existing `Item:` contract-label repairs retain their durable repair/promotion
  semantics, rather than weakening those tests to fit a broader rejection.
- A deliberate structured list objective with an explicit contract still
  activates unchanged. Explicit user-seeded goal handling is preserved.
- The source project remains untouched. Users can cancel an affected active
  head with `/goal cancel`, remove a queued row with `/list remove N`, or use
  `/list tweak` for an active head / `/list add` for new work to supply a
  concrete objective and `Done when:` contract. Later work is selectable
  explicitly with `/list next N`; genuine decisions are not bypassed.

## Verification evidence

- `verification/affected-suites.log`: 328 passed, zero failed across 12 suites,
  including existing auditor-approved list and standalone completion handoffs,
  intake/import, reviewer, recovery, durable repair promotion, decision and
  cold-load hold coverage. An earlier run exposed two contract-label repair
  regressions; implementation was narrowed and both pass unchanged.
- `verification/recovery-gates.log`: 76 passed, zero failed across four suites.
- `verification/negative-control.log`: an isolated copy with the new reviewer
  guard removed fails the exact numbered-row assertion with exit 1. No live
  source was modified for that counterfactual.
- Fresh-context reviewer `d14bae13-0bd5-409e-9767-829518a1969c` inspected the
  baseline diff and supplied test artifacts read-only: no blockers identified.
- TypeScript and inventory checks passed. Inventory was regenerated after the
  changes. No skipped test was introduced by this fix.
- Initial full release gate: 4,398 passed, zero failed, 4,399 discovered across
  471 files; runner exit 0, then Jiti, auditor-extension, inventory, pack and
  final packed-launcher probes succeeded. The tool resync lost the outer-shell
  exit receipt, so a receipt-preserving repeat was launched rather than
  claiming an unobserved top-level exit.
- That repeat hit the runner's stalled-suite watchdog in compaction-survival
  after 959 silent seconds under host load around 84; exit 1, not a pass.
  The unchanged compaction-survival file immediately passed alone: 2 passed,
  zero failed in 3 seconds. A fresh quiet full gate is being run; its receipt
  and final output will be recorded before completion.

