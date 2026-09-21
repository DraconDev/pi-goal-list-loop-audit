# Runtime-globals retirement, slice 2 (v0.38.87, 2026-09-21)

## Method

Consumer scan over all 207 registry names (extensions only, then
tests/scripts per candidate). 24 names are pure registry debt: every
consumer already has a direct-import path, so the `defineGoalRuntimeGlobal`
call, registry entry, ambient `var`, and typed entry (8 of them) delete
cleanly with zero behavior change:

- goal-session.ts (11): `classifySessionHandleInvalidation`,
  `ownerFilePath`, `SESSION_HANDOFF_FILE`, `SESSION_OWNER_FILE`, and 7
  `__testOnly*` — all re-exported through `goal.ts` or imported direct.
- goal-ui.ts (8): `recentActions`, `CONTEXT_STARVATION_REFUSE_THRESHOLD`,
  `CONTEXT_STARVATION_RECENT_WINDOW_MS`, `COMPACT_FIRST_NUDGE_PERCENT`,
  and 4 `__testOnly*`.
- goal-settings-ui.ts (3): `auditorThinkingLevels`,
  `promptSettingsMenu`, `promptModelRef` (source pins match the locals,
  which stay).
- goal-orchestrator.ts (1): `persistenceDegradedNotified` (pin-only).
- goal-auditor-hooks.ts (1): `EAGER_AUDITOR_RETRY_SEC` (pin-only).

Registry 207 → 183. No import cycles risked: nothing was rewired
except two test files (below); owning modules keep their locals.

## Test rewires (2)

- `recentActions`: the orchestrator test read it via
  `(globalThis as any)`. Now exported from `goal-ui.ts` and imported
  directly.
- `tests/starvation-ladder.test.ts` and
  `tests/behavioral-orchestrator.test.ts` used retired `__testOnly*`
  names through the ambient/globalThis path (`G = globalThis as any`
  alias in starvation — the scan's blind spot). Both now import from
  `goal.js`; the 5 behavioral call sites take `as any` casts, the
  file's idiom (37 precedents), since the real signature types the
  mock out.

## Verification

- `tsc --noEmit` clean — the strong check; it caught the one bare
  survivor (`__testOnlyRememberCtx` in behavioral-orchestrator).
- Contract + touched suites + whale: 219/219.
- Fast suite: 2221 pass, 0 fail. The 9 other slow files touching
  retired names: 90/90.
