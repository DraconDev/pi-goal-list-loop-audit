# runToDone schema coverage (v0.38.79, 2026-09-20)

## What

v0.38.73 added `runToDone?: boolean` to the `Goal` interface
(extensions/goal-loop-core.ts) but did not add it to the published
contract in schemas/goal.schema.json. The T6 drift test
(tests/persistence-hardening.test.ts, "schema does not drift from the
Goal interface") failed on the next full serial run:

    AssertionError: Goal interface field "runToDone" missing from the schema

Full-suite result before the fix: 2457 pass / 1 fail / 2 skip across
261 files. The single failure was this omission — nothing else.

## Fix

One additive property next to `autoContinue`:

    "runToDone": { "type": "boolean", "description": "v0.38.73 run-to-done: ..." }

No required-field change, no behavior change. The flag was already
persisted, ledgered, and read at runtime; only the published contract
was behind.

## Verification

- tests/persistence-hardening.test.ts: 17/17 (T6 green)
- All six schema-consumer files (stale-interrupt-resume, retry-bounds,
  release-contract, list-queue, stall-handling, persistence-hardening):
  116 pass / 0 fail
- scripts/release-pack-smoke.mjs: pass (challenge confirmed)
- Full serial suite re-run (`bun test --parallel=1
  --max-concurrency=1 --timeout=60000`): 2458 pass / 0 fail / 2 skip
  across 261 files, exit 0 (see /tmp/glla-verify-suite.log)
- `npx tsc --noEmit`: clean (unchanged — JSON-only edit)

## Process note

A parallel `bun test` re-run (default flags) was attempted and produced
209 failures — invalid run, not a regression: this suite requires the
repo's serial flags (`test:all`), and parallel execution trips Bun's
"test() inside another test()" guard with cascading errors. Re-ran with
the canonical serial command.
