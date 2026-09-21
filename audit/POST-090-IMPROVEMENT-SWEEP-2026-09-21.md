# Audit: post-0.38.90 improvement sweep (2026-09-21)

Goal `2026092…audit`: run an audit, see if other changes are warranted.

## Checked, no change

- **Deprecations** (5 files): all intentional compat shims with reasons
  (old-state readers, upstream renames, event-driven migration).
- **Suite skips**: none in source; 2 runtime skips are env-gated.
- **PROMOTION-CONTRACT.md**: version-free, no drift.
- **INDEX trail**: highlights reel ending at v0.38.55 + "see CHANGELOG"
  pointer — deliberate, version range current.
- **Ledger types** (~340 claimed, 343 actual): within "~" tolerance.

## Fixed

- **ARCHITECTURE.md file count**: "260 files" → "~260" (262 test files
  after process-state-reset + ui-polish; hard counts rot in days).

## Open recommendation: tool-description discoverability

`/goal` routes: status timeline pause resume cancel decide audit verify
tweak archive start plan. Description lists
`status|timeline|pause|resume|cancel|tweak|archive|start` — missing
**plan, audit, verify** (standalone features) and **decide**
(contextual: only valid paused-on-choice; recommend leaving out).

`/list` routes: start audit depth tweak pause resume show add/import
plan clear cancel next remove/rm settings. Description lists show start
resume tweak next remove clear cancel audit — missing **plan** (the
rounds-based drafting from the staged-drafts work) and **add/import**
(the bulk-enqueue path).

Pin-safe: the no-hardcoded-guidance pin only watches
`/goal (pause|resume|tweak|cancel|decide|status)` — plan/audit/verify
don't trip it (timeline precedent verified the mechanism).

Cost: every added token rides every agent turn. Proposed minimal add:
`/goal` +`plan|audit|verify`, `/list` +`plan|add`. Left for owner
decision.
