# Full audit pass — 2026-09-29 (v0.38.109 → v0.38.110, branch main)

One survey pass over the whole project, run to completion. Objective: leave
the project in a known state.

## How the pass ran

Four read-only `explore` children ran in parallel, one per subsystem, each
required to re-verify its own candidates and to report a `Retracted
candidates` section (a pass that only confirms is not a pass). The
orchestrator then re-read every kept candidate against the current tree before
recording it, and separately deep-reviewed the unreviewed v0.38.109 WIP the
auto-committer had landed.

| Area | Files surveyed | Findings kept |
|---|---|---|
| loop engine / auditor | goal-auditor-hooks (2513, full), goal-loop-auditor-process (2428, full), goal-loop, dispatch/forever/repetition/stats/backoff/shield, orchestrator | 4 (2 HIGH, 1 MEDIUM, 1 LOW) |
| continuation / recovery | goal-continuation, goal-heartbeat, goal-recovery, main-model-recovery, start-context, quota-retry | 1 (MEDIUM) |
| tools / state / docs | goal-tools, goal-activation, goal-list-queue, goal-session, state helpers, schemas, publish workflow, prompts, packaging, README/INSTALL | 4 (3 MEDIUM, 1 LOW) |
| UI / display | goal-commands, settings-menu/ui, goal-ui, pickers, agents-panel, completion-summary, drafting, timeline | 3 (2 MEDIUM, 1 LOW) |

## Result

**12 findings: 2 HIGH, 6 MEDIUM, 4 LOW — all fixed, all pinned by a test.**
No DECIDE findings: every candidate had one durable fix, so nothing needed a
direction call from the user.

The two HIGH findings are the same defect class as the field incident this
repo recorded on 2026-09-28 (`STUCK-AT-LAST-PART-2026-09-28.md`): **goals
stuck at the last part because the audit gate never opens.** That doc closed
the primary cause (a hard cap wired only into the inline settlement path,
v0.38.107). This pass found the cap still has two holes, and that the hole is
structural rather than incidental.

## HIGH 1 — the regression shield is an uncapped re-continuation treadmill

`extensions/loops/goal-auditor-hooks.ts:1887` — the shield branch approves
internally, fails the `<evidence>` contract, sets the goal back to `active`,
and calls `scheduleContinuation` before reaching any cap.

The v0.38.107 hard cap counts `disapproved` rounds
(`countTrailingComparableDisapprovals`, `goal-loop-core.ts`). A shield-block
row is `approved: true, disapproved: false`, so that counter walks to it,
`break`s, and returns **0**. The cap is structurally blind to the branch, not
merely mis-tuned on it.

Failure: an auditor that approves but cannot satisfy the evidence contract
returns this verdict every round → re-complete → re-audit → blocked again,
forever, with no cap, no ledger counter and no user-visible stop. Identical
shape to the hellhunter/junk-runner treadmill, on a path the cap never
measured.

## HIGH 2 — IMPOSSIBLE(partial) under aggressiveMode is the second one

`extensions/loops/goal-auditor-hooks.ts:2201` — same structure. The row is
`impossible: true, disapproved: false`, so the comparable streak breaks at 0
and the aggressive no-progress stop is gated on `result.disapproved` and never
fires. Only the non-partial impossible path is terminal or pausing.

Failure: an agent that narrows one axis per round while the auditor finds a
new impossible axis cycles indefinitely.

Both are fixed by one new primitive, `countTrailingUnsettledRounds`
(`goal-loop-core.ts`): it counts every trailing round that failed to **settle**
the goal, across all verdict classes — disapproval, shield block, impossible.
An approval (the only round that ends the loop) and an infra error (not a
verdict) both break the streak; mechanical pre-audit gate rows stay
transparent, as everywhere else. Both branches now pause on the same
`auditCapHard` the disapproval path uses, offering accept / resume / tweak /
cancel.

## HIGH 3 — the stale-recovery heartbeat could never re-arm

Found by a follow-up scout sent specifically at the gap this pass had left
(`goal-heartbeat.ts`, previously unread).

`extensions/goal-heartbeat.ts:1188` — `scheduleHeartbeatPoll` checks the
session generation **before** releasing its handle:

```ts
if (generation !== flags.sessionGeneration || flags.heartbeatTimer !== timer) return;
flags.heartbeatTimer = null;
```

The stale-terminal path bumps `sessionGeneration` but deliberately *preserves*
the timer (`goal-orchestrator.ts:466`, `if (!preserveStaleRecovery && …)`) so
a same-process handle that becomes healthy again can self-heal without
`/reload`. That preserved timer was armed under the **old** generation, so it
always took the early return — while still holding a handle to a timer that
had already fired and was dead.

Every re-arm site is guarded by `if (flags.heartbeatTimer) return`
(`scheduleHeartbeatPoll` and `startHeartbeat`), so one stale terminal killed
the heartbeat for the rest of the process: the zombie-abort, wedge, stall,
pending-latch, stranded-audit and subagent-hang watchdogs all went silently
dead. Recovery depended on an unrelated supervision event arriving — precisely
what the silent-handle-death scenario it exists for does not deliver.

The handle is now released first, and a generation mismatch re-arms for the
**current** generation instead of dying. A real `session_shutdown` still
clears and nulls the handle, so the new branch is reachable only on the
preserve path. Proved fail-before: reverting the ordering makes the new pin
fail on the stranded-handle assertion.

## MEDIUM — an alternating ladder defeated the cap that did exist

`countTrailingComparableDisapprovals` `break`s on a grader change so a
fallback re-baselines the streak. That is correct for a genuine re-baseline,
but each new claim re-resolves the chain from the top, so a primary auditor
that infra-fails on alternating rounds produces `D(B), D(A), D(B), D(A)…` —
count 1, forever, with `audit_cap_keep_going` firing indefinitely.

`trailingStreakGraderStable` existed to detect exactly this ("a cap resting on
it is measuring noise") and had **no production caller** — only a test. It is
now wired: when the trailing streak is not from one grader, the cap measures
`countTrailingUnsettledRounds` instead, and says so in the pause reason.

## The gate was already red when this pass started

The baseline `npm run test:all` failed one test, and the cause was the
unreviewed v0.38.109 WIP, not this pass. Proven, not inferred: the test passes
at `e1e2c905` (the commit before the WIP) and fails at HEAD.

v0.38.109 made the shared delay function eager for transient failures, and its
own comment names the auditor fallback lane as an intended beneficiary. But
`tests/auditor-fallback-unification.test.ts` still asserted the old ladder, so
the WIP shipped with a red gate that nobody ran. The test expectation was
stale, not the code — it now asserts the eager rung **and** adds the mirror
case that a billing wall still takes the bounded ladder, which is the half of
the contract that keeps the change honest.

## The other four

- **`/goal timeline` counted objections the runtime had settled.** It filtered
  `superseded !== true` raw, while every other consumer goes through
  `liveDisapproval`, which runs `backfillSupersededObjections` first. On a
  legacy history settled by a later approval the display said "address N open
  objections, then re-submit" for work the loop had already accepted. Now
  counted by a new `countLiveDisapprovals` that shares the runtime's rule.
- **The continuation self-heal budget could never be refilled.** The turn-start
  reset was gated on `continuationStartSelfHealTimer` being live, but both
  terminal paths null the timer without clearing the counter. After one
  episode spent its budget, the next stuck episode armed at the longest delay
  and immediately reported an already-spent budget with **zero** re-probes —
  dead automatic recovery for the rest of the session, blaming a budget spent
  on a long-resolved episode. Reset is now unconditional; the ledger row still
  fires only when a timer was genuinely armed, so the record keeps its meaning.
- **`buildTaskList` persisted blank subtask titles the published schema
  rejects.** `validateTaskProposal` checked the top-level title and the subtask
  *count* but never a subtask title, and `buildTaskList` wrote `s.trim()`
  unguarded. One stray newline in a proposed array produced a goal file that
  fails `title: minLength 1`, with nothing reported at write time. Rejected at
  the boundary now.
- **`INSTALL.md` contradicted the code on the auditor's default.** It claimed
  the auditor runs "with no extensions … by default", "extension-less
  session". The mirror is **on** by default (`enabled = mirrorSetting !==
  false`), and `README.md` said so correctly. A user following INSTALL would
  remove a provider extension to "fix" a problem that did not exist, and
  break their auditor. Corrected to state the real default and the opt-out.

## Two scout claims I disproved before recording

Recorded because a pass that only confirms is not a pass.

- **"The schema sets `additionalProperties: false`, so the five
  `PendingCompletion` fields the runtime writes are rejected."** False — there
  is no `additionalProperties` anywhere in `schemas/goal.schema.json`. The
  fields are genuinely undeclared (real drift, now typed), but no consumer was
  being rejected and the severity was wrong.
- **"A 503 ladder goes DOWN after the eager window."** Executed
  `mainModelFailureDelayMs(classify("503"), n, 15)` for n=1..32: `5000 ×10`,
  then 60s/120s/240s/480s/960s/1800s and flat. Strictly monotonic, terminating,
  and the cap holds. The transient window is bounded at 10 requests over 50s.

## Retracted by the scouts themselves

Recorded so a later pass does not re-tread them: non-atomic state writes (every
durable write is temp-file + `fs.renameSync`); `Goal` top-level schema drift
(46 fields ↔ 46 properties, zero drift both ways); vacuous tests (0 of 304
files with zero assertions, 0 `.skip`, 0 literal-truthiness asserts); prompts
naming a non-existent tool (all 14 registered names check out; the rest are
host pi tools or setting names); `auditVerdict.model` being omittable on the
infra path (the history write is gated on `auditorRan`); hard-cap bypass via an
early `return` (every pre-cap return is gated on `!result.disapproved` or on
`approved`/`impossible`); the four `findings.md` readers disagreeing on indent
(they agree, and read disjoint sets); `SETTINGS.md` ranges vs normalizer clamps
(every documented bound matches).

## Gate

`npm run test:all`: **2821 pass, 1 skip, 0 fail** across 306 files, plus
`tsc --noEmit` clean, the jiti state-split repro, and the offline auditor
extension verification.

New pins: `tests/audit-unsettled-treadmill-cap.test.ts` (8),
`tests/audit-followup-contract.test.ts` (12), plus one case added to
`tests/continuation-start-self-heal.test.ts`.

The HIGH 1 behavioural test was proved fail-before: against a worktree at
`e1e2c905` with the counter helper injected but the caps **not** wired, the
shield round leaves the goal `active` (`'active' !== 'paused'`). The other
unit pins fail against the pre-fix source by construction (the exports did not
exist).

## A note on the gate: this repo is edited while it is audited

Worth recording because it changes how a red gate must be read. The
auto-committer daemon and at least one other session were both writing to
`main` throughout this pass. Two consequences, both observed rather than
assumed:

- A `test:all` result is only authoritative for the commit it ran against. The
  run recorded here started at a HEAD that a concurrent session then moved
  (v0.38.111 landed in the same window), and reported a failure in
  `main-model-recovery.test.ts` that does not reproduce on the current tree —
  a torn read across a moving checkout, not a real defect. The final numbers
  below are from a run pinned to a recorded commit SHA.
- The v0.38.109 → v0.38.111 WIP chain was never reviewed by anyone before it
  reached `main`, which is how a red gate shipped twice. The lesson generalises
  past this repo: on a watched repo, the daemon will happily publish
  unreviewed work that fails its own gate, and "the tests were green last
  time" is not evidence about the current tree.

## What this pass did not cover

Recorded so silence is not read as cleanliness:

- `goal-heartbeat.ts` (1921 lines) was read only in targeted regions; the
  zombie-run watchdog, the context-starvation latch, and the
  `continuousSupervisor.check` backoff ladder are unreviewed. This is the
  largest gap.
- `goal-tools.ts` (4100 lines), `goal-activation.ts` (3484) and
  `goal-commands.ts` (3407) were read at their tool-registration, persistence
  and display seams, not paged end to end.
- `goal-loop-shield.ts` (996) was not read at all.
- The two HIGH findings are **structural, not field-observed**: both need a
  repeated same-class verdict to spin. No ledger in this repo or the fleet was
  checked for a goal that actually hit them. That is the honest limit of this
  pass — the shape is proven, the incidence is not.
- Whether a goal-level iteration counter outside these files bounds the two
  branches: none was found, but `runGoalOrchestrator` was not traced.
