# Drafting-to-completion experience

## Requirement and ownership map

| Concern / screenshot | GLLA-owned path | Regression evidence / remaining work |
| --- | --- | --- |
| Structured choices, 20260916_120648 | goal-loop-core buildSeedGrillMessage; three drafting prompts | drafting-questionnaire.test.ts pins tool-first guidance; model obedience and picker internals are external |
| Visible phases and dependent questions | same prompt builders; proposal confirmation floor | Roadmap, independent batches, dependent stages, explicit question/proposal handoff; existing confirm-draft tests protect confirmation |
| Promise-only ending, 20260916_213326 | goal-activation agent_end / tool_result; drafting-handoff observer | drafting-handoff.test.ts registered-handler replay, exact corrective followUp and no duplicate; cancellation, new user, busy, pending, shutdown and new draft suppress stale correction |
| Paused vs recovery/monitoring, 20260916_195540 | goal-loop-display paused lifecycle and goalDisplayActivity; goal-ui evidence projection | Shared card/footer distinguishes scheduled waits (auto-continue), untimed user waits (resume action), and evidenced recovery (auto-retry). truthful-pause-labels.test.ts covers future/due/overdue/absent timers and old queued work. Age no longer implies monitoring; explicit monitoring objectives retain the existing display classification, not proof of a live external watcher. |
| Outcome-first completion, 20260916_224518 / 224738 / 224741 / 224746 / 224749 | completion-summary renderer; goal-tools claim capture; goal-orchestrator archive | Shipped: lead-paragraph headline echo; empty-paren husks removed in evidence extraction and structured strips (shared stripMachineGroups); repair re-claims carry priorCompletionSummary so chat AND archived Terminal summary lead with the whole work (tests/recap-preservation.test.ts, red→green); 111 adjacent tests pass |

## Draft handoff diagnosis and containment

A real-shaped questionnaire tool_result increments the interview floor, but draft-only successful agent_end previously returned without a handoff. The active-goal answered-question-dispatch test manually schedules continuation and does not cover this path. A registered-handler replay initially failed the missing-follow-up assertion while a genuine question correctly waited. This is an external model unfinished-response symptom with a GLLA-owned bounded recovery seam, not a Pi-core implementation target.

The correction is limited to the reported dangling introduction shape after a noncancelled answer. It spends one budget per explicitly entered draft, waits for settlement, then requires the current generation, unchanged draft/activity revision, idle/no pending messages, current ownership, and no hold. It sends a custom followUp (never a synthetic human answer), requesting the next question or proposal without activation. It never rearms; new answers do not replenish the budget. New tools, user replies, turn starts/ends, cancellation and replacement supersede queued correction. Ordinary questions and ambiguous prose fail closed. Model adherence remains external and is not guaranteed by MockPi tests.

## Bounded checks so far

- Original registered-handler repro: 1 pass / 1 expected failure (missing automatic follow-up).
- Automatic correction plus adjacent drafting/confirmation/continuation tests: 41 pass / 0 fail, six files (`/var/tmp/glla-drafting-adjacent-auto.log`).
- Expanded cancellation/lifecycle drafting fixtures: 11 pass / 0 fail (`/var/tmp/glla-drafting-fences.log`).
- Summary fragment fixes: nested-husk probe plus 110 adjacent tests pass across 9 files (`/var/tmp/glla-husk-adjacent.log`).
- Whole-work recap preservation: red (delta-only re-claim lost the recap from chat AND archive) → green; 111 pass / 0 fail across 10 files, tsc clean, diff-check clean (`/var/tmp/glla-recap-full.log`).
- Drafting + pause/display + continuation policy: 180 pass / 0 fail across 10 files (`/var/tmp/glla-drafting-pause-green.log`); `TMPDIR=/var/tmp npx tsc --noEmit` and `git diff --check` pass.
- Retry fixture fidelity: production recovery writers persist recoveryEpisodeKey/pendingCompletion; old provider-wall fixtures were updated to carry that evidence. The old plain-user wait pin is superseded by explicit deliberate-wait coverage, not treated as a recovery episode. No scheduling or durable lifecycle change.
- Full release-wide gates: still required (task 5).

## Release status

Not released. Drafting, display and summary changes are implemented; final release-wide verification and publication remain. This report is not a completion claim.
