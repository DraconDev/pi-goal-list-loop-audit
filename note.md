# Now

- v0.38.105: same-model retry budget (operator direction 2026-10-08) — the CURRENT main model gets N consecutive retries (default 10, the TRANSIENT_EAGER_ATTEMPTS quantum) before the configured fallback chain is touched. Settings: `mainModelSameModelRetries` (0..100; 0 = legacy immediate rotation). Reason-agnostic: the existing envelope cadence applies inside the phase (eager 5s for transient, provider reset for hinted walls, ladder for persistent). A successful rotation resets the budget for the backup; a cycle reset re-seeds it. Status card shows the live counter.
- v0.38.105: `countTrailingRepeatedDisapprovals` is now gate-aware — deterministic mechanical pre-audit fast-fail rows are transparent to the state-based no-progress stop, matching `countTrailingComparableDisapprovals`. A red contract command cannot park the goal as an "identical auditor objection" anymore; the goal agent reads the gate and continues (field 2026-10-08, clean-web /pol/ inspection goal at 16:54 was paused for ~12 min on a self-evident fix the goal agent then made in commit a951e6c019).

# Next

## some choices are truly self evident
/home/dracon/Pictures/Screenshots/Screenshot_20261008_180530.png
we can look into this and perhaps others we really should not be pausing on 

## some weird main model recovery objective
/home/dracon/Pictures/Screenshots/Screenshot_20261008_191653.png


## i think we are too eagerly falling back the main model we need to more eagerly retry


## this error and any time of error we see we just keep hammering the retry

 Error: 429: {"type":"server_error","message":"Upstream request failed: Rate limit exceeded. Please try again later."}

# later

# Testing

# Research
investigate

https://pi.dev/packages?name=goal
https://github.com/openai/codex
https://github.com/xai-org/grok-build
https://github.com/anthropics/claude-code
https://github.com/deepseek-ai/deepseek-harness & its plugins
