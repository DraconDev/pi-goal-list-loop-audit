# Fast/slow suite split (v0.38.82, 2026-09-21)

## What

Full serialized suite: ~7 minutes (423s over 261 files). `npm test`
now runs the fast set through `scripts/run-tests.mjs`: the whole
suite minus the 12 slowest files, excluded via one bun
`--path-ignore-patterns` flag per file. `npm run test:slow` runs
those 12; `npm run test:changed` runs git-affected files (tightest
loop); `npm run test:all` and `release:check` are unchanged and still
run everything.

## Evidence

Per-file standalone timings (265 files, 6-way parallel, 2026-09-21;
absolute numbers inflated by load, ordering stable). Over ~8s:
behavioral-orchestrator (106s), drafting-handoff (37s),
completion-communication (33s), auditor-process (21s),
auditor-retry-callback (19s), list-draft-handoff (16s),
auditor-stall-watchdog (15s), compaction-containment (13s),
revision-bound-audit (11s), subagent-hang-detection (10s),
loop-error-exemption (10s), glla-stale-context (8s).

## Semantics (verified by probing bun, not docs)

- Repeated `--path-ignore-patterns` union; comma-separated does not.
- Ignore patterns beat even explicit paths — so the runner drops the
  exclusion whenever a positional path is present.
- Value-taking flags (`-t` etc.) consume the next token so filter
  values are not mistaken for paths (caught by the self-check test
  before release).

## Verification

- `tests/test-split.test.ts` (4): slow-list validity (exists,
  unique, test files), fast exclusion shape, explicit-path escape,
  slow/all passthrough + filter handling.
- Fast suite measured: 2210 pass / 1 fail / 254 files in 217s — the
  single failure was lockfile drift (below), not the split.
- Repair folded in: `package-lock.json` had drifted to 0.38.78
  behind the .79–.81 bumps (no full suite ran between them to catch
  it); re-synced to the release version. Lesson: bumps need a suite
  run, not just release-contract.
- `tsc` clean (runner/list are JS + a test-covered pure builder).
