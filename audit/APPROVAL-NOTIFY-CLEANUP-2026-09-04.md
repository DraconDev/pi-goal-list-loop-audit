# Approval-notify cleanup (2026-09-04, v0.38.20)

Field report: `Screenshot_20260904_192025.png` — after the v0.38.19 approval,
the `✓ done` block read as "no summary", with the verdict seemingly arriving
after completion was already declared.

## Forensics

Ledger (`.pi-glla/active.jsonl`):

- `audit_started … origin: complete-goal` 17:52:25Z → `goal_archived …
  status: complete` 18:02:04Z. The detached auditor ran ~9.5 minutes BEFORE
  approving. "Complete before verify" is disproven — the confusion comes
  purely from the message text (below).
- Zero `terminal_completion_notice_*` events (send or `_unsent`) across the
  whole file. The v0.38.18 transcript-closure notice never fired here because
  the reporting tab still runs pre-v0.38.18 loaded code (brief-shaped notify
  proves ≥0.38.14). Remedy on that tab is `/reload`, not a code change.

The `...` cuts in the screenshot are v0.38.13 `clipSummaryValue` working as
designed: every cut lands on a word boundary (`into pi's…`, `guard in…`,
`fail-before…` — the `…` glyph reads as `...` at small font sizes). Not
mid-word mangling. But five 120-char label lines still scan as soup, and the
reprinted `Next: detached auditor verdict decides.` directly above `—
auditor … approved.` is self-contradictory — that is the real defect.

## Fix (v0.38.20)

- `withoutStaleNext(details)` — strips the superseded `Next:` recap line
  (case-insensitive, leading-space tolerant; `Next-step:`-style labels kept).
- `buildApprovalChatLines({outcome, details, approval, record})` — outcome +
  at most two informing details + approval trailer + `— record:
  <archiveRel>` pointer. The full six-label record stays in the archive and
  the transcript notice.
- Wired into all three `✓ done` paths: detached approval notify + transcript
  notice details (`goal-auditor-hooks.ts`), manual-verify and no-audit
  notifies plus the no-audit command-output block (`goal-tools.ts`). The
  manual-verify record pointer is captured pre-archive (post-archive
  `state.goal` is null — the same trap the recap/brief comments name).
- External/pager notifies keep the compact single line (unchanged).

## Tests

`tests/approval-notify.test.ts` (3): Next dropped with order preserved,
details capped at two, `withoutStaleNext` edge cases. Fail-before verified
(post-fix test file against `de266935^`: import error, suite fails).
`tests/completion-summary-lines.test.ts` source-pin updated to the new wiring
(hooks + tools use `buildApprovalChatLines`, template owned by
`completion-summary.ts`).
