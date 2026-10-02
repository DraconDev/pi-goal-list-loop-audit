# Full audit + tasklist — 2026-10-02

Method: five read-only scout subagents (auditor lifecycle, display/UI,
loop engine, session/lifecycle, commands/queue) with tight briefs, then
parent verification of the highest-risk claims against the code. 47
scout findings; 8 verified, 2 corrected/downgraded, rest reported as-is
(each needs confirmation before implementation). Prior audit
(`CONTROL-UI-AUDIT-2026-10-02`, F1–F5 + U1–U5) is not duplicated except
where scouts sharpened it (L1 supersedes F2's strictness half).

Status key: VERIFIED (parent read the code) · REPORTED (scout claim,
file:line spot-checked) · CORRECTED (claim wrong as stated, real
variant noted) · DOWNGRADED (not a bug as stated).

## P0 — must fix before release (regression in unreleased tree)

### S1 VERIFIED — workerless gate breaks macOS audits
`workerProcessMatches` (`goal-loop-auditor-process.ts:919`) has a
win32 branch and a `/proc` branch; on Darwin the `/proc` read throws
→ `catch → false`. So `auditorWorkerLiveForAttempt` is always false
on macOS and the new heartbeat gate parks healthy in-flight audits
after 90s quiet. No `darwin` string exists anywhere in the process
or worker files. Fix: add a Darwin branch (`ps -o command=` +
cwd check), or gate workerless recovery to linux/win32. Test: live
worker respected on darwin (platform-gated stub), workerless still
recovers.

## P1 — verified majors

### A1 VERIFIED — intentional no-tool disapproval wiped into infra-retry
`goal-loop-auditor-process.ts:1871` returns disapproved:true with an
error; `normalizeAuditorInfrastructureResult` (`:102-124`) then
forces `disapproved:false` + error, so `hooks:2112`
(`result.error && !result.disapproved`) sends a deterministic policy
violation down the provider retry ladder instead of agent rework.
Fix: preserve intentional disapproval (marker flag normalize
respects). Test: no-tool approval → disapproved + rework, no ladder.

### L1 VERIFIED — respec handoff needs marker + complete spec in one turn
`goal-loop.ts:679`: `lastAssistantText` is the last message only.
Marker on turn N with incomplete spec, spec finished on turn N+1
without re-emitting the marker → no handoff, and no other path sets
`reconcile`. Metricless + unbounded ⇒ spins in draft billing turns.
Supersedes F2's strictness half. Fix: sticky marker (persist
markerSeen; handoff when spec later completes) or re-prompt for the
marker. Test both orders.

### C1 VERIFIED — fan-out dedupe prefix can never match
`goal-orchestrator.ts:1024` dedupes on
`` `Fix audit finding: ${text} — Done when:` `` but
`parseListItemDeclaration` (`goal-loop-core.ts:3928`) splits the
contract out of stored objectives, so `startsWith` never matches and
every `/list audit` re-run re-queues the whole open set (cap 50).
Fix: dedupe against the stored form. Test: re-run queues 0.

### C3 VERIFIED — tweak bumps revision in RAM before durable write
`goal-commands.ts:1045`: `state.goal = bumpGoalRevision(latest)` then
unchecked `updateGoal` (returns boolean, `goal-orchestrator.ts:921`).
A failed transaction write leaves a phantom revision in memory that
later persists. Same class as the fixed `complete_goal.newObjective`
case. Fix: carry `revision` inside the patch. Test: failed write
keeps old revision.

### D1 VERIFIED — loop card shows another goal's action, no age
`goal-loop-display.ts:2592` takes the raw last ring entry; the
v0.34.124 goal-scoping + recency fix (`:2449-2463`) was never ported
to `loopLines`, and the ring is process-global. A live loop card can
wear a dead goal's ✓. Fix: port scoping + recency. Test: loop card
ignores pre-loop actions.

### D3 VERIFIED (code-adjacent to U1) — blocked-with-timer triple contradiction
`goal-loop-display.ts:2314` renders `auto-retrying · next probe`
while `pausedNextTransition` (`:1217`) returns bare `/goal resume`
and the status chip (`:1454-1458`) says `action needed ·
auto-retry`. Three directives on one card. Fix with U1's language
pass. Test pins for all three rows.

### S2 VERIFIED-PARTIAL — session_start never resets in-memory dispatch
`goal-activation.ts:1868-1900` resets the stood-down latch,
watchdog, and disk record but never `resetContinuationDispatchState`
(`goal-continuation.ts:1952`); a stale in-memory ref then trips the
heartbeat early-return (`goal-heartbeat.ts:1507`) indefinitely.
Confirmed the missing call; permanent blindness needs an unsettled
dispatch (verify settle paths before fixing). Test: rebind with
stale ref → heartbeat recovers.

### L4 CORRECTED — loopPrompt draft branch derefs specFile unchecked
As stated (sendLoopTurn throw) it is wrong: that block's
`phase !== "draft"` guard excludes bare-draft loops. The real
variant: `loopPrompt` (`goal-loop.ts:392-399`) enters on bare
`respecPhase === "draft"` (no specFile check in
`respecNeedsDraftPhase`) and `path.basename(loop.specFile!)`
throws on corrupt/hand-migrated state missing specFile. All
producers set both, so minor robustness: guard + reconcile
fallback. Test: draft-phase without specFile neither throws nor
spins.

## P2 — reported majors (confirm, then fix)

Auditor: A2 attemptId rotation orphans prior workers
(`goal-auditor-hooks.ts:723`, reap uses the NEW id) · A4 recovery
blind spots: bare `catch → null` (`auditor-process.ts:1973`) +
same-ms tie refuses recovery (`:1944`) · A5 round-2 no-verdict
fail-open truncates falsification prose (`worker.mjs:1068-1069,777`)
· A6 `verificationIncomplete` poisons round-2 confirmations forever
(`worker.mjs:674,1062-1064` + `process:1849`) · A7 generation
handoff misreported as cursor-persistence failure
(`process:566-568`, `hooks:1200-1202`) · A8 unabortable fallback
sleeps strand claims incl. manual (`process:421,611,620`,
`hooks:1292`).
Loop: L2 draft prompt drops stuck-ladder intervention while the
ladder still kills (`goal-loop.ts:392-399` vs `:749-840`) · L3
mid-tick rebind discards the draft→reconcile handoff (`:679-687` +
`:647-660`).
Session: S3 mid-session generation bumps invalidate the shutdown
handoff (`goal-session.ts:798`, bumps at `:1672,:1770`) · S4
`freshCtx()` nulls `lastCtx` on any `isIdle()` throw, stranding
one-shot timers (`goal-orchestrator.ts:491`) · S5 workerless gate
unreachable under a stale latch (in-flight + dead worker falls
through at `goal-heartbeat.ts:1388-1401`).
Commands: C2 `/goal start` over an active loop stacks two live
things (`goal-commands.ts:332` explicit path skips loop-stop) · C4
`/list remove` on a group orphans invisible children (`:1774`) ·
C5 `addSingleItem` bypasses the zombie-twin guard (`:1838` vs
`:1207`) · C6 `/goal verify` clobbers a recovery-pending claim's
retry cursor (`:272`).
Display: D2 monitor badge unreachable, renders QUEUED
(`goal-loop-display.ts:1111,1563-1594`) · D4 auditor sessionPath
row raw/unbounded/unsanitized (`:1966`) · D5 stale-Next filter eats
legitimate next actions (`completion-summary.ts:220-239`).

DOWNGRADED, not tasked: A3 double-apply race — both apply paths are
synchronous from decision to claim-clear, so one runs fully first
and the second no-ops on the cleared claim (single process;
multi-process is ownership-fenced). Consider an assertion test only.

## P3 — minors (batch by area)

Display: D6 clause-cut floor dead math (`:113`, `finding-lead.ts`)
· D7 recap projections skip sanitization
(`completion-summary.ts:102-123,1258-1280`) · D8 filler Outcome
invents "done" (`:198`) · D9 IDLE/BUSY carries no freshness
(`:1537-1551,2109-2115`) · D10 NaN elapsed guard (`:2578,:1822`).
Loop: L5 prompt built twice per turn (`:587-592`) · L6 early
returns leave fired timer handle (`:471-474`) · L7
`countCheckedSpecItems` ignores indented boxes
(`goal-loop-forever.ts:703-709`).
Auditor: A9 history/log mutate before durability known
(`hooks:1806,1836` vs `:1865-1886`) · A10 NODE_OPTIONS passthrough
+ unvalidated sessionPath command render (`process:1562,1726`,
`hooks:1077`).
Session: S6 generation reassigned after RPC/heartbeat binding
(`goal-activation.ts:1954` vs `:1745,:1766`) · S7 stranded clock
measures session activity, masking worker death (`:1675`) · S8
rearm clears interrupt before dispatch confirmed
(`goal-session.ts:726`) · S9 overdue backstop latches before
dispatch, ignores failures (`:292`) · S10 `heal_failed`
ledger-only, silent mode refusals (`goal-loop-core.ts:3298`).
Commands: C7 conflict retry re-prompts after explicit cancel
(`:1094`) · C8 `/review <id>` silent substring ambiguity (`:1921`)
· C9 stale-probe save skip reports "saved"
(`goal-settings-ui.ts:213`) · C10 invalid hand-edited settings
silently degrade (`goal-settings.ts:616`).

## Tasklist (prioritized)

1. [P0] Darwin worker matching (S1) — add Darwin branch or
   platform-gate workerless recovery; tests both ways. Blocks
   release on mac.
2. [P1] Preserve no-tool disapproval (A1) — marker through
   normalize; test pins rework-not-ladder.
3. [P1] Sticky respec handoff (L1, supersedes F2) — markerSeen +
   late-spec handoff; test both orders.
4. [P1] Fan-out dedupe on stored form (C1) — test re-run queues 0.
5. [P1] Tweak revision inside patch (C3) — test failed write keeps
   revision.
6. [P1] Loop recent-action scoping (D1) — port goal fix; test.
7. [P1] Blocked-timer single directive (D3 + U1) — language pass;
   pin all three rows.
8. [P1] Reset in-memory dispatch on session_start (S2) — confirm
   settle behavior, then fix + test.
9. [P1] Guard loopPrompt draft specFile (L4) — corrupt-state test.
10. [P2] Confirm-then-fix batch A: A2, A4, A8 (worker/retry
    lifecycle).
11. [P2] Confirm-then-fix batch B: A5, A6 (challenge-round
    semantics) — needs a policy decision (fail-open vs
    fail-closed, flag lifetime).
12. [P2] Confirm-then-fix batch C: A7, S3, S4, S5 (generation/
    handoff fencing).
13. [P2] Confirm-then-fix batch D: L2, L3 (draft-phase
    interventions + rebind).
14. [P2] Confirm-then-fix batch E: C2, C4, C5, C6 (queue/command
    integrity).
15. [P2] Confirm-then-fix batch F: D2, D4, D5 (display
    correctness).
16. [P3] Minors batch display (D6–D10) + loop (L5–L7).
17. [P3] Minors batch auditor/session/commands
    (A9, A10, S6–S10, C7–C10).

## Verification performed by parent

- S1: confirmed zero `darwin` handling in process/worker files.
- A1: read normalize + hooks gate — wipe confirmed.
- L1: read handoff block — same-turn requirement confirmed, no
  other reconcile writer.
- L4: corrected line refs; loopPrompt variant confirmed.
- D1: read both branches — port gap confirmed.
- D3: code-adjacent to previously verified U1 area.
- C1: read dedupe + parser split — mismatch confirmed.
- C3: read bump ordering + updateGoal boolean — confirmed.
- S2: confirmed missing reset call; permanence conditional.
- A3: downgraded — sync atomicity argument above.
- All other findings: scout-reported, file:line spot-checked,
  logic not independently traced.

## Coverage

- Auditor lifecycle: process (2573), worker (1162),
  audit-lifecycle, auditor-extensions, launch fully; hooks ~95%.
- Display: display fully (minus ~70 skimmed lines), summary
  substantially, goal-ui substantially.
- Loop: forever + loop + dispatch + respec prompt fully; core
  skimmed (1–500 of 4961).
- Session: state fully; heartbeat 1200–2020, recovery 740–1080,
  activation 1654–2400 fully; session/core/dispatch/
  orchestrator/goal skimmed with spot reads.
- Commands: settings, list-queue, orchestrator fully; commands,
  tools, settings-ui strategic + hot spots.

## Implementation dispositions (parent pass, 2026-10-02)

Every P0/P1 item fixed + tested. Every P2/P3 item confirmed-then-fixed
with durable collateral, except the five downgrades below (traced, not
assumed). P3 line refs below are post-fix; scout refs drifted.

FIXED (behavioral test + pin where the rig cannot reach the failure path):
- S1 darwin worker matching (`workerProcessMatches` darwin `ps` branch).
- A1 no-tool disapproval to transcript, `disapproved:true` preserved.
- L1 sticky respec handoff (`respecMarkerSeen` + draft-marker gate).
- C1 fan-out dedupe on the stored objective form.
- C3 tweak revision inside the patch; `CommandDeps.updateGoal` widened boolean.
- D1 loop recent-action goal scoping + recency.
- D3+U1 blocked wording `blocked — resume to continue`, timer-only chip.
- S2 kept + pinned (both resets clear the ref).
- L4 `loopPrompt` specFile guard (degrade, not throw).
- A2 `priorAttemptId` lineage: rotation stamps + cancels the prior worker
  (`audit_prior_worker_cancelled`) + pre-dispatch reap at both sites.
- A4 unreadable-transcript ledger (`completed_audit_recovery_unreadable`).
- A5 abandoned challenge preserves prose to `challenge-abandoned.md`
  (bounded 8k; fail-open kept + evidence sidecar — batch B policy).
- A7 handoff quiet-stop: `refusalResult()` re-checks `isLive()` (7 sites).
- A8 abortable ladder sleeps (`AbortSignal` threaded, incl. tools path).
- A9 copy-before-append at BOTH sites (detached hooks + inline/Esc tools)
  + in-place-contract unit test. Second instance found during test design.
- A10 NODE_OPTIONS dropped from passthrough; session command quoted.
- C2 explicit `/goal start` stops the live loop (`stopConflictingLoops`,
  both paths; live in-session test + negative proof).
- C4 `/list remove` on a group cascades to queued children + sidecars,
  one Confirm; live-child goal refuses the whole remove.
- C5 direct-add zombie guard + `ts`/`at` cutoff fix.
- C6 `/goal verify` on recovery-pending resumes (fresh attempt by design).
- C7 conflict retry stops after explicit cancel (`cancelled` out-signal).
- C8 `/review` substring ambiguity refuses with the candidate list.
- C9 stale-probe save refusal throws through the menu NOT-saved catch.
- C10 dropped junk settings ledger `settings_invalid_ignored`, once per
  distinct (key, value) per process (no per-tick spam).
- D2 shared `foldWatchingActivity()`; D4 sanitized+bounded worker row;
  D5 noun-near-verb stale-Next filter; D6 floor scales; D7 sanitize in
  recap projections + audit gaps (approval-chat lines, counts line,
  extras twin routed to the quoted builder); D8 honest empty outcome;
  D10 non-finite elapsed clamp.
- L2 draft `${INTERVENTION_NOTE}` wired; L5 single prompt build;
  L6 timer handle cleared first (pin); L7 indented checkbox count.
- S3 owner-generation publish on mid-session bumps; S4 `freshCtx()`
  only drops `lastCtx` on stale-class throws; S5 workerless disjunct
  under the stale latch; S6 RPC re-bind on claim-raised generation
  (+ `__testOnlyGetSubagentRpcGeneration` seam + test).
- S7 stranded clocks measure REAL activity (`strandedQuietMs()` on
  `lastRealActivityAt`, 3 sites: stale-latch x2 + ordinary).
- S9 overdue backstop: continuation route proves the park-clear before
  latch+ledger; probe route releases the latch at settle when the same
  wait is still parked (`HeartbeatDeps.updateGoal` widened boolean).
- S10 unhealable policy corruption notifies the true cause (the ledger
  already had `goal_policy_heal_failed`; gates used to misattribute).

DOWNGRADED (traced against the code):
- A3 double-apply race: both apply paths synchronous decision→claim-clear.
- S8 rearm-before-dispatch: all four `consumeStaleContinuationRearm`
  sites schedule-or-already-scheduled (session_start's schedule is
  unconditional-on-true with the load barrier verified down; the other
  three decline only when a timer/dispatch is already pending); every
  no-op exit (manual hold, recovery-owned, stale) has an owning flow
  that re-drives dispatch. Clear-on-promised-resume is the documented
  marker design. (An earlier pass mislabeled the S9 probe-route fix
  "S8"; the record now reads S9-probe / S9-continuation.)
- D9 IDLE/BUSY freshness: decided 2026-09-07 (head owns liveness via
  `stream {age}`; status keeps state+counts so the two never disagree).
- A6 verificationIncomplete "forever": the flag is attempt-scoped (fresh
  worker child process per attempt); within-attempt refusal is the
  documented v0.38.99 integrity stance ("may not certify what it never
  saw"); the retry ladder re-audits clean. Fail-closed kept (batch B).
- L3 mid-tick rebind vs handoff: dead mechanism — capture is fresh at
  tick start (no pre-capture await), `:677` rebinds sync-immediately
  before the `:691` write (no interleave possible), spreads carry the
  flag, full replacements are new loops; the only loss is tick-abandon
  after an explicit stop (moot).

NOTED, out of scope: F2's UX hint (strictness superseded by L1);
timeline `challenge`/`model` raw interpolation (`goal-commands.ts`
`timelineVerdictLine`) — flagged for a later display pass, outside the
D7 recap-projection boundary.

GATES STATUS: `tsc --noEmit` + focused/broad suites could not run in
this pass — the sandbox shell is EMFILE-dead (`os error 24` on every
spawn, 10+ consecutive turns). All edits were re-read in place for
syntax/type/shape risk instead (highest-risk items: the
`HeartbeatDeps.updateGoal` boolean widening — no test fakes
`createGoalHeartbeat`, sole production injector already boolean; the
C10 diff guard for explicit-undefined defaults; the S9 latch narrowing).
Resume procedure: `npm run check`, then the focused files
(overdue-backstop, completed-audit-recovery, stuck-audit-latch,
policy-self-heal, objective-conflict, cmd-review, settings-stale-save,
settings-invalid-report, audit-history-copy, session-rpc-rebind,
completion-summary-lines, loop-forever, display), then the broad
behavioral + auditor suites, then `check:inventory` + inventory regen.

## Field addendum — held respec loop silently discarded (2026-10-02 screenshots)

A respec draft loop completed its draft (`[RESPEC DRAFT COMPLETE]`),
the session reloaded, the loop HELD (autoResume off) — and the
load-hold warning named every resume verb EXCEPT `/loop resume`. The
user ran `/loop respec` again, which silently replaced the held loop
with a fresh reconcile loop; the held loop's history was lost.

Fix (unreleased tree, `tests/loop-held-start.test.ts` 6 tests):
- `startLoopFromConfig` (`goal-loop.ts`) now asks (Resume / Start
  fresh / Cancel) before a fresh start replaces a lifecycle-held
  loop; headless fails closed (`loop_fresh_start_refused_held`);
  explicit "Start fresh" ledgers `loop_held_discarded`. Deliberate
  stops/pauses keep silent fresh-start (already decided).
- The load-hold warning names `/loop resume` when a loop is held
  (byte-identical otherwise, pinned by test).

Related field report (Clean Web final audit parked ~90m,
`auditor_recovery_cursor_persistence_failed` + `workerless-in-flight`,
no worker): by design the parked claim waits for an explicit
`/goal resume` or `/list resume` — the S9/A6 recovery paths exist in
this tree, but a parked claim never auto-retries. Post-release:
resume it explicitly; if it parks again with a cursor-persistence
error, that is a new bug against the recovery write path.

## Field addendum 2 — auditor still parks on 0.38.108 (clean-web, 2026-10-02 pm)

Journal + job-dir forensics on the live clean-web claim (5 verdicts, then
attempts that never settle). Three stacked defects, two fixed:

FIXED (a) Dead-cursor poison: worker-death parks kept
`auditorAttemptedRefs=[dead model]`; the next session-recovery begin
inherited them (fresh cycle requires `auditorFallbackExhausted`, never
set by a death park), so the walker exhausted in ~9ms with "no auditor
model" and consumed the one-shot auto retry. Journal-proven (select→
exhausted in 9ms, twice). Fix: both park sites clear the 7 dead-cursor
keys (mirror the burn clearing); evictions + identical streak survive.
Test: workerless park drops the cursor.
FIXED (d) Silent reconcile: `readCompletedCompletionAudit` returned null
with zero ledger trace (only exceptions logged). A complete valid
6th verdict (disapproval, `ok:true`, full evidence) sat unapplied while
the claim parked workerless. Fix: every rejecting gate now ledgers
`completed_audit_recovery_rejected` with its name. The mur2sq0s verdict
is still on disk — the next resume re-attempts reconcile and will name
its gate. Test: rejection names gate + attempt.
OPEN (b) Orphaned supervision: the mur2sq0s worker ran 14:57→15:10 and
completed, but the parent poll never applied the result (no settlement,
no ledger). Prime suspect: generation handoff/compaction orphaned the
await (A7 quiet-stop) with no adoption by the new generation. Needs
runtime evidence (job lock + handoff markers at the time); shell was
dead for the whole session so no process telemetry could be taken.
OPEN (c) Detector masked by host activity: the stranded branch keys on
host quiet (`lastRealActivityAt`), so in an active session a dead audit
sits until the host idles 90s (here: 45 min, 15:10→15:55). Fix direction:
key ALSO on audit-progress silence (claim `lastActivityAt` + worker
absence). Needs claim-activity writer verification first.
OPEN (e) Same-failure burn: "provider empty response" × N and
"unsupported tool: write" cycle the same single candidate with no
circuit breaker on the death path (the identical streak lives only in
settlement, which needs a result). Provider flakiness is external (the
main model hit empty responses too); GLLA's share is bounding it.
