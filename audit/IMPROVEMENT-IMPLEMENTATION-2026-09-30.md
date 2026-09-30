# Project improvement implementation — 2026-09-30

Contract: implement all findings and the improvement plan in
[the project audit](FULL-PROJECT-AUDIT-2026-09-30.md), preserving GLLA's
ownership boundary, consent policies, and append-only git history.
Historical audit evidence remains immutable. This register describes current work.

## Findings

| Item | Required result | Status | Evidence |
|---|---|---|---|
| F1 | Race-safe owner acquisition/reclaim/refresh/takeover | Implemented; validated | 6-process/90-mutation, SIGKILL, malformed/stale observations; 32 integration checks |
| F2 | Interrupted runner always fails after cleanup | Implemented; validated | Real SIGINT/SIGTERM tests, including cooperative exit 0 |
| F3 | Test-owned detached workers and descendants are reaped | Implemented on Linux; validated; other platform limits documented | Owned registry, normal/abort escalation, stale-identity refusal; 17 worker integration checks |
| F4 | Compactor subprocess lifecycle cleans up on timeout/signals | Implemented; validated | 4 real compactor lifecycle cases plus auditor cleanup checks |
| F5 | Every supported serialized summary receipt can be acknowledged | Implemented; validated | Maximum ASCII/Unicode/control/backslash receipt checks |
| F6 | Crash-safe archive and summary delivery obligation | Implemented; validated | 48 persistence checks; cold Node SIGKILL at 3 boundaries; journal-to-outbox transfer |
| F7 | Old-generation probes cannot suppress new supervision | Implemented; validated | Rebind retirement and fresh progress checks in 54-test receipt/probe run |
| F8 | Consistent documented auditor defaults | Implemented; validated | README corrected; executable extension mirroring fixture |
| F9 | Runner propagates child failure; release stops on red tests | Implemented; validated | Real delayed child exit 7 and signal status tests; release uses && |
| F10 | Current findings/evidence/provenance register | Complete | Final source/log hashes and successful release provenance |
| F11 | Retry reset participates in test isolation | Implemented; validated | Composite reset membership and poisoned retry/timer regression |
| F12 | Mechanical filter pipe closure cannot crash caller | Implemented; validated | Node noisy early-filter exit, failing head status, cancellation checks |

## Improvement plan

| Area | Required result | Status |
|---|---|---|
| Architecture | Typed dependency interfaces for settlement, ownership, continuation, supervision; fewer ambient globals; explicit durable transition obligations | Implemented; validated: typed owner/settlement persistence seams plus ContinuationDeps/HeartbeatDeps; 183 → 179 bridge names; one state owner |
| Behavioral coverage | Deterministic lifecycle sequences and crash/persistence fault injection preserve the documented invariants | Implemented; validated: concurrent owners, cold SIGKILL, injected intent/outbox faults, rebind/compaction/restart sequences, gated delayed-verdict revision race |
| Compatibility | Supported peer range and version matrix, genuine platform coverage with explicit limits | Implemented: six actual Pi/platform boundary lanes passed; detached registry remains Linux-specific |
| Dependencies | Evaluate supported manifest/lock update, preserve upstream-only dispositions, validate advisory outcome | Implemented; validated: pinned Pi 0.99.1; affected entries 3 → 1; upstream brace-expansion shrinkwrap disposition retained |
| Canaries | Opt-in real-host checks with recorded versions and bounded spend, distinct from hermetic release validation | Implemented: disabled-by-default weekly/manual workflow; one-request token/payload/metadata-cost guard; stub tests pass; paid provider execution not requested |
| Audit policy | Visible skipped challenges, calibrated challenge metrics, explicit high-risk strictness option | Implemented; validated: strict full-tier option, skipped disclosure, existing ledger flip/skip metrics |
| Durability | Document and implement chosen process-crash/storage-loss semantics; verify relevant writes | Implemented: chosen process-crash recovery level, explicit power/storage-loss exclusion; cold process boundary tests |
| Performance | Reproducible cold-load/rotation/heartbeat/outbox/context/audit-cost measurements | Implemented: versioned synthetic runtime/context baselines; ledger retry counts, challenge outcomes, attempt elapsed cost; paid-provider costs not inferred |
| Operator surfaces | Clear work/progress/retry/pause/action state; ledger-derived failure-age and challenge outcomes | Implemented; validated: existing status plus /glla stats reliability table/JSON, no additional polling |
| Starvation warning | Notification latch rearms between episodes even during busy windows | Implemented; validated |
| Documentation | Generated small inventories, authoritative settings/compatibility description, coherent audit index | Implemented; validated: generated inventory with release drift check; settings, compatibility, reliability references; corrected index |
| Runtime-state policy | Reconcile AGENTS instructions with intentional exclusion of machine-local runtime state | Implemented |
| Final gate | Full release check succeeds on recorded current source with meaningful test coverage and no false success | Complete: exit 0; 2,928 pass, 1 skip, 0 fail; unchanged source digest |

No item is complete merely because another item passes. External host/provider
behavior will be recorded explicitly and addressed through GLLA hooks or
configuration where owned, rather than patched upstream here.

## Current targeted evidence

[Verification record](improvement-evidence-2026-09-30/targeted-verification.json)
contains saved logs and current source hashes. These are incremental targeted
checks; they are not a full release result. The ownership and settlement
protocols and their platform/storage limits are described in
[OWNERSHIP-AND-SETTLEMENT.md](../docs/OWNERSHIP-AND-SETTLEMENT.md).

Ownership now enters activation through `ProcessOwnerBoundary`; the bridge
registry was reduced from 183 to 179 names. Settlement now has a lexical
operation and injectable typed persistence context; continuation and supervision
retain their typed dependency interfaces. Other legacy subsystems still use the
bridge; this is a measured retirement step, not a claim of zero ambient state. The strict challenge
option preserves the default, requires confirmed full-tier approval when
enabled, and refuses unconfirmed legacy-worker approvals at the parent.


## Final validation and dispositions

`npm run release:check` exited **0** in 834.7 seconds: **2,928 pass, one skip,
zero failures** across 319 test files, followed by TypeScript, Node/jiti state
verification, offline auditor-extension verification, generated-inventory drift
check, package dry run, and installed-tarball RPC/skill/load smoke checks.
[Release provenance](improvement-evidence-2026-09-30/release-check.json) records
Node 22.22.2, Bun 1.3.14, exact file hashes, and identical before/after source
digest `d12d84e1962cbdc9335531b35dbf1dec5e0861f0a26a9eb1d30f0f538925349c`.
The different git heads reflect daemon commits to audit evidence; tested source
files did not change. [Full log](improvement-evidence-2026-09-30/release-check.log)
SHA-256: `ad161044149c59b49f91a58177e9e7c996a7b4ae1892dd4e859bf218408362a2`.

All six final compatibility lanes passed in
[run 36755234525](https://github.com/DraconDev/pi-goal-list-loop-audit/actions/runs/36755234525):
Pi 0.84.2 and 0.99.1 on actual Ubuntu, macOS, and Windows runners. Saved final
matrix metadata/logs accompany the local release evidence. Platform limits in
COMPATIBILITY.md remain part of the contract, including Linux-specific detached
registry and explicit Windows SIGKILL skips.

Earlier failed/stopped runs are retained, not relabeled as successes. The first
complete implementation run correctly stopped release validation on four stale
assertions and a recap timeout. The assertions now follow the durable settlement
phase/receipt obligation and shared cleanup helper; pause wiring is inspected as
syntax instead of through a comment-sensitive character window. Worker fixture
polls stop on failure and have bounded startup allowance. The live-progress test
advances its watchdog clock from real child events, preserving the legacy-wall
assertion while separate tests cover boot silence. Production timeouts were not
changed to accommodate fixture scheduling.

One subsequent suite stalled with a busy Bun process and an exited git child.
The runner stopped it with failure after the silence limit. Its cause remains
unresolved: the affected file passed independently and its preceding 25-file
sequence passed 222 checks; the final complete run passed. This is retained as
an observed, non-reproducing harness/host incident, not attributed to Bun or
silently treated as a GLLA code repair. No host, Pi, provider, or other-plugin
implementation was modified.

The remaining full dependency advisory is upstream `brace-expansion` 5.0.9 in
Pi's shrinkwrap. A supported Pi update removed two affected package entries;
the ineffective override was removed, and raw audit responses plus disposition
are retained. Process-crash recovery is the chosen durability level; power-loss
survival is outside the contract. Performance/context fixtures are synthetic,
ledger challenge cost is attempt elapsed time, and the opt-in real-provider
canary was not executed. No package tag or publication was performed.
