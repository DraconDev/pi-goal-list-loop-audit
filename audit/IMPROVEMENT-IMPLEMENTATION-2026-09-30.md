# Project improvement implementation — 2026-09-30

Contract: implement all findings and the improvement plan in
[the project audit](FULL-PROJECT-AUDIT-2026-09-30.md), preserving GLLA's
ownership boundary, consent policies, and append-only git history.
Historical audit evidence remains immutable. This register describes current work.

## Findings

| Item | Required result | Status | Evidence |
|---|---|---|---|
| F1 | Race-safe owner acquisition/reclaim/refresh/takeover | Implemented; final gate pending | 6-process/90-mutation, SIGKILL, malformed/stale observations; 32 integration checks |
| F2 | Interrupted runner always fails after cleanup | Implemented; final gate pending | Real SIGINT/SIGTERM tests, including cooperative exit 0 |
| F3 | Test-owned detached workers and descendants are reaped | Partial | Suite-group escalation and inherited-pipe checks pass; detached-worker registry remains |
| F4 | Compactor subprocess lifecycle cleans up on timeout/signals | Implemented; final gate pending | 4 real compactor lifecycle cases plus auditor cleanup checks |
| F5 | Every supported serialized summary receipt can be acknowledged | Implemented; final gate pending | Maximum ASCII/Unicode/control/backslash receipt checks |
| F6 | Crash-safe archive and summary delivery obligation | Implemented; final gate pending | 48 persistence checks; cold Node SIGKILL at 3 boundaries; journal-to-outbox transfer |
| F7 | Old-generation probes cannot suppress new supervision | Implemented; final gate pending | Rebind retirement and fresh progress checks in 54-test receipt/probe run |
| F8 | Consistent documented auditor defaults | Implemented; final gate pending | README corrected; executable extension mirroring fixture |
| F9 | Runner propagates child failure; release stops on red tests | Implemented; full release gate pending | Real delayed child exit 7 and signal status tests; release uses && |
| F10 | Current findings/evidence/provenance register | In progress | This register plus source/log hashes; final release provenance remains |
| F11 | Retry reset participates in test isolation | Implemented; final gate pending | Composite reset membership and poisoned retry/timer regression |
| F12 | Mechanical filter pipe closure cannot crash caller | Implemented; final gate pending | Node noisy early-filter exit, failing head status, cancellation checks |

## Improvement plan

| Area | Required result | Status |
|---|---|---|
| Architecture | Typed dependency interfaces for settlement, ownership, continuation, supervision; fewer ambient globals; explicit durable transition obligations | Open |
| Behavioral coverage | Deterministic lifecycle sequences and crash/persistence fault injection preserve the documented invariants | Open |
| Compatibility | Supported peer range and version matrix, genuine platform coverage with explicit limits | Open |
| Dependencies | Evaluate supported manifest/lock update, preserve upstream-only dispositions, validate advisory outcome | Open |
| Canaries | Opt-in real-host checks with recorded versions and bounded spend, distinct from hermetic release validation | Open |
| Audit policy | Visible skipped challenges, calibrated challenge metrics, explicit high-risk strictness option | Open |
| Durability | Document and implement chosen process-crash/storage-loss semantics; verify relevant writes | Open |
| Performance | Reproducible cold-load/rotation/heartbeat/outbox/context/audit-cost measurements | Open |
| Operator surfaces | Clear work/progress/retry/pause/action state; ledger-derived failure-age and challenge outcomes | Open |
| Starvation warning | Notification latch rearms between episodes even during busy windows | Implemented; final gate pending |
| Documentation | Generated small inventories, authoritative settings/compatibility description, coherent audit index | Open |
| Runtime-state policy | Reconcile AGENTS instructions with intentional exclusion of machine-local runtime state | Implemented |
| Final gate | Full release check succeeds on recorded current source with meaningful test coverage and no false success | Open |

No item is complete merely because another item passes. External host/provider
behavior will be recorded explicitly and addressed through GLLA hooks or
configuration where owned, rather than patched upstream here.

## Current targeted evidence

[Verification record](improvement-evidence-2026-09-30/targeted-verification.json)
contains saved logs and current source hashes. These are incremental targeted
checks; they are not a full release result. The ownership and settlement
protocols and their platform/storage limits are described in
[OWNERSHIP-AND-SETTLEMENT.md](../docs/OWNERSHIP-AND-SETTLEMENT.md).
