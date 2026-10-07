# Fresh project audit — 2026-10-07

## Contract and boundary

One fresh pass in the repository rooted at `/home/dracon/Dev/pi-plugins/pi-goal-list-loop-audit`, on existing branch `main`. No parent/sibling or nested Git project was surveyed or modified. Source changes were committed by the existing auto-committer with configured identity `DraconDev <dracsharp@gmail.com>`; no identity/branch changes or history rewriting were performed.

## Parallel survey evidence

One async workflow `ec304f3d-547f-4b35-8e95-3c3090227072` launched three fresh-context, read-only scout lanes together. Each had a named directory/file brief, a soft 35 / hard 40 tool-call budget, a ~150-line report cap and an instruction to stop/report partial results near the token limit. All three returned successfully; no scouts remain running.

- State lane `bee6447f-8032-4930-be39-4d4a620b84a1`: `extensions/loops/`, task/state/owner modules and related tests. Found task-verification replacement race and unbounded takeover signal-error recursion.
- Audit lane `0a4aae36-01e4-4253-8e07-d9e45ac14314`: auditor lifecycle/process, reviewer, completion summary and related tests/docs. Found outside-scope section loss and phantom queue-admission counts.
- Runtime lane `b373c717-685e-4b23-b4c2-cfaed7a4f15a`: continuation/recovery/heartbeat/quota modules, release scripts/workflows and related tests/docs. Found self-heal timer cancellation and goal-only recovery of parked loops.

Reports were compared against the prior findings ledger. The five new findings were appended to `.pi-glla/audit-loop/findings.md`, without re-reporting its historical findings. No DECIDE findings were found, and no outstanding DECIDE checklist lines exist.

This is a bounded sampled audit, not a claim that every line of the large codebase was inspected or that the repository is defect-free.

## Repairs and durable evidence

| Finding | Root-cause repair | Commits | Behavioral coverage |
| --- | --- | --- | --- |
| Task verification replacement race | Re-admit context and reject a changed goal object, task-list identity or serialized list after asynchronous verification | `ffb3f828`, `c2c67348`, typing correction `8e0c2d4f` | All three tools reject replacement goal, replacement list and in-place list changes; 29 task tests passed |
| Takeover signal-error recursion | Reclaim only after fresh classification proves quiet ownership; refuse a live signal failure after one attempt | `a2a19186`, `0f96814e` | Persistent EPERM is bounded and preserves owner; ESRCH with proven death reclaims; 20 owner tests passed |
| Reviewer outside-scope loss | Preserve heading scope through nested sections and extraction; informational report section is excluded from both enqueue and proposal | `1a59ba61`, `e4a01b17` | Section reset, nested headings, source boundaries and actual queue exclusion |
| Reviewer phantom admissions | Adapter returns actual admitted count; count rejected/partial admissions in ledger and notification, without a successful cascade claim when nothing was admitted | `1a59ba61`, `e4a01b17`, fixtures `b5677316`, `134a0726` | Rejected admissions in all modes, partial admission, architectural and clean-audit queues; combined reviewer/scope gate 65 passed |
| Continuation self-heal dead end | Separate settled recovery identity from in-flight dispatch; retain generation/lane fencing; restore only the same timeout-parked loop via loop scheduler; length continuation uses its own lane | `c4610b60`, `819d429b`, `01d75209`, `a12daed9`, final lifecycle correction `bdf845bc`; tests `10282e83`, `e6381e45`, `cd58130c` | Real timer callbacks recover goal/loop/length, acknowledge turn proof, respect replacement/user stops and exhaust a bounded budget |

All FIX entries have a checked box and real fix commits. The ledger's HIGH entry is supplemented by its appended verification correction for `bdf845bc`.

## Verification chronology (no failed run claimed green)

- Baseline `timeout 120 npm run check`: passed.
- Baseline `timeout 240 npm test`: timeout (124); not a full-suite success.
- Focused final gate before the lifecycle correction: 152 passed, 0 failed across 13 files.
- First `timeout 900 npm run release:check`: failed in the test stage (3321 passed, 1 skipped, 3 failed across 352 files, ~613 seconds). Existing goal/list resume and compaction recovery tests caught a compatibility flaw in the initial self-heal repair.
- Root invariant diagnosed: settled dispatch debt cannot occupy the in-flight slot. Corrected in `bdf845bc`, retaining existing recovery APIs and tests unchanged.
- `timeout 120 bun test --parallel=1 --max-concurrency=1 --timeout=15000 tests/behavioral-orchestrator.test.ts -t 'compaction releases a timed-out dispatch|resume releases an unacknowledged dispatch|missing start proof stands down durably'`: 3 passed, 0 failed (153 unrelated tests filtered).
- `timeout 90 bun test --parallel=1 --max-concurrency=1 --timeout=15000 tests/continuation-start-self-heal.test.ts tests/continuation-retry-persistence.test.ts tests/goal-loop-dispatch.test.ts`: 15 passed, 0 failed.

Final full release gate and independent reviewer rehearsal are pending; append their actual results before a completion claim.
