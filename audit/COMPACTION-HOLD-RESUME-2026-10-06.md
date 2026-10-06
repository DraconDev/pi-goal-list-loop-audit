# Unreachable compaction holds

Junk Runner's screenshot shows a project replanning at increment 7 with fifteen
unfinished requirements, a summarization-output failure hold, and a broad resume
notice claiming there is nothing to resume. The durable loop is inactive at
iteration 8; the builder and its audit history remain present. Inspection was
read-only; no external project or running session was changed.

GLLA owns this mismatch. `session_compact_failed` preserves a failed loop with
one of three reasons: `summarization output limit:`, `context overflow:` or
`compaction failure:`. None was admitted by `RESUMABLE_STOP`, so both
`/glla resume` and `/loop resume` refused the work preserved for them. The
failure notification also named the goal-only resume command in loop sessions.

Prepared 0.39.12 recognizes these explicit recovery holds through the shared
loop resume predicate. Both commands keep the existing project register and
history. Refinement recognizes the same recoverable reasons. These holds do
not grant automatic lifecycle restart permission. Existing branch, blocker
and active-objective checks still apply. The compaction failure notice now
names `/new`, then `/loop resume` for loop/project recovery. A fresh transcript
is useful when the old context cannot fit; resume does not approve a claim or
repair an external summarizer.

Six public-command regressions (three failure classes through each command)
failed before the change and passed afterward. They verify restored activity,
unchanged adopted requirements and iteration history, and no replacement loop.
The host failure test also checks that an emitted hold is resumable, does not
auto-restart through lifecycle admission, and advertises the correct command.
Selected verification logs are in `audit/compaction-hold-resume-2026-10-06/`.
This version is prepared, not published; the session screenshot already loads
0.39.11 and needs the new code before either resume command can recover this
legacy reason.
