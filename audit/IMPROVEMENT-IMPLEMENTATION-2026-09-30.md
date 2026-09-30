# Project improvement implementation — 2026-09-30

Contract: implement all findings and the improvement plan in
[the project audit](FULL-PROJECT-AUDIT-2026-09-30.md), preserving GLLA's
ownership boundary, consent policies, and append-only git history.
Historical audit evidence remains immutable. This register describes current work.

## Findings

| Item | Required result | Status | Evidence |
|---|---|---|---|
| F1 | Race-safe owner acquisition/reclaim/refresh/takeover | Open | Competing-process regression required |
| F2 | Interrupted runner always fails after cleanup | In progress | Real signal regressions required |
| F3 | Test-owned detached workers and descendants are reaped | Open | Ownership registry and teardown regressions required |
| F4 | Compactor subprocess lifecycle cleans up on timeout/signals | Open | Real worker/descendant regressions required |
| F5 | Every supported serialized summary receipt can be acknowledged | Open | Maximum ASCII/Unicode/escaped receipt regressions required |
| F6 | Crash-safe archive and summary delivery obligation | Open | Settlement-boundary crash/restart regressions required |
| F7 | Old-generation probes cannot suppress new supervision | Open | Rebind/progress regressions required |
| F8 | Consistent documented auditor defaults | Open | Executable default fixture plus docs checks required |
| F9 | Runner propagates child failure; release stops on red tests | In progress | Real child-exit and downstream-gate regressions required |
| F10 | Current findings/evidence/provenance register | In progress | This register; final source-bound verification required |
| F11 | Retry reset participates in test isolation | In progress | Membership and poisoned-latch regressions required |
| F12 | Mechanical filter pipe closure cannot crash caller | In progress | Noisy early-exit and cancellation regressions required |

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
| Starvation warning | Notification latch rearms between episodes even during busy windows | Open |
| Documentation | Generated small inventories, authoritative settings/compatibility description, coherent audit index | Open |
| Runtime-state policy | Reconcile AGENTS instructions with intentional exclusion of machine-local runtime state | Open |
| Final gate | Full release check succeeds on recorded current source with meaningful test coverage and no false success | Open |

No item is complete merely because another item passes. External host/provider
behavior will be recorded explicitly and addressed through GLLA hooks or
configuration where owned, rather than patched upstream here.
