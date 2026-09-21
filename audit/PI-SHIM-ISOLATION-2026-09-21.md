# Pi-shim isolation: per-file process-state reset (v0.38.88, 2026-09-21)

## Premise correction

This item assumed the MockPi shim leaked Pi surfaces. Evidence says the
shim is faithful (auditor tests already use fake `pi` binaries via
`GLLA_PI_BINARY`; `customStubMode` covers both TUI shapes) and no live
order-dependence reproduces (suspect combos green: behavioral + status-ux
+ display 272/272, poisoner→victim pairs green). The real gap is
structural: 99 test files import `goal.js`, 21 call `activate()` with NO
afterEach reset, and the rest hand-pick from 17 scattered
`__testOnlyReset*` hooks — per-file isolation is folklore, and
`test:changed` subsets run in whatever order git yields.

## Change

- `__testOnlyResetProcessState()` composite in `loops/goal.ts`: invokes
  all 17 exported latch resets (owner/stale/terminal/ownership-recheck,
  starvation/tool-activity/quiet-watch, auditor surface + recovery,
  length-exhaustion/zombie-retry, overdue-backstop/zombie-watchdog/
  hang-probes, compactor, owner-heartbeat/stand-down). Zero cycle risk:
  no extension module imports `loops/goal.js`.
- `tests/harness/setup.ts` preload calls it before EACH file (verified:
  preload re-runs per file, same pid — 2 probe lines for 2 files).
  Dynamic `await import`, not static: `goal-ui` reads
  `GLLA_EAGER_SETTLE_MS` at module top level, and a hoisted static
  import would load the graph before the preload's env setup and re-arm
  the 2.5s production settle suite-wide.
- Existing per-test afterEach resets stay (idempotent defense in depth).
- Fixed the stale `mock-pi.ts` header claiming all behavioral tests live
  in ONE file.

Explicitly NOT covered: `state.goal` (files re-seed/restore per cwd; no
cross-file poisoning observed), cross-module timers (no test starts
ticker/heartbeat timers directly; unproven as a pollutant), persisted
disk state. If a future order-failure implicates one, extend the
composite — the membership pin forces the decision to be explicit.

## Verification

- New `tests/process-state-reset.test.ts` (3/3): poisoned starvation
  streak clears; poisoned owner claim releases (stranger foreign→clean);
  membership pin enumerates every exported `__testOnlyReset*/Clear*`
  and asserts the composite invokes it.
- `tsc` clean. Fast suite 2224/0 (256 files), slow suite 283/0 —
  no file depended on cross-file latch state.
