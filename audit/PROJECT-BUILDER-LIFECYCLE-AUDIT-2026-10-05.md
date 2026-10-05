# Project-builder lifecycle audit — 2026-10-05

## Scope and disposition

GLLA project drafting, increment planning, detached verification, continuous
supervision, durable recovery, hold/resume, status presentation and terminal
handoff. Shared goal-audit retention and the full release gate are included.
Application implementation, external providers, Pi internals and other plugins
remain outside the implementation boundary. No live project was resumed or
its runtime journal edited by this audit.

Three implementation defects are addressed:

1. **Heartbeat misclassification (0.39.2):** a live project audit left the main
   session idle and accumulated continuation stalls. The exact uncancelled
   project dispatch now protects that window; a durable claim alone cannot.
2. **Premature evidence cleanup (0.39.3):** startup retention runs before
   reconciliation and could delete old results belonging to unresolved claims.
   Cleanup now reads durable goal and project claim identities, retaining their
   physical jobs until those claims settle. Manual cleanup uses the same rule.
   Protected jobs are excluded from reported cleanup candidates. Unrelated
   finished jobs continue to expire normally. Unreadable durable claim state
   blocks cleanup rather than authorizing deletion through an empty fallback.
3. **Compaction during project audit (0.39.3):** settled-turn compaction only
   received the goal-audit flag. A production reproduction fired compaction
   during a project audit. The shared compaction boundary now refuses while
   the exact project audit dispatch owns the wait.

Freeport provides direct heartbeat evidence: its 64th auditor tool completed
less than two seconds before escalation. Junk Runner retained the same stop
reason, but its job had already been reaped at startup; no lost semantic verdict
is claimed as proven. See the separate incident report and observation JSON.

## Coverage register

| Contract | Implementation checked | Verification |
| --- | --- | --- |
| Intended scope requires confirmation; claims cannot adopt verification status | respec transitions and registered tools | builder/wiring acceptance, decline and refinement tests |
| Every task maps to an open requirement; task claims do not verify requirements | plan/claim/begin transitions | incomplete batch, unknown ids and first-increment tests |
| Detached dispatch is singular and owned by the current root/claim | runtime running map, host context, generation adapters | concurrent wakes, disowned context, exact-claim and root tests |
| Main-session inactivity cannot stop an active increment audit | heartbeat dispatch guard | real installer/agent-end/worker plus six actual idle heartbeat ticks |
| Opportunistic compaction waits for the project auditor | shared compactor boundary guard | actual agent_settled with 315k context during a dispatched worker; red before fix, green after |
| No live-dispatch claim after cancellation or replacement | running-map predicate and controller cleanup | cancelled dispatch, replacement attempt and real worker cleanup tests |
| Supervisor freeze prevents dispatch/retry; explicit pause prevents late settlement | runtime dispatch/retry guards and pause cancellation | initial freeze, between-attempt freeze and actual worker pause tests |
| Rapid resume does not adopt a cancelled worker's result | abort and finally rearm guards | pause/resume race test |
| Bounds leave requirements unfinished and recoverable | project bound checks and loop resume | token/time bounds, blocker/resume tests; iteration resume code reviewed |
| Retry/fallback uses configured models and journals its cursor | shared fallback policy and runtime cursor commit | primary bounded retry and configured fallback tests |
| Late or different-revision evidence cannot settle new scope | synthetic audit goal, request hash/revision checks, transition identity checks | stale attempt, refinement, detached protocol tests |
| Recovery consumes valid completed evidence instead of respawning | completed-job lookup before model dispatch | actual saved worker approval recovered with launcher removed |
| Retention preserves unresolved recovery evidence | durable claim projection in health/cleanup | paused goal and held project regression; cleanup then actual approval recovery |
| Unreadable claim state cannot authorize job deletion | retention blocked report and cleanup guard | EISDIR journal failure preserves jobs; cleanup resumes after read recovery |
| Disapproval invalidates earlier regression proof and feeds replanning | settlement transitions | negative regression, contradictory and incomplete-evidence verdict tests |
| Completion requires every adopted criterion verified | settlement, archive and summary preconditions | one-batch unfinished, terminal archive and strict summary tests |
| Archive/outbox failures cannot discard verified evidence | archive before commit, durable outbox | archive failure, corrupt outbox and delivery/replacement replay tests |
| Journal failure cannot leave RAM ahead of disk | copy transition and rollback | complete prior-state restoration test |
| All-blocked work cannot spin after resume | blocker state and command guard | registered all-blocked/unblock/resume test |
| Status distinguishes live dispatch, stale evidence and held work | builder UI, compact footer, claim-fenced telemetry | missing telemetry, held reason and narrow-width renderer tests |
| Terminal summaries remain legible and transport bounded | shared summary limits and production renderer | dark/light semantic headings, bold/no italics, large Unicode summary tests |
| Runtime machine-local state stays outside published source history | ignored .pi-glla and release packaging | release contracts and installed tarball checks |

## Deliberate limits

There is no separate final audit dispatch after the last increment. Every
increment checks its selected requirements and previously verified acceptance
criteria as regressions; the last successful increment can complete the project
only when no adopted requirement is unfinished. A distinct additional final
review would be a workflow change, not an existing implemented stage.

Independent verification cannot establish capabilities absent from the adopted
scope. Draft confirmation and explicit scope refinement remain the controls
for deciding what the intended project includes. Human-only acceptance and
unresolved product decisions remain unfinished rather than being simulated or
silently removed. Long bounded tools may remain silent; tool waits are not
proof of forward progress. No test suite proves every possible host/provider
failure ordering.

SEO's previously observed orphan remains a separate runtime recovery debt.
The fixes here neither manufacture approval nor recover evidence that an older
retention sweep has already deleted.

## Validation

53 focused runtime/retention/compaction checks passed across four files. The
retention regression first exposed an incomplete test fixture (missing required
pending claim fields), then passed with a valid durable claim. Current host
0.99.1 and minimum host 0.84.2 TypeScript passed. Sixty actual renderer frames
across dark/light and widths 40/80/120 were inspected; no line overflowed its
terminal width, including the new held-audit card and footer.

The final **0.39.3 full release gate passed (exit 0)**: **3,230 passed, 1 skipped,
0 failed**, 3,231 cases across 349 files, approximately 585 seconds for the test
suite. The skip is the existing environment-gated watched-repository
auto-committer test. Remaining stages passed: current TypeScript, Jiti shared
state, offline auditor extension loading, inventory, dry-run packing and
installation/import of the actual 0.39.3 tarball with bounded launcher/worker
RPC and delegate skill loading. This is a clean complete gate for the final
implementation, not a reconstruction from retries of failed cases.

Earlier broad runs were stopped through their own signal handler when further
audit findings changed the implementation; process-group cleanup ran. Those
interrupted baselines are not release approvals. The final full gate starts
after all three fixes and their reproductions are in place.

Evidence: `audit/project-builder-audit-2026-10-05/`. Version 0.39.3 is prepared;
publication and live terminal intervention were not performed by this audit.
