# Rich terminal summaries — 2026-09-11 (v0.38.46)

Field request (screenshots 20260911_003839 / 003903 / 003907 vs 004103):
the Antigravity close — `### Key …` sections, numbered findings with bold
leads + code refs, PASS tables, verification summary — instead of GLLA's
flat six-bullet `[goal-event]` card. Goal `20260911092611-xnye14`.

## Decisions (owner, pre-implementation)

- Scope: terminal render only (chat + transcript + archive). Progress
  cards, status line, external notifies unchanged.
- Shape: sections + table (closest to the screenshots).
- Archive: rich too — the archive IS for humans. Raw six-label recap stays
  verbatim as the machine layer; `## Terminal summary` carries the rich
  markdown over it.
- Budget: verbose — findings cap 8, values/table cells 200 chars, Next
  cap 4.

## Implementation

- `extensions/completion-summary.ts`: `buildRichTerminalParts` (partition
  stale-filtered details into findings / Tests / Next buckets; Tests +
  Audit table rows; empty sections omitted, never invented) +
  `composeRichTerminalLines` (headline + `### Key Findings & Remediation`
  + `### Verification Summary` + `### Next`) + `buildRichArchiveSection`
  (status-aware headline: `## Done` vs `## Aborted`, approval/record
  synthesized from durable history). `buildTerminalApprovalRender` composes
  chat (sections + approval/counts/record trailer, record last, extras) and
  transcript (sections + approval, no record/extras — old contract).
- Honesty rules preserved: Tests status is PASS only on `pass` without a
  nonzero `fail` (else FAIL/REPORTED); Audit row only with history;
  `NO VERDICT` never renders a row; table pipes escaped; filler still
  drops via `briefValueContent`; stale Next still filtered.
- `extensions/loops/goal-orchestrator.ts`: `archiveCurrentGoal` appends
  `## Terminal summary` built from the post-fence terminal goal, so chat
  and archive cannot disagree. Zero new import edges (orchestrator already
  imports completion-summary; `md` file write now publishes `richMd`).
- Untouched: `buildApprovalChatLines` (legacy compat), `recap` (external
  notify), widget/status surfaces, the continuation `✓ done` notice
  (different surface, out of scope).

## Verification

- New `tests/rich-terminal-summary.test.ts` (8): headline, numbering,
  table, FAIL detection, pipe escaping, stale-Next, trailer contract,
  no-audit path, archive headlines.
- Migrated: terminal-approval-render (3), completion-communication (3),
  behavioral-orchestrator v0.34.91 / v0.36.0 / v0.34.22, E1 source-text pin.
- Full gate green at ship; tsc clean; v0.38.46 tagged + released + published.
