# Code Context

## Files Retrieved
1. `package.json` (lines 1-62) — package identity, allowlist, scripts, peer/dev dependencies, and Node engine.
2. `package-lock.json` (lines 1-30) — root lock metadata; package version and direct dev-dependency declarations are synchronized.
3. `tsconfig.json` (lines 1-22) — strict NodeNext TypeScript configuration.
4. `.github/workflows/publish.yml` (lines 1-91) — quality/publish jobs, npm trusted-publishing OIDC, tag check, and release gate.
5. `scripts/run-tests.mjs` (lines 1-60) — npm test runner; directly spawns Bun.
6. `scripts/release-pack-smoke.mjs` (lines 1-180) — tarball installation, packed entry/import checks, and worker probe.
7. `scripts/verify-auditor-extensions-offline.mjs` (lines 1-80) — mandatory hermetic auditor-extension check.
8. `schemas/goal.schema.json` (lines 1-260) — published goal contract; policy enum includes both `goal` and `list`.
9. `tests/goal.schema.test.ts` (lines 1-81) — local lightweight shape helper rather than schema-driven validation.
10. `tests/persistence-hardening.test.ts` (lines 321-343) — current schema-to-interface field-name parity pin.
11. `INSTALL.md` (lines 7-18, 27-50, 215-236) — requirements, install/update, and development commands.
12. `README.md` (lines 120-160, 483-520) — current command semantics and development/release instructions.
13. `examples/example-objective.md` (lines 1-119) — shipped worked examples.
14. `PLAN.md` (lines 1-64) — shipped historical plan and old smoke instructions.
15. `docs/INDEX.md` (lines 1-74) — package index and repository-only/public-material split.
16. `docs/RELEASING.md` (lines 1-50) — npm release procedure and trusted-publishing setup.
17. `.pi-glla/audit-loop/findings.md` (current append-only audit history; inspected for deduplication).

## Key Code / Findings

### MEDIUM — The documented “optional Bun” requirement is false for every test/release command
- **Location:** `INSTALL.md:12`; `scripts/run-tests.mjs:48-51`; `package.json` script block (the `test`, `test:fast`, `test:slow`, `test:all`, and `release:check` entries).
- **Impact:** A developer who follows the stated Node-only requirements can reach `npm test` or `npm run release:check` without Bun. The runner unconditionally executes `spawnSync("bun", ["test", ...])`, so the documented setup fails with a missing-`bun` command before any tests run. CI happens to install Bun explicitly, which masks the contradiction.
- **Verification/test gap:** No preflight or docs contract checks that the documented requirements include every executable used by the npm scripts; the release tests exercise CI’s Bun-installed environment, not the documented minimal setup.
- **Deduplication:** This is a current requirements/runner mismatch, distinct from the previously fixed historical runner/test-count wording.

### MEDIUM — A shipped worked example sends bare `/list` to the wrong command surface
- **Location:** `examples/example-objective.md:49-50`; compare current semantics at `README.md:160` and `INSTALL.md:120`.
- **Impact:** The example says bare `/list` “show[s] active + waiting items,” while the current command deliberately enters Confirm-gated context drafting; the viewer is `/list show`. A user copying the example can start an interview and accidentally queue/start work instead of merely inspecting the queue.
- **Verification/test gap:** The release contract checks that the example file is shipped, but no test executes or parses its command examples against the registered command router. A docs/command parity test would catch this class of regression.
- **Deduplication:** This is a surviving location of the already-recorded bare-`/list` semantics change, not a new routing change; retain as a residual documentation defect rather than a runtime fix.

### LOW — The shipped PLAN contains a non-working state path and superseded mechanics
- **Location:** `PLAN.md:6-8`, `PLAN.md:24-25`, `PLAN.md:38`, `PLAN.md:55-63`.
- **Impact:** Although the header calls PLAN historical, it is included in the npm artifact. Its smoke instructions inspect `.pi-gla/active.jsonl`, while the current state root and all onboarding docs use `.pi-glla`; following those commands checks a directory that the product does not use. The same artifact still advertises a five-minute backoff hard cap that was removed as dead behavior.
- **Verification/test gap:** Release tests assert that PLAN is present, but do not validate its paths/commands against the current state-root and loop implementation. A repository-only historical-plan banner or a small path/command drift pin would prevent shipping misleading instructions.
- **Deduplication:** No equivalent current PLAN path/cap finding was present in the inspected findings history.

### LOW — `tests/goal.schema.test.ts` is a stale local shape test, not a schema contract test
- **Location:** `tests/goal.schema.test.ts:10-17, 25-29, 64-81`; published policy enum at `schemas/goal.schema.json:35-39`; stronger current field-name check at `tests/persistence-hardening.test.ts:321-343`.
- **Impact:** The test defines its own `Goal`/`isValidShape` implementation, explicitly says full JSON Schema validation is deferred, and still asserts that `policy: "list"` is invalid. That contradicts the shipped schema and the core list queue. A future schema/runtime change that breaks list-state validation, nested required fields, enums, or formats can pass this test because it never reads the schema or persisted fixtures. The parity test checks property names, not values or structure.
- **Verification/test gap:** Add a real schema-driven validation path (or at least fixtures for active goal, queued list item, nested verdict, and invalid enum/missing nested field) rather than maintaining a second hand-written shape contract.
- **Deduplication:** The prior schema findings covered field additions/drift; this is the remaining value/shape-validation gap in the legacy schema test.

### LOW — INSTALL overstates when the running version appears in the status line
- **Location:** `INSTALL.md:34-38`; runtime projection at `extensions/loops/goal-ui.ts:849-850` and `extensions/goal-loop-display.ts:1184-1185`.
- **Impact:** INSTALL says the status line “always” shows `vX.Y.Z`, but the renderer only appends a supplied `versionTail`, clears the whole status segment for an idle/non-supervised state, and suppresses an unknown version. Users debugging an idle or damaged-manifest session can be told to expect a version that the product intentionally does not display.
- **Verification/test gap:** Existing display tests cover an explicitly supplied tail and idle clearing separately, but no documentation contract checks the INSTALL wording against the two runtime cases.
- **Deduplication:** The cleared-segment decision and version-tail implementation are already recorded; this is a remaining user-doc mismatch, not a new runtime defect.

## Architecture
- `package.json` owns the npm allowlist and all release entry points. The current dry-run contains 104 files, including runtime extensions, workers, prompts, schema, docs, examples, media, and the skill; tests are intentionally excluded.
- `release:check` runs the Bun suite, typecheck, Jiti regression, hermetic extension check, `npm pack --dry-run`, and the installed-tarball smoke. The smoke imports the packed extension through Jiti and starts the shipped auditor worker, so its current package-path coverage is meaningful.
- The workflow separates quality from trusted publishing; OIDC is scoped to `publish`, and the release tag is checked against `package.json` before `npm publish`.
- The published goal schema is a documentation/contract artifact. The current persistence test checks top-level and nested field-name parity, while the older schema test duplicates a reduced shape and has drifted from the published `list` policy.

## Start Here
Open `INSTALL.md:7-18` together with `scripts/run-tests.mjs:48-51` first: the stated optional dependency directly contradicts the actual test/release entry point. Then fix the stale command/path examples in `examples/example-objective.md:49` and `PLAN.md:24-63` before treating the packaged documentation as release-ready.

## Validation and residual risk
- Passed: `npm run check`.
- Passed: `npm pack --dry-run --json --ignore-scripts`; 104 files listed, including the documented runtime/public files.
- Passed: shell/JS syntax checks (`bash -n scripts/smoke.sh`, `node --check` on the release scripts, JSON parsing for package/schema).
- Passed: `npm run test:auditor-extensions`.
- Passed: 40 focused tests across release-contract, goal schema, persistence hardening, and version tests.
- Not run: full `npm run release:check` (long suite), live `scripts/smoke.sh` (requires tmux, pi auth/provider quota), npm audit, and consumer-host matrix testing. The Bun setup finding is therefore documentation-level; CI itself is expected to work because the workflow installs Bun.

BLOCKERS: none

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "Completed a read-only scoped audit, deduplicated against .pi-glla/audit-loop/findings.md, recorded five concrete documentation/test-contract findings with severity, exact locations, impact, and verification gaps, and reported BLOCKERS: none."
    }
  ],
  "changedFiles": [],
  "testsAddedOrUpdated": [],
  "commandsRun": [
    {
      "command": "npm run check",
      "result": "passed",
      "summary": "TypeScript check completed without errors."
    },
    {
      "command": "npm pack --dry-run --json --ignore-scripts",
      "result": "passed",
      "summary": "Package dry-run succeeded; 104 files were listed."
    },
    {
      "command": "bash -n scripts/smoke.sh; node --check scripts/release-pack-smoke.mjs; node --check scripts/verify-auditor-extensions-offline.mjs; node --check scripts/run-tests.mjs; JSON parse checks",
      "result": "passed",
      "summary": "Scoped shell, JavaScript, package, and schema syntax checks passed."
    },
    {
      "command": "npm run test:auditor-extensions",
      "result": "passed",
      "summary": "Hermetic offline extension allowlist check passed."
    },
    {
      "command": "bun test tests/release-contract.test.ts tests/goal.schema.test.ts tests/persistence-hardening.test.ts tests/glla-version.test.ts --parallel=1 --max-concurrency=1 --timeout=60000",
      "result": "passed",
      "summary": "40 focused tests passed across four files."
    },
    {
      "command": "npm run release:check",
      "result": "not-run",
      "summary": "Skipped because the full suite is long; CI installation and focused packaging checks were run instead."
    },
    {
      "command": "scripts/smoke.sh",
      "result": "not-run",
      "summary": "Skipped because it requires tmux, a configured pi host, and provider quota."
    }
  ],
  "validationOutput": [
    "Current package version is 0.38.97 and package-lock root metadata matches.",
    "Current npm dry-run includes 104 files and excludes tests as intended.",
    "No repository files were modified or staged by this audit."
  ],
  "residualRisks": [
    "Full release:check and live smoke were not run in this scout pass.",
    "No npm audit or multi-host consumer install matrix was run.",
    "The example/PLAN and schema-test findings are documentation/test-coverage risks rather than observed production runtime failures."
  ],
  "noStagedFiles": true,
  "diffSummary": "Read-only audit; no repository diff.",
  "reviewFindings": [
    "no blockers",
    "medium: INSTALL.md:12 contradicts Bun-dependent test/release scripts",
    "medium: examples/example-objective.md:49 documents the wrong bare-/list behavior",
    "low: PLAN.md:24-63 ships obsolete state-path and backoff instructions",
    "low: tests/goal.schema.test.ts:10-81 is a stale hand-written shape test",
    "low: INSTALL.md:34-38 overstates status-line version visibility"
  ],
  "manualNotes": "Findings were checked against the append-only audit history; the bare-/list issue is called out as a surviving documentation location of an already-recorded runtime semantics change."
}
```