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
- Final outcome-first chat/archive tests: 30 pass / 0 fail across four files (`/var/tmp/glla-chat-archive-green.log`). Gate-row integration reads the written archive and verifies command/hash retention; chat omits them. Representative production-renderer output saved and inspected at `audit/fixtures/DRAFT-COMPLETION-CHAT-2026-09-17.md`.
- Full release gate for 0.38.57: `TMPDIR=/var/tmp timeout 1800 npm run release:check`, raw log `/var/tmp/glla-v0.38.57-gate3.log`: 2243 pass / 2 skip / 0 fail across 221 files, followed by typecheck, state-import repro, auditor-extension fixture, npm pack inspection and installed tarball import/skill smoke success. Two skips: real AgentManager stop RPC; auto-committer watched-repo integration (both environment-gated).
- Subsequent prompt/tool description parity and comment cleanup: 30 pass / 0 fail across six affected files (`/var/tmp/glla-final-targeted.log`); typecheck and diff-check pass. No production behavior change after the full gate.
- Failed intermediate verification runs remain in `/var/tmp/glla-wreos1-release-check*.log` and `/var/tmp/glla-v0.38.57-gate2.log`; they are not counted as successes. Old presentation assertions were updated to the confirmed chat/archive split. The detached approval test now releases its fake verdict only after observing repaint, removing a fixed-timer race. The telemetry fixture holds its report phase longer but remains a sampled observation test, not a guaranteed event stream.

## Fresh review and dispositions

The fresh read-only reviewer (`da35b8d2-6b4c-4448-b703-e2b51d214b15`, report `wreos1-contract-review.md`) found three valid recap defects and one drafting wording conflict. All were corrected before publication:

- Multi-repair durability: objective-scoped `Goal.completionRecap` is persisted with the audit claim and survives disapproval/reload; a different objective does not inherit it. The registered-handler test now drives **two disapprovals** before final approval.
- Full archival evidence: the original claim is appended verbatim in a labeled archive section; the regression includes a distinctive log path, hash, and over 10,000 characters of evidence.
- Structured repair precedence: both headline and Summary select the original recap, whether plain or structured. A four-combination renderer matrix covers plain/structured original and repair claims.
- Drafting wording: one rule now batches independent questions per phase and defers dependent questions until prerequisites are answered. Superseded literal UP FRONT assertions were updated without removing the batching/structured-picker checks.

The multi-repair handler test failed before the fix (`/var/tmp/glla-multirepair-red.log`) and passed afterward (`/var/tmp/glla-multirepair-green.log`). Adjacent suites: 55 pass (`glla-recap-review-adjacent.log`), drafting suites 58 pass (`glla-review-fixes2.log`), matrix/context suites 21 pass (`glla-review-matrix.log`). Typecheck and diff-check passed.

Full gate4 retained honestly at `/var/tmp/glla-v0.38.57-gate4.log`: 2240 pass / 2 skip / 3 fail. All three failures were explicit template-size pins after a +23 ASCII-byte continuation wording change, not cardinality/growth failures. Pins were refreshed by the per-payload delta; provider usage and cardinality assertions remain unchanged. No measurement implementation changed.

Final full gate: `TMPDIR=/var/tmp timeout 1800 npm run release:check`, `/var/tmp/glla-v0.38.57-gate5.log`: **2244 pass / 2 skip / 0 fail**, 2246 tests across 221 files; typecheck, state-import/auditor fixture, package inspection, installed tarball import and skill smoke all passed. The same two environment-gated integrations remain skipped (AgentManager stop RPC and watched-repo auto-committer). This supersedes gate3 after the production review fixes.

## Release status

Version 0.38.57 prepared, including the previous Unreleased paragraph-routing and audit fixes. Fresh review findings are resolved and final release-wide verification passed. Publication verification remains. This report is not a completion claim.
