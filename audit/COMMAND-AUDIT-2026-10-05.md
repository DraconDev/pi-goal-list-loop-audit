# Command and recovery audit — prepared 0.39.5

Scope: GLLA's five registered slash-command families, argument completions,
settings-table entry, decision-picker actions and durable recovery transitions.
Implementation and tests stay in GLLA. Live project journals, terminals and
external command registrants were not modified or restarted. This patch is
prepared as 0.39.5 and is not yet published.

## Confirmed findings and corrections

| Finding | Before | Corrected behavior |
| --- | --- | --- |
| Broad loop resume | `/glla resume` only admitted the restore-hold reason | Shares admission with `/loop resume`, then uses its blocker/branch checks; retains the increment claim |
| List audit resume | `/list resume` rejected an auditing head | Delegates to the existing completion-audit recovery handler |
| Terminal goal controls | Pause and verify revived terminal work; cancel could replace terminal disposition | Pause, verify and cancel explicitly refuse complete/aborted goals |
| Manual verify ownership | Stale host could persist a new completion claim | Refuses before claim mutation or audit launch |
| Manual review ownership | Stale host produced review artifacts/follow-up work | Refuses at the entry boundary |
| Decision replacement | A selection from an old picker could cancel a replacement goal | Revalidates host and exact pending decision after the dialog yields |
| Decision delivery | A failed content-choice send could be followed by resume | Keeps the decision paused and names the failed delivery |
| Executable decisions | A `/list cancel` option steered the agent and resumed instead | Dispatches list controls through cmdList; supported loop controls use cmdLoop |
| Goal transaction failure | Pause/resume/verify ignored a failed state update and announced success or attempted dispatch | Stops on the failed transaction, with no success message or new claim dispatch |
| Command guidance | Decide was missing from completions; status linked to bare `/list` (drafting); max-iteration project hold omitted its resume hint | All goal routes have completions; inspection uses `/list show`; bound admission and hint share the predicate |
| Explicit stop guidance | Stopped project audits rendered as held and advertised `/loop resume`, which correctly refuses that user stop | Card and footer say audit stopped and direct inspection to `/loop status` |

The retained Junk Runner hold dates to 2026-10-04, before this release; the
broad-resume defect explains why the operator's chosen recovery command did
not reactivate it. This is distinct from establishing a new heartbeat failure.
See BROAD-RESUME-2026-10-05.md for the exact claim-to-worker regression.

## Reviewed command contract

| Family | Reviewed routes and boundaries |
| --- | --- |
| `/goal` | Bare draft/natural-language objective, start, plan, audit, verify, status, timeline, archive, pause, resume, cancel, tweak, decide. Confirm/replacement, single-active-work, stale ownership, pending claim/settlement, terminal state and post-dialog identity |
| `/list` | Bare draft/input detection, add/import, start/next, show/depth, audit/plan, pause/resume/tweak, remove/rm, clear/cancel, settings redirect. Queue hydration, paused/auditing head recovery, archive-before-advance, sidecars and stale mutation admission |
| `/loop` | Bare draft, start, plan, audit, respec, status, refine/polish, pause/resume, stop/cancel, finish. Branch ownership, bounds, preserved history/claims, blocked requirements, cancellation and independently verified project completion |
| `/glla` | Settings table; version/status/log/stats/audits/agents/switchlog; fallbacks; pause/resume/cancel/wipe; owner/takeover; postaudit/reviewer; tooloverride; bug; retired reset and unknown action. Read-only inspection vs mutation, supervisor freeze, waiting queue, settings confirmation and post-dialog stale host |
| `/review` | Archive id resolution (exact/unique partial), explicit modes, manual follow-up extraction and mutation admission |

Pause commands intentionally have different scope. `/glla pause` freezes the
supervisor while active work/worker execution remains intact. `/goal pause`,
`/list pause` and `/loop pause` hold their work. `/glla resume` also unfreezes
the supervisor and can start a waiting-only queue; targeted resumes handle their
own work. Stop/cancel and finish are distinct from a resumable pause. Bare
`/list` drafts; `/list show` inspects. Unknown natural-language goal/loop/list
input may legitimately enter drafting; unknown `/glla` actions are refused.

## Validation

Each new defect group was reproduced with behavior tests before its correction.
The command admission run failed nine assertions (six terminal combinations,
stale verify, stale review and auditing list recovery); the decision replacement,
list decision execution and stopped-card regressions each failed independently.
The transaction-failure injection failed pause, resume and verify before fixing
caller handling. Before logs are retained in command-audit-2026-10-05/.

The broader command behavior pass ran 227 cases: 226 passed and one old
source assertion expected the incorrect bare `/list` inspection hint. The
assertion was corrected to `/list show`; its complete file subsequently passed.
A final current-source run covers the corrected assertions, all new regressions,
real project audit resumption/archival, TUI widths, command discovery and
neighboring recovery paths. Final counts and evidence are recorded below once
that run finishes. TypeScript and the Jiti shared-state test are also checked.

This is a focused command audit, not a claim that every possible combination
of provider failure, dialog interleaving and filesystem failure was exhaustively
enumerated. The full release gate must run before publishing 0.39.5.
