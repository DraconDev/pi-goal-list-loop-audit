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


## Auditor disapproval 2026-09-17 (monitoring labels, citation husks)

The detached auditor reproduced two production defects and the review was accepted as evidence:

- **Monitoring labels** (`extensions/goal-loop-display.ts:1010`, `extensions/goal-loop-core.ts:745`): the keyword predicate rendered `MONITORING · next check` for a queued goal whose objective merely mentioned `healthz`. Objective text is intent, not runtime evidence; no GLLA producer attests an external watcher. `isMonitorGoal` now fails closed and queued activity renders as queued. Red repro `/var/tmp/glla-monitor-red.log` (the auditor's own probe output is quoted in the report) → green `/var/tmp/glla-monitor-green.log` in `tests/truthful-pause-labels.test.ts`.
- **Citation husks** (`extensions/completion-summary.ts:456`): the evidence-token grammar consumed only the first line reference, leaving `(,2760)` husks visible in the Deathrun screenshot. The pattern now consumes complete line lists/ranges and the archive retains the full reference. Red `/var/tmp/glla-screenshot-red.log` → green `/var/tmp/glla-screenshot-green.log` in `tests/screenshot-completion.test.ts`.
- **Substantive fixtures**: GLLA, Deathrun and Neonbreak screenshot-derived renderer fixtures now pin meaningful change explanations, failures/skips/limitations and the chat/archive citation split: `audit/fixtures/GLLA-COMPLETION-2026-09-17.md`, `DEATHRUN-COMPLETION-2026-09-17.md`, `NEONBREAK-COMPLETION-2026-09-17.md` (tests/screenshot-completion.test.ts). They transcribe historical examples; they are not newly executed external-project checks.
- **note.md** reconciled to verified 0.38.57 publication and the corrective 0.38.58 release; Later/Research retained.
- Adjacent display/summary/lifecycle suites: 296 pass / 0 fail across 20 files (`/var/tmp/glla-corrective-adjacent.log`).

Corrective release **0.38.58 published and registry-verified**. Commit `50596b320bb14359d2d0fccb8a9a6d73146cc685` (fix + release prep) pushed to main; tag `v0.38.58` = same commit; GitHub Release published 2026-09-17T04:06:45Z (https://github.com/DraconDev/pi-goal-list-loop-audit/releases/tag/v0.38.58). Full gates: gate1 `/var/tmp/glla-v0.38.58-gate1.log` honestly failed the version-trail contract (2248 pass / 1 fail) until `docs/INDEX.md` reached v0.38.58; gate2 `/var/tmp/glla-v0.38.58-gate2.log`: **2249 pass / 2 skip / 0 fail** across 222 files, typecheck/package/skill/tarball smoke green. Release workflow 35180679312 succeeded end-to-end (run log `/var/tmp/glla-v0.38.58-publish.log`): same 2249/2/0 suite, then npm trusted publishing with provenance (transparency log index 2872706353). Separate-shell verification (`/var/tmp/glla-v0.38.58-registry.json`, `/var/tmp/glla-v0.38.58-registry-version.json`): `npm view pi-goal-list-loop-audit version dist-tags.latest --registry=https://registry.npmjs.org --prefer-online --json` → **0.38.58 / 0.38.58**; direct version endpoint shasum `00b9bc199c2b64a0e8339e9268487143ad3c4725` matches the workflow log. npm processed the new version for ~2 minutes after publish; no republish or credential change was attempted. The running interactive Pi session remains on its loaded version until reload; isolated installed-tarball loading was verified by both gates.

## Release status

Version **0.38.57 published and registry-verified**, including the previous Unreleased paragraph-routing and audit fixes. Tag `v0.38.57` points to `cbb847d1649857ff9109579486518909f5a6f602` on main; no history rewriting.

- Published release: https://github.com/DraconDev/pi-goal-list-loop-audit/releases/tag/v0.38.57 (2026-09-17T02:36:28Z).
- Release workflow https://github.com/DraconDev/pi-goal-list-loop-audit/actions/runs/35175063587 succeeded, including 2244 pass / 2 skip / 0 fail and npm trusted publishing with provenance. Tag quality workflow 35175062734 also succeeded. Raw logs: `/var/tmp/glla-v0.38.57-publish.log`, `/var/tmp/glla-v0.38.57-tag-ci.log`.
- Separate-shell `npm view pi-goal-list-loop-audit version dist-tags.latest --registry=https://registry.npmjs.org --prefer-online --json` returns **0.38.57 / 0.38.57** (`/var/tmp/glla-v0.38.57-registry.json`). Initial index checks returned 0.38.56 while npm processed the new version; no republish or credential change was attempted.
- Direct version endpoint `/pi-goal-list-loop-audit/0.38.57` confirms tarball shasum `1cf0a29f072ad920a73bbe0e0040f959e809361f`, matching the publish log, plus SLSA provenance metadata (`/var/tmp/glla-registry-version.json`).
- Running interactive Pi was not reloaded or upgraded during this goal; registry verification does not claim the already-running extension changed version. Isolated installed-tarball loading was verified by both local and release gates.

Fresh review findings are resolved; terminal goal approval remains the detached auditor's decision.


## Final receipt-boundary repair (0.38.59)

The 04:54 audit correctly identified the Neonbreak Process/Ledger entry as
repository bookkeeping and the still-future wording in note.md. The previous
completion claim's assertion that note.md matched publication was incorrect.
It is now explicitly reconciled to the verified 0.38.57/0.38.58 releases;
Later/Research are unchanged. Subsequent release status belongs in this report.

The chat boundary removes repository-only receipt findings, not just their
paths. Empty groups are removed, remaining groups renumbered, and per-finding
proof stays aligned. Raw groups remain available to the archive. Failures,
skips, partial/unrun evidence and scope limitations remain visible. The
Neonbreak saved chat no longer has Process/Ledger or its audit-document path;
the archive still has the complete receipt. GLLA's closure receipt is likewise
archive-only. Useful implementation references and substantive ledger fixes
remain in chat; receipt classification does not use test-proof action words.

Verification: tests/repository-receipts.test.ts and screenshot-completion.test.ts
pin those behaviors. A blanket path-stripping attempt caused three existing
regressions in /var/tmp/glla-receipts-full-gate.log (2249 pass / 2 skip / 3 fail);
the implementation was narrowed, with those existing assertions unchanged.
Fresh reviewer 3763f162-c1d7-448b-a988-9bed447b591a identified missing literal
`unrun` protection and cross-contamination from proof `checked`; both were
accepted and corrected, with red /var/tmp/glla-v59-review-red.log then green
/var/tmp/glla-v59-review-green.log (38 pass / 0 fail). No findings deferred.

Final full command: `TMPDIR=/var/tmp timeout 1800 npm run release:check`.
Raw /var/tmp/glla-v0.38.59-final-gate.log: **2252 pass / 2 skip / 0 fail**,
2254 tests across 223 files; typecheck, state import, auditor extension fixture,
package inspection, packed skill and installed 0.38.59 import all passed.
The same AgentManager RPC and watched-repo integrations remain environment-gated
skips. `git diff --check` passes. All three regenerated screenshot-derived chat
and archive projections were inspected; historical external-project test
counts are clearly labeled, not claimed as freshly executed checks.

The accidentally duplicated historical changelog tail introduced during 0.38.58
prep was removed by comparing it to the intact 0.38.57 tagged contents. This
changes documentation only and does not rewrite Git history. Package, lock and
docs index now identify 0.38.59.

Publication verified: tag `v0.38.59` at `d9834f83` on main; GitHub release
https://github.com/DraconDev/pi-goal-list-loop-audit/releases/tag/v0.38.59
published at 2026-09-17T05:15:40Z. Release workflow 35185043123 and tag quality
workflow 35185043696 succeeded. Publish log:
`/var/tmp/glla-v0.38.59-publish.log`; provenance transparency index 2873488684.
Separate-shell npm registry query returns version and latest **0.38.59**
(`/var/tmp/glla-v0.38.59-registry.json`); direct version endpoint shasum
`05105b35d72e2161d9773abb8da749675a5a16b4` matches the workflow artifact
(`/var/tmp/glla-v0.38.59-registry-version.json`). No existing release or Git
history was rewritten. Running interactive Pi was not reloaded.
