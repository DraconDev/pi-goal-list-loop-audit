# Now

## Replan/repair UX audit

Recheck the repair-card path from the saved-intent screenshot and make sure a
malformed list item cannot keep re-firing forever, the original target remains
recoverable, and `/list next`/`/list resume` are always the truthful actions.
Include the replan-required surface: its original target, concrete recovery
step, and queue position must stay visible without the repair card becoming a
new source of indefinite churn.

Evidence:
- /home/dracon/Pictures/Screenshots/Screenshot_20260823_181617.png

# Next

## PR #21 — review only, no wholesale merge

Recheck the repair-card path from the saved-intent screenshot and make sure a
malformed list item cannot keep re-firing forever, the original target remains
recoverable, and `/list next`/`/list resume` are always the truthful actions.

Evidence:
- /home/dracon/Pictures/Screenshots/Screenshot_20260823_181617.png

## PR #21 — review only, no wholesale merge

https://github.com/DraconDev/pi-goal-list-loop-audit/pulls/21

The state-root portion has already been ported and hardened on `main`; the
blank-until-resume auditor-surface work was developed separately and is now
hardened on `main`. Do not merge or close this PR without explicit
confirmation. Revisit only to extract any still-unported, independently
useful change.

## Release

Its been a while

## Investigate 

https://github.com/DraconDev/pi-goal-list-loop-audit/issues
https://github.com/DraconDev/pi-goal-list-loop-audit/pulls

# Next 2

## Compaction fallback for long goals

Sometimes a large goal gets stuck because the current model cannot compact its
context. Evaluate a dedicated compact/recovery fallback model path, including
whether a free model is acceptable, without treating this as a price hack.

# Later

## Better status visuals

The status/widget surfaces deserve a visual pass: decide what a user needs to
see for active work, queues, auditor state, stalls, and recovery without
turning the TUI into a wall of text.

Evidence:
- /home/dracon/Pictures/Screenshots/Screenshot_20260822_132806.png
- /home/dracon/Pictures/Screenshots/Screenshot_20260822_200250.png

## Documentation refresh

Update the README and docs for new visitors after the current behavior settles;
start with the installation and first-use path rather than an exhaustive
changelog narrative.

## `/list add` accidental command

I rarely use `/list add` and sometimes type it instead of an audit. Revisit
command wording/completion only after `/list audit` semantics are settled.

## `/glla bug` capture flow

Consider a `/glla bug` command that records observed failure context and useful
logs, while keeping the capture artifact separate from durable goal state.

## audit other goal plugins


# Idea

## Audit command naming

`/list audit`, `/goal audit`, and `/loop audit` may need clearer distinctions
from `/list start`, `/goal start`, and `/loop start`. Avoid launching a broad
audit immediately when the user has not specified what they mean.

one problem is htat hte audit often goes outside the folder so i launch audit on a page 
then next i see everything is getting audited

## Fewer mid-execution questions

Questions are useful for real decisions, but interrupting a list/goal/loop for
routine implementation choices is costly. Save non-blocking questions for the
end, ask only when the choice changes the result, and gather more constraints
in the initial draft.

# Superseded / resolved

- **Repair/replan card blocked its own first turn:** fixed after Screenshot_20260825_173552.png. A repair card now gets one durable, generation-safe bootstrap continuation containing `propose_task_list` and the preserved target; repeated heartbeat attempts stop at the latch, while `/list resume` explicitly re-arms one retry. The card also shows the concrete recovery step and queue position.
- **Long-running subagent stalls:** fixed in v0.35.64. Children still warn at
  the short detection thresholds, then a frozen top-level tracked child gets
  one generation-fenced child-specific abort request after the configurable
  long threshold (default 30m); nested/unreachable children stay warning-only,
  and stale child probes no longer shield unrelated parent cleanup. Production
  control uses pi-subagents' existing root-session `subagents:rpc:stop` bridge;
  no upstream package patch is required, and the real AgentManager/RPC path is
  covered by `tests/subagent-stop-rpc.integration.test.mjs`.
- **Objective cannot complete / subagent called `complete_goal`:** the child
  session now fails closed at the host boundary; only MAIN may mutate goal,
  loop, or list state. Fixed and covered by the v0.35.62 host-boundary work.
- **List vanished after reload / `/list resume` had nothing visible:** queue
  hydration and queue-only visibility were repaired and released in v0.35.61.
- **Agent completed a goal in the middle of a list:** child ownership and exit
  handling were hardened in v0.35.62; retain the screenshot only as historical
  evidence unless a fresh reproduction appears.
- **Auditor selector parity:** auditor model selection now uses the model picker
  and chooses thinking immediately with the selected model; parity tests cover
  persistence and forbidden-model filtering. The standalone thinking row is a
  convenience path, not the primary selection flow.
