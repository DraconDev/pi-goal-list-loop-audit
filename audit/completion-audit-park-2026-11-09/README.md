# A parked completion audit: the stranding dead end and the bogus diagnosis

**Trigger.** A field report: *"some lists stalled and forced me to re-prompt —
claim auditor issue but same model as session"* (`Screenshot_20261109_052717.png`).

Shipped under `## Unreleased` — no version bump, no tag.

## What the screenshot shows

The transcript ends with `complete_goal`'s staged admission:

> `AUDIT PENDING — nonterminal. The completion claim is stored. Before the
> detached audit starts, GLLA will check preventive compaction at an owned idle
> boundary. End this turn; do not poll or submit another claim.`

then `Compaction/startup check is now in progress.` and
`Reloaded keybindings, extensions, skills, prompts, themes, and context files`.

The item's card afterwards:

```
Fix audit finding: LOW: parse_ppid_from_stat panics on truncated input — list item · paused · total 4h 45m
  completion audit: parked — no review recorded
  the stored completion claim was not evaluated — the audit waits while the item is paused
  lifecycle: safely parked · owner: detached auditor recovery · 14 queued
  last host activity not available · next: /list resume starts a fresh auditor
  The completion claim is stored and was not judged. Fix the auditor/session issue, then /list resume to start exactly one fresh audit.
```

Two distinct defects are visible in that block, and they compounded:

1. **A dead end.** With recovery consent present, the one automatic retry was
   consumed and launched nothing, so the only exit was a manual resume.
2. **A diagnosis the record did not support.** `Fix the auditor/session issue`
   was printed for *every* cause. The operator checked the auditor model against
   the session model — identical, because the auditor inherits the session model
   by default — and reported the diagnosis as wrong. It was: the durable reason
   was `session_shutdown:reload`, a host boundary.

## Defect 1 — the admission gate contradicted the recovery that owns it

Two gates disagreed about the same state:

- `maybeAutoRetryParkedCompletionAudit` (the single durable automatic recovery)
  requires `goal.status === "paused"` … and its origin is `session-recovery`.
- The pre-audit admission branch in `retryStoredCompletionAudit` required
  `state.goal?.status === "auditing"` for **every** origin except `manual` and
  `agent`:

  ```ts
  if ((state.goal?.status !== 'auditing' && origin !== 'manual' && origin !== 'agent')
      || abortedStandDown || … ) return;
  ```

So an automatic retry could never pass: it runs only when the goal is paused, and
the gate refused paused. It consumed its one-shot marker and returned forever.

**Reproduction (before the fix).** Stage admission with a busy `complete_goal`,
interrupt with a session boundary, then grant the automatic retry the way a
successor session does (`autoResume` on):

```
events: …, audit_compaction_admission_pending, audit_recovery_pending,
        session_shutdown, session_handoff_rejected, audit_recovery_auto_retry_claimed
state:  status paused · phase recovery-pending · preAuditCompaction true
        compactions started: 0   auditors started: 0
```

The claim was made (`audit_recovery_auto_retry_claimed`) and then nothing
happened — with the load hold NOT involved (`loadHoldAt: undefined`), so this was
not the documented consent gate.

**Fix.** `recoveryAdmitted` allows the `session-recovery` origin to discharge the
debt it owns, and journals `audit_compaction_admission_discharged` when the debt
is discharged without a compaction. The origin is narrow: it arrives solely from
`maybeAutoRetryParkedCompletionAudit`, which has already cleared the load hold,
the supervisor freeze, the provider due time, the one-shot marker,
`automaticRecoveryAttempted`, the generation and `guardGoalBeforeContinuation`.
Compaction is still attempted first — the debt's purpose is unchanged — and the
launch falls through on the same safe boundary only when compaction is
unavailable, spent, or failed (the branch's own documented behaviour).

**After the fix**, same reproduction:

```
audit_recovery_auto_retry_claimed → audit_compaction_admission_started
→ (compaction completes) → phase: starting, preAuditCompaction: undefined, one worker start
```

## Defect 2 — one sentence asserted a fault class the record did not contain

`markCompletionAuditRecoveryPending`/`parkCompletionAuditRecovery` wrote the same
`pauseSuggestedAction` for every reason:

> `The completion claim is stored and was not judged. Fix the auditor/session
> issue, then <resume> to start exactly one fresh audit.`

The durable `pauseReason` did carry the real breadcrumb
(`completion audit blocked — no verdict: session_shutdown:reload`), but **no
surface rendered it** — both parked card renderers printed a constant line and
then the action sentence. The only diagnosis on screen was that guess.

**Fix** — `extensions/completion-audit-park.ts` (leaf module; imports only the
provider vocabulary so both the writer and the two renderers can share it):

| Cause | Classified from | Action |
| --- | --- | --- |
| session boundary | `session_shutdown:*`, `session_start:*`, `silent-host-successor:*`, `host-rebind` | "the session changed before the auditor finished, so nothing about your auditor or model setup is implicated" |
| watchdog | `stale-latch-recovery`, `heartbeat-recovery` | "the auditor stopped reporting and the supervisor parked it rather than guess" |
| provider | `isRecoverableProviderError` | "the provider failed the audit run. Restore provider access (or pick another auditor model…)" |
| verdict apply | `verdict-apply-gate` | "its verdict could not be applied to this goal" |
| no verdict | anything else | "the auditor exited without a verdict; if it repeats, check the auditor model and tool budget" |

An unknown reason degrades to **no-verdict**, never to a model accusation and
never to "nothing is misconfigured" — both would assert facts the record does not
contain. The card now prints `why: <cause> (<raw breadcrumb>)` on both the glance
and detailed renderers.

## What deliberately did not change

- **The cold-load consent gate.** A load without Auto-resume (or an explicit
  resume, or same-process continuity) still holds a parked claim for a decision.
  Making a reload auto-dispatch would spend consent the operator never gave; the
  fix is that the *admitted* path now finishes, and the held path says why.
- **Lists stop at the paused item.** Advancing past a claim that was never judged
  would silently drop it. The queue (14 items in the report) waits and the card
  names the surface command.
- **The durable `pauseReason` shape** (`completion audit blocked — no verdict: …`)
  is unchanged: displays and several tests key off it, and the defect was the
  action line's certainty, not the record.

## Verification

```text
bun test tests/pre-audit-compaction.test.ts        → 14 pass / 0 fail   (11 before; 3 new)
bun test tests/completion-audit-park.test.ts       →  8 pass / 0 fail   (new)
bun test tests/retry-bounds.test.ts                → 18 pass / 0 fail
bun test tests/display.test.ts                     → 121 pass / 0 fail
bun test tests/behavioral-orchestrator.test.ts     → 159 pass / 0 fail
bun test tests/completed-audit-recovery.test.ts    → 50 pass / 0 fail
bun test tests/auditor-resume.test.ts              → 38 pass / 0 fail
bun test tests/same-process-successor-resume.test.ts → 3 pass / 0 fail
bun test tests/audit-stuck-batch.test.ts           → 11 pass / 0 fail
bun test tests/stale-api-terminal.test.ts          → 16 pass / 0 fail
bun test tests/recovery-lifecycle-regression.test.ts → 30 pass / 0 fail
bun test tests/host-session-lost.test.ts           → 17 pass / 0 fail
bun test tests/auditor-blank-until-resume.test.ts   →  9 pass / 0 fail
bun test tests/fresh-session-auto-recovery.test.ts →  7 pass / 0 fail
bun test tests/load-hold-release.test.ts           →  3 pass / 0 fail
bun test tests/pause-anti-confabulation.test.ts    →  4 pass / 0 fail
bun test tests/ui-status-projection.test.ts        → 11 pass / 0 fail
bun test tests/doc-parity.test.ts                  → 13 pass / 0 fail
bun test tests/doc-index.test.ts                   →  3 pass / 0 fail
npx tsc --noEmit                                   → clean
node scripts/check-no-project-names.mjs            → clean
node scripts/generate-inventory.mjs --check        → exit 0
```

### New tests, and what each one pins

- *a reload during the admission wait still launches the stored audit when
  recovery consent exists* — fails before the fix at
  `audit_compaction_admission_started` (the claim was consumed with zero
  compactions and zero launches); asserts one compaction re-entry, then exactly
  one worker start and cleared debt.
- *a cold load without consent HOLDS the staged claim, and says so without
  blaming the auditor* — the consent law is intact, the action line names the
  session boundary, the banned generic sentence is absent, and the durable
  `recoveryReason` still records `session_shutdown:*`.
- *the promised manual path works from the parked state: /list resume starts
  exactly one audit* — the card's own `next:` promise, driven below the
  preventive target so it proves the debt is discharged rather than re-compacted.
- `completion-audit-park.test.ts` — the classifier and copy, including the
  unknown-reason default and the length bound.

### Two pre-existing failures on this host, both reproduced at tag `v0.39.65`

Both are 5-second test-budget timeouts in tests that boot a real child process;
each reproduces identically in a clean `git worktree` at the pre-change tag, so
neither is caused by this work:

- `tests/regression-shield.test.ts` — "mechanical checks stay async and kill
  descendant processes on timeout"
- `tests/audit-lifecycle-surfaces.test.ts` — "durable: an ordinary complete_goal
  records phase running + lastActivityAt before the verdict"

`node scripts/run-tests.mjs` also refuses to start here: the installed Bun 1.3.3
lacks `--parallel` / `--path-ignore-patterns` (the runner requires ≥1.3.14), so
the suite was run file-by-file. No aggregate total is claimed.
