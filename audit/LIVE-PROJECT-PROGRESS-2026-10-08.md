# Live project progress and observability study — 2026-10-08

Read-only observational study. No project source, runtime journal, active goal, process, or running loop was changed. This is not a benchmark of v0.39.16, not a complete project audit, and not proof that previous agents shipped no useful work.

## Method and limits

Snapshot started 2026-10-08T00:43:28Z. Discovery found 78 active.jsonl paths under /home/dracon/Dev (plus one unrelated state-root probe); 65 had a state snapshot recoverable from the last 8 MiB. Global state-root selector was workingDir. Local owner PID probes were corroborated by process comm=pi and matching cwd; nine distinct projects had matching live owner processes, including GLLA itself. A process census found two Pi processes in Deathrun, but only the recorded owner was treated as evidence of GLLA ownership. Alive process does not prove productive work.

Focused current-segment analysis covered Hegemon, Polis, Hellhunter, Darklord, Freeport, Doomtap, Deathrun, Studio, and the platform list. Recent git history and dirty paths were read without running their tests or touching their worktrees. Some directories share a parent git root (Studio/platform), so git commits cannot be attributed to those goals from cwd alone. Ledger rotation means current-segment counts are NOT full-run counts. Latest snapshots retain only 200 loop measurements / 20 builder history entries; older ledger segments exist and were inventoried, not fully replayed. Projects changed while being observed.

Temporary analysis artifacts, containing fuller local snapshots: /tmp/glla-live-study/{snapshots.json,analysis.json,analysis-summary.txt,snapshot.py,analyse.py}. These are not tracked or copied wholesale to avoid exposing raw project diagnostics.

## Observed runs

| Project | Snapshot | What it establishes / does not establish |
|---|---|---|
| Hegemon | Active loop; 686 iterations since Oct 3; measureCmd absent, builder absent, maxIterations=0. 123 current-segment loop_measured events all have null values; 88 spec_updated events. | This is the older metricless spec-reconciliation shape, not the audited requirement-builder shape. It can continue indefinitely without a measured product outcome. Recent hypotheses include citation discipline, spec-to-test-count bridges and documenting previous work. Some actual accessibility changes are mentioned; no end-to-end product claim was independently checked. |
| Polis | Inactive old metricless spec loop; 1163 iterations; held for main-model recovery. All 30 measurements in the current segment have null value. | Recent hypotheses include correcting citations, doubled articles and stale decision counts. This is concrete evidence of housekeeping taking loop turns, not proof that all 1163 turns were housekeeping. |
| Darklord | Inactive builder; phase auditing, cycle 28, revision 2, 100 loop iterations; all 10 requirements currently open. Retained history: 10 approved and 10 needs-work increments. | Parked on auditor infrastructure stall: heartbeat without tool/output progress for 10m. Past approvals do not translate to current verified coverage; rejected audits can reopen every verified requirement. Does not establish zero code delivery. |
| Freeport | Inactive builder; phase auditing, cycle 22, revision 4; 3 verified / 9 open requirements; retained history: 6 approved, 9 needs-work, 5 replanned. | Also parked on auditor infrastructure stall. Some coverage is explicitly verified, but the retained cycle count/outcomes alone cannot quantify newly delivered capability or repeated work. |
| Doomtap | Inactive builder; phase auditing, cycle 11, revision 1; 12 open requirements; retained history: 4 approved / 6 needs-work. | Also parked on auditor infrastructure stall. Concrete mastery/forge tasks appear in retained history; current open status cannot be read as absence of implementation. |
| Hellhunter | Inactive builder; phase replanning, cycle 8; 6 verified / 2 blocked requirements. | Partial verified progress exists. The remaining requirements include playable-loop evidence and route-transition bisection, not merely missing code. Snapshot blockage alone does not prove an external dependency; current GLLA distinguishes work from external blockers. |
| Deathrun | Live owner; goal auditing; recent asset/art and practice-harness changes. | A currently supervised goal with visible artifact changes. Delivery quality was not re-tested in this read-only study. |
| Studio | Live owner; active goal auditing previously fixed findings. | Current objective is verification, not building a new capability. Parent-repo commits are not attributable to this goal without paths/run identity. |
| Platform list | Live owner; paused standby; five queued goals. | Pause reason says fresh-context reviewer still running. This is waiting rather than product building. Child liveness/result delivery was not verified, so no stuck-wait defect is asserted. |

### Checkpoint visibility gap

At inspection, Hegemon HEAD was 9e704fd1b dated Oct 1, before the Oct 3 loop start. Its worktree contained 679 changed/untracked paths: heuristic classification gave 530 test paths, 61 documentation/evidence paths, 25 tooling/CI paths, and 63 other/runtime/config paths. These categories are path-based, not value judgments, and the snapshot changes over time. The absence of new commits means no shipped checkpoint can be inferred from HEAD movement; it does NOT mean no work was done. Source checkpoint problems are external to GLLA and were not repaired.

Latest 100 commit samples in other game repos contain both runtime/assets and substantial documentation/test/tooling activity. Test and documentation changes can be valuable; raw commit counts and test counts are not capability-delivery measures.

## GLLA-owned mechanisms that explain the observations

1. **Activity is a weak proxy for progress.** extensions/goal-loop-repetition.ts:isActuallyStuck exempts file-writing iterations unless replies are very similar; any positive gitCommitCount or specItemProgressCount also exempts. A sequence of different housekeeping edits can therefore keep the loop alive without advancing a product milestone. This is not a proven failure of the repetition detector: it is a mismatch between liveness and delivery.
2. **Metricless loops have no delivery verdict.** extensions/goal-loop.ts handles absent measureCmd as null and asks the agent to say honestly whether its prediction landed. Hegemon/Polis lack builder requirements and maxIterations is zero. Newer builder auditing does not retroactively convert these old running states into capability verification.
3. **Broad rejection loses the distinction between delivered and currently verified.** extensions/respec-builder.ts:settleRespecAudit reopens every previously verified requirement after a non-infrastructure negative verdict, not just named regressions. This conservatively avoids false current verification, but can generate repeated re-verification and makes current coverage look like no historical progress. Historical evidence should remain distinguishable from present validity; weakening verification is not the recommendation.
4. **Verification infrastructure can dominate or halt delivery.** Three recent builders retain auditing phase but have inactive loops with infrastructure-stop reasons. This is known, explicit parking, not silent approval. We need phase/cost attribution to know how much time was actually spent building versus verifying/retrying.
5. **Project acceptance can emphasize evidence maintenance.** Hellhunter and several recent hypotheses include freshness-at-HEAD, document censuses, citation locks and test-count reconciliation. These are legitimate constraints, but should not become an unbounded surrogate for product capability work.

## Are we logging enough?

There is enough existing evidence to diagnose the patterns above: durable state, dispatch/start acknowledgments, errors/fallbacks, compaction, hypotheses, builder history/reports, requirements, and git artifacts. Lack of raw volume is not the main issue. The six inspected game ledger-segment directories alone total roughly 1.4 GiB; repeated full state/report snapshots are substantial.

Missing or poorly exposed causal/progress information:

- **Per-iteration outcome receipt:** milestone/requirement IDs, intended outcome, actual outcome, evidence references, baseline/result revision, changed paths, and reason for choosing that work. Intent/hypothesis is not a delivered result.
- **Persistent progress signals:** fileWrites/gitCommits/specItemProgress/currentHead are computed in goal-loop.ts, then iterMetrics resets; loop_measured only records iteration/value/best/stall/hypothesis/stuck. The signals that exempted a turn from stuck detection are not preserved in that event.
- **Requirement deltas:** newly verified, reopened, blocked or unblocked IDs with exact reasons and causal audit attempt. respec_builder_transition logs phase/revision/cycle plus the latest history/scope change, not an explicit before/after coverage delta. Reconstructing from full snapshots is possible but cumbersome.
- **Phase costs:** timestamps and model records exist, but there is no simple durable per-increment building/verifying/retrying/waiting elapsed-time and token/cost roll-up. tokensUsed is accounted token usage, not proof of provider spend; cached input and pricing must not be guessed.
- **Attribution:** many dispatch records already carry identity; outcome/measurement/transition events need consistent run/project/cycle/attempt/session-generation identity too. A shared-repo commit or daemon write must not automatically count as this agent's delivery.
- **Running-version provenance:** record loaded GLLA version, relevant policy/config and loop mode at run start/rebind. Current source/package version is not proof of the code loaded by an older session.
- **Queryability:** histories are capped and journals rotated; an indexed or replayable progress view should distinguish cumulative run history from retained windows and show last durable checkpoint, last validated milestone and age of no capability progress.

## Recommended order of improvement (not implemented here)

1. Build a read-only progress digest from existing journals: mode, last demonstrable capability change, requirement coverage deltas, dominant phase, stop/wait reason and evidence links. Label unknown/unattributed values instead of inventing progress.
2. Add compact structured iteration/requirement-delta receipts and version provenance, not full transcript duplication. Reuse existing request/dispatch identities; bound payloads and redact diagnostics.
3. Introduce a delivery-level review trigger for many turns without validated milestone movement. Documentation and test edits count as activity, not automatically capability progress. Legitimate research/verification gets an explicit bounded outcome, not a blanket penalty.
4. Preserve historical delivery separately from current validity/freshness. Only itemized evidence may retain current verified status; global rejection must remain conservative unless its actual regression scope is known.
5. Offer explicit conversion/replanning for old unlimited metricless reconciliation loops into small capability increments. Do not silently mutate ongoing contracts or running processes.

Most important conclusion: the system can observe that work is occurring while remaining unable to explain whether the intended project became more useful. The next investment should be outcome attribution and capability-progress visibility, not simply more events or more automatic refires.
