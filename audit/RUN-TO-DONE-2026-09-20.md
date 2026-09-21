# Run-to-done mode (v0.38.73, 2026-09-20)

## Request

"Draft up front, then carry on til the end unless we have a good reason
to stop." Clarified to: run-to-done mode (draft once, push through
pauses/decisions with recommended options) with hard stops only —
complete, caps exhausted, provider down, user abort.

## Design

Consent, not a setting. A `runToDone` boolean on the goal, set only via
`propose_goal_draft(runToDone: true)` after the interview asks supervised
vs run-to-done. The Confirm dialog displays the mode in full view (the
Confirm IS the consent — never a silent agent-side param); consent is
durable on the goal and ledgered as `run_to_done_consented`. Batch and
single-list drafts refuse the flag with guidance (single-goal only v1);
the `glla-delegate` skill instructs the interview question.

Runtime (all gated on the per-goal flag, supervised behavior untouched):

- Session start: the flag releases cold-restore consent
  (`shouldAutoResumeOnSessionStart` with effective `true`) — held loops
  resume, recovery/retry probes restore, auditor surface releases.
  Specific beats general: wins over unset AND explicit-false global
  autoResume.
- Decisions: `pause_goal` kind=decision auto-defaults immediately with
  the same counter + autoDefaultLog mechanics as the budget path, under
  a distinct `run_to_done_auto_default` ledger event and copy.
- Audit caps: BOTH cap branches (complete_goal in goal-tools.ts,
  provider-retry in goal-auditor-hooks.ts) park instead of converting
  to TODOs. Repeated rejection means the approach is wrong — a cap is
  exactly the "good reason to stop" the request names.
- Preserved stops: error/abort ceilings (already terminal), provider
  outage (parks — nothing to do but wait), user abort/pause (always
  wins), blocked-on-external (missing input is hard-stop-class, not
  friction — pinned by test). The auditor is never skipped.
- Visibility: `run to done` chip on every status branch while set.

## Verification

- New `tests/run-to-done.test.ts`, 9 tests: draft consent (flag +
  dialog notice + ledger), supervised control, batch refusal, decision
  auto-default with no budget, cap parks with flag (aggressive, cap 2,
  two fake-auditor disapproval rounds), aggressive conversion preserved
  without flag, session-start held-loop resume + blocked stays parked,
  held control, status chip present/absent.
- Incidental finding while testing: without ANY consent the auditor
  surface stays suppressed after cold restore and audits never run —
  the control cap test initially timed out until granted legacy
  autoResume, which itself proves the new consent releases the surface.
- Slice green: run-to-done (9) + decision-budget + eager-continuation +
  delegate-skill + display + goal-loop-display (145 total) +
  behavioral-orchestrator + auditor-process + persistence-recovery +
  goal-loop-core (227 total). `tsc` clean.
- One existing source pin updated: eager-continuation-core's
  `if (effectiveCap.aggressiveMode) {` regex now matches the
  run-to-done-excepted condition. This is the user-directed contract
  change itself (caps stop under run-to-done), not a weakening — the
  aggressive default is behaviorally pinned intact by the new control
  test.
- `docs/INDEX.md` version trail repaired (was pinned at v0.38.71;
  release-contract pin green again).
