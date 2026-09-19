# Steering report disposition — 2026-09-19

## Report

> child completed before consuming steering

## Ownership check

This behavior is not implemented by GLLA. The repository has no steering or
steer-delivery code; GLLA only invokes the external `pi-subagents` host
surface. No GLLA source or fresh-audit ledger entry was changed for this
external-only report.

## Evidence

The installed upstream `pi-subagents` implementation explicitly defines
`unconsumedSteerReason()` in
`/home/dracon/.pi/agent/npm/node_modules/pi-subagents/src/runs/background/steering.ts`.
`run-child-session.ts` calls it when an accepted steering request has no
matching child `message_end` before settlement, and
`subagent-runner.ts` terminalizes queued requests with the same reason during
run shutdown. The message therefore describes an unconsumed request at child
settlement; it is not proof that a GLLA continuation or audit dispatch dropped
an input.

The installed upstream package is `pi-subagents@0.69.0`. Its changelog records
prior fixes for accurate steering-consumption reporting and keeping native
children alive while queued steering/follow-up work remains pending (the
0.67.0 fixes). This repo's lockfile pins the separate development dependency
at `0.62.0`; changing that external dependency is outside this GLLA audit.

## Disposition

External-only upstream behavior; no GLLA FIX or DECIDE finding. If the report
reproduces against the older pinned package, route it to `pi-subagents` or
upgrade that dependency under a separately authorized dependency goal. No
external files were modified.

BLOCKERS: none for GLLA.
