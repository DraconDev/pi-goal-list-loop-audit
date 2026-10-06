# Automatic project blocker actions — 2026-10-06

GLLA owns the blocker journal, project tool and presentation. External access,
runner environments, project implementation and Pi core remain outside this fix.

Goal/list pause tools already emit a general action reminder. Project requirement
blockers now emit a visible transcript card and notification immediately after a
successful durable transition, without needing a status command. The full reason,
actor, next step and expected result are displayed. `owner`, `nextAction` and
`expectedResult` are optional tool inputs stored with the requirement; old reports
fall back to asking the agent to recheck and identify the remaining operator step.
No environment-specific command is guessed from unstructured diagnostic text.

The shared project widget also shows a short action and links `/loop blockers`
for complete details. The transcript renderer uses a bold warning heading and bold
accent action labels, without italics. New and changed blocker contracts are shown;
unchanged contracts do not repeat a card. Existing restored blockers remain visible
through the widget and blocker inspection; this change does not open a modal on load.

Display occurs after persistence, cannot start a turn, clear a blocker, resume a
held project or substitute for independent verification. Partial blockers keep
other open work available. Unblocking removes obsolete action fields and requires
recorded resolution evidence. Display failure does not discard the durable blocker.

Validation: 32 tests across four files, zero failures; TypeScript, runtime inventory
and whitespace checks pass. Public tool tests cover automatic display, persisted
fields, renderer, partial/all-blocked behavior, deduplication, changed actions,
legacy fallback, display failure and evidence-backed unblocking staying paused.
Evidence: `automatic-blocker-actions-2026-10-06/`.

Prepared in the 0.39.13 working tree; not published by this task.
