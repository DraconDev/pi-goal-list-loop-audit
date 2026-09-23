# /glla resume + /loop resume dropped the manual-recovery probe under a load hold (2026-09-23)

Field: dracon-utilities, goal `20260922161844-0l2jg5` (L1+L2 bucket asset
system). A deterministic-400 manual hold (opencode-go `encrypted_content`
refusal) was cold-loaded — load hold engaged — then `/glla resume`
consumed the manual hold and the goal stayed parked. Ledger: the resume
state row matches `manuallyResumeMainModelRecovery` output exactly
(active=current model, attempts=0, hold flags cleared), then NOTHING — no
probe event, no timer, goal still paused/blocked. User: "resuming this
failed".

## Root cause

`probeMainModelRecovery` bails silently on `supervisorPaused(state)`,
which is true when EITHER `supervisorPausedAt` OR `loadHoldAt` is set
(extensions/goal-loop-core.ts). `/goal resume` and agent-resume release
the load hold at entry; `/glla resume` (`cmdGllaResume`) and `/loop
resume` (recovery branches) did not:

- `cmdGllaResume` cleared only `supervisorPausedAt`, then called
  `manuallyResumeMainModelRecovery` and returned. The fired probe hit
  the `loadHoldAt` gate and vanished: hold consumed, probe dropped,
  nothing armed. (Not `/goal resume`: no `load_hold_released` event and
  `loadHoldAt` still set in the final state rule it out; kind=goal
  rules out loop-resume; no agent-resume provenance event rules that
  out.)
- `cmdLoop`'s manual-resume/retry branches return before the
  held-loop path's downstream `clearLoadHold` — same wedge for
  loop-kind recoveries.

## Fix (v0.38.96)

- `cmdGllaResume` releases the load hold (ledger `load_hold_released`,
  via `glla-resume`) before the recovery branches — the function
  already claims the same consent semantics as `/goal resume`.
- `cmdLoop` releases the hold at resume-branch entry (via
  `loop-resume`); the downstream release becomes an idempotent no-op.
- Regression: two tests in tests/load-without-autostart.test.ts pin the
  field shape (paused + manualResumeRequired + cold-load hold) for both
  commands — hold released, probe dispatched, work re-armed. Both fail
  without the fix.

## Workaround (v0.38.95, no upgrade needed)

Run `/goal resume`: it clears the load hold first, then takes the
normal unpause path (the manual hold is already consumed) and schedules
a continuation on the current session model.
