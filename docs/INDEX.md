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
- [Vision assist](VISION-ASSIST.md): image evidence and provider routing policy.

## Contribute

- [Architecture](ARCHITECTURE.md): entry points, work lifecycles and persistence.
- [Design reference](DESIGN.md): implementation concepts and lifecycle details.
- [Long-running supervision](DESIGN-long-running-supervision.md): progress, recovery and terminal communication.
- [Subagent visibility](DESIGN-subagent-visibility.md): supervisor/worker display responsibilities.
- [Promotion contract](PROMOTION-CONTRACT.md): queue item → active goal → archive.
- [Runtime inventory](RUNTIME-INVENTORY.md): generated source and registration counts, not coverage claims.
- [Release process](RELEASING.md): validation and npm publication.
- [Historical positioning and decomposition](GLLA-POSITIONING-AND-DECOMPOSITION-2026-08-08.md): dated ecosystem research and the decomposition rationale; not a current companion API reference.

## Versions and shipped content

[CHANGELOG.md](../CHANGELOG.md) records the release history from
v0.35.14–v0.39.22 and unreleased work. `/glla version` reports the loaded version
and registry comparison. A checkout can contain changes not yet published.

The package includes this documentation, [examples](../examples/),
[prompts](../prompts/) and [schemas](../schemas/). The full tests, tracked audit
evidence and local `.research/` material remain repository-only. Runtime
journals and archives live under the selected state root, not inside the
published package.

`/glla bug` captures diagnostic context under the state root's `bugs/` directory
without changing the objective journal. Review captures for sensitive content
before sharing them.
