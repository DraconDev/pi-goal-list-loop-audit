# Gettick stuck / missing pause tool — 2026-08-25

## Field evidence

`/home/dracon/Pictures/Screenshots/Screenshot_20260823_091841.png` shows a
parked objective after a model turn reported:

```text
Tool pause_goal not found
```

The same screen rendered the objective as `paused`, `safely parked`, owned by
the `glla recovery timer`, with an automatic retry several hours away. The
objective was therefore durable and visible after reload, but the model-facing
control needed to stop or resume the turn was unavailable at the point of
failure.

## Root cause

GLLA's tool definitions are registered lazily. Before v0.35.60, the active
set was repaired only at `session_start` and after `agent_end`. A separate
allowlist/modlist extension can replace Pi's active tool set between those
boundaries. The definitions remain registered, but the model-facing active set
no longer contains `pause_goal`; Pi then returns `Tool pause_goal not found`.
A recovery timer can still persist the paused state, which makes the resulting
screen look like a stuck objective rather than a tool-visibility race.

This is a bounded reproduction of the visibility race, not a claim that the
screenshot identifies which external extension changed the active set.

## Fix

v0.35.60 adds `ensureAgentToolsReady()` in
`extensions/loops/goal-activation.ts`. It re-registers the definitions and
runs the existing allow/hide policy repair immediately at `before_agent_start`,
plus `agent_start` and `turn_start` compatibility boundaries. Re-registration
is intentional because a replacement session can reset Pi's registry without
resetting GLLA's local `toolsRegistered` flag. Foreign-session and
stale-session gates remain before the repair, so child sessions do not claim or
expose the host's state plane.

The existing per-project `toolOverrides.hide` policy still wins after the
standard missing-tool self-heal; this fix does not override an explicit user
hide policy.

## Verification contract

- `tests/gettick-tool-visibility.test.ts`: after lifecycle restore, simulate an
  external active-tool replacement that resets both the active set and the
  registry, then verify `before_agent_start` restores and re-registers
  `pause_goal` and the tool remains callable.
- `npx tsc --noEmit`: must exit 0.
- `npm run release:check`: full suite must pass with zero failures.

## Boundary

This fix makes the model-facing GLLA tool set resilient to an intervening
active-tool replacement. It does not auto-cancel a legitimate timed wait or
change the durable pause/resume contract. The parked objective remains
resumable through the existing `/goal resume` or `/glla resume` command paths.
