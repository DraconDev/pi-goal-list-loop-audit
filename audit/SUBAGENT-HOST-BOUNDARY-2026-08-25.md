# Subagent host-session boundary — 2026-08-25

## Finding

The note.md screenshot concern was a real ownership bug, not merely expected
Explore visibility. GLLA is loaded into child sessions. The normal in-memory
child path was refused when a MAIN owner already existed, but three gaps
remained:

1. A child `session_start` arriving before the MAIN host could claim the
   owner-null plane and run restore/owner writes before the host appeared.
2. `/goal`, `/list`, `/loop`, `/glla`, and `/review` commands called
   `rememberCtx()` but then dispatched regardless of whether the context was
   foreign. Tools had a guard; slash commands did not.
3. A persistent child has a file-backed `SessionManager`. The old silent-host
   successor test treated any same-cwd file-backed context as a host after the
   old owner went stale, so a persistent Explore/general-purpose child could
   be absorbed as the host and mutate the main queue.

The durable telemetry path was separate and legitimate: the MAIN extension
receives `subagents:started`, `subagents:compacted`, and terminal events,
records `subagent_session`/hang evidence, and renders `/glla agents` from the
host context. That path must not be disabled while child contexts are fenced.

## Root invariant

A headless child context never owns or mutates the host goal/loop/list state
plane. Host lifecycle/rebind contexts remain admitted. Subagent lifecycle
telemetry is host-owned event data and remains visible through the existing
manager/event-bus integration.

`pi-subagents`' `AgentSession.bindExtensions()` uses the default headless
`print` context (and can also use `json`), with `hasUI === false`; this is the
stable worker discriminator. Session-file presence alone is not authority,
because `persistSession: true` children are file-backed too.

## Fix

v0.35.62 changes:

- `extensions/loops/goal-session.ts` adds `isWorkerSessionCtx` for headless
  print/json contexts. Worker contexts are rejected before owner-null claims,
  state-root registration, restore, tool repair, self-heal, or successor
  absorption. `isForeignCtx` and `foreignToolGuard` also fail closed for these
  contexts; missing tool execution context no longer falls back to the host.
- `extensions/loops/goal-activation.ts` rejects child `session_start` before
  lifecycle state is touched and applies the same guard to every slash-command
  surface. A file-backed interactive host successor remains eligible for the
  existing silent rebind path.
- `tests/subagent-host-boundary.test.ts` covers first-claim prevention,
  foreign slash-command refusal, persistent-child refusal after the host goes
  stale, legitimate host successor admission, and durable Explore telemetry.
- README, changelog, package metadata, and this audit record the boundary.

No telemetry event listener or `/glla agents` rendering path was removed.

## Verification

- Focused host-boundary suite: **3 pass / 0 fail**.
- Existing lifecycle, orchestration, recovery, panel, ledger, and hang suite:
  **161 pass / 0 fail** across 7 files.
- `npx tsc --noEmit`: **passed**.
- Fresh `npm run release:check` (`/tmp/rc-subagent-final3.log`): **1579 pass /
  0 fail / 2 skipped**, 1581 tests across 145 files in 203.68s; Jiti smoke
  passed and `npm pack --dry-run` produced
  `pi-goal-list-loop-audit-0.35.62.tgz`.
