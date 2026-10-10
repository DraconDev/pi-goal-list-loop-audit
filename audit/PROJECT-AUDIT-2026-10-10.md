# One project audit pass — 2026-10-10

## Scope and method

Current GLLA repository on main, version 0.39.24. Three fresh-context read-only scouts launched together in workflow `676fea34-cd5f-4e4a-8d71-837b132bf12b`: lifecycle/recovery, UI/fleet/summary, and audit/persistence/release. Briefs named source/test seams, requested ~35 tool calls and reports capped at 150 lines. No sibling mutations or nested folder-auto-banner inspection. Parent verified and deduplicated the three supported candidates before fixes.

Authoritative finding dispositions are appended to `.pi-glla/audit-loop/findings.md` under the 2026-10-10 section. Runtime journals remain outside package artifacts. No new DECIDE finding was established. No extra survey round or speculative refactor was performed.

## Fixes

| Finding | Fix commit | Regression evidence |
| --- | --- | --- |
| Fleet prints arbitrary saved prerequisite text across its privacy boundary | 6950b8d3 | c8b215b3; private objective/reason/action fixture fails before fix; 11 fleet tests pass afterward |
| Narrow shared footer clips required command after secondary context | 69186b7f | 5bcd48af; red-proven, commands survive styled/plain widths 32/40/60; 9 surfaces tests pass |
| Delayed model selection crosses supervisor/load hold at saved-surface boundary | d560f0d5 | 718c1595 and 6f6a7a63; all 18 goal/list/loop accepted/rejected/thrown cases red before fix, green afterward; accepted selection reconciles exactly once on release |

The recovery defect did not demonstrate dispatch escaping the downstream supervisor gate. The fix preserves pending selection for reconciliation, checks holds on both resolved and rejected host callbacks, protects surface release, and rebinds to the successfully persisted reconciled cursor.

## Verification

- `timeout 120 npm test -- tests/fleet-health.test.ts`: 11 pass, 0 fail.
- `timeout 120 npm test -- tests/ui-status-surfaces.test.ts`: 9 pass, 0 fail.
- `timeout 240 npm test -- tests/recovery-delayed-holds.test.ts tests/recovery-owner-fences.test.ts tests/recovery-restore-after-restart.test.ts tests/same-model-retry-before-fallback.test.ts`: 62 pass, 0 fail.
- `timeout 100 npm run check`: exit 0 after correcting test fixture timestamp types.
- Inventory regenerated through `node scripts/generate-inventory.mjs`.
- `timeout 1800 npm run release:check`: exit 0; 3633 pass, 0 fail (3634 tests, 386 files); package, import, launcher/worker RPC and skill probes pass. Full log: `/tmp/glla-audit-full.log`.

The persistence scout initially observed a five-second fixture timeout; the same case passed on a longer bounded rerun (68 focused tests pass). No concrete persistence defect established from that observation.

## Known state and limits

Fixes are committed on main with configured repository identity; daemon commits preserved without rewriting history. Existing untracked nested folder-auto-banner was left untouched. This pass does not publish a new release or reload sibling sessions; registry-installed 0.39.24 remains the earlier release while these audit repairs reside in the source tree.

Selective bounded survey, not exhaustive certification. Real providers, multi-process races, Windows and power-loss/fsync behavior were not exercised. Independent final rehearsal pending.
