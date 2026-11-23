# Objective summaries and completion-loop audit

The end-of-objective card now keeps a short request together, including secondary requirements on later lines. It preserves literal identifiers such as `save_queue.ts` and visibly abbreviates longer requests. In the collapsed report, up to four flat findings remain readable, and the footer still carries the review outcome and saved-record reference.

## Scope

Reviewed the GLLA checkout at package version 0.41.1, starting at `f46755cd`. The review follows the completion claim into audit admission, settlement, durable archive, and terminal rendering. It also sampled rework continuation and paused-decision recovery. The fixtures run against the installed Pi renderer and a local mock host.

## Findings

| Finding | Disposition |
| --- | --- |
| The Goal excerpt ended at the first qualifying sentence and removed underscores. A card could omit a second requirement and display a different filename. | Fixed. The excerpt uses the supplied wording across lines, with a 200-character target and an ellipsis when clipped. The renderer wraps it at the available width. The archive has the full objective. |
| The collapsed Summary counted flat findings against its two-line prose limit. A structured report could hide its third change and its final receipt. | Fixed. Prose and findings have independent allowances. The receipt and its accompanying annotations survive collapse. |
| A failed automatic decision can leave a chosen option in the persisted assumption log. | Open. The decision path writes `autoDefaultLog` before delivery. With a simulated stale send, the decision stayed paused and the ledger correctly recorded a delivery failure with zero adoptions, while the durable assumption log contained the choice. The audit records this as a separate loop defect. |

At 40 columns, the rendered card shows the result “Pending edits survive a restart,” retains “Fix duplicate saves. Verify save_queue.ts on restart.” and shows the first four changes with the review qualification and saved record. Expanding the message reveals the fifth change. [Production renderer fixture](../tests/summary-renderer.test.ts)

The audit reproduced the failed send with one extra assertion in a temporary copy of the decision fixture to inspect the persisted `autoDefaultLog`. [Decision fixture](../tests/decision-auto-select.test.ts) · [Write and delivery order](../extensions/goal-commands.ts)

## Task list

- [ ] **Record automatic decisions only after adoption.** Align the persisted assumption log with the outcome of the shared picker and heartbeat path. Cover both prose recommendations and executable resume options. A failed delivery or refused resume must leave the original decision pending, preserve its options, and record the failure with zero new assumptions or adoption events. A successful adoption must record exactly one assumption and one adoption event. [Decision command](../extensions/goal-commands.ts)
  - [ ] Extend the regression fixture to assert the durable assumption log after a stale send and after a refused resume. Retain the successful-adoption coverage and check the journal after reload. [Decision tests](../tests/decision-auto-select.test.ts)
- [x] **Keep secondary requirements and literal filenames in the objective excerpt.** The narrow card shows both lines of the short fixture, including `save_queue.ts`. A long excerpt ends in an ellipsis. [Objective excerpt tests](../tests/summary-human-reminder.test.ts) · [Renderer test](../tests/summary-renderer.test.ts)
- [x] **Keep primary changes and the receipt visible in the collapsed report.** The 40-column fixture shows four primary findings, the review qualification, and the saved-record reference. Expansion reveals the fifth finding. [Renderer test](../tests/summary-renderer.test.ts)

## Loop checks

- The completion paths build the receipt before settlement. The archival path writes the intent and archive before releasing the live goal, and persisted approval messages can be replayed after an interrupted delivery. [Settlement](../extensions/loops/goal-orchestrator.ts) · [Delivery tests](../tests/terminal-summary-delivery.test.ts)
- Stored mechanical gate receipts are admitted for the matching worktree fingerprint, and the cursor-refusal path snapshots its persistence diagnostic before parking the saved claim. [Auditor hooks](../extensions/loops/goal-auditor-hooks.ts) · [Persistence tests](../tests/persistence-failure-diagnostics.test.ts)
- Rework continuation sends changed instructions and re-sends them across a compaction boundary. Repeated hygiene events are counted without repeating the same journal row. [Continuation tests](../tests/delta-only-continuation.test.ts) · [Context hygiene tests](../tests/context-hygiene.test.ts)

## Verification

Bun 1.3.14 passed 251 tests across 23 suites covering the report, message replay, gate receipts, persistence diagnostics, decision handling, and continuation. Typecheck, generated inventory, private-name and whitespace checks, and the npm pack dry run passed. The full release run was stopped after 342 seconds under host contention.
