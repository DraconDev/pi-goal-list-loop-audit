# Final-audit refusal and high-context list session — 2026-10-28

## Scope and evidence boundary

Both screenshots were inspected natively. Deathrun and capture-anime-girls
remain strictly read-only: no source-project code, goal state, contracts,
approvals or artifacts were changed. Fixes and synthetic reproductions are in
GLLA only. This does not approve either project's deliverable or repair Pi,
providers or external plugins.

## First report: current amendment defect confirmed and repaired

Screenshot_20261028_122546.png identifies deathrun and reports rejected
`complete_goal(newObjective)` confirmations. Its latest durable state remains
paused/blocked with that complaint. Its retained deterministic disapproval
rejects `git diff --stat <pre-goal sha>..HEAD` as unsafe mechanical syntax,
exit 126. This proves a real contract placeholder problem; it does NOT prove
the screenshot's more specific claim that bash actually executed a redirect.
The claimed 42-to-45 check count and the project's work were not independently
verified here. Contract correction still needs explicit confirmation.

Current GLLA did compare `state.goal !== amendmentGoal` after awaiting Confirm,
in addition to semantic fields. A deep-equal goal clone reproduced rejection
with unchanged durable contract. Original diagnostic source is retained as
`repro-before-fix.ts.txt` (inert historical evidence, not a desired-behavior test).
The original bounded reproduction plus existing authority tests passed 9/0 by
asserting the observed defect, before implementation.

The fence now checks semantic target, revision, status, objective, contract,
policy, task content and competing pending claim, plus existing session and
owner authority. It no longer treats JS allocation or task-object key order
as consent changes. Tasks/claims are snapshotted before awaiting Confirm so
in-place edits also invalidate consent. Cancellation and declined confirmation
remain non-mutating and cannot submit a claim.

`tests/amendment-confirmation-fence.test.ts` verifies successful unchanged
rehydration and harmless task-key reordering; rejection covers id, revision,
contract, objective, status, policy, in-place task edits, competing claims,
session generation, owner and cancellation. It also proves a declined Confirm
still cannot amend scope. Successful amendments advance the durable revision
and enter independent audit; tests use an inert worker, not provider approval.

## Second report: large real input-side usage, not proven audit deadlock

Screenshot_20261028_122841.png shows `903844 / 200000 token target` while an
audit has recent tool activity. Source journal audit dispatch: 12:11:42Z; shutdown:
12:29:37Z with `audit_recovery_pending: session_shutdown:quit` and
`audit_worker_cancelled: quit`. Latest state is paused/no verdict with one
queued item. No final approval or independently established deadlock is shown.

Read-only parent session:
`/home/dracon/.pi/agent/sessions/--home-dracon-Dev-dracon-platform-web-games-wip-capture-anime-girls--/2026-10-27T11-43-42-232Z_01a17d2c-5e98-7796-bef5-49b00ffc0c0b.jsonl`.
At line 2475, the completion request records input 215 + cacheRead 902272 =
**902487 input-side tokens including cache**, output 1273, total 903760.
At line 2081 it was already input 237 + cacheRead 777600 = 777837. These are
provider-reported usage fields, not an independently captured wire payload or
903k uncached input. Journal line 928 (`context_usage_sample`, 12:11:43.467Z,
one second after audit dispatch) records the same request with provider usage
`inputTokens` 215 / `cacheReadTokens` 902272 / `totalTokens` 903760 **and** a
host `contextUsage.tokens` estimate of **903844**, window 1048000 (86.24%).

The screenshot's `903844` is therefore the host/displayed context estimate at
the dispatch sample, not a provider-reported token count; the 84-token gap
between that estimate and the sample's own provider `totalTokens` is exactly
the estimate-versus-accounting difference this report keeps distinct. No
separate or larger estimate delta is claimed, and the displayed figure is not
presented as 903k of uncached input. The `200000` in the same line is GLLA's
configured *preventive* target, not the model window (the sample records
1048000), so the display reports a session 4.5x past the preventive target while
still inside the hard window — exactly why the objective treats the target as
preventive rather than an unconditional ceiling. There are no compaction entries
in that parent session.

### GLLA-owned suppression mechanism

The source project's `compactor-boundary.json` is zero bytes, with mtime
2026-10-26T18:06:12.362Z. Read-only retained journal segment
`segment-1793115587023-1554229-c18d1v1y.jsonl`, lines 143/151, records compaction
firing at 18:06:12.363Z and completion at 18:06:56.678Z. Durable
lastCompactionAt records that later success. Previously, parsing the empty
marker failed before success reconciliation, suppressing preventive compaction
indefinitely while tokens stayed above half the target, including new sessions.
This is a reproduced mechanism, not proof of every historical contact's idle
state or of which writer truncated the file. Historical loaded-source identity
is not established by the displayed package version alone.

Marker reads and UI now share bounded no-follow regular-file evidence.
Malformed metadata can reconcile a proven durable success later than its own
write timestamp, after recovery grace. Older/future success cannot release a
newer failed attempt; unknown failures stay one-shot across reload. Oversize,
nonregular and symlink metadata never authorizes blind retry. Marker creation
and success updates use same-directory atomic replacement rather than
truncating the live file; failed replacement cleans temporary data and leaves
the original intact. Failure to persist a claim cannot launch repeated
unrecorded optional compactions.

### Safe pre-audit admission

The old complete_goal path persisted a claim and immediately launched the
auditor. By the actual settled boundary the audit exclusion was already active.
Existing ordinary dispatch/agent_settled compaction checks were present, but
could not recover the malformed marker and did not stage this transition.

Now an above-target completion stores explicit revision-bound pre-audit
admission debt and returns without compacting a busy tool callback or launching
a worker. Owned settled contacts admit it. If safely eligible, one optional
compaction owns the boundary; success/failure callbacks and session_compact
rebind through current session/owner authority. Only afterward does the stored
claim launch exactly one independent audit, without another main-agent turn.
A proven-success marker can rearm directly at this already-safe audit boundary.

The target remains preventive, not an unconditional hard ceiling: unavailable
or already-spent/failed optional compaction admits the retained completion
claim's independent audit once safe. It does not strand the goal waiting for
an unavailable summarizer or silently erase work. New revision mismatches hold
the retained claim and offer explicit `/goal verify` after scope review.
Decision pauses, load holds, cancellation, foreign owners and stale generations
cannot dispatch. Existing live/legacy audit attempts are not retroactively
assigned compaction debt; absence of this process's in-flight flag does not
prove an older worker never started. Truly in-flight audits remain excluded.

The widget explicitly describes waiting for the safe compaction boundary;
compaction eligibility no longer falsely says an unlaunched claim is a live
audit blocking it.

## Verification progress

- `verification/affected-suites.log`: 366 passed, zero failed across 18 files,
  including semantic consent, atomic/malformed marker recovery, admission
  success/failure/unavailable cases, late revision/cancel/session/owner races,
  audit recovery, list approved-completion handoff and decision/cold-load holds.
- Focused seven-suite run: 73 passed, zero failed; later final focused gate
  (`verification/final-focused.log`): 31 passed, zero failed across the three
  new suites. TypeScript and regenerated inventory checks passed.
- Three isolated-copy negative controls (`verification/*-negative.log`,
  `negative-controls.json`) remove exactly one guard each and fail for the
  intended behavioral reason: object-identity rejection returns,
  malformed-marker success reconciliation is lost, and pre-audit admission
  debt is never persisted. Exit 1 in every case; live sources were restored.
- The amendment suite initially pinned response wording
  (`target changed during scope confirmation`, `not confirmed`, `AUDIT
  PENDING`), so a diagnostic-only rewording failed while the protected behavior
  was intact — an incidental assertion, not a contract. Those three text
  assertions are replaced with durable evidence: the persisted goal revision,
  a deep-equal unchanged goal with no stored `pendingCompletion` on rejection,
  and a stored `pendingCompletion.attemptId` on success.
  Both required controls are in
  `verification/amendment-wording-controls.log`. CONTROL 1 rewrote all three
  messages without touching behavior and the suite passes 14/0; CONTROL 2
  restored the original object-identity fence and the suite fails on the
  DURABLE revision assertion (`the confirmed amendment advanced the audited
  revision on disk`), not on message text. The control copy also had to include
  `bunfig.toml`; omitting it dropped the `./tests/harness/setup.ts` preload and
  made the UNMODIFIED copy fail 2/14 with a `ctx.modelRegistry.find` TypeError.
  That was an environment defect of the control, and the baseline was
  re-established at 14/0 before any control was credited.
- The same class of pin remained in `tests/pre-audit-compaction.test.ts`, which
  asserted `/AUDIT PENDING/` on the tool response and
  `/waiting for safe compaction boundary/` on the rendered widget. Both are
  diagnostic copy, not the protected contract, so they are replaced with
  durable and structural evidence: the persisted `preAuditCompaction` debt plus
  stored `attemptId`, a staged admission that is not an error, and the
  non-live-audit classification expressed as "the compaction reason is not
  `audit` and the render carries no `DETACHED · LIVE` liveness badge". The
  exactly-once dispatch, busy-host hold, preserved claim and
  decision/cold-load/cancel/revision/session/owner gating assertions are
  retained unchanged. Controls are in
  `verification/pre-audit-wording-controls.log`, on a copy whose baseline was
  re-established at 11/0: CONTROL A reworded the response text and both widget
  labels and the suite still passes 11/0; CONTROL B removed the admission guard
  and the suite fails on the DURABLE assertion
  (`pendingCompletion.preAuditCompaction`), not on prose.
- Fresh-context reviewer `116ba0a2-9aee-47bc-b236-0b84545e6d90` raised an
  undeclared-global blocker; resumed reviewer `b60f88bc-f960-4aa9-8a29-6628f2db2271`
  verified the intentional runtime-global bridge and the 31/0 focused log,
  withdrew the blocker, and reported no remaining issue. No source change was
  made merely to satisfy the false positive.
- Gate robustness finding (host contention, not product): two intermediate full
  gate runs on this host failed under extreme load. The first, at load average
  123–144 on 16 cores, failed 13 assertions (`verification/contended-gate-run.log`);
  the second, at 80–107, failed 5 in the detached-auditor/compactor boot paths.
  Every failing assertion reduces to a wall-clock allowance rather than a
  behavioral condition: hand-rolled `performance.now() + N` deadline loops, a
  fixed `tick(2800)` settlement, a 30 s framework frame, and audit boot windows
  that expire before a starved child process can publish progress. Two of those
  waits were mine and are now fixed at the root:
  `tests/pre-audit-compaction.test.ts` and
  `tests/compaction-settled-boundary.test.ts` take their budgets from
  `tests/harness/host-budget.ts` (`waitFor`), which scales with measured host
  contention while still REQUIRING the condition — the three-suite rerun gave
  26 passed, zero failed. Three of the remaining (`respec-builder-audit-runtime`,
  `compactor-worker-lifecycle`, `list-draft-handoff`) already use the shared
  helper and pass on rerun once load fell and in isolation (38 passed, zero
  failed). The fourth, `auditor-stall-watchdog`, had a real host-dependent
  assertion, fixed below. This is recorded as
  host contention, not a claimed product regression, and no assertion was
  loosened: every condition is still required, only the wall-clock allowance
  follows the CPU actually available.
- Guard defect found and fixed while investigating that: the repository already
  had a rule forbidding hand-rolled wait deadlines
  (`tests/host-contention.test.ts`, "no test file hand-rolls a wait deadline any
  more"), and it matched only `Date.now()`. Waits written against
  `performance.now()` — including two of the ones that false-failed the gate —
  passed the guard silently. The matcher now accepts either clock, so the rule
  covers the shape it exists to forbid. An isolated-copy control
  (`verification/guard-blind-spot-control.log`) shows the old matcher PASSES a
  `performance.now() + 2000` deadline and the new one FAILS it, while a
  compliant `untilMs(2000)` wait is still accepted in both. This is the
  durable fix for that class; the host's own oversubscription (measured 6.5x
  load per CPU against the deliberately pinned 2x ceiling in
  `extensions/goal-loop-shield.ts` `MECHANICAL_LOAD_SCALE_MAX`) is left alone
  because that ceiling is an intentional product contract, not a test defect.
- Two `tests/auditor-stall-watchdog.test.ts` assertions measured the HOST, not
  the product. They required the cancelled detached worker to have booted far
  enough to install its own SIGTERM handler and write a marker file. On a
  saturated host the watchdog fires before that, the signal hits the default
  disposition, the child dies correctly — and no marker appears, so a healthy
  watchdog was reported as broken.
  The first repair over-corrected: it also accepted a *reaped job-scratch
  directory* as evidence. That is unsound, because production reaps the
  directory after its bounded termination waits regardless of whether the child
  actually died — a surviving worker also leaves no directory. The assertion
  now requires the PARENT'S OWN observation of that exact child's exit
  (`exitCode`/`signalCode` non-null on the captured ChildProcess, cross-checked
  with a `kill(pid, 0)` probe). That accepts both legitimate outcomes — the
  worker's handler ran and exited 0, or the default SIGTERM disposition killed
  it before it booted — and a worker that survives still fails.
  Controls in `verification/stall-marker-negative.log`: (A) the
  auditor-requested shape disables signaling while leaving scratch cleanup
  INTACT, and the test correctly fails with "the detached silent worker was
  cancelled (parent observed its exit)" even though the directory was removed;
  (B) the coarser earlier control (signaling and cleanup both disabled) also
  fails; and (C) a direct standalone reproduction of the auditor's probe — a
  live never-exiting child whose job directory has already been deleted —
  reports `{"childAlive":true,"jobDirExists":false,"oldPredicatePasses":true,
  "newPredicatePasses":false}`, i.e. the old predicate false-passed exactly as
  reported while the new one does not. The repaired suites run 27 passed /
  zero failed, and the two tests dropped from ~32s to ~6s because they no
  longer wait out a handler that was never installed.
- Final `npm run release:check` on the finished tree (including the
  durable-state amendment and pre-audit assertions, both wording controls and
  the repaired teardown assertion), run at a quiet window (load ~7–12):
  **exit 0**, retained in `verification/release-check.exit` and
  `verification/release-check.log`: **4,433 passed, one pre-existing env-gated
  skip, zero failed; 4,434 discovered across 474 files**, runner exit 0 in
  **865 seconds** — down from 5,787 s for the same suite under contention,
  because no test now waits out a starvation timeout. Jiti identity regression, auditor-extension fences, inventory check,
  pack dry-run and installed packed-worker/skill probes all succeeded after it.
  This is local packed
  evidence, not a published-release claim or a claim about either source
  project's deliverable.

## Boundaries of this result

Neither source project was resumed, cancelled, amended or completed. The
deathrun contract placeholder still needs its own explicit correction and
confirmation; the high-context project still has no audit verdict and its one
queued item remains queued. Historical marker-truncation cause and exact
per-contact host idleness are not reconstructed. Provider token accounting is
retained as reported evidence, not a wire capture. The configured target stays
preventive rather than an unconditional ceiling, and no in-flight audit is
interrupted or compacted across.
