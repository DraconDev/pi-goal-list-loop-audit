# Fresh audit verification — 2026-09-23

## Scope and evidence

- Fresh scout fan-out: workflow `876cf269-f827-4de0-b166-e92a0175bea8`, one `runs.all` dispatch with four `scout` children. The launch metadata and each child's report are preserved in this directory.
- Findings: `.pi-glla/audit-loop/findings.md`, sections `Priority field follow-up — 2026-09-23` and `Fresh project audit — 2026-09-23`.
- Every newly recorded finding is checked and cites commits present on `main`; no new decision remains because auditor-bash confidentiality was already decided in the append-only history.

## Canonical release gate

Command:

```text
TMPDIR=/var/tmp timeout 1800 npm run release:check
```

Final full-suite observation after all product/test changes:

- 2558 passed
- 2 skipped (host/daemon environment-gated tests)
- 2 failed only by the Bun 60-second per-test timeout under full-suite load:
  - `tests/glla-stale-context.test.ts` — `/glla` stale-handle inspection
  - `tests/compaction-survival.test.ts` — three mid-run compacts followed by approval
- The two files were rerun together immediately afterward with the same command shape used by the suite:

```text
timeout 240 bun test tests/glla-stale-context.test.ts tests/compaction-survival.test.ts --parallel=1 --max-concurrency=1 --timeout=60000
```

Result: **9 passed, 0 failed in 10.34s**. This distinguishes load-sensitive suite timeouts from product regressions; both affected flows pass when bounded and isolated.

Additional gates run green during the pass:

- `npm run check` — exit 0
- `npm audit --audit-level=moderate` — 0 vulnerabilities
- focused lifecycle, queue/repair, compaction-failure, recovery-persistence, settings, vision, branch-loop, refinement, schema/release, and display suites — all pass
- package dry-run and packed-artifact smoke are part of `release:check` and completed before the two load-timeout tests were reported by Bun.

## Repository state

At rehearsal time, product/test/docs trees were clean. The only working-tree delta was expected `.pi-glla/active.jsonl` runtime-ledger drift from the live goal/test harness; no staged files were present.
