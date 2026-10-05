# Broad resume missed stalled project audits

The operator used `/glla resume` to recover Junk Runner, reasonably expecting
it to resume the held project. The 0.39.4 command only treated a stopped loop
as resumable when its reason was exactly `held on restore`. A continuation-stall
hold instead fell through to `Nothing to resume`. This is owned by GLLA.

Read-only journal inspection shows Junk Runner retained its original
2026-10-04T22:04:48.870Z stop and increment-1 claim through the 0.39.4 update.
That observation does not establish a recurrence of the auditor heartbeat bug;
it does establish that the broad resume surface could not recover that hold.
No live runtime journal, terminal, worker or project source was changed here.

The prepared 0.39.5 fix shares held-loop admission between `/glla resume` and
`/loop resume`, including the project max-iteration exception. Broad resume
then delegates to the actual loop handler, retaining blocker, branch, active
goal and dispatch checks. Terminal loops remain terminal. The two commands
still differ in scope: broad resume also unfreezes supervisor machinery and
handles goals/list work and model recovery.

The actual installer-to-command-to-worker regression failed before the fix
because the held audit remained inactive. After the fix it retains the audit
attempt identity, dispatches the worker, survives six real heartbeat ticks,
verifies the requirement, archives completion, and posts its receipt.
40 focused tests across four files passed; TypeScript passed. Additional
neighboring checks and shared-state import verification are recorded alongside
this report. This patch has not been published.

Darklord's screenshot shows increment 4 running, not held. During inspection
its worker completed additional tool calls; one bash command waited 240 seconds
before inspecting a test log. It remained active with recent tool completion.
This observation is point-in-time progress, not a promise of eventual approval.
