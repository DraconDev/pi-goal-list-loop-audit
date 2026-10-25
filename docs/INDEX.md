# Documentation guide

## Get useful work done

- [Product overview](../README.md): what GLLA does, who it is for, work shapes and trust boundaries.
- [Install and update](../INSTALL.md): setup, companions, auditor configuration and first run.
- [Practical workflows](WORKFLOWS.md): fixes, audits, backlogs, spec-driven builds and bounded improvement.
- [Recovery](RECOVERY.md): saved work, resume commands, provider fallback, compaction and completed objectives.
- [Settings](SETTINGS.md): files, precedence and available options.
- [Work-shape philosophy](../LIST-PHILOSOPHY.md): goals, work pools and loops.
- [Delegation skill](../skills/glla-delegate/SKILL.md): normal-chat queue requests and consent boundaries.

## Understand the boundaries

- [Compatibility](COMPATIBILITY.md): declared peers, tested environments and execution limits.
- [Reliability and measurements](RELIABILITY-AND-MEASUREMENT.md): what telemetry and canaries do—and do not—establish.
- [Ownership and settlement](OWNERSHIP-AND-SETTLEMENT.md): runtime ownership and durable completion.
- [Truthful UI status](UI-STATUS.md): the workflow/execution projection behind what the status line claims.
- [Vision assist](VISION-ASSIST.md): image evidence and provider routing policy.

## Contribute

- [Architecture](ARCHITECTURE.md): entry points, work lifecycles and persistence.
- [Design reference](DESIGN.md): implementation concepts and lifecycle details.
- [Long-running supervision](DESIGN-long-running-supervision.md): progress, recovery and terminal communication.
- [Subagent visibility](DESIGN-subagent-visibility.md): supervisor/worker display responsibilities.
- [Work lifecycle and activity](DESIGN-work-lifecycle.md): lifecycle authority, observed activity and the wake contract.
- [Promotion contract](PROMOTION-CONTRACT.md): queue item → active goal → archive.
- [Runtime inventory](RUNTIME-INVENTORY.md): generated source and registration counts, not coverage claims.
- [Release process](RELEASING.md): validation and npm publication.
- [Historical scaffold plan](../PLAN.md): the v0.1–v0.7 milestone record; not current onboarding or commands.
- [Historical positioning and decomposition](GLLA-POSITIONING-AND-DECOMPOSITION-2026-08-08.md): dated ecosystem research and the decomposition rationale; not a current companion API reference.

## Versions and shipped content

[CHANGELOG.md](../CHANGELOG.md) records the full release history from
v0.1.0-alpha.1 (2026-07-19) through v0.39.54 (2026-10-25), including a `/glla` settings surface that keeps its promises — a reachable Version indicator row, and a postaudit editor that no longer forgets an option an earlier edit saved — a release gate that no longer reports a busy machine as a broken one, interrupted audits that never claim the operator aborted them, a version indicator that is a choice of one surface, declared Pi 1.x support, auditor liveness that survives an unavailable identity probe, one-surface card rendering, a readable task-amendment dialog and system-wide draft auto-accept, authenticated auditor verdicts, fail-closed crash recovery, session inheritance and ten-slot role fallbacks, clearer
waiting/completion messages, deterministic final-audit persistence,
provider-report preservation/privacy fixes and untagged v0.39.29 development
changes; the npm registry remains the publication authority. `/glla version`
reports the loaded version and registry comparison. A checkout can contain
changes not yet published.

The package includes this documentation, [examples](../examples/),
[prompts](../prompts/) and [schemas](../schemas/). The full tests, tracked audit
evidence and local `.research/` material remain repository-only. Runtime
journals and archives live under the selected state root, not inside the
published package.

`/glla bug` captures diagnostic context under the state root's `bugs/` directory
without changing the objective journal. Review captures for sensitive content
before sharing them.
