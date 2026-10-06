# Continue interrupted work after main-model fallback — 2026-10-06

GLLA owns model selection and work rearming through public Pi hooks. Its settled
failover handler already scheduled saved goal/list/loop continuations, but returned
for ordinary requests. handleMainModelAgentEnd returned immediately after selecting
a backup, expecting core retry to continue. When that retry did not run, an ordinary
request or one-off blocker review could be left with a selected fallback and no
continuation. No Pi core or provider code was modified.

The settled handler now sends one continuation for the interrupted ordinary request,
using existing conversation/tool results and a bounded original-turn excerpt.
Capture is session/generation/workspace scoped; generated glla retry prompts do not
replace the original request or build nested handoff copies. The complete original
conversation remains authoritative. The message instructs continuation from current
progress, without replaying successful actions, changing scope, restarting a project
or demanding a new objective solely because the model changed. Status questions
remain status questions. Active goal/list/loop scheduling remains unchanged.

A running or queued turn prevents dispatch. A successful core retry clears the
failure and consumes the need for handoff; repeated settlement cannot duplicate it.
User aborts cancel automatic handoff without discarding the durable recovery episode.
Supervisor pauses, recovery waits and manual recovery holds remain respected.
Send failure retains the pending handoff for later fresh contact and reports failure.
The existing unsupervised-error-retry message type participates in failure-input
hygiene, retaining the latest meaningful handoff instead of accumulating obsolete
failed retry pairs. No external sessions or project state were changed.

Validation: 33 tests across three files plus 12 context-hygiene tests passed (45
in total); TypeScript, inventory and whitespace checks passed. Integration coverage
includes actual accepted backup selection, original request preservation, settlement
boundary, deduplication, busy/queued state, abort, successful core retry, send failure
and bounded long requests. Evidence: fallback-work-continuation-2026-10-06/.
Prepared for 0.39.13; no publication or live-session reload performed by this task.
