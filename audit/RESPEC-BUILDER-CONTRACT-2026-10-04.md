# Respec builder implementation contract

User-authorized objective: evolve `/loop respec` into sustained project building,
not polishing. Draft intended capabilities, build substantial increments, audit
independently, and replan from unfinished requirements until the intended project
is verified or explicitly paused/stopped.

Required behavior:

1. Draft from project research and operator intent. Distinguish observed behavior
   from desired capabilities; do not silently turn a missing feature into an
   accepted limitation. Existing binding Rules stay authoritative. Confirm the
   intended requirements before adopting new project scope.
2. Persist a requirements register and a coherent current increment. Each
   requirement has observable acceptance criteria, status and audit evidence.
3. Claimed task completion triggers the existing isolated auditor machinery.
   The build agent cannot mark requirements verified or approve its own cycle.
4. Auditor failures and unfinished requirements feed the next plan. Blocked work
   keeps its reason. Replanning cannot silently remove requirements or failed
   work. Scope changes use an explicit confirmed refinement.
5. Persist Drafting, Building, Auditing and Replanning phases. Reload/compaction,
   stale workers and concurrent pause/stop must not lose or settle newer work.
6. Only independent verification of the complete intended contract can finish
   the project. Ending a task batch, checking Markdown boxes or editing prose
   cannot imply completion. Bounds and stops remain distinct from completion.
7. UI/status show phase, current increment, verified/remaining/blocked coverage,
   evidence and next action, using semantic colors and bold without italics.
8. Document command syntax and validate unsupported arguments. Update version
   and inventory; verify behavioral state transitions, real tool/command wiring,
   detached auditing, persistence/reload and actual dark/light narrow UI rendering.

Implementation remains within GLLA and reuses its journal and auditor. No
production loop is started while implementing. No publishing is part of this
request.

## Implementation checkpoint — foundation

Implemented the pure requirements/increment state machine in
`extensions/respec-builder.ts`, attached its durable shape to `LoopState`, and
added `extensions/respec-builder-audit.ts` to synthesize the existing auditor's
Goal contract. The adapter includes current increment acceptance criteria and
regressions for earlier verified capabilities. Added phase-specific builder
prompt and status coverage projection for loops carrying builder state.

Six behavioral tests pass for partial approval, full completion, negative and
contradictory verdicts, infrastructure failures, stale attempts/revisions,
blocking, immutable snapshots, scope adoption validation and the production
auditor prompt. This is not a completed feature: the command does not yet
initialize builder state, and tools, journal transitions, detached dispatch,
recovery, confirmed scope refinement, terminal settlement and UI evidence still
need integration. Existing respec dispatch remains operational meanwhile.

## Implementation checkpoint — command and tool wiring

`/loop respec [project direction]` now initializes the builder's intended-scope
draft. Registered production tools propose confirmed requirements, plan a batch,
claim tasks and persist an audit request. Eight core/actual-installer tests pass,
including durable command/tool state and refusal of proposed scope. TypeScript
checks pass. The runtime calls the existing detached auditor and synthesizes
increment acceptance/regression contracts; it fences settlement to the captured
builder and keeps infrastructure failures as parked claims. Claim timestamps are
durable, and auditor progress aborts work whose owning loop/session changed.

Still unproven/incomplete: detached-worker behavioral/restart tests; prompt/tool
guidance details; preservation of ambiguous root-spec selection; legacy restored
draft regression test migration to distinguish it from the new command; explicit
blocked/unblocked and confirmed scope-refinement flows; evidence retention across
replanning; bound/pause/stop/terminal settlement; semantic UI frames; documentation,
version and full validation. Do not claim feature completion or publish yet.

## Implementation checkpoint — scope, blockers and phase card

Added confirmed full-register refinement with explicit removal records and
revision fencing; changed scope requires renewed independent verification.
Added blocker/unblock tools, retained increment task/evidence history in state
and transition events, and parked automation when all remaining work is blocked.
Clearing blockers and editing paused scope do not automatically resume work.
Preserved ambiguous root-spec selection and routed `/loop refine` hints into the
builder prompt. Updated legacy regression tests to exercise restored old drafts
separately from the new intended-project command.

Added a compact project widget with phase, increment, coverage, task, blockers,
evidence and action. Width checks and no-italic checks pass. 22 tests pass across
the core, real command/tool wiring, restored draft and display suites. Actual
dark/light rendered-frame inspection, detached process/reload lifecycle tests,
terminal archival/queue handoff and broader release checks remain outstanding.

## Implementation checkpoint — detached lifecycle and release validation

Six real detached-process protocol tests pass for approval/archive/handoff,
disapproval/replanning, recovering finished exact-claim evidence after reload
without another spawn, pause cancellation, archive-failure settlement retry and
concurrent-wake deduplication. Combined builder/draft/display suites reached
28 passing tests. Auditor jobs now use the durable logical claim prefix; claim
timestamps and revision tokens survive reload. Completion writes a project
archive before terminal state and announces queued work. Pause/stop cancels
workers through the existing process signal boundary.

Rendered and inspected 36 actual project widget/status frames in dark/light
themes at 40/80/120 columns. Narrow action text was shortened to preserve the
user's command. Prepared version 0.39.0 and updated README, command completion
guidance and changelog. Production scope review uses the existing scrollable
Confirm component and configured draft auto-accept policy. Auditor inspection
and configured provider-extension mirroring are respected.

The full release gate is running as exec session 9345, with output in
`/tmp/glla-respec-builder-release-check.log`. It found a stale same-model-toggle
source assertion expecting two audit call sites; the new respec site makes three.
That assertion was corrected and its targeted suite passes. Do not claim the
full gate passed until completion and any required rerun. Remaining review:
audit fallback-chain cursor/settings support, bound behavior, current-source
compatibility, completion requirement audit and full clean validation.
