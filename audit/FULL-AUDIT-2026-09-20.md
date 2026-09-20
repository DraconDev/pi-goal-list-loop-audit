# Full audit — pi-goal-list-loop-audit v0.38.71 (2026-09-20)

Method: first-hand review plus full gate execution in this checkout.
Scale: ~52.7k lines in `extensions/`+`scripts/`, ~53.7k lines of tests
(255 files). Core modules were read in full (entry/DI wiring, runtime
globals bridge, persistence, evidence shield + mechanical sandbox, auditor
worker/launcher, auditor extensions, update check, payload guard); the
remainder was covered by gate execution, pattern sweeps, and sampling —
not line-by-line. A supplementary multi-agent sweep was launched but
concluded early without consumable output; nothing below depends on it.

## Verdict

Healthy. All release gates pass, no secrets, no known-vulnerable
dependencies, no genuine test failures, and the highest-risk code
(contract-executed commands, auditor sandboxing, persisted state) is
the best-hardened. Findings are one medium (flaky test margin), three
lows, and one observation. No release blocker.

## Verified gates (observed 2026-09-20)

| Gate | Result |
|---|---|
| `tsc --noEmit` | exit 0 |
| `bun test` full suite | 2432 pass / 2 skip / 2 fail across 256 files, 627s — both fails are load flakes, green on solo rerun (7/7) |
| `tests/repro-jiti-state-split` | pass |
| `verify-auditor-extensions-offline` | pass, no temp install dir |
| `release-pack-smoke` | pass: tarball installs, Jiti load, worker RPC probe, skill zero diagnostics |
| `npm pack --dry-run` | 100 files, 3.5 MB |
| `npm audit` (incl. dev) | 0 vulnerabilities |
| Secret sweep (`extensions/`, `scripts/`) | no hardcoded tokens/keys |
| Git | `main` in sync across origin/github/gitlab; `v0.38.71` tag present; tree clean |

## Findings

1. **Medium — flaky settlement margin in `tests/paused-suspicious-close.test.ts`.**
   The suspicious-close test takes 9.44s solo against a 10s `waitFor`
   ceiling (94% unloaded; tripped at 10.4s under load). It will flake on
   any loaded runner. Widen the ceiling or make settlement event-driven.
   (`tests/objection-pinning.test.ts`, 2.9s solo vs 51.9s loaded, is pure
   contention — no action.)
2. **Low — ~240-name `globalThis` bridge (`extensions/loops/goal-runtime-globals.ts`).**
   Explicitly managed (single checked registry, typed data slots,
   registration-count overwrite detection, single-registration contract
   test), but still last-write-wins global mutation on double-activation
   or child-session module re-execution. The retirement path (replace
   function slots with dependency interfaces) is documented but
   incomplete — keep retiring it; do not add new slots.
3. **Low — stale header in `extensions/goal-loop-shield.ts`.** Still claims
   "pure, dependency-free enforcement logic" above what is now an 882-line
   module dominated by the process-spawning mechanical runner. One-line fix.
4. **Low — hygiene.** ~10 stale local branches (`pi-agent-*`, `pr-*`); two
   August goal records in `.pi-glla/goals/` still marked `active`
   (likely superseded by the `active.jsonl` ledger — confirm and archive);
   state growth (`active.jsonl` 5 MB, ledger segments 29+8+8 MB, 207
   audit-job dirs) deserves a stated retention/rotation policy.
5. **Observation — shield matching is fuzzy by design.**
   `checkRegressionShield` accepts top-3-longest-token references, so a
   keyword-stuffing report could theoretically satisfy it. Mitigated by
   the detached auditor and human Confirm layers (defense in depth); worth
   stating that threat model explicitly in the module docs.

## Strengths (verified, not assumed)

- **Mechanical sandbox** (`goal-loop-shield.ts`): shell-free `spawn`, allowlisted
  command prefixes, strict charset (exit 126 on unsafe), two narrow compound
  forms with per-segment validation, pipefail-head semantics, process-group
  cleanup, output bounds, `node_modules/.bin` PATH parity.
- **Auditor isolation**: `--no-extensions` + resolved-path allowlist only
  (never raw `npm:` specs — no network installs, offline-safe), fail-closed
  resolution, self-mirror exclusion (GLLA can't load itself into its own
  auditor), sha256 request-hash validation, RPC tool gating to
  `read/grep/find/ls/bash`, atomic `result.json`.
- **Persistence** (`goal-loop-core.ts`): every sampled parse is try/caught
  with schema-version, safe-id, and date checks; atomic rename-via-temp;
  `wx` lock files with proven-dead-PID reclaim; reverse-tail audit-log reads.
- **Evidence shield**: references must live inside `<evidence>` (prose-echo
  bypass closed), CJK-aware tokenization, preamble/out-of-scope filtering.
- **Update check**: render path never touches network; refresh is throttled,
  TTL-cached, timeout-bounded, `unref`'d, with async-error listener and
  fail-silent design.
- **Tests**: hermetic harness (per-process settings redirect, per-file reset,
  zeroed settles); sampled tests are behavioral (identity, ordering, floors,
  idempotency); zero genuine TODO/FIXME debt markers in `extensions/`.
- **Process**: own audit loop demonstrably live (2026-09-20
  disapprove→approve cycle in `.pi-glla/audits.jsonl`); per-change audit docs
  current; per-version CHANGELOG; release gate loads the packed artifact
  through the real Jiti boundary; README scope claims are honest.
- **History**: the 2026-08-09 mirror divergence is resolved — all remotes
  agree at `e5f86a88`.
