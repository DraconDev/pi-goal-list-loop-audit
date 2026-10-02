# Final-audit clearing + summary pairing — 2026-10-02 (evening)

## Final audit: cleared, verified read-only

The operator reported a still-stuck final audit, then observed it had
cleared. Verified across all 19 live pi hosts (20:19–20:21 UTC):

- clean-web goal `20261002065243-sfdk2a` archived 16:14:31 UTC with
  `audit_settlement_completed`; the previously parked `mur2sq0s` job now
  carries `result.json`. The Field-addendum-2 park is resolved.
- No project journal shows an active completion claim in auditing state.
- Zero resultless audit jobs (`progress.json` without `result.json`) in
  any live project's `.pi-glla/audit-jobs/`.
- SEO (`dracon-platform/seo`) still holds its orphaned completed job on
  disk with no live owner process — known unresolved runtime debt (needs
  a normal Pi session in seo to reconcile; read-only here, unchanged).

Per-project state was projected from each journal's latest `state`
entries plus recent non-noise ledger events (probe kept outside the
repo at `/tmp/fleet-survey.py`).

## Fleet notes (all processes left running, per operator choice)

- 19 pi agents live: 2 dracon-strategy, studio, chat, clean-web,
  dracon-platform root, 11 wip games, eve. Plus 1 subagent runner.
- hellhunter / junk-runner / deathrun show `session_compact_failed` +
  `compactor_transcript_error` + `loop_stopped` — loops stopped on a
  compaction failure, not on audit. deathrun additionally held
  (`load_hold_engaged`, idle since 18:34). eve wiped at 16:02
  (`glla_wipe`, idle). polis logged `loop_stuck` 19:07 then resumed
  turns. None of these are final-audit states; flagged, not changed.

## UI: Remaining/Next problem+action pairing

`note.md`: "Next and remaining is pretty much the same no? ... clearer
way to see what is important." The card stated one fact twice — the
problem under ### Remaining, its fix under ### Next. Operator chose
pairing over re-ranking or section merge.

Change (`extensions/completion-summary.ts`, human projection only —
archive machine layer keeps the verbatim recap):

- A `Next:` action sharing ≥2 content words (≥1 long, ≥5 chars) with an
  `Unresolved:` problem renders inline under it as `→ Next: …` and
  leaves ### Next. Full-body word sets: the shared topic usually sits
  at the tail of a long problem body, outside the restatement head
  window.
- ### Next keeps only standalone actions; a fully paired card omits the
  empty section. `Left out` (decided scope) never pairs.

Verification:

- New `tests/remaining-next-pairing.test.ts`: 6 pass (written first —
  4 failed pre-change, 2 negative pins passed vacuously).
- Consumers green: rich-summary-dedup, rich-terminal-summary,
  finding-lead-contract, verification-status, second-gemini-gap,
  repository-receipts, structured-summary (68 pass, 0 fail).
- `tsc --noEmit`: 7 errors before and after, none in touched files.
- Inventory regenerated; `check` exits 0.

Pre-existing, out of scope: `completion-summary-lines.test.ts` "the ✓
done chat notifies ..." fails identically with and without this change
(stale source-text pin — D7 sanitized the line to
`✓ done — ${sanitizeDisplayText(notice.outcome)}`; pin still expects
the raw form). Left untouched for its owner.
