# Now

- v0.38.105: same-model retry budget (operator direction 2026-10-08) — the CURRENT main model gets N consecutive retries (default 10, the TRANSIENT_EAGER_ATTEMPTS quantum) before the configured fallback chain is touched. Settings: `mainModelSameModelRetries` (0..100; 0 = legacy immediate rotation). Reason-agnostic: the existing envelope cadence applies inside the phase (eager 5s for transient, provider reset for hinted walls, ladder for persistent). A successful rotation resets the budget for the backup; a cycle reset re-seeds it. Status card shows the live counter.
- v0.38.105: `countTrailingRepeatedDisapprovals` is now gate-aware — deterministic mechanical pre-audit fast-fail rows are transparent to the state-based no-progress stop, matching `countTrailingComparableDisapprovals`. A red contract command cannot park the goal as an "identical auditor objection" anymore; the goal agent reads the gate and continues (field 2026-10-08, clean-web /pol/ inspection goal at 16:54 was paused for ~12 min on a self-evident fix the goal agent then made in commit a951e6c019).

# Next

# Done 2026-10-08 — self-evident pauses + same-model retry budget

## some choices are truly self evident — ADDRESSED
Was: the state-based no-progress stop paused the clean-web /pol/ goal on
three byte-identical `deterministic-pre-audit` fast-fails (a bare
`bun run peek` with no URL). Now: `countTrailingRepeatedDisapprovals` is
gate-aware, so a red contract command can no longer park the goal; the goal
agent reads the gate and continues. Full decision-pause inventory in
`audit/RECOVERY-AND-AUDIT-PHASE-FIXES-2026-10-08.md` — the gate-blind stop
was the only defective self-evident pause; the rest (hard cap, soft cap in
non-aggressive mode, IMPOSSIBLE partial, shield treadmill, heartbeat stall)
are genuine human-decision points and stay.

## some weird main model recovery objective — ADDRESSED
Was: the first 429 / Token-Plan-limit failure rotated the session to a
backup. Now: the current model gets `mainModelSameModelRetries` (default
10, 0 = legacy immediate rotation) consecutive retries through the existing
envelope cadence before the chain is touched; a successful rotation restarts
the budget for the backup; the status card shows the live counter. See
`docs/RECOVERY.md` "Same-model phase (v0.38.105)". Screenshots were
`/home/dracon/Pictures/Screenshots/Screenshot_20261008_180530.png` and
`Screenshot_20261008_191653.png`; error was
`429: {"type":"server_error","message":"Upstream request failed: Rate limit exceeded. Please try again later."}`.

# later

# Testing

