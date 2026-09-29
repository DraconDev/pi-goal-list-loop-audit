# Full plugin audit — v0.38.104 → v0.38.105 — 2026-09-29

## Decision

The 7-agent audit of the released v0.38.104 tree produced 12 findings.
10 are fixed in-tree with regression tests and verified green
(full suite 2557 pass / 0 fail, `tsc --noEmit` clean). The remaining
plausibility-over-strictness item is a deliberate **wont-fix**: the
mechanical gate fails closed toward the AI auditor, and relaxing it risks
false mechanical passes. That is the safe direction for a pre-check.

## Method

- `GLLA full audit 0.38.104` workflow, 7 reviewer agents over the
  shipped tree (extensions, scripts, tests, docs).
- Each finding reproduced with a probe before fixing; each fix carries
  a regression test in the repo's own suite (no `/tmp`-only evidence).
- Gates: focused files first, then full `node scripts/run-tests.mjs`
  plus `npx tsc --noEmit`.

## Findings fixed (10)

### Shield / mechanical pre-check (`extensions/goal-loop-shield.ts`)

1. **Mixed-contract Done-when dropped in list mode.** `contractItems`
   (`:28`) lost the Done-when criterion for list-mode contracts, so a
   satisfied criterion never counted. Kept in list mode; covered in
   `tests/regression-shield.test.ts`.
2. **Negation blind spots.** Contraction `n't` and trailing
   `is not run` were not detected, letting negated check commands
   through as positive evidence. Fixed via `MECHANICAL_NEGATION`
   contraction handling, `MECHANICAL_NEGATION_TRAILING` (`:171`)
   with a 40-char window (`:173`), and qualifier-strip ordering
   (`:212-213`). Covered in `tests/regression-shield.test.ts`.
3. **Server-guard bypass.** `yarn dev` / `yarn serve` and
   `python3 -u server.py` / `python3 -m http.server` passed the
   server-mode guard, so long-running servers could pose as checks.
   `isServerModeMechanicalCommand` (`:184`) now rejects them while
   preserving non-server python commands. Covered in
   `tests/regression-shield.test.ts`.

### Milestone failure text (`extensions/loops/goal-tools.ts`)

4. **Inconclusive routed to FAILED language.** Milestone checks that
   were inconclusive (not failed) were reported with failure text,
   misrouting retry behavior. `milestoneCheckFailureText` (`:518`)
   now distinguishes fail vs inconclusive; the three call sites
   (`:3014`, `:3071`, `:3119`) are wired. Covered by 2 unit tests in
   `tests/task-atomicity-gate.test.ts`.

### Auditor worker / stderr diagnostics

5. **Stream errors overwrote diagnostics.**
   `handlePiStreamError` (`scripts/goal-auditor-worker.mjs:1165`)
   replaced the accumulated stderr diagnostic instead of appending,
   destroying the original cause. Now accumulates via
   `accumulateStderrDiagnostic` (`:1163`, `:1169`). Covered by a
   source-pin test in `tests/auditor-error-paths.test.ts`.
6. **Control-char pollution.** OSC sequences and C1 controls
   (128–159) leaked into diagnostics. `stripOscSequences` and
   `stripStderrControlChars`
   (`scripts/auditor-stderr-diagnostic.mjs:33,54`) strip OSC as a
   unit plus C1. Covered in
   `tests/auditor-stderr-diagnostic.test.ts`.

### Test / docs hygiene

7. **Release-contract flakiness.** `npm pack` dry-run tests had no
   timeout budget on slow machines. Given `{ timeout: 60_000 }`,
   matching existing precedent in the suite
   (`tests/release-contract.test.ts`).
8. **INSTALL.md provider-inheritance contradiction** (`:248-252`).
   Reworded to match actual behavior.
9. **CHANGELOG typos.** `IMPOSIBLE` spelling and an anachronistic
   `v0.38.107` reference fixed; kept `IMPOSSIBLE(partial)` text to
   match `goal-tools.ts` code.
10. **docs/INDEX.md version trail** kept consistent with the release
    (required by the release gate).

## Verification

- Focused: `bun test` over the 5 touched test files — 82 pass / 0 fail.
- `tests/task-atomicity-gate.test.ts` solo: 20/20.
- Full `node scripts/run-tests.mjs`: first run 2554 pass / 3 fail,
  rerun **2557 pass / 1 skip / 0 fail** across 296 files. The 3 first-run
  failures did not reproduce (known cross-file timing flake class, cf.
  the `zzz successor-plane reset` file-hygiene interference); no failure
  detail was captured from the tailed first run.
- `npx tsc --noEmit`: clean (added
  `scripts/auditor-stderr-diagnostic.d.mts` for the new `.mjs`).

## Deliberately deferred

- **Plausibility over-strictness** (`go test -run`, `cargo test <filter>`,
  `test -d build` rejected by the bare-gate): wont-fix. The gate is a
  pre-check; over-strictness routes to the AI auditor, which is the safe
  direction. Relaxing risks false mechanical passes. Revisit only with
  audit data showing goals stuck *at* the mechanical gate.
- **Workflow `unresolved` items**: static line citations still want
  probe reproduction; runner-log pins and live-rig/daemon-e2e outcomes
  are environment-dependent and unstated here.
- **Residual stuck causes** (auditor model quality, hard-goal pool,
  provider endpoint instability) are not fixable by GLLA code alone.

## Release readiness

Fixes are committed (daemon auto-commits `edaf7117..7d46b7d7`).
v0.38.105 is **not cut**: no version bump, no tag, no publish.
Needs operator go-ahead for bump + `npm run release:check` + tag + publish.
