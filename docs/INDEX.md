# docs/ index

Ordered by reading path, not alphabetically.

## Start here

- [README](../README.md): install, first goal, and choosing goal/list/loop work.
- [Recovery guide](RECOVERY.md): resume commands, audit progress, model changes,
  completed projects and opportunistic compaction.
- [Settings](SETTINGS.md): settings files, precedence and every option.
- [Installation and updating](../INSTALL.md): npm/source setup, companions and
  reloading existing sessions.
- [Delegation skill](../skills/glla-delegate/SKILL.md): normal-chat goal/list
  delegation and confirmation.
- [Changelog](../CHANGELOG.md): changes shipped in each release. The history
  spans v0.35.14–v0.39.14; `/glla version` shows the installed version and the
  registry comparison command. A checkout can contain unpublished changes.

## Architecture
- `ARCHITECTURE.md`: 20-minute newcomer overview (three loops, audit lifecycle, persistence)
- `PROMOTION-CONTRACT.md`: the list item → goal → archive seam, diagrammed
- `DESIGN.md`: plugin design (types, state, extension lifecycle)
- `DESIGN-long-running-supervision.md`: v0.36.0 event/progress-driven supervision, aggressive recovery, terminal recaps, and future decision checklist
- `GLLA-POSITIONING-AND-DECOMPOSITION-2026-08-08.md`: ecosystem
  positioning, competitor review, and the goal.ts decomposition plan
  (the current strategic doc; read this before touching
  `extensions/loops/goal.ts`)
- `VISION-ASSIST.md`: vision-assist plugin notes
- `RELEASING.md`: how to publish to npm

## Supporting material
- `../prompts/`: goal/loop drafting prompt templates
- `../schemas/`: goal state JSON schema
- `../examples/`: example objective files
- `../CHANGELOG.md`: user-facing changelog (unreleased at top)
- `/glla bug`: `extensions/goal-commands.ts:cmdGllaBug` captures failure context to `<stateDir>/bugs/<ts>-<id>.md` without touching `active.jsonl`/`goals/*.md` (see `tests/glla-bug-capture.test.ts`)

## Repository-only material
The audit history and competitor research live in `audit/` and `.research/`
for contributors, but are intentionally not included in the npm tarball.

## Research material
`.research/`: competitor plugin sources pulled from npm tarballs for study
(gitignored, local only). Re-pull with `cd .research && npm pack <pkg> &&
tar xzf <tgz>`; see the positioning doc's appendix for the package list.
