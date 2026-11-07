# Completion reports for human eyes — the structure gate (2026-11-07)

> **Shipped in v0.39.64.** `glla version` / the version row reports the loaded
> build, so a session can tell whether it is running the structure gate
> (v0.39.64+) or an older build that only annotates the claim (v0.38.69–v0.39.63).
> The stale-build warning also compares the loaded build against this checkout.

## The complaint

Two field reports, one cause. A downstream goal closed after ~45 minutes with:

> Outcome: The mini popup is gone — the toolbar button now opens <home page>… Changed:
> removed default_popup and <project>/entrypoints/popup/, added a background
> onClicked that opens <home page>, moved <three buttons> onto it, and dropped
> all max-width caps from the shared glass styles; no game logic touched.
> Evidence: <artifact>.png screenshot…
> Tests: vitest 72 passed… — NOTE: low evidence density: no path:line evidence
> tokens and no verification gate rows…

The operator's verdict: "we are getting pretty bad reports by the end, we would
want detailed ones that are for human eyes."

## What the machinery already did

The rendering layer was not broken. `extensions/completion-summary.ts` can
produce an area-grouped card with nested evidence bullets, a
`Quality Gate | Command | Scope | Status | Notes` table, and `path:line` tokens —
`.pi-glla/archive/20261031094542-rxnfwy.md` in this repo is 16 KB of exactly
that. The reported claim produced the fallback instead because `findingGroups`
and `gateRows` are **optional** parameters, and the agent supplied neither.

The one mechanism that noticed was `completionSummaryDensityNote`. It appended
the NOTE quoted above and **still let the claim through**:

```ts
const densityNote = completionSummaryDensityNote(finalSummary, sanitizedGroups, sanitizedGates);
const claimedSummary = densityNote && finalSummary
  ? `${finalSummary.trimEnd()} — NOTE: ${densityNote}`
  : finalSummary;
```

So the system's own diagnosis of the problem shipped inside the report as
though it were part of the report. A warning the agent can ignore is not a
contract.

A second, quieter contributor: `human-handoff.ts` tells agents not to put
"investigation history, file inventories, tool counts" in the human
explanation, and `showVerification` defaults off. The agent obeyed — it wrote a
*tight* summary — and the constraint it was obeying produced the thinness.

## The fix: refuse, don't annotate

`complete_goal` now runs `completionSummaryStructureGap` **before**
`beginCompletionAudit`:

```
complete_goal needs structure for multi-area work — this claim spans 7 paths
(<artifact>.png, <project>/entrypoints/background.ts, <project>/wxt.config.ts,
<project>/entrypoints/<home>/<HomeApp>.svelte, <project>/lib/ui/theme.css,
<project>/tests/writer-contract.test.ts (+1 more)) but supplied no findingGroups or gateRows, so the summary and the
durable archive record it as one opaque bullet.

Re-submit with one findingGroups entry per work area ({ title, findings:
["<user-visible outcome> — <concrete evidence or path:line>"] }), plus gateRows
for the commands you actually ran ({ gate, command, scope, notes }). One group
is enough when the paths really are one coherent area.

Single-area work stays a flat recap — omit both fields when the change really is
one area. The claim was NOT sent to the auditor and no state changed.
```

Breadth has two sources:

| Signal | Source | Why it is needed |
| --- | --- | --- |
| `completionSummaryChangedPaths` | the recap's own `Changed:` value and any `path.ext` / `path.ext:12` token | catches a claim that already knows it spans areas |
| `goal.telemetry.files` | durable v0.38.100 change set | not the agent's prose — in the reported case it named **6** files while the recap named one artifact |

Directories are excluded: `lib/` is not something a reviewer can open, and
counting it would let one path-shaped word look like scope.

Threshold `MULTI_AREA_MIN_PATHS = 3`. Two paths can honestly be one coherent
change (a source file and its test); three distinct files with no grouping is
where a flat bullet stops being readable.

**Supplying either field satisfies the gate.** One group is enough for a
coherent multi-file change — the gate demands structure, not theatre, and
inventing artificial groups to pass would be worse than the flat card.

## Single-area work is untouched

`completionSummaryStructureGap` returns `undefined` when the claim spans fewer
than three paths, when it already carries groups or gates, and when there is no
summary at all. The flat six-label render remains correct for one-file work and
is still the pinned behavior in `tests/rich-terminal-summary.test.ts`.

The refusal is ledgered as `complete_goal_structure_refused` with the judged
paths, the durable change set, and its overflow count — the same forensic trail
`completion_summary_low_density` keeps.

## Where the fix deliberately does not reach

- **Chat stays compact.** The operator chose "keep compact + full archive": the
  card is not the place for six files of prose, so the archive keeps the
  detail and the card names the record. This change makes the *archive* and the
  grouped card rich, not the chat.
- **The density lint is unchanged.** It still annotates claims that carry
  structure but no pointers. The structure gate removes the case where the
  annotation was the *only* signal.
- **No automatic structure synthesis.** GLLA refuses and explains; it never
  invents finding groups from telemetry. An invented group would be an
  unverified claim wearing a verified shape.

## Evidence

- `extensions/completion-summary.ts` — `completionSummaryChangedPaths`,
  `completionSummaryStructureGap`, `MULTI_AREA_MIN_PATHS`.
- `extensions/loops/goal-tools.ts` — the capture-time refusal before
  `beginCompletionAudit`, plus the schema guidance on `completionSummary`,
  `findingGroups`, and `gateRows`.
- `tests/completion-structure-gate.test.ts` — 6 tests: the archived claim's
  real text is refused and names its change set; single-area work stays flat; supplied
  structure satisfies the gate; directories are not breadth; `complete_goal`
  refuses with no state change; `complete_goal` still audits a single-area
  claim.
- `tests/finding-lead-contract.test.ts` — "archive table prints each evidence
  token once per row". The replay exposed a second bug the complaint was
  hiding: `findingPresentation` already folds extracted `path:line` tokens into
  `reason`, and the archive table then joined `evidence` in again, so
  `<project>/entrypoints/background.ts:41-46` printed twice on one row of a report that
  is supposed to be readable. Not cosmetic — a doubled pointer makes the
  reader re-check whether the second one is a different claim.
- `audit/COMPLETION-SUMMARY-POLICY-2026-08-19.md` — the new
  "multi-area claims must carry structure" section.
- Replayed against the archived claim text and telemetry from
  the downstream project's `.pi-glla/archive/<goal-id>.md` and its `active.jsonl`
  state line, not a synthetic fixture.

## Naming rule (added to AGENTS.md with this change)

The audit trail for this work is now name-free, and `AGENTS.md` carries a
standing rule plus `npm run check:names` inside `npm run release:check`. The
gate judges only lines **new** relative to the newest release tag, so the tree's
~950 historical references are grandfathered without a committed baseline — a
baseline in git would publish the very names it protects. The denylist lives
untracked at `.dracon/no-project-names.txt`; a fresh clone reports "denylist
absent" and exits 0 rather than failing.

`tests/` is out of scope by design (a fixture may need a realistic repo name,
and tests do not ship), and `tests/no-project-names.test.ts` drives the script
in a throwaway repo with a synthetic denylist so the test file itself stays
name-free.

## Verification

| Gate | Command | Result |
| --- | --- | --- |
| Structure gate tests | `bun test tests/completion-structure-gate.test.ts` | 6 passed, 0 failed |
| Completion/summary surface | `bun test tests/completion-*.test.ts tests/rich-terminal-summary.test.ts tests/rich-summary-dedup.test.ts tests/structured-summary.test.ts tests/summary-*.test.ts tests/terminal-*.test.ts tests/recap-preservation.test.ts tests/revision-bound-audit.test.ts tests/human-handoff.test.ts tests/finding-lead-contract.test.ts tests/outcome-first-chat.test.ts tests/repository-receipts.test.ts tests/remaining-next-pairing.test.ts` | 232 passed, 0 failed across 25 files |
| Audit settlement surface | `bun test tests/audit-*.test.ts tests/approved-audit-settles.test.ts …` (18 files) | 168 passed, 1 failed — `approved-audit-settles` "residual-failure tail", **pre-existing**: reproduced identically on baseline `cd198d16` in a clean worktree |
| Behavior orchestrator | `bun test tests/behavioral-orchestrator.test.ts` | 159 passed, 0 failed |
| Typecheck | `npx tsc --noEmit` | 0 errors |
| Inventory | `npm run check:inventory` | in sync after regeneration |
| Docs/index parity | `bun test tests/doc-index.test.ts tests/doc-parity.test.ts tests/release-contract.test.ts tests/packaged-markdown-links.test.ts tests/goal-schema-parity.test.ts tests/tool-cap-inventory.test.ts` | 44 passed, 0 failed |

Not run: the full `npm run release:check`. The packaged runner refuses this
host's Bun (`1.3.3`) — it needs 1.3.14+ for `--parallel` /
`--path-ignore-patterns` — so the suite was run file-group by file-group under
`bun test` instead.
