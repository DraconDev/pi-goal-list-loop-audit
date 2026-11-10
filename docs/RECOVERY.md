# Recovering and inspecting work

Start with `/glla status`. For full saved details, use `/goal status`,
`/list show`, or `/loop status`, depending on the work surface.

## Durable fixes, temporary workarounds and evidence

`record_goal_judgment` works for the owned active goal/list item or loop/project.
Every new judgment needs `durableFix`, `reason` and concrete `evidence` (an
inspected artifact, reproduction or observed result). It persists the target,
contract revision and executor-assertion provenance through reload.

For `choice="deferred"`, also provide `durableBlocked=true`, a `blocker` with
`kind` (`unsafe`, `impossible`, `external-blocked`) and concrete `evidence`, plus
`followUp`. If using an actual workaround, its `action`, `safety`, `rollback` and
`verification` are all required. Routine failed tests and incomplete local work
are not external blockers. Recording a justified workaround admits bounded
work under the existing contract; it does **not** admit final completion or
silently waive a required task. The independent auditor must inspect the cited
blocker, behavior and checks; populated fields alone prove none of them.

Legacy task deferrals remain historical context. All unfinished committed tasks
still block completion and archival. If a recovered approval has unfinished
work, its settlement claim is invalidated and rework resumes (an explicit pause
is preserved); this is not reported as an archive storage failure.

Draft auto-accept is not consent to weaken adopted scope. Completion pivots,
repair redrafts, loop spec refinements and project requirement refinements need
specific confirmation; a changed target during confirmation refuses the
amendment. Loop refinement shows the current and proposed spec and refuses a
concurrent spec change. Ordinary loop plateau, bounds and explicit finish keep
their stopping semantics: stopping is not independent implementation approval.

Completion can carry explicit `outcomeClaims` (`required`: `loaded`/`executed`,
`kind`, `evidence`). Installation metadata or a journal marker cannot support
such claims; runtime loading alone cannot support successful execution. Valid
observations are still executor assertions requiring independent inspection of
the real target/revision. Omitting this optional structured field does not
remove the auditor's obligation to inspect actual behavior. GLLA does not
cryptographically authenticate arbitrary artifacts or classify architectural
quality from prose.

## Resolving contract conflicts without losing work

A rejected invocation is not a passed criterion. Correcting shell syntax is distinct from waiving failures or required human evidence: keep the confirmed criteria until explicitly amended. `/goal verify` starts/manages a completion audit; it does not edit the contract or supply missing evidence.

Public tweak syntax is `/goal tweak "<existing objective> Done when: <complete revised contract>"` (or paused `/list tweak`). Keep the full objective and every criterion to retain. There is no standalone `/goal tweak verification contract ...` or contract-edit flag. An omitted `Done when:` clause preserves criteria; a bare clause clears them only after confirmation. Identical text reports no change.

For a concrete numbered-command amendment, the decision shows the old/new criterion and whether it is a syntax-only correction or a substantive criteria change. Explicit selection persists the exact amendment before resuming and preserves objective/tasks/checkpoints. Missing items, unchanged proposals, stale consent or precommit refusal cannot report successful amendment. A committed recovery snapshot with failed journal/markdown projections is explicitly reported as projection-incomplete: work stays paused with the revised criteria retained; repair storage and reconcile instead of reapplying consent. Criteria without exactly one delimited command require full-contract confirmation, not an inferred whole-line replacement. Declining/unattended defaults retain the original criteria; supported material exceptions remain held. Revised criteria still require independent verification.

Other slash suggestions say **Request agent to run**: this delivers an instruction, not proof that a command ran or changed durable state. Inspect persisted status before treating a resolution as accepted. Never invent player transcripts or treat a nonzero test gate as passed because a pipeline was rejected.

## Waiting is not paused

**⏳ waiting** yields the main agent to named background dependencies. The
saved goal/list item or loop/project remains supervised; exact terminal results
trigger a bounded assessment of the retained checkpoint. Waiting does not mark
tasks or project requirements successful. **⏸ paused** for a user hold,
decision, or manual-action blocker freezes automatic continuation; children may
still run, but their results cannot bypass the freeze. A scheduled time gate is
stored as a paused goal with `pauseKind=wait`, but is displayed as a scheduled
wait, not a manual-action blocker.
Lifecycle is separate from activity such as researching, implementing, auditing
or recovering. Activity requires observed evidence, not the model's narration.

A scheduled wait intentionally ends the current turn. Pi may still print its
own red abort transport line; the admitted wait card explains that this is not
a failed assessment. Tool output, notifications and status use the same saved
assessment deadline (ISO `Z` is labelled UTC), not a manual-resume instruction.
An exact owner/goal/pause/turn match keeps the expected abort quiet after the
card is shown, even after the one-shot message rewrite. An unmarked abort still
reports once; a new turn or changed owner/pause is not suppressed. This is
presentation-only: it neither registers a new wake nor changes deadlines,
retry policy or explicit holds. Closing Pi still does not prove a live wake.

The agent uses `wait_for_background` with exact owned `runIds` and a reason.
`pause_goal(kind="standby")` is a compatibility entry requiring the same ids;
use a genuine pause for decisions, user holds or manual-action blockers. Unknown
worker ids are rejected. Legacy saved standby records have no provable ownership:
GLLA requests an assessment once eligible, rather than promising automatic wake.

Use `/goal status`, `/list show`, or `/loop status` to inspect the checkpoint.
On reload, GLLA reads only the saved identity-matching public status artifacts;
completed, failed, stopped or missing results are assessed without discarding
scope or progress. A running artifact with no deadline is assessed after at most
30 minutes; stale activity without a provably live local process is assessed
sooner. No busy polling or guessed worker adoption is performed. Load holds,
supervisor pauses and pending audits remain authoritative. Explicit resume
reconciles a dependency wait instead of blindly re-sending the main work.

### Checking authorized external work

For external work that has no owned subagent notification, use
`pause_goal(kind="wait", resumeAt="<ISO deadline>", reason="<what to assess>")`.
A valid deadline and a registered current-host heartbeat are required; failed
admission leaves the goal unpaused and reports that no wake was registered.
This registers a **bounded assessment check**, not a completion detector or an
arbitrary shell command. On the assessment turn inspect fresh authorized logs
or results, distinguish completed/failed/unknown outcomes, and register a new
bounded check if needed. `blocked` plus prose such as “on next wake” registers
nothing and must not promise automatic continuation.

The card exposes the saved check deadline and wake owner. **WAITING** requires
fresh, matching host registration; **RUNNING** background activity additionally
requires a matching worker activity timestamp. Old or absent worker activity
is unknown/stale, not proof of a stuck worker. A saved checkpoint with no live
host/wake evidence is **EXECUTION UNCONFIRMED**. Parent chat, elapsed time, file
existence, and process age do not prove worker progress or completion.

Deadlines survive restart, but host timers do not. Reopen the session and admit
continuation (release a load hold explicitly); GLLA's fenced heartbeat assesses
an overdue check shortly after its deadline, subject to dispatch, recovery and
persistence gates. It does not bypass explicit user/supervisor/load holds,
unresolved persistence failures, or replaced/terminal ownership. Detailed
`/glla status` shows saved versus live evidence. No automatic wake is promised
while the host is closed or registration is unconfirmed.

See [the lifecycle/state reference](DESIGN-work-lifecycle.md).

## Manual-action blockers

A blocked pause card puts the full prerequisite in readable text. `Next` names
an explicit supplied action; if the saved action is missing or only a resume
command, it asks you to resolve the prerequisite and report the result instead.
The retry command appears separately: **after the prerequisite is resolved**.
Resume retries the work; it cannot complete a checkout, supply permission or
produce missing evidence. Ordinary authorized work should continue rather than
be parked merely to request resume.

Agents should lead pause reasons with the remaining prerequisite, not completed
work. Before claiming a page or inbox cannot be inspected, check available,
authorized tools; access and payment authorization must never be assumed.
This display change neither grants access nor changes pause/resume policy.

## Which resume command?

| Command | Use it for |
| --- | --- |
| `/glla resume` | Broad recovery: release supervisor/load holds, retry saved model recovery, or resume the current goal, list item or eligible held loop. If a paused goal and held loop both qualify, the UI asks which one. |
| `/goal resume` | Resume the current goal through its goal recovery path. |
| `/list resume` | Resume the current list item, including recovery of its pending completion audit. |
| `/loop resume` | Resume an eligible held metric loop or project builder, retaining its target, iteration and audit claim. |
| `/goal recover [id]` | Read-only. Not a resume: reconciles live state with the saved goal records on disk and previews a restore-as-new recipe. See below. |

For a held project, `/glla resume` delegates to the same loop recovery as
`/loop resume`. Both retain blocker and branch checks. Neither overrides an
explicit `/loop stop` or declares unfinished work complete. Resume feedback
explains when work cannot restart.

After loading a session, **Loaded without starting** means the saved work is
restored but automation awaits your decision. Load the intended conversation,
inspect its state, then resume. Enable **Auto-resume** in `/glla` only if you
want automation to restart after future loads.

## A parked completion audit

When an agent claims completion, the claim is stored and a detached auditor
verifies it. If the auditor run ends without a verdict, the claim is **parked**:
the item is paused, the claim stays durable, and the card says
`completion audit: parked — no review recorded`.

A parked claim names its own cause. The causes are not interchangeable, and
none of them means your claim was lost:

| Cause on the card | What happened | What to do |
| --- | --- | --- |
| `the session changed before the auditor finished` | A session boundary (reload, restart, successor session) ended the run before a verdict. Nothing is misconfigured. | Resume. Exactly one fresh audit starts. |
| `the auditor stopped reporting` | The supervisor noticed the worker went silent and parked the claim instead of guessing a verdict. | Resume; if it repeats, check the auditor model and tool budget in `/glla settings`. |
| `the provider failed the audit run` | The provider refused or dropped the audit request (quota, auth, transport). | Restore provider access or pick another auditor model, then resume. |
| `the verdict could not be applied` | The auditor answered, but applying its verdict to this goal failed. | Resume to audit the current scope again. |
| `the auditor exited without a verdict` | The worker finished without producing a verdict marker. | Resume; if it repeats, check the auditor model and tool budget. |

A session boundary is the common one on long lists, and it is the one most
often misread: `Fix the auditor/session issue` used to be printed for every
cause, which sent operators to check an auditor model that was already the
session's own model. Only the provider row asks you to fix anything.

**Lists hold at the parked item.** The queue does not advance past work whose
completion claim was never judged, because doing so would silently drop the
claim. The card names the surface command (`/list resume` or `/goal resume`).

**Consent decides whether it resumes by itself.** A load committed to
load-time automation (Auto-resume in `/glla`, an explicit resume, or a
same-process session replacement) finishes the parked claim on its own —
including a claim that was waiting for a pre-audit compaction boundary when the
session changed. A cold load holds for an explicit decision and says so.

**The recorded failure class decides how it comes back.** The audit lane
records what kind of failure it was, and that class — not the error text —
picks the lane:
| The failure was | The claim comes back | Why |
| --- | --- | --- |
| the auditor's own (`no-verdict`, `context-exhausted`) | the auditor's ladder: an eager first retry, then a slower probe, and a visible "N identical failures" slowdown marker if it keeps failing | an identical retry reproduces the same wall |
| a provider wall (`provider`, `transport`, `timeout`) | the durable provider cadence — every five minutes, for as long as the claim is eligible | the provider is expected to answer again |

A claim parked before the class was recorded keeps the text-based behaviour it
had. A deliberate stop — "automatic recovery is off", "the recovery horizon was
reached", "the cursor could not be persisted" — is never resumed by automation:
those are decisions, not outages.

**A quoted reset is waited for, and a stall is not.** When the provider names a
deadline (`resets <ISO>`, even a week away) the audit waits for it instead of
re-arming a five-minute timer for the whole outage. When it names nothing, the
lane retries on its durable cadence and then stops and asks:

| The audit has produced no verdict for | What happens |
| --- | --- |
| less than 6 hours, and no reset was quoted | it keeps retrying |
| 6 hours, and no reset was quoted | a decision card: pick another auditor model, start a fresh bounded window, or cancel |
| 30 minutes, and the model no longer resolves | a decision card — a retired model cannot be waited for |

A quoted reset suspends that bound entirely: the wait is scheduled, not
stalled. Before v0.39.69 there was no stop at all, so a plan quota that was
exhausted for good produced "still failing — next auto-retry in 5m" forever.

If a fallback auditor model is configured, it is used: the five-minute retry
re-resolves candidates from the top of the chain instead of re-walking the
model that just failed. A model proven unresolvable stays excluded.

## Saved records that disagree with live state

Live state, not a markdown file, decides what is running. `.pi-glla/goals/<id>.md`
and `.pi-glla/archive/<id>.md` are **projections** written by the normal goal
writer. A projection can outlive the goal it described: a cancelled list item,
a replaced objective or a deleted live slot leaves the file saying
`**Status**: active` while the newest ledger snapshot says `goal: null`.

`/goal status` and `/goal resume` report a leftover projection as saved-but-not-
live, and `/goal recover [id]` lists every saved record with the answer that
matters:

| Label | Meaning |
| --- | --- |
| `CURRENT` | This record is the live objective. `/goal status`, `/goal resume` and `/goal tweak` act on it. |
| `STALE PROJECTION` | Only a leftover file. Nothing is running it; it is **not** resumable. |
| `HISTORICAL` | Terminal record with its archive published. Finished work, `complete` or `aborted`. |
| `TERMINAL, UNARCHIVED` | Finished on disk but the archive never landed — cleanup debt, not work. |
| `UNREADABLE` | No `**Status**` marker; not a goal record and never promoted to one. |

`/goal recover` mutates nothing. It reads the live slot, the saved records and
any queue sidecars, then prints the recipe below for every non-`CURRENT` record
whose scope survives a round trip.

### Restore as NEW

Resume cannot reopen archived work, and a stale projection cannot be edited back
to life. The supported path is a **new** goal built from the saved scope:

1. Run `/goal recover` and read the record's recipe. It is a `/goal start` command
   carrying the saved objective followed by `Done when:` and the saved criteria.
2. Confirm before you paste it: the recipe's round-trip line reports
   `N criteria in, N out` and says whether the objective and criteria are
   identical. A recipe whose round trip does not match is never printed as a
   command.
3. Run it. `/goal start` is goal mode — this never becomes a list item, and an
   existing unrelated live goal is replaced only because an explicit start is
   consent to do so.
4. Recreate the plan with `propose_task_list` using the saved structure. The
   restored plan starts **pending**: completed task states, checkpoints, audit
   verdicts, approvals, timers and the goal id are history and stay history.
5. Verify the durable result, not the receipt. A command that returned
   `accepted: true` is not activation evidence. `/goal status` and `list_status`
   must show the new goal active, the same objective and contract, and the
   expected task plan before recovery counts as done.

The old record stays in `archive/` (or as cleanup debt in `goals/`) as the
provenance of the recreation. Nothing about it is revalidated by being copied:
old tests and audit reports describe the old goal.

### Contract round trips are fixed points

A saved contract re-enters through the same `Done when:`-family introducer that
created it. Introducer handling is now symmetric — the line-start form keeps
exactly one introducer, and duplicates in front of captured criteria are
consumed — so exporting a stored contract and recreating from it does not
accumulate `Done when: Done when:` prefixes. Criteria text is never rewritten; an
already-present marker collapses in one pass. Absent, inline, line-start and
decorated introducers all round-trip to the same criteria set.

## Project increment infrastructure retries

A project increment audit that stalls, times out, cannot launch, has no verdict,
or encounters authentication/configuration failure now retains its exact claim
and active supervision. It journals a next-episode deadline before rearming the
existing loop timer: 5 seconds initially, exponentially paced to a 5-minute cap.
There is no failure-count or elapsed-recovery cutoff. Auth/config problems may
need operator repair; GLLA neither changes credentials nor treats failure as
approval. Status shows the durable failure class, count, retry deadline and bounded actual
cause, not a fictional live worker. The pending project card places the cause
beside its retry deadline, including after reload. Auth/config causes retain
safe model/endpoint/permission details: they are not collapsed to “credentials”.
Retry diagnostics are at most 600 characters of plain prose. Credentials,
authorization headers, URL userinfo/query/fragment, signed URL parameters and
PEM material are redacted before truncation. Objects and full exception stacks
are not persisted; legacy retry diagnostics are re-redacted on reload. Redaction
is a best-effort projection for marked secrets, not a promise to detect arbitrary
unlabelled sensitive prose.

Each configured candidate ladder remains finite within an episode. Only the
next due, admitted episode clears its exhausted cursor and re-resolves current
settings. Saved approval evidence is reconsulted before provider dispatch, so
archive/outbox repair can settle the original verdict without another worker.
Pause, stop, supervisor freeze, project bounds and cold-load consent still win.
Reloaded deadlines do not authorize execution by themselves. Legacy automatic
`audit infrastructure:` holds migrate only with explicit resume or existing
load admission; deliberate user holds do not migrate. Storage refusal rolls
back the transition and cannot authorize unjournaled dispatch.

## Metric and audit-loop measurement recovery

An admitted metric loop (including `/loop audit`) distinguishes verified numeric
readings from infrastructure/no-verdict failures. Empty, nonnumeric or nonfinite
zero-exit output is a measurement configuration failure, not plateau evidence. Exec throws,
nonzero exits, missing exit codes and malformed envelopes preserve best/last,
with a safe diagnostic recording exit/stderr, absent/empty/nonfinite stdout or
the executor exception message (not its stack). Recovery status retains that
cause beside the retry deadline after journal reload. These diagnostics do not
change retry ownership, counts, pacing, stop authority or bounds. They preserve
history, iteration, plateau and stuck accounting. They journal a 5-second to
5-minute capped retry before arming the existing timer, without a count/horizon
cutoff. A due measurement retry re-runs the measure, not another agent turn;
unknown output cannot trigger git regression or approval. Missing metrics retain
the same productive accounting and retry until a numeric verdict returns.

Fallback error turns outside main-model recovery now get the same durable pacing;
recognized provider errors keep the existing main-model recovery owner. Explicit
user aborts retain their finite stop cap. Retry status identifies the saved wait,
not a live worker. Session consent, supervisor freezes, stop/pause, refinement
ownership, storage refusal and loop bounds remain authoritative. A same-process
reload successor may retain existing consent; a quit followed by a cold load
without auto-resume does not gain consent from its saved deadline.

Initial `/loop start` and proposal probes intentionally refuse an unusable
baseline before admission; they do not silently start invalid drafts. Explicit
`force=1` or the audit route's deferred-baseline admission permits missing-baseline
work; once admitted it retries without consuming iterations until a valid
measurement seeds the baseline. Goal completion audits use
`Goal.pendingCompletion`, not loop state: their one-shot/horizon eligibility is
out of this loop recovery scope, not an unresolved loop gate.

This covers admitted project, metric and audit-loop infrastructure recovery,
including auth/config and unknown errors. It does not authorize initial admission,
bypass explicit interrupt/abort authority or user/load/supervisor holds, repair
external providers, or guarantee dispatch while storage or the host is unavailable.

## Is an audit progressing?

Read the auditor rows, rather than the main session's spinner alone:

| Display | Meaning and next step |
| --- | --- |
| **Auditing**, recent activity | The detached auditor is producing events. Tool completions and changing evidence provide stronger progress evidence than elapsed time alone. A long duration alone does not establish a stall. |
| Waiting on a tool, elapsed/timeout | A tool is still running. Its ticking timer is a wait indicator; timeout handling remains automatic. |
| Waiting for dispatch | A saved claim exists, but no live worker activity is observed yet. Inspect status for restoration or recovery holds. |
| No verdict · automatic retry | A project infrastructure episode ended; the saved deadline paces another episode. Auth/config may need repair. This is neither approval nor a live-worker indicator. |
| **Audit held** | Automation parked with a recorded reason. Inspect `/loop status`, resolve the cause, then resume through the command shown. |
| **Audit stopped** | The project was explicitly stopped. Resume is not offered for that stop. |
| Completion review disapproved | The auditor found an unmet contract. Read its required fixes; repair work can continue automatically. Rejection does not mean approval is stuck. |

If progress stops and the UI reports a wedged main session, follow its recovery
message: interrupt the stuck turn with Escape if needed, then resume. Use
`/glla bug <what you observed>` to capture GLLA diagnostics without changing
the saved objective. A process that has exited cannot reconcile an audit;
load/resume the original session before inspecting its pending claim again.

## Changing models during recovery

An allowed manual `set`/`cycle` selection resumes work held solely for
main-model recovery on the selected model. Goal/list work keeps its
objective, verification contract, telemetry and history; a recovery-held
loop keeps its objective and iteration history and restarts supervision.
Resume is scoped: restore/unknown/recovery events, nested
forbidden-selection reverts, internal recovery rotations, forbidden
models, stored audit claims, supervisor/load pauses, user/decision/
permission holds, and deterministic request refusals are never treated as
resume consent. Failed resume persistence restores the episode and holds
dispatch; repeated selection never duplicates continuation.

A manual switch never bypasses an unrelated hold and never authorizes an
upload, purchase, or other gated action.

## Same-model phase (v0.38.105)

Before rotating to a configured backup, GLLA allows **up to** its same-model
retry budget on the currently selected model (default 10; setting
`mainModelSameModelRetries`, 0..100, 0 = legacy immediate rotation). When an
untried, permitted configured backup remains, this phase also expires after
**two minutes**. Whichever limit is reached first allows fallback selection.
An in-flight provider call still finishes under the host's timeout; the phase
limit does not claim to interrupt a running request. The
phase exists because most provider failures are transient: a 429 "rate limit
exceeded" rotating the session to a backup on the first turn spends a
different provider's quota to solve a five-second problem.

- The budget is **reason-agnostic** — the existing envelope cadence applies
  inside it: 5s for the eager transient window, then the short ladder;
  an explicit upstream reset hint still controls retries of that provider;
  persistent walls ladder per `mainModelRetryMinutes`. Neither may postpone
  eligibility to test an independent configured backup past the phase deadline.
  With no untried permitted backup, normal paced recovery remains in force.
- Same-model probes consume the retry budget once when admitted; failure
  parking advances the separate failure/cadence count, not the retry budget.
  The initial failure is not itself a retry.
- A successful **rotation** resets the budget for the new model so the
  backup earns its own retries from zero and a fresh per-model phase clock.
  The per-model `modelFailureSteps` counter (see
  [audit/MODEL-CADENCE-2026-10-11.md](https://github.com/DraconDev/pi-goal-list-loop-audit/blob/main/audit/MODEL-CADENCE-2026-10-11.md))
  tracks THIS model's own failures — a new backup never inherits the
  primary's rung, and a successful backup session that later fails again
  starts a fresh phase with eager retries. The same-model phase deadline
  is suspended while a serving backup is healthy and only resumes once
  the backup actually fails.
  Same-model retries preserve visited predecessors; they never erase the failed
  primary and accidentally select it ahead of the next backup. Phase clocks
  survive restart, and restored long waits are shortened to the fallback gate
  when another permitted configured candidate remains.
- A **cycle reset** (return to the current model after the chain was
  visited) re-seeds the budget at 1.
- The status card shows the live counter (`Same-model retries: N`) so an
  operator can see how close the next failure is to triggering rotation.
- 0 keeps the legacy immediate rotation. Use it deliberately — for example
  a project with no time tolerance for a flaky primary benefits from
  rotating on the first blip; the default of 10 matches the
  `TRANSIENT_EAGER_ATTEMPTS` quantum ("enough to prove it is not a blip").

If an older loaded extension still hides the objective or shows an obsolete
retry countdown, update GLLA and run `/reload`, inspect `/loop status`, then
resume. Saved legacy recovery holds are supported from 0.39.8 onward.

## Persistent paced recovery (no elapsed-time give-up)

Main-model recovery retries with paced backoff for as long as the failure
remains recoverable, in every mode. There is no 24h automatic-recovery
horizon: legacy expiry metadata is discarded during normalization, while
explicit upstream reset sleeps and the same-model/fallback policy stay intact.
As of 0.39.27, hintless rate-limit/Token Plan errors use ten eager 5-second
scheduling slots, then a 1-minute doubling ladder capped at 30 minutes;
actual provider request time is additional. They do not invent a coding-plan
reset window or wait hours before reaching the configured fallback budget.
Explicit upstream reset hints remain authoritative, bounded by the 5h envelope.
Other account/auth failures retain the configured ladder; the optional hourly
:00:30 probe adds a recovery opportunity. An exhausted single-model chain keeps
that model's failure cadence when starting another cycle: revisiting a failing
model is not success and does not reset backoff. Goal/list and loop provider
errors enter the same durable wait immediately, including loops with no backups.
A recovery-held loop keeps ownership across reload; queued list work does not
replace it while its provider retry is pending. Explicit manual holds and
deterministic client errors still stop. Failed recovery-wait persistence
restores state, leaves dispatch held, and arms no timer.

Legacy already-manually-held horizon records rearm only after positive
restore completion plus resume consent, and only for the exact old
elapsed-time stop wording. Identity, counters, contract and history are
retained; generic manual, decision, audit, deterministic,
supervisor/load, and replaced-owner holds never migrate.

### Which failures count as retryable (v0.39.63)

Two predicates must agree, and only one of them decides policy.
`isEagerRetryFailure` chooses the 5s eager window; `isRecoverableProviderError`
decides whether the **durable** lanes (compaction classification, recovery-wait
restore, the auditor retry plan) may wait on the failure at all. A string the
first hammers but the second refuses gets rapid retries and then a park with no
wake — the field shape this version fixed.

Recognized as retryable, beyond HTTP statuses and quota/billing/auth wording:

- **connection-level transport text** — `Connection error.`, `connection reset
  by peer`, `Connection refused`, `The connection was lost`, `connection closed
  before message completed`, `failed to connect`, `connection terminated`;
- **fetch/socket teardown** — `fetch failed`, `Failed to fetch`, `premature
  close`, `other side closed`, `UND_ERR_SOCKET`, `write EPIPE`, `socket hang
  up`, `stream ended without a finish event`;
- **DNS** — `EAI_AGAIN`, `getaddrinfo ENOTFOUND …`;
- **timed out / timeout** (unchanged);
- **an empty provider response** (`Provider returned an empty response`, `the
  provider returned an empty completion`), which the eager lane has trusted
  since 0.38.104 and the auditor lane already files as a provider failure.

Deliberately still **not** retryable, and pinned by tests: user aborts and
prompt-policy refusals, context/output-token limits (compaction owns those),
deterministic 400s, and unclassified prose such as `auditor produced no verdict
marker` or `expected an empty array, got 3 items`. Failing open on bare
unknown text was rejected on purpose: it would put a dead auditor worker on the
provider ladder and turn the no-verdict branch into a re-audit loop.

## Compaction-timeout handoff

A compact-first timeout (including the 120s budget) hands the original
provider diagnostic to paced automatic model recovery instead of parking
for manual resume. The saved goal/list/loop contract survives, the
compaction one-shot budget stays spent, owned compaction is cancelled
before the handoff, and late compactor callbacks cannot duplicate
dispatch. A persisted automatic wait is required before timers arm;
storage failure keeps fail-closed dispatch.

## Ownership cleanup and ordinary chat

Recovery follows a work identity (goal id, loop start, or explicit chat),
not whichever live slot exists when a delayed callback fires. Terminal
(`complete`/`aborted`), genuinely absent, or replaced owners retire
supervised markers and cancel both recovery and hourly timers immediately;
explicit cancellation does the same. Cleanup never runs during an
incomplete restore, and failed cleanup persistence restores the marker and
holds dispatch. Ordinary-chat recovery is explicit, never inferred from a
legacy orphan, and terminal goal archival neither adopts nor deletes it.
Late accepted/rejected model selections cannot cross a terminal, absent,
replaced, new-episode, or user-hold boundary.

## Protected holds and truthful displays

User stops, genuine decisions, permission gates, deterministic
nonrecoverable errors, and persistence-safety holds stay authoritative:
no timer, fallback, or model switch overrides them.

The saved `attempts` counter counts GLLA backoff steps, not provider
requests. Status labels it **Recovery steps** with **episode age**, and
explicitly denies that age proves continuous failure. A screenshot saying
“Retry failed after 15 attempts” or showing IDLE does not confirm the actual
session state: inspect the saved goal/list/loop identity, recovery owner, holds
and host error events. No supplied screenshot/session journal has confirmed
objective loss. Pi's public extension hook is `agent_end` with assistant
`stopReason="error"` and error text; its `auto_retry_end` notification is not an
ExtensionAPI event. GLLA does not infer a durable owner from notification prose.
Ordinary unsupervised chat retries remain process-local, not a persistent
GLLA objective or reloadable retry contract. A durable `retryAt`
alone renders execution as unconfirmed (`retry scheduled (unconfirmed)`);
live snapshots distinguish armed regular timers, hourly-only timers,
in-flight selections, active/queued host turns, absent timers, and
supervisor/load/context/stale-extension/persistence holds. Selection alone
is never reported as provider success.

When the host ends a turn with an abort error while the goal is already
paused (for example a quota-driven `wait` pause), GLLA records the refusal
with the pause kind and reason (`goal-paused-host-abort`) instead of a bare
non-recoverable entry, sends no retry, and notifies that the red `Error:`
line is the host's own transport — not a GLLA retry and not a new failure.
An abort on an active turn keeps the plain non-recoverable record, so the
two cases stay distinguishable in the journal. A blocked pause keeps its
separate `goal-blocked-paused` record.

## No objective to resume—but a recovery message remains

An objective, its completion claim, and provider recovery are separate state.
A retry/fallback record can belong to ordinary chat or remain after tracked
work has already settled. It is not evidence that the objective is still active.

If `/glla resume` says **No GLLA objective is paused** and clears an old recovery
marker, it clears that marker—not the conversation, archive or completed work.
Inspect `/goal archive` for goal history and `/loop status` for a saved project.
For ordinary chat, send `continue`; for additional work after an accepted result,
start a new goal. Resume does not reopen an archived objective.

Reloading refreshes extension code but does not repair provider access, credits
or credentials. A selected model and a responsive UI do not prove that the next
provider request will succeed. If a fallback is needed, select one you can use,
then inspect status and resume eligible unfinished work explicitly.

## When a project completes

Project completion requires independent verification of every adopted
requirement and a written archive. After completion, the project widget and
GLLA footer disappear; other unfinished work can still show its own UI.
The semantic completion summary, `/loop status` and archive retain the
verification evidence. There is no resume action for an already completed
project. Start a new project when its intended scope changes.

## Why context can exceed 200k

**200,000 tokens is the default opportunistic compaction target.** Configure
`compactionTokenThreshold` through the global settings; see [SETTINGS.md](SETTINGS.md).
GLLA checks at safe idle boundaries during supervised work. Active tools,
audits, queued messages and pauses can defer an attempt. An idle conversation
without active GLLA work does not start automation simply by crossing the target.

Pi's summarizer can fail, for example when its output hits the model's token
cap. GLLA records that failure and continues eligible work. It does not retry
the same failed compaction episode every turn. Failed or unknown episodes rearm
when a later safe check observes context below half the configured target. A
confirmed successful compaction rearms after its three-minute recovery grace,
yielding one normal work boundary before another attempt. This also recovers
older success markers from the durable completion timestamp. Pi's `/compact`
is available for a manual attempt; summarizer success is not guaranteed by
GLLA's scheduling. Compare current context with the recorded attempt time
before treating an older high-token sample as the current transcript size.
`/glla status` shows the configured target and last recorded completion time.

When a host-owned compaction failure parks a loop or project, its durable work
remains resumable. Use `/new` if the current transcript still cannot fit, then
`/loop resume` or `/glla resume` to continue the saved project. A saved
summarization-output failure is a hold, not completed work. Resume preserves
requirements and history; it does not approve the outstanding audit claim.

## Failed requests and context growth

GLLA filters obsolete error-only assistant replies from outgoing model input and
compaction input, retaining the latest failure for retry diagnosis. This applies
with or without an active goal, list or project. Adjacent GLLA dispatch and
automatic retry prompts disappear with their discarded failures. User requests,
tool calls and results, and user aborts remain intact.

Project dispatches also bound repeated audit reports and refer back to durable
evidence. Adopted acceptance criteria remain complete in the ordinary dispatch;
oversized contracts require scoped reads from durable state before work.

These projections leave the saved transcript intact. The host's context estimate
can therefore remain high until a successful compaction replaces the transcript
prefix, even though provider input has already shed obsolete failure pairs.
Filtering failed attempts does not restore an unavailable provider endpoint.

## Continuing work after a model fallback

Selecting a fallback does not finish or replace the task. Active goals, list items
and loops continue through their saved contracts and progress. For ordinary turns
and one-off blocker reviews, GLLA requests one continuation after the failed run
has settled, with a bounded excerpt of the original request and instructions to
use existing successful tool results. The complete conversation remains authoritative.

Once the ordinary request exhausts its configured fallback candidates, subsequent
recoverable failures use ordinary retry backoff. A passive record of the selected
model is not a fresh switch or a scheduled recovery owner. Delayed retries carry
the original request as well, while credential and deterministic failures retain
their manual-action rules.

A successful core retry consumes this handoff; repeated settlement cannot duplicate
it. Running or queued turns, explicit aborts, supervisor pauses and recovery waits
prevent automatic sends. A send failure retains the pending handoff and reports
that delivery failed. GLLA does not restart the project or unblock a dependency
just because the selected model changed.

## Project requirement blockers

New or changed project blockers automatically show a concise action card:
short obstacle, who can act, why the agent cannot continue, concrete next step
and expected result. Long measurements stay in the full-details view.
`block_project_requirement` distinguishes `kind="work"` from `kind="external"`.
For work, give `id`, diagnostic `reason` and a concrete `nextAction`. The
requirement stays open, the previous batch is retained as history, and the agent
replans and keeps building/refining. Failed tests, unrun checks, missing evidence
and unfinished implementation belong here; usually the agent can simply keep
working without calling this tool at all.

For external dependencies, also give `summary` (up to 240 characters), `owner`,
`expectedResult` and `whyAgentCannotProceed`. Incomplete reports are rejected
before changing durable state. Continue other open requirements; only all-blocked
projects hold. Classifying a mistaken blocker as work releases a blocker-only
hold and continues, while user pauses/stops, supervisor holds and exhausted
budgets stay held. Branch-mode holds still require the guarded resume command.
The classification and next step are journaled; no requirement becomes verified.
Put long diagnostic evidence in `reason`.

Older saved reports remain readable and are labelled **Needs clarification**.
They do not establish that the operator must intervene; ask the agent to explain
or continue fixing the work. GLLA does not infer external dependencies or shell
commands from unstructured test output. Unchanged reports do not repeat the card.
Displaying a card does not dispatch work, clear a blocker or verify a requirement.

Use `/loop blockers` to reopen complete recorded reasons and the next action. These
are agent reports, not proof that a dependency is still unavailable. Ask the
agent to recheck against the current project, resolve what it can, and give an
exact command/location and expected result for any action that requires you.
The view is read-only and remains available on stale handles.

For a held project, ordinary user turns receive its bounded durable contract as
per-turn context. A fresh conversation does not mean the project is complete or
that no objective exists. This context does not grant permission to resume and
is not appended repeatedly to transcript history.

Use `/loop recheck` to request one agent assessment of the saved blockers.
`/loop resume` does the same for an all-blocked project held solely by blockers.
The review can reclassify ordinary repair work with `kind="work"` and continue
building while preserving scope. Real dependencies remain blocked. Rechecks do
not silently reopen requirements, and a running or queued turn prevents duplicate
review dispatch. If sending fails, the saved hold remains intact.

When evidence shows resolution, the agent calls `unblock_project_requirement`;
then `/loop resume` continues the saved project. Unblocking does not verify a
requirement. All-blocked projects retain their hold instead of repeatedly
dispatching work that cannot progress.

## Updating a running session

The npm package is also the Pi plugin; there is no separate Pi-only release.
Follow the [update instructions](../INSTALL.md), run `/reload` in existing
sessions, and use `/glla version` to check the version actually loaded.
Publishing a package does not replace code already loaded in a live session.
