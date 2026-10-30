# Auditor resume, not restart — field report 2026-10-29

This records why the last completion claim never received a verdict and the
decision taken to fix it: resume the auditor's own pi session across a
provider failure instead of restarting the audit cold.

## The reported symptom

`note.md` asked: *"if model runs out midway do we redo the whole audit?"* and
*"we keep failing the last audit perhaps due to auditor switching"*.
Screenshot `Screenshot_20261029_165300.png` shows the answer GLLA actually
gave at the time:

    GOAL · auditing · RUNNING · 8/8 tasks · age 5h 24m · 450k tok
      provider error
      64 calls finished · activity 0s ago
      audit elapsed 1h 46m

immediately after a sequence of infrastructure notices:

    Detached auditor failed on openai-codex/gpt-6-luna (setting) — retrying
    with minimax/MiniMax-M3.1-Flash (fallback-pin). This is infrastructure,
    not a verdict.
    Detached auditor failed on minimax/MiniMax-M3.1-Flash (fallback-pin) —
    retrying with amr/deepseek-v4.1-flash (session-fallback). This is
    infrastructure, not a verdict.

## Observed journal evidence (`.pi-glla/active.jsonl`, this repo)

Candidate exhaustion on 2026-10-29, all `failureClass: "provider"`:

| at | from | to |
| --- | --- | --- |
| 18:02:56.278Z | openai-codex/gpt-6-luna (setting) | minimax/MiniMax-M3.1-Flash (fallback-pin) |
| 18:03:06.183Z | minimax/MiniMax-M3.1-Flash (fallback-pin) | amr/deepseek-v4.1-flash (session-fallback) |
| 18:04:27.589Z | amr/deepseek-v4.1-flash (session-fallback) | *(none)* — `503: workspace_billing_scope_unavailable` |
| 18:04:27.590Z | `auditor_fallback_exhausted` | — |
| 18:19:27.645Z | retry: gpt-6-luna again | → MiniMax → deepseek |
| 22:39:33.567Z | `auditor_fallback_exhausted` | `failureClass: "no-verdict"`, display `no auditor model` |

**Observed**: every configured auditor candidate failed on a provider error.
The claim was never rejected on merit — no verdict was produced at all. GLLA
behaved correctly here: the stored completion claim stayed durable and the
notices explicitly said "this is infrastructure, not a verdict".

**Inferred, not established**: which provider or account state caused the
individual failures beyond the recorded `503 workspace_billing_scope_unavailable`
and generic `provider error` text. No inference is made about account quota.

## The GLLA-owned cause

A mid-audit failure does not just switch models — it discards the audit.

1. Every auditor spawn uses `--no-session` unless `auditorInspection` is on,
   and that setting **defaults to `false`**
   (`extensions/goal-settings.ts:468`, spawn at
   `scripts/goal-auditor-worker.mjs:836`). Nothing persists the auditor's pi
   session by default, so there is no session to resume even in principle.
2. Each retry allocates a **new** `attemptId` and cancels the previous worker
   (`extensions/loops/goal-auditor-hooks.ts:731-736`, `:802-804`).
3. No partial result is carried forward. A search for
   `priorReport|partialFindings|carryForward|resumeFrom` across
   `goal-auditor-hooks.ts` returns **zero matches**.

Consequence: the 64 tool calls and 1h 46m of work shown in the screenshot are
thrown away on every switch, and the next attempt starts cold. On a large goal
this makes a successful verdict much less likely, which matches the reported
"we keep failing the last audit". The restart is deterministic, not a race.

The capability to fix this already exists but is unused by default: `inspection`
(`extensions/goal-loop-auditor-process.ts:1475-1477`) spawns
`--session <jobDir>/session.jsonl` instead of `--no-session`, and the worker
already honours it (`scripts/goal-auditor-worker.mjs:831-836`, including round 2
reusing the same spec).

## Why this is GLLA-owned

The classification, fallback walk, attempt rotation and `--no-session` default
are all GLLA code. The upstream provider failures are external and are *not*
part of the fix: the defect is that GLLA responds to an external failure by
discarding its own completed work. No Pi core, provider or external plugin
change is required.

## Decision: resume the session, and when to refuse

Chosen: spawn auditors with a durable `--session <jobDir>/session.jsonl` by
default and, on retry, resume that same session with a short continuation
brief. The auditor keeps its own real transcript — the files it read, the
commands it ran, the objections it had already formed — so a model switch no
longer restarts 64 tool calls of reasoning. The alternative (start fresh and
seed a summary of prior findings) was rejected: a summary is lossy and the
retry would have to trust evidence it did not gather itself.

Resume is deliberately **not** universal. It applies only to `provider`,
`transport` and `rate-limit` failures, where the session is healthy and was
merely cut off. A `context-exhausted` or compaction-failed audit restarts cold:
its transcript is already over budget, so resuming reproduces the same failure
and spends the retry budget to arrive at the same wall.

Resume is refused, and the audit restarts cold, when anything that defines the
audit has changed: the goal revision, the claim identity (replaced or
cancelled), the audit tier, or an explicit user cancel. Resuming across any of
those would judge a different question with the old work.

### A resume that cannot survive cleanup is not a resume

The session file lives in the attempt's job directory, and a failed attempt is
currently deleted whenever it produced no result — explicitly so kill-and-
restart loops do not accumulate empty dirs
(`extensions/goal-loop-auditor-process.ts:2920-2926`). Enabling durable
sessions alone would therefore persist a file that the very next failure path
removes, leaving nothing to resume. The retained session must survive that
cleanup for an attempt that is still resumable, while resultless directories
must still not accumulate.

### Verdict integrity is unchanged

A resumed audit is still one logical attempt and is judged normally. Verdicts
remain attempt-gated and revision-validated, a stale or mismatched attempt can
never apply its result, full-tier falsification still runs, and in-flight
isolation is preserved. What changes is only that the work is not thrown away.
Resume lineage (priorAttemptId, from/to model, resume count, revision, tier) is
recorded in the ledger and in verdict provenance, so an operator can tell a
resumed audit from a first-pass one without the verdict itself weakening.

## Related, separately reported — OUT OF SCOPE for this goal

- Tweak-confirm "wall of text": `extensions/goal-commands.ts:1206` interpolates
  the full `CURRENT:` and `NEW:` objective unformatted and untruncated, so a
  long objective is printed twice and fills the screen
  (`Screenshot_20261029_112819.png`, `_152631.png`, `_165336.png`).
- `/glla wipe` feels frozen: `.pi-glla/active.jsonl` here is 6.8 MB and
  rotation only triggers at 8 MB (`LEDGER_ROTATION_BYTES`,
  `extensions/goal-loop-core.ts:2379`). The reported slowness resolved on its
  own after waiting, so this is a latency note, not a hang.

## Prior recovery goal — closure status

The provider/quota recovery goal (`20261029112830-o9ecox`) was archived
`aborted` with `stopReason: "user wipe (/glla wipe)"`, not approved. Its work is
present in HEAD and green (`recoveryWaitIsDue` at both call sites;
`release:check` 4461 pass / 1 skip / 0 fail). It carries no auditor verdict
because of the same candidate exhaustion documented above.

## Implemented

- `auditorInspection` now defaults to `true`, so an auditor dispatch asks for a
  durable `--session <jobDir>/session.jsonl` instead of `--no-session`. The
  setting remains a real opt-out.
- A no-result attempt now KEEPS its job directory when it actually wrote a
  session (`hasResumableAuditorSession`). Previously that directory was deleted,
  which made resume a no-op. Retained directories keep the worker lock a
  finished audit keeps, so `inspectAuditJobHealth` classifies them `dead` once
  the worker PID is gone and the existing retention ceiling still reaps them —
  verified: `{"dead":1,"ambiguous":0,"cleanupCandidates":1}`.
- `decideAuditorResume` is the explicit policy. Resume requires: durable
  sessions on, a prior attempt, a `provider` or `transport` failure, an
  unchanged goal revision, the same claim lineage, an unchanged audit tier, no
  cancel, and a real non-empty session on disk. Every refusal returns a named
  reason.
- The worker spawns `--session <prior session>` and, when resuming, sends a
  short continuation brief instead of the full audit prompt, because the
  session already holds the brief and the commands already run.
- A missing or empty transcript degrades to a cold start, never a failed audit.
- Every dispatch records `auditor_resume_decision` (resumed or refused, with
  its reason, the prior attempt, the model being resumed onto, tier and
  revision), so a continued audit is distinguishable from a first-pass one.

## Verification

`tests/auditor-resume.test.ts` (18 cases) covers the default dispatch, the
retained-session artifact, reaping of a retained directory, the opt-out, the
resume/restart matrix for every failure class and every disqualifier, the
end-to-end `--session <prior transcript>` spawn, and cold fallback for a
vanished transcript.

Isolated controls (`controls.py`) prove both directions fail meaningfully, and
that a harmless rewording still passes. Raw logs are in `verification/`.

The auditor verdict path was not changed: `tests/auditor-verdict-authentication`,
`tests/revision-bound-audit`, `tests/auditor-challenge` and the full
`tests/auditor-*.test.ts` + `tests/audit-*.test.ts` set stay green (522 pass).

Gates at final HEAD `5e576645`: `npm run release:check` exits 0 — 4479 pass,
1 skip, 0 fail across 476 files, plus pack smoke; `npm run check` and
`npm run check:inventory` exit 0. Full output retained at
`verification/release-check.log`.

## Follow-up: the first claim was disapproved and why (2026-10-30)

The first completion claim was disapproved, correctly. The durable default, the
retention rule and the report were fine, but the **production retry path never
resumed** — the tests passed because they called the pure policy helper with
fabricated matching ids instead of driving the real dispatch resolver. Three
defects, all now fixed and covered:

1. **Claim identity conflated with the rotated job-dir key.** `beginCompletionAudit`
   saved the old `attemptId` as `priorAttemptId` and minted a new `attemptId` for
   the retry, then the resolver compared the two as claim identity — so an
   ordinary retry was refused as `claim-replaced` every time. Claim identity is
   now a stable `claimLineageId` minted once per `complete_goal` submission; a
   genuinely replaced claim carries the prior lineage in `priorClaimLineageId`,
   so the mismatch is still detectable.
2. **The session was looked for at a path the worker never writes.** Production
   job dirs are `audit-jobs/<logicalAttemptId>-<nonce>`; the resolver checked
   `audit-jobs/<priorAttemptId>/session.jsonl`, which almost never exists, and
   reported `no-session`. It now resolves through `findAuditJobDirectory`
   (newest-first by mtime).
3. **Revision, tier and cancel state were never supplied.** The guards existed
   but could not fire, so "a moved revision restarts cold" was untestable in
   production. All three are now persisted on the claim at dispatch
   (`auditorRevision`, `auditorTier`, `auditorAbortCause`).

Resume lineage now reaches **both** surfaces the contract names: the
`auditor_resume_decision` ledger entry (source model, target model, resume
count, revision, tier, prior attempt) and the verdict itself, via
`resumeProvenance` on the audit-history entry.

Two new isolated controls pin the wiring, because the previous control set was
satisfied by a broken production path: `rotated-claim-identity-regression`
restores the old claim comparison and `bare-session-path-regression` restores
the bare-path lookup. Both now exit nonzero.

## Fifth disapproval: the new class was dropped on reload (2026-10-30)

The auditor caught a defect in my own change, and it falsified the structural
claim I made about it. I wrote that the class "is declared once instead of in
five hand-copied unions". Two hand-copied whitelists of the same union survived,
and one sat in a file I had changed:

```
extensions/goal-loop-core.ts:3465   const auditorFailureClasses = ["transport", "timeout", "no-verdict", "provider"];
extensions/goal-recovery.ts:103     const AUDITOR_FAILURE_CLASSES = new Set([...same four...]);
```

`normalizePendingCompletion` gates the persisted field through that list, so
`context-exhausted` was silently dropped on every state reload, while `provider`
survived because it happened to be in the list:

| seeded class | on disk | after `readState` |
| --- | --- | --- |
| `provider` | `provider` | `provider` |
| `context-exhausted` | `context-exhausted` | **undefined** |

That is not cosmetic. Once the class is `undefined`, the retry ladder's
synthetic branch defaults it to `opts.retryFailureClass ?? "transport"` — and
`transport` is resumable. After a host restart with the retry marker persisted,
an overflowed transcript could therefore be **resumed**, which is precisely what
the class was added to prevent. The test that should have caught this seeded
`provider`, the one value that survives a stale whitelist.

The durable fix is not "add the missing literal to two lists". The lists are now
derived from one declaration, with a compile-time exhaustiveness assertion:

```
export const AUDITOR_INFRASTRUCTURE_CLASS_VALUES = [
  "no-verdict", "timeout", "transport", "provider", "context-exhausted",
] as const satisfies readonly AuditorInfrastructureClass[];

type MissingAuditorClass =
  Exclude<AuditorInfrastructureClass, (typeof AUDITOR_INFRASTRUCTURE_CLASS_VALUES)[number]>;
const AUDITOR_CLASSES_ARE_EXHAUSTIVE: MissingAuditorClass extends never ? true : never = true;
```

Adding a member to the union without adding it here is now a **typecheck
failure**, not a silent runtime drop. Both former copies read the shared list.
Verified: dropping `context-exhausted` from the array produces
`error TS2322: Type 'true' is not assignable to type 'never'`.

The tests now pin the durable path. The round-trip test round-trips *every* class
rather than just `provider`, and the context-restart case seeds the claim, reads
it back through `readState`, and dispatches against that reloaded object. Both
fail against the stale whitelist:

```
AssertionError: context-exhausted must survive a durable reload; a dropped value defaults back to resumable transport
AssertionError: context-exhausted must survive the reload this dispatch actually reads from
```

Replaying the auditor's own end-to-end flip chain now refuses instead of
resuming: `persisted class after reload : context-exhausted`,
`retryFailureClass ?? transport: context-exhausted`,
`{"resume":false,"reason":"failure-class"}`.

Two controls cover it: `reload-drops-context-class-regression` reinstates the
stale whitelist (exit 1) and `shared-class-list-incomplete-regression` removes a
member from the shared list, which must fail at **typecheck** (exit 2) — the
script's `CHECK` suite runs `tsc` precisely so the mechanism asserted is the
mechanism that fires.

## Fourth disapproval: context exhaustion was resumable (2026-10-30)

Two contract items were still unmet. The first was a behavioral contradiction
of the objective, not a documentation gap.

**Context exhaustion resumed.** The classifier had no context class at all, so
every overflow and compaction message fell through to `"provider"` — and
`"provider"` is resumable. Probing the production classifier and resolver with
the real message shapes:

| error | before | after |
| --- | --- | --- |
| `exceed_context_size_error` | `provider` → `{"resume":true}` | `context-exhausted` → refused |
| `maximum context length is 200000 tokens` | `provider` → `{"resume":true}` | `context-exhausted` → refused |
| `Auto-compaction failed: prompt too large` | `provider` → `{"resume":true}` | `context-exhausted` → refused |
| `503 workspace_billing_scope_unavailable` | `provider` → resume | unchanged (correct) |

Adding the class honestly meant following it through every place the union was
duplicated: the core type, the process re-export, the infrastructure-retry
cursor, the persisted retry field on the hooks cursor and the respec builder,
plus the schema enum. Those copies are why the class could have been added and
silently dropped; they now reference one declaration.

The matcher is deliberately narrow — a provider error that merely *mentions*
context still resumes, and there is a test for that, so the fix cannot quietly
turn every transient fault into a cold restart.

**The ledger half of the lineage requirement had no test.** `grep` found
`auditor_resume_decision` referenced only at its writer. The new test drives the
real retry dispatch and asserts the durable row carries `priorAttemptId`,
`sourceModel`, `resumedOntoModel`, `resumeCount`, `tier` and `revision`.

Both are now load-bearing: `context-exhaustion-resumable-regression` and
`missing-resume-ledger-regression` each exit nonzero.

## Third disapproval: the baseline was never stamped (2026-10-30)

The third claim was disapproved, correctly, for the most consequential gap yet.
The guards were written but **only the retry closure stamped the baseline**, so
the first retry after a parked provider failure compared against `undefined`:

| probe (production claim shape) | before | after |
| --- | --- | --- |
| revision moved 1 -> 99 | `{"resume":true,...}` | `{"resume":false,"reason":"revision-unknown"}` |
| tier full -> light | `{"resume":true,...}` | `{"resume":false,"reason":"tier-unknown"}` |
| same, baseline armed | `revision-moved` | `revision-moved` |
| unchanged, baseline armed | `resume:true` | `resume:true` |

It was reachable: `/goal tweak` accepts a *paused* goal and bumps the revision
without clearing `pendingCompletion`, so the very first retry could resume a
transcript gathered against the **old contract**.

Two fixes, both load-bearing:

1. **The primary `complete_goal` dispatch stamps the baseline** once per claim
   (not per candidate — a candidate fallback inside one dispatch must not read as
   a tier change). `revision` uses the codebase's `?? 0` convention, because a
   fresh goal has no revision and "absent" must not mean "unknown".
2. **The policy fails closed** when the baseline is absent (`revision-unknown`,
   `tier-unknown`) instead of skipping the guard. Absence is not permission: a
   claim that cannot state what it was dispatched against cannot be proven to
   still match, so it restarts cold.

The tests now drive the **real `complete_goal` tool** and assert the claim it
leaves behind, instead of hand-building a claim carrying the very fields whose
absence was the defect. Two new controls (`primary-dispatch-baseline-regression`,
`fail-open-baseline-regression`) reinstate each defect and exit nonzero.

## Second disapproval and its three fixes (2026-10-30)

The second claim was disapproved with three specific gaps, all real:

1. **The user-abort cause was never recorded.** `recordUserAuditorAbort` existed
   but had no caller, so `"user"` was unreachable and an explicit cancel was
   classified `"transport"` — which the resume policy treats as resumable. The
   host `AbortSignal` is now wrapped (`recordUserAbortOnSignal`), the decision is
   recorded where the human actually makes it, and `result.abortCause` rides the
   durable claim so a retry refuses to resume it.
2. **First-resume provenance omitted the source model.** `auditorSourceModel` was
   only stamped during a RESUMED dispatch, so `fromModel` was absent on the first
   resume — exactly when lineage first matters. Every dispatch now stamps the
   model it ran on, read back before the next stamp; both the ledger entry and
   the verdict name the prior model.
3. **Verdict application was not tested on the resumed path.** The stale-attempt
   case only covered stamping. It now exercises the real gates
   (`persistClaimWorkerActivity`, `isGoalRevisionCurrent`) in both directions, so
   a blanket refusal fails as loudly as a wrong accept.

A tenth control, `first-resume-source-model-regression`, initially PASSED against
the broken code — proving the test was reaching past the production decision into
a helper. Extracting `auditorDispatchStampFacts` made the defect reachable and the
control now exits nonzero. That is the same failure mode as the first disapproval
(fabricated inputs satisfying a policy helper), caught this time by the control
rather than by the auditor.

## Verdict-integrity evidence on the resumed path

The resumed path is proven not to weaken judging, through the real resolver and
the real protocol:

- **Attempt gating and revision binding** are unchanged: the resumed dispatch
  carries its own `attemptId`, and a moved goal revision is refused
  (`revision-moved`) before any worker spawns.
- **The falsification round survives a resume.** The worker derives the challenge
  from the TIER alone (`goal-loop-auditor-process.ts`, `strictChallenge` /
  `challengeSkip`), so resume cannot reach that decision. The test captures the
  real `request.json` at spawn time and asserts a resumed full-tier dispatch
  under `strictChallenge` sends no `challenge: false` and no skip reason, while a
  light tier still records `light-tier`.
- **`tests/auditor-verdict-authentication`, `tests/revision-bound-audit` and
  `tests/auditor-challenge` still pass** unchanged (59 pass together with the
  resume suite), and the full `auditor-*` / `audit-*` set stays green.

The schema drift pin (`persistence-hardening.test.ts` T6) caught a real omission
while this was being finished: `resumeProvenance` existed on `AuditVerdict` but
was not declared in `schemas/goal.schema.json`. The pin was right and the schema
was fixed, rather than the assertion relaxed.

## Regressions this change surfaced (fixed)

Making durable sessions the default exposed a latent terminal-summary bug that
had been dormant only because the session hint almost never rendered: the
"Auditor session kept for review" line was contributed as bare prose AFTER the
record pointer. It now renders as a bullet and is placed before the record, so
the summary keeps one change-first voice with the record still last
(`extensions/completion-summary.ts`, `extensions/loops/goal-auditor-hooks.ts`).
`tests/approval-notify.test.ts`'s shape assertion was updated to match the new
bullet prefix while keeping its real requirement — shell-safe quoting of a
worker-reported path — intact.
