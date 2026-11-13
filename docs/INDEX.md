# Documentation guide

## Get useful work done

- [Product overview](../README.md): what GLLA does, who it is for, work shapes and trust boundaries.
- [Install and update](../INSTALL.md): setup, companions, auditor configuration and first run.
- [Practical workflows](WORKFLOWS.md): fixes, audits, backlogs, spec-driven builds and bounded improvement.
- [Recovery](RECOVERY.md): saved work, resume commands, stale saved records and restore-as-new, provider fallback, compaction and completed objectives.
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
v0.1.0-alpha.1 (2026-07-19) through v0.40.0 (2026-11-13), including an audit
lane that waits for the provider's quoted reset (even a weekly one) instead of
re-arming a five-minute timer, uses a configured fallback model instead of
re-walking the failed one, and stops to ask after six hours without a verdict
instead of retrying an exhausted quota forever — and the final-audit lane
reading the failure class the auditor already recorded — an
auditor-owned crash keeps the bounded ladder, the slowdown marker and the
horizon instead of being handed to the provider lane's unbounded five-minute
cadence — every provider error keeping retry authority — a concurrency wall arriving as HTTP 400 retries promptly instead of parking, and its `resets <ISO>` deadline is honoured as an upper bound — saved goal records that stop pretending to be live work (`/goal recover` classifies every projection and previews a round-trip-checked restore-as-new recipe) and a parked completion audit that names its real cause instead of blaming the auditor, the release gate judging only text it can prove is new, multi-area completion claims that are refused until they can be read rather than shipped as one opaque bullet, dropped connections, timeouts and 429s sharing one aggressive durable retry, tweak cards as labelled quote blocks, and an auditor switch that is now global-only — one switch for every project, where session inheritance follows each session's live model and thinking — and approval through the Confirm gate instead of a typed tweak, an operator-surface pass that stopped asking the user to act on finished work — a terminal goal retires its main-model recovery marker, a clean list completion starts the next item on its own, `/glla wipe` went from 912 ms to 71 ms by not rescanning 280 MB of history, the tweak confirmation shows the exact objective pair with the rationale behind a toggle, the audit card names the model that actually ran, and a stale loaded build warns instead of silently explaining the wrong source — a `/glla` settings surface that keeps its promises — a reachable Version indicator row, and a postaudit editor that no longer forgets an option an earlier edit saved — a release gate that no longer reports a busy machine as a broken one, interrupted audits that never claim the operator aborted them, a version indicator that is a choice of one surface, declared Pi 1.x support, auditor liveness that survives an unavailable identity probe, one-surface card rendering, a readable task-amendment dialog and system-wide draft auto-accept, authenticated auditor verdicts, fail-closed crash recovery, session inheritance and ten-slot role fallbacks, clearer
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
