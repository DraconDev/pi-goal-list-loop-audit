# docs/ — index

Ordered by reading path, not alphabetically.

## Active focus (recent work, durable artifacts)

This package's policy contracts and recent changes are recorded in
the audit/ directory of the **repository checkout** — it is not
shipped in the npm tarball (see "Repository-only material" below).

For shipped docs, the relevant entry points are:

- `../CHANGELOG.md` — user-facing changelog; an `Unreleased` section may lead
  the file, followed by the current released version. v0.35.5 adopted the six-label completion
  recap; v0.35.6 added typed-boundary regression pins; v0.35.7 added
  deterministic fast-fail pre-audits, zero-pause autonomous execution, and
  task milestone gating; v0.35.8 added main-model preferred-primary
  failback; v0.35.9 hardened cross-version npm tarball checks; v0.35.10
  handles multi-entry npm dry-run reports; v0.35.11 accepts both npm report
  shapes; v0.35.12 supports npm 12's keyed pack reports; v0.35.13 fixes stale-API recovery loops.
  v0.35.14–v0.38.22 continue through the supervisor freeze (`/glla pause`),
  load hold, auditor picker parity, Windows launch fix, zombie-watchdog
  subagent carve-out, due-wait backstop, the `/glla agents` visibility panel,
  durable state-root selection, blank-until-resume auditor context, frozen
  subagent recovery, bounded repair/replan recovery, production RPC child
  stopping, mandatory hermetic auditor-extension validation, optional provider
  extensions, bounded zero-stream retry containment, crash-safe persistence,
  and packed-artifact release verification — see CHANGELOG.md for the full
  trail.
- `../README.md` — what the plugin is, install, quickstart, and the
  architectural guarantee (drafting + confirm + detached auditor).
- `../INSTALL.md` — source install / local development setup; the recommended
  companion plugins and the `auditor reads / writes are path-checked`
  note.

## Entry points
- `../README.md` — what the plugin is, install, quickstart
- `../INSTALL.md` — source install / local development setup
- `../CHANGELOG.md` — user-facing changelog; the first versioned heading is
  the current released package version (use `/glla version` to compare with
  the registry); post-release work may appear in `Unreleased` above it.

## Architecture
- `DESIGN.md` — plugin design (types, state, extension lifecycle)
- `DESIGN-long-running-supervision.md` — v0.36.0 event/progress-driven supervision, aggressive recovery, terminal recaps, and future decision checklist
- `GLLA-POSITIONING-AND-DECOMPOSITION-2026-08-08.md` — ecosystem
  positioning, competitor review, and the goal.ts decomposition plan
  (the current strategic doc — read this before touching
  `extensions/loops/goal.ts`)
- `VISION-ASSIST.md` — vision-assist plugin notes
- `RELEASING.md` — how to publish to npm

## Supporting material
- `../prompts/` — goal/loop drafting prompt templates
- `../schemas/` — goal state JSON schema
- `../examples/` — example objective files
- `../CHANGELOG.md` — user-facing changelog (unreleased at top)
- `/glla bug` — `extensions/goal-commands.ts:cmdGllaBug` captures failure context to `<stateDir>/bugs/<ts>-<id>.md` without touching `active.jsonl`/`goals/*.md` (see `tests/glla-bug-capture.test.ts`)

## Repository-only material
The audit history and competitor research live in `audit/` and `.research/`
for contributors, but are intentionally not included in the npm tarball.

## Research material
`.research/` — competitor plugin sources pulled from npm tarballs for study
(gitignored, local only). Re-pull with `cd .research && npm pack <pkg> &&
tar xzf <tgz>`; see the positioning doc's appendix for the package list.
