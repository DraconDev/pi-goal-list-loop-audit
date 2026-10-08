# Self-evident choices and same-model retry phase — 2026-10-08

**Operator direction** (note.md 2026-10-08): two pauses and one rotation order are
wrong.

1. The "self-evident choice" decision card (clean-web /pol/ inspection goal at
   16:54). A red contract command was being read as an "identical auditor
   objection" by the state-based no-progress stop; the goal paused with a
   decision card whose recommended answer was self-evident, and the goal agent
   fixed the underlying script twelve minutes later in commit `a951e6c019`
   (17:15) and the goal completed.
2. The main-model recovery rotation. On a 429 / `Token Plan usage limit`, the
   first failure rotated the session to a backup instead of retrying the model
   already chosen. A 5-second blip on the primary spent a different provider's
   quota to solve it; the operator read the switch as GLLA giving up.

## Outcome

- `countTrailingRepeatedDisapprovals` (`extensions/goal-loop-core.ts`) is
  now gate-aware. Mechanical pre-audit rows (`deterministic-pre-audit`) are
  transparent to the streak, matching `countTrailingComparableDisapprovals`
  which already skipped them. A red contract command cannot park the goal as
  an "identical auditor objection" anymore; the goal agent reads the gate and
  continues. The auditor-only streak still fires for real stalls, and the
  other caps (`auditCap`, `auditCapHard`) still bound the round count.
- Same-model retry budget (operator direction 2026-10-08). The CURRENT main
  model gets N consecutive retries (default 10, the
  `TRANSIENT_EAGER_ATTEMPTS` quantum) before the configured fallback chain is
  touched. Settings: `mainModelSameModelRetries` (0..100; 0 = legacy immediate
  rotation). Reason-agnostic: the existing envelope cadence applies inside
  the phase (eager 5s for transient, provider reset for hinted walls, ladder
  for persistent). A successful rotation resets the budget for the backup;
  a cycle reset re-seeds it. The status card surfaces the live counter.
- Three call paths in `probeMainModelRecoveryImpl` (resume-backup,
  cycle-reset, the rotation success path) all re-arm the supervised surface
  the same way. The un-pause+schedule block now lives in one helper
  (`resumeSupervisedRecoverySurface`); the three branches emit
  `main_model_probe` with `mode: "resume-backup" | "cycle-reset" |
  "same-model-retry"`.

## Files

- `extensions/main-model-recovery.ts` — `DEFAULT_MAIN_MODEL_SAME_MODEL_RETRIES
  = 10`, `MAX_MAIN_MODEL_SAME_MODEL_RETRIES = 100`,
  `normalizeMainModelSameModelRetries`, `sameModelRetriesRemain`.
- `extensions/goal-loop-core.ts` — `MainModelRecovery.sameModelRetries?: number`,
  `sanitizeMainModelRecovery` bounds it, `formatMainModelRecoveryStatus`
  surfaces the live counter, `countTrailingRepeatedDisapprovals` skips
  mechanical pre-audit rows.
- `extensions/goal-recovery.ts` — `sameModelRef` exported;
  `parkMainModelAfterFailure` increments the counter; `tryMainModelFallback`
  (both entry points) and the cycle-reset branch reset it on accepted switch;
  new `resumeSupervisedRecoverySurface` helper; new same-model probe branch
  in `probeMainModelRecoveryImpl` keyed off `sameModelRetriesRemain`.
- `extensions/loops/goal-orchestrator.ts` — the generic recoverable branch
  in `handleMainModelAgentEnd` consults the same-model budget before calling
  `tryMainModelFallback`. The context-overflow carve-out before it keeps
  rotating for a model-cap problem.
- `extensions/goal-settings.ts` — `mainModelSameModelRetries` setting type,
  default, `GLOBAL_ONLY_KEYS`, sanitize guard (clamped 0..100, integer).
- `extensions/settings-menu.ts` — `Same-model retries before rotation` row
  with the operator description.
- `extensions/loops/goal-settings-ui.ts` — numeric editor case, shared with
  the menu.
- `docs/SETTINGS.md` — new row in the global-only table.
- `docs/RECOVERY.md` — "Same-model phase (v0.38.105)" section.

## Tests

- `tests/audit-no-progress-detection.test.ts` — new v0.38.105 test:
  10 identical gate rows → 0; byte-identical real auditor rows → 3; mixed
  and reversed histories; stair-stepped auditor + gate interleavings.
- `tests/same-model-retry-before-fallback.test.ts` (new) — pure
  `normalizeMainModelSameModelRetries` / `sameModelRetriesRemain` math;
  source-pinned gate wiring in the orchestrator and the probe path;
  integration: fresh recovery re-arms on current model (no setModel call,
  `main_model_probe` with `mode: "same-model-retry"`); budget exhausted
  walks the chain; legacy 0 budget preserves immediate rotation;
  `parkMainModelAfterFailure` extends the counter across same-model calls
  and `tryMainModelFallback` resets it on accepted switch; sanitize bounds
  to the cap; status surfaces the live counter.
- `tests/main-model-recovery.test.ts` — pre-existing "runtime fallback
  walk" test now sets `sameModelRetries: 10` so it still exercises the
  chain path; the same-model contract is covered by the new file.

## Scope boundary

GLLA only. The decision-card picker, the audit-state machine, the
fallback-chain selector, the goal/list/loop state schema, and the
recovery-host timer wiring are unchanged. No other plugin, no provider
config, no extension boundary touched.
