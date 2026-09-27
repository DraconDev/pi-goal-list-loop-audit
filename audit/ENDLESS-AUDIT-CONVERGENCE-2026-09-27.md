# The endless audit — why goals never converged

**Date**: 2026-09-27 · **Scope**: `extensions/goal-loop-auditor.ts`,
`tests/auditor-scope-guard.test.ts`

## The report

Audits were not landing and never finished. Field screenshots taken across
ten repos at 02:10 on 2026-09-27:

| repo | reviews | disapproved | elapsed |
|---|---|---|---|
| hellhunter | 8 | 8 | **63h 39m** (13/13 tasks) |
| neonbreak | 13 | 13 | 19h 04m |
| football | 4 | 4 | 2h 11m |
| doomtap | — | — | 1h 59m (29/72 tasks, 7 queued) |

Host load at the time: **112.26**.

## Diagnosis: non-terminating, not slow

This is not a stalled audit and not a slow one. It is a refinement loop with
no convergence criterion. Every round the auditor found a genuinely new,
narrower objection:

- football — *"the last seven 'documented non-passes' were avoidable"*
- hellhunter — *"resolve the strike-registration finding at its actual cause;
  the current probe is capture-phase and cannot see the bubble-phase guard"*
- neonbreak — *"run the comparison in the same immutable rendering
  environment as the baselines"*

These are real defects, so the work is not wasted — it is converging
asymptotically. But "approved" requires the auditor to find *nothing*, and at
that depth of scrutiny something always remains.

Two mechanical causes, both in the audit brief:

1. **Objections were scoped to the repository, not the change.** The brief's
   `SCOPE GUARD` bounds the auditor to "the project at hand" — which is the
   whole repo. A defect anywhere in a codebase that never becomes defect-free
   therefore blocks approval forever.

2. **The surface was self-feeding.** Each disapproval appends to
   `.pi-glla/audit-loop/findings.md` (148 KB at the time of this work). That
   ledger is the auditor's own output, and it became the next round's blocking
   target: football's round-4 disapproval was literally *"close L31, L32, L33
   and L117"* — auditing a 166-line findings ledger the auditor itself grew.
   Positive feedback: more findings → bigger surface → more findings.

There was also no finite definition of *approved*. The brief said "be
skeptical and semantic" and then listed many reasons to disapprove, with no
statement of what evidence would suffice.

## What is deliberately NOT changed

**The tier resolver was left alone.** `resolveAuditTier` is escalation-only
and `priorDisapprovals > 0` forces `full` for the rest of the goal's life, so
round 8 is audited exactly as hard as round 1. That looks wrong and is
recorded here as a known wart, but weakening it would drop the falsification
round — which is where several of the real defects above were caught.
Trading correctness for speed is the wrong trade while the goal of the tier
work is trust. Revisit only if the loop is still unbounded after this change.

## The fix

### `CHANGE SCOPE` — what may and may not block

**Blocking:** a defect introduced by, or left unfixed in, the changed paths; a
verification-contract item that is missing, weakly verified or contradicted; a
regression this change causes elsewhere.

**Non-blocking** (report as advisory, do not disapprove): pre-existing
conditions and tech debt outside the changed paths; style, naming, speculative
hardening; anything not tied to a specific changed path or contract item.

Plus: *your own prior audit findings are inputs to re-check, not new
targets* — which is the line that breaks the self-feeding loop.

This narrows the existing `SCOPE GUARD` (which bounds the repository) rather
than replacing it, and it is conditional on recorded paths so the
`no recorded paths keeps the previous brief shape` pin still holds.

### `WHAT APPROVED MEANS` — a reachable bar

Approved **iff** every verification-contract item is verified by evidence the
auditor personally inspected, **and** no defect is found inside the changed
paths. Both conditions are checkable. The brief says explicitly that
withholding approval while hunting for a hypothetical defect outside the
reviewed change "is not scepticism, it is an unreachable bar."

### `REWORK ROUND` — round N asks a different question

When `auditHistory` shows prior disapprovals, the brief reframes the job:
*"your primary question is whether the PRIOR objections are now closed."* A
genuinely new in-scope defect still blocks — convergence is not
rubber-stamping.

The adversarial posture itself is untouched. Only its target is bounded.

## Verification

- `tsc --noEmit` clean.
- **167/167** across the 12 auditor suites (`auditor-scope-guard`,
  `auditor-challenge`, `auditor-stall-watchdog`, `auditor-process`,
  `auditor-timeout-settings`, `auditor-eager-retry`, `auditor-error-paths`,
  `audit-job-retention`, `stall-handling`, `audit-change-scope`,
  `visual-auditor-fresh`, `auditor-polish`).
- Three new tests pin the contract: the change-scope/approval-bar halves, the
  absence of rework framing on a first round, and its presence on a rework
  round including the "new defect still blocks" clause.
- One pre-existing pin caught a real mistake: `audit-change-scope` asserts the
  brief never contains `changed_files` when no paths were recorded. The first
  draft of the block mentioned `<changed_files>` unconditionally and failed it;
  the sentence is now conditional on recorded paths.

## Known limits

- **This is not yet proven against the field.** It changes the brief, so the
  next real rework rounds are the actual test. Watch the
  `reviews / disapproved` ratio: a goal that was 8/8 should stop climbing.
- **No circuit breaker yet.** A goal whose contract is genuinely unsatisfiable
  can still loop. The recommended backstop is a bounded-round escalation to a
  human decision (accept-with-debt vs continue) rather than another audit. Not
  implemented here — it needs goal-state plumbing, and it is a safety net for
  the case this fix does not cover, not the fix itself.
- Tier-by-blast-radius instead of tier-by-activity-volume is still open. Volume
  (`fileWrites`/`bashCalls`/`turns`) is uncorrelated with risk: a 300-file
  mechanical refactor and a 3-line auth change both score "full."
