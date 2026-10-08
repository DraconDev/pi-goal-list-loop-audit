# Progress observability implementation — 2026-10-08

Status: initial pure report reducer implemented with four passing component regressions; lifecycle telemetry, read-only adapter, command and broader acceptance remain unfinished.

## Adopted scope

Progress visibility only. Existing project runs remain read-only. Scheduling, work selection, plateau/stop decisions, verification approval and requirement invalidation policies must not change. No release publication, tagging, upstream changes, or mutation/restart/migration of another project. Baseline observations: audit/LIVE-PROJECT-PROGRESS-2026-10-08.md.

## Architecture and invariants

- A shared pure progress reducer drives both the public `/glla progress` surface and a machine-readable reporting script. It consumes versioned compact receipts plus existing legacy journal records; it does not call ownership, persistence, recovery, scheduling or model APIs.
- The filesystem adapter reads the selected state root, rotated segments and current journal under explicit byte/file/line bounds. Truncated input, malformed records, schema mismatch, unknown roots, unavailable data and historical-only windows must be disclosed. Reports must not silently turn bounded-tail samples into lifetime totals.
- Receipt families cover session/runtime provenance, iteration/increment outcomes, requirement status deltas and phase transitions. Identity includes target/run/project, generation, iteration/cycle and audit attempt when known. Deduplication must not combine distinct runs or sessions. Observers are best-effort and must never alter the existing lifecycle outcome on I/O or projection failure.
- Outcome receipts preserve existing file-write/commit/spec-item progress signals before reset. These are activity, not capability delivery. Independently verified requirement evidence is a verification fact, not an unqualified claim of product shipment; the digest labels historical verification separately from present validity.
- Requirement deltas identify newly verified, reopened, blocked and unblocked IDs with their causal attempt/reason, including scope changes. Existing conservative reopening remains unchanged.
- Phase accounting distinguishes building, verification, retry/recovery and waiting; durations and usage carry observed/inferred/unknown provenance. Token counters are not currency, and no billing/cached-input assumptions are made. Missing intervals are not filled with invented work.
- Loaded-version provenance is captured at extension registration, not reread from a potentially changed manifest on every report. Legacy runs without registration evidence remain unknown.
- No raw transcript, secrets, unrestricted diagnostics or unbounded audit reports are copied into new events. Strings, ID lists and evidence references are bounded/redacted. The report links to evidence rather than duplicating it.

## Implementation register

1. Pure report model, uncertainty/attribution rules and bounded read-only adapter — pending.
2. Versioned lifecycle observers and retained activity signals — pending.
3. Public command and machine-readable reporting entry point — pending.
4. Sanitized observational replay and observational immutability checks — pending.
5. Lifecycle, cancellation, compatibility and failure-isolation regressions — pending.
6. Static/full release gates, committed evidence and clean tree — pending.

## Verification ledger

- Initial feature test run failed at module resolution because the new report module did not exist (0 pass / 1 fail / 1 error); this is a missing-feature baseline, not behavioral proof against an existing implementation. `/tmp/glla-progress-report-baseline.log`.
- After initial pure reducer implementation: `timeout 180 bun test --timeout=60000 tests/progress-report.test.ts`: 4 pass / 0 fail. Covers metricless housekeeping not becoming delivery, historical verification distinct from current reopening, separate run identities, and bounded/malformed input disclosure. `/tmp/glla-progress-report-first.log`.
- `timeout 120 npm run check`: exit zero after these additions. `/tmp/glla-progress-types-first.log`.
- The contract is NOT satisfied yet: these are component checks, not the required lifecycle, replay, public-interface or final full release gates. Previous-goal green gates are not evidence for this implementation.
