# Loop obstacles should continue repair work — 2026-10-06

GLLA owns project state transitions and continuation. The builder previously
only offered a blocking transition, even for ordinary repair obstacles.
The public block_project_requirement tool now requires kind=work or kind=external.
Work needs reason and nextAction, keeps the requirement open, returns to replanning,
records repair feedback and retains the abandoned increment in history. Its reply
orders planning and continued building/refining in the same turn. No blocker action
card is emitted and no independent verification is claimed.

External dependencies retain the actionable blocker contract (summary, actor,
next step, expected result, inability to resolve within authorized scope). Other
open work continues. Only all-blocked projects hold. The classification is supplied
by the agent, not guessed from text by a deterministic truth classifier.

Correcting a mistaken blocker with kind=work releases only a blocker-only hold
and arms normal continuation after persistence. User pauses/stops and unrelated
recovery holds are preserved. Supervisor freezes, exhausted bounds and branch-mode
holds cannot be bypassed. New external blocker records also preserve an existing
user hold instead of rewriting it into a blocker-only hold.

The builder dispatch prompt explicitly directs proactive building/refining through
failed tests, missing evidence, unrun checks and implementation gaps, with work
reclassification for earlier mistaken blocker reports. Scope and acceptance stay
binding. No external project journals, processes or sources were changed.

Validation: 53 tests across six files passed; TypeScript, runtime inventory and
whitespace checks passed. Public-handler coverage exercises repair while active,
retained task history and next-step feedback, partial external dependencies,
all-external hold, mistaken-blocker correction and fresh batch planning, no claimed
verification, user-pause preservation even across new dependency records, and
existing stale/hold guards. Logs: loop-repair-continuation-2026-10-06/.

Prepared for 0.39.13; this task did not publish or reload live sessions.
