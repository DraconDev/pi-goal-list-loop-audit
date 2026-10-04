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
