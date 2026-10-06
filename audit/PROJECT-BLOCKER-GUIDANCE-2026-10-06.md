# Readable blockers and actionable recovery

Neonbreak's held DC-4 requirement records unfinished visual-baseline
regeneration/review in a pinned render environment. The screenshot truncates
the reason before its operator action, and the card advertises resume even
though every unfinished requirement is blocked and resume refuses.

Read-only inspection confirms the requirement includes both operator and CI
baseline sets. Its reason claims local checks passed and 94 environment
mismatches prevented visual work. The project environment module deliberately
refuses a mismatched renderer. This is a plausible recorded blocker, not a
fresh independently verified inability to proceed. Its suggestion names a
visual-baselines dispatch, whereas the actual workflow is visual-ci.yml and
the regenerate job uploads only docs/snapshots/ci/. A project agent should
recheck the current state and produce the exact steps for both required sets,
including which actions it can perform. No project, workflow or OS was changed.

Prepared 0.39.13 adds read-only `/loop blockers`, with wrapped complete reasons,
requirement identities, explicit agent-report provenance and a concrete request
to recheck, resolve possible work and specify exact external actions. It names
the evidence-backed unblock tool and subsequent resume, without making
unblocking equivalent to verification. Resume refusal shows the same details.
Cards link to the inspection command; all-blocked cards stop offering a resume
that will be refused. Partially blocked projects retain legitimate resume paths.

Verification: 28 tests passed across four files. Coverage includes narrow card
widths, long reasons with late operator instructions, public-command inspection
without state mutation, all-blocked guidance and existing resume preservation.
TypeScript, regenerated inventory and whitespace checks passed. Projection of
Neonbreak's live saved reason retained the late operator instructions and capped
display line length at 96 characters. Evidence is retained in
`audit/project-blocker-guidance-2026-10-06/`. This change is prepared, not published.
