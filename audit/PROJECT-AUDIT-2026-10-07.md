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

## Final verification and known state

The fresh-context reviewer rehearsal (`0ee9e521-b62e-40e7-a579-02320fa749c7`) reported no issues, Merge verdict OK with notes, BLOCKERS none. It independently inspected the five lifecycle repairs, their behavioral tests, ledger boxes, production queue adapter, and commit evidence via the local reflog. It did not execute tests; command evidence below is from the parent.

Full release attempts are NOT represented as green:

1. The initial run found the three resume/compaction regressions, repaired in `bdf845bc` as documented above.
2. The next run stalled in `tests/loop-branch-ownership.test.ts` after a 60-second test timeout. A bounded isolated rerun of the entire file passed all 10 tests.
3. The following run completed with 3323 pass, 1 skip and 1 fail: an old source pin required the variable name `record` instead of the correctly settled `unacknowledged` argument. The pin was updated to require the terminal record in `3fd4c602`, without changing its semantic requirement.
4. The latest full run completed with 3323 pass, 1 skip and 1 fail: `parent tool watchdog honors the worker-armed granted budget` in the unchanged `tests/auditor-process.test.ts`. That case passed all 10 bounded repetitions; the complete auditor-process file plus stall-handling file then passed 87 tests, zero failures. This intermittent full-suite failure remains an observation, not a fabricated root-cause finding. There is no single all-green `release:check` run from this pass.

The final validation strategy pivoted to bounded isolated-file reruns instead of repeatedly chasing a clean aggregate run. Remaining limitation: aggregate suite intermittency is not diagnosed by this sampled audit. No release/tag/publish action was performed.

Additional final commands:

- `timeout 120 bun test --timeout=60000 tests/loop-branch-ownership.test.ts`: 10 pass, zero failures.
- `timeout 120 bun test --timeout=15000 --rerun-each=10 tests/auditor-process.test.ts -t 'parent tool watchdog honors the worker-armed granted budget'`: 10 pass, zero failures (490 filtered).
- `timeout 180 bun test --parallel=1 --max-concurrency=1 --timeout=60000 tests/auditor-process.test.ts tests/stall-handling.test.ts`: 87 pass, zero failures.
- `timeout 180 bash -c 'npm run check && npm run test:jiti && npm run test:auditor-extensions && npm run check:inventory && npm pack --dry-run && node scripts/release-pack-smoke.mjs'`: typecheck, jiti state identity (1 pass) and offline auditor-extension checks passed; inventory detected expected count drift from this repair and stopped later stages.
- Regenerated inventory with `timeout 30 node scripts/generate-inventory.mjs`, committed in `f4ee01b4`.
- `timeout 180 bash -c 'npm run check:inventory && npm pack --dry-run && node scripts/release-pack-smoke.mjs'`: inventory, dry-run package and packed launcher/worker/skill smoke all passed.

## Prompt-to-artifact completion checklist

1. Fresh 3+ parallel scouts: successful single workflow and three tight briefs/run IDs above. Satisfied.
2. New findings appended/deduplicated: five new FIX entries at the ledger's 2026-10-07 section; no new DECIDE entries. Satisfied.
3. Every new FIX repaired and committed on the existing branch/identity: table above plus lifecycle correction and source-pin/inventory commits; no branch/identity changes or history rewrites. Behavioral regression and typecheck evidence recorded. Satisfied.
4. DECIDE raised and recorded: none found; no outstanding DECIDE checklist lines. No work queued without a decision. Satisfied.
5. Honest known state: five checked FIX boxes with real commits, no fabricated findings; full-suite failure history and intermittent remainder retained rather than hidden. Satisfied, with the explicit aggregate-test limitation above.

## Detached challenge repair and final resubmission

The primary detached auditor independently passed 160 tests and typecheck and approved the original five repairs. Its required falsification round then correctly disapproved a new regression introduced by scope preservation: text-only deduplication let an outside-scope finding suppress identically worded local work when the external report appeared first. This is a sixth concrete FIX in the same pass, not a second survey.

- Ledger: appended the HIGH scope-deduplication finding; checked only after fix commit `73f60ada` existed.
- Root repair: deduplication identity includes effective scope and text; both scoped identities survive while same-scope copies still collapse.
- Behavioral regressions `18c13764`: both source orders, repeated same-scope sources, exactly one local admission and one informational external finding, no external proposal.
- Read-only before/after VM probe of the actual pre-fix committed module versus current module: `{"beforeLocal":0,"afterLocal":1}`. No main-branch code was temporarily reverted.
- `timeout 90 bun test --timeout=15000 tests/reviewer*.test.ts tests/auditor-scope-guard.test.ts`: 67 pass, 0 fail across 6 files.
- Final focused gate (14 files, continuation/task/owner/reviewer/scope/stall lifecycle): 191 pass, 0 fail in ~10 seconds.
- `timeout 150 bash -c 'npm run check && npm run check:inventory && node scripts/release-pack-smoke.mjs'`: typecheck, inventory and packed launcher/worker/skill smoke passed. Inventory regeneration committed in `927ec315`.
- Prior reviewer could not resume after runtime replacement (exact status and resume attempts both returned Async run not found). A labeled fresh-context same-role fallback reviewed only the challenge repair: run `8f3bedbf-8f16-496c-a202-bf20a9eb9736`, no issues, Merge verdict OK with notes, BLOCKERS none. It inspected current source and both-order tests; parent command results are separately recorded above. Reviewer completed before resubmission.

Final total: **six NEW FIX findings, all checked and committed; DECIDE none; zero outstanding FIX/DECIDE checklist lines**. The earlier aggregate-suite intermittency limitation remains explicit and unchanged; no release-readiness claim is added.
