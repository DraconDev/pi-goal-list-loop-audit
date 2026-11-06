# One project audit pass — 6 November 2026

## Scope and result

Scope was this GLLA repository only (`pi-goal-list-loop-audit`); no parent/sibling
or nested Git project was modified. Baseline at audit time: package `0.39.62`
with `Unreleased` changes (transport durable-retry + tweak-card quote blocks)
on `main`, on `origin/main`, working tree clean (daemon `a7c58346`
`.opencode/glla/state.json` was the latest commit; HEAD had moved from
`4777df30` during the audit by daemon commits — no rewrite was observed or
performed). This was a report-only one-pass audit, not `/goal verify` for the
live goal, and not a release certification.

**Result: no blocking defects found in the reviewed surface.** All recent
fixes inspected (v0.39.61 operator surface, v0.39.62 global-only auditor +
`propose_tweak` + reviewer junk-work guard, and the two `Unreleased` fixes)
are real code wired into their surfaces, with passing targeted tests. Two LOW
hygiene items were found (audit INDEX drift; live goal has no verification
contract). The full release / typecheck gates were **not** completed in this
audit (host contention) — see Verification — so this report must not be read
as a publish claim for `0.39.63`.

## Live state at audit time (observed)

- `package.json` `0.39.62`; `CHANGELOG.md` `Unreleased` documents the two
  pending fixes (transport + tweak-card), matching
  `audit/transport-failure-durable-retry-2026-11-05/README.md` and
  `audit/tweak-card-formatting-2026-11-05/README.md`.
- Live goal `20261105212942-f6rru5` (`active`) is the transport-fix goal; its
  objective is the verbatim `note.md` paste and its `verificationContract` is
  empty (flagged below as a contract-quality note, not a code defect).
- `note.md` still carries the November 5 transport items — correct as a
  trigger, pending closure on release.
- `.pi-glla/active.jsonl` 1.6 MB, `audits.jsonl` 3.2 MB. One retained audit
  job (`audit-mskzqzza-0cc0ep-…`, v0.34.111-era, old cwd path) remains in
  `.pi-glla/audit-jobs/`; the 2026-11-04 retention sweep reaped 13 and left 1.
  Retained, not active work.
- `extensions/` largest files (maintainability advisory, pre-existing):
  `loops/goal-tools.ts` 4772 lines / 296K, `goal-commands.ts` 3887,
  `loops/goal-activation.ts` 4201, `goal-loop-display.ts` 3725,
  `loops/goal-auditor-hooks.ts` 2975. The earlier `goal.ts` decomposition is
  done; remaining size is known debt, not a new finding.

## Verified (real code, not scaffolding)

1. **Transport durable retry (`Unreleased`).** `extensions/main-model-recovery.ts`
   `TRANSPORT_FAILURE` + `isRecoverableProviderError` accept connection-level
   wording and the empty-response family, while aborts / context-overflow /
   deterministic 400s / unclassified prose keep their owners. The gate feeds
   `classifyCompactionFailure`, durable-wait restore, and `auditorRetryPlan`
   as documented. `audit/…/verification/predicates.txt` and
   `compaction-park.txt` contain real predicate tables and a real
   `session_compact_failed` replay. Classifiers lowercase evidence before
   matching, so `TRANSPORT_FAILURE` is effectively case-insensitive.
   Advisory only: the retained bare `network`/`socket` tokens (pre-existing,
   not introduced here) make any error string containing those words
   durable-retryable; the pinned refusal cases (`connection pool exhausted …`)
   stay `unknown` as required. No change recommended.
2. **Tweak-card quote blocks (`Unreleased`).** `extensions/confirm-draft.ts`
   `quoteBlock` / `plainCardBody` / `buildTweakConfirmBody` /
   `buildAmendmentConfirmBody` put `**From:**`/`**To:**` on their own lines
   with verbatim text quoted line-by-line; changed contracts become two
   labelled quotes. Both `ctx.ui.confirm` fallback sites apply the plain
   downgrade (`goal-commands.ts:3886` `confirmTweak`,
   `loops/goal-tools.ts:910` scope amendment) — there are no other callers, so
   no RPC path renders literal `**From:**` / `> `. Consent content is
   verbatim (viewport paging, not elision); `quoteBlock` trims outer
   whitespace but the callers trim the replacement upstream, so no
   user-visible loss.
3. **Stale recovery marker (v0.39.61 item 1).** Retirement is two layers and
   they compose: `archiveCurrentGoal` (`loops/goal-orchestrator.ts:1470`)
   clears goal-owned non-`chat` markers; `settleApprovedCompletion`
   (`loops/goal-auditor-hooks.ts:1283`) then runs
   `retireOrphanedMainModelRecovery` + `clearStaleMainModelRecovery` after the
   slot closes; display (`goal-recovery.ts:723` `mainModelRecoveryHasLiveOwner`
   via `loops/goal-ui.ts:930`) hides `chat` + no-goal/no-loop. `chat` markers
   intentionally survive on disk for reload restore ("ordinary-chat ownership
   is not goal loss") while rendering no action-implying card — observed
   nuance, not a defect. `/glla resume` shares the same retirement predicate
   (`goal-commands.ts:3089`).
4. **`/glla wipe` latency (v0.39.61 item 3).** `fireReviewer` uses bounded
   `scanLedgerRecordsSince` (`goal-loop-core.ts:3026`,
   `loops/goal-auditor-hooks.ts:2905`) with a 24h lookback — a sound superset
   for both predicates (UTC day start < 24h ago; 5-min window inside it).
5. **List auto-advance (v0.39.61 item 4).** Advance lives only in
   `archiveCurrentGoal` (`loops/goal-orchestrator.ts:1556`) on
   `policy === "list" && status === "complete"`; settlement performs no second
   advance (commented `goal-auditor-hooks.ts:1288`). The group-close-blocked
   path returns without advancing by design (durable work, explicit cleanup).
6. **Auditor model label (v0.39.61 item 5) / stale-build banner (item 6).**
   `goal-loop-display.ts:2794` prefers the executed/recorded model;
   `glla-version.ts` + `loops/goal-activation.ts:1984` emit the stale-build
   ledger/notice. Covered by the passing tests below.
7. **v0.39.62 global-only auditor + `propose_tweak` + reviewer junk guard.**
   `auditorModel` / `auditorThinkingLevel` are in `GLOBAL_ONLY_KEYS`
   (`goal-settings.ts:380`) and `docs/SETTINGS.md:48` lists the same set;
   stale project copies are evicted (`goal-settings.ts:933`). `propose_tweak`
   (`loops/goal-tools.ts:4707`) funnels through `cmdTweak`'s Confirm gate and
   is tracked by session-start self-heal (`goal-loop-core.ts:4816`
   `GLLA_TOOL_NAMES`). Evidence shapes are excluded via the narrow
   `report-fragment.ts` classifier (table-row / source-heading /
   contract-label); prose trigger words remain refactor-class by design —
   that is the extractor contract, not a regression.
8. **Hygiene.** No `console.*`, no code-debt `TODO`/`FIXME` (all TODO hits are
   the domain auditor-TODO projection). Child-process uses are fixed commands
   with bounded, sanitized output (`goal-loop-core.ts:5064`
   `git log -1 --format=%ct` in `cwd`; `completion-summary.ts:763`
   `execFileSync("git", fixedArgs, { timeout: 3000 })`). No `eval`/`Function`.
   Temporary `tests/tmp-e2e-evidence.test.ts` was created and deleted across
   two daemon commits and is absent at audit time. Daemon `N file(s) … DELTA`
   messages are expected per `AGENTS.md`; `backup-messy-history`, `pr-21`,
   `pr60` branches are leftovers, not divergence (`main` = `origin/main`).

## Findings (LOW, non-blocking)

- **LOW-1 — `audit/INDEX.md` is stale.** It stops at October 2026 in its
  "Recent reviews" list and never mentions the November audits
  (`operator-surface-2026-10-31`, `tweak-card-formatting-2026-11-05`,
  `transport-failure-durable-retry-2026-11-05`). The November work is still
  discoverable via `CHANGELOG.md`, but the index should gain the three
  entries so the canonical audit trail stays honest.
- **LOW-2 — live goal has no verification contract.** Goal
  `20261105212942-f6rru5` is `active` with an empty `verificationContract`
  and a raw-`note.md` objective. The fix is shipped and well-evidenced
  (`durable-solution` judgment recorded), but a completion audit against an
  empty contract would be weak. Recommend a `Done when:` contract (or
  `tweak`) before `complete_goal`, plus closing the `note.md` items on
  release. Process note, not a code defect.

No DECIDE items were raised; no fixes were made in this audit (report-only).

## Verification

Host was heavily contended throughout (8× slower than idle per the test
runner; load ~79; 22/30 Gi RAM, 20 Gi swap). Bounded results below are the
evidence for this report; the full gates were not claimed.

| Gate / check | Command (bounded) | Observed result |
| --- | --- | --- |
| Inventory | `node scripts/generate-inventory.mjs --check` | exit 0, no diff |
| Transport + tweak-card pins | `npm test -- tests/transport-failure-durable-retry.test.ts tests/amendment-confirm-compact.test.ts` | **30 pass / 0 fail** |
| Recovery / compaction / retry pins | `npm test -- tests/main-model-recovery.test.ts tests/compaction-failure.test.ts tests/persistent-provider-recovery.test.ts tests/rework-round-scope.test.ts tests/empty-provider-response.test.ts tests/retry-bounds.test.ts` | **81 pass / 0 fail** |
| Wipe / list-advance / auditor-label / stale-build pins | `npm test -- tests/glla-wipe-latency.test.ts tests/glla-wipe-real-path.test.ts tests/wipe-ledger-scan.test.ts tests/list-auto-advance.test.ts tests/auditor-model-display.test.ts tests/stale-build-warning.test.ts tests/glla-version.test.ts` | **33 pass / 0 fail** |
| `propose_tweak` / reviewer / settings-scope pins | `npm test -- tests/propose-tweak.test.ts tests/reviewer-extraction-hardening.test.ts tests/settings-scope-guard.test.ts tests/settings-editors.test.ts tests/amendment-confirmation-fence.test.ts` | **101 pass / 0 fail** |
| Inventory-globals / settings-menu / reviewer pins | `npm test -- tests/inventory-globals.test.ts tests/settings-menu-complete.test.ts tests/reviewer.test.ts tests/reviewer-modes.test.ts tests/reviewer-source-curation.test.ts` | **82 pass / 0 fail** |
| Typecheck (attempted) | `npx tsc --noEmit` (300s limit, twice) | **timed out** under contention — not run, not claimed |
| Full fast suite (attempted scope) | `npm test` (full) | **not run** in this audit (327 targeted tests above are the suite evidence) |
| Release gate | `npm run release:check` | **not run** — do not treat the tree as publish-ready on this report alone |

## Known limits

- Read-only survey of the GLLA tree; no live Pi session was driven, no
  screenshot/extended-UI pass was performed, and upstream Pi / provider /
  subagent-extension behavior was treated as external per `AGENTS.md`.
- Targeted tests cover the areas the recent fixes touch; they are not the full
  484-file suite, and `tsc` is unverified in this pass.
- Before publishing `0.39.63`, re-run `npm run release:check` on an idle host
  and record its result; update `audit/INDEX.md` (LOW-1) and close `note.md`
  (LOW-2) in the same release pass.
