# AGENTS.md — how the pi-goal-loop-audit repo behaves

> **Audience**: the pi-goal-loop agent loop and any agent working in this
> repo. Durable rules; read before operating.

## Scope boundary

This repository builds **GLLA only**. Do not modify or attempt to repair the
operating system, Pi core, `pi-subagents`, `pi-memory`, providers, or arbitrary
other plugins. External behavior may be observed and safely contained through
GLLA's public hooks, but an upstream defect is not a GLLA implementation target.
Before changing code for an issue, verify that the behavior is owned by GLLA;
record and dispose of external-only reports explicitly instead of silently
expanding the repository boundary.

## Never name the operator's private projects

This package is published to npm and mirrored publicly. **Do not write the name
of any private project, workspace, or proprietary tree into anything that
ships or is mirrored**: `CHANGELOG.md`, `README.md`, `docs/`, `extensions/`,
`skills/`, `prompts/`, `schemas/`, `scripts/`, `examples/`, and `audit/`.

A field report's durable value is the bug, the reproduction, and the fix — not
which private tree found it. Naming a project publishes an inventory of
your private work to every consumer of the package.

Write it this way instead:

- **Provenance**: "a field report", "an operator report", "a downstream
  project" — never the project name and never its goal id.
- **Reproductions in `audit/`**: keep the path shape and file counts so the
  evidence still verifies, and redact the name —
  `<project>/entrypoints/background.ts`, `<project>/lib/ui/theme.css`.
- **Artifacts**: `<artifact>.png`, not the project-specific filename.
- **Commit messages and ledger text**: same rule. The daemon's auto-commits
  quote file paths; a foreign project's paths must not ride them.

Exempt by design:

- **`tests/`** — a fixture may need a realistic repo name, and tests are not
  shipped documentation.
- **Published release history** — sections older than the newest release keep
their original text. An npm tarball is immutable and this repo forbids
rewriting pushed history. The rule moves forward with each release.

Enforcement: `npm run check:names`
(`scripts/check-no-project-names.mjs`) runs inside `npm run release:check`. It
judges only lines **new** relative to the newest release tag, so historical
text is grandfathered automatically and no baseline manifest has to be
committed — a committed baseline of *names* would publish the very names it
protects.

The watch list has two sources, both consulted:

- **`.dracon/no-project-names.txt`** — plaintext, operator-local, untracked.
  Add a name here and the gate fails on new text until it is reworded. This is
  the one to edit when a project name needs blocking now.
- **`scripts/no-project-names.denylist.json`** — tracked, SHA-256 hashed under
  a fixed salt. It makes the gate run in CI and on a contributor checkout,
  where the plaintext file does not exist, without publishing the names. Add an
  entry with the `node -e` one-liner documented in that file's header.

A hit from the hashed list is reported as `<matches a watched name>` — the gate
must not echo a name back into CI logs.

## dracon-sync daemon: git-history rules for agent loops

This repo is watched by the **dracon-sync daemon**, which auto-commits
working-tree changes within ~3-10 seconds and pushes them to its configured
remotes immediately after. Codeberg is currently excluded in
`.dracon/dracon-sync.toml` (Forgejo rejects pushes with
`Forgejo: Quota exceeded`), so the live mirrors are **github and gitlab**;
do not read the missing codeberg remote as a divergence.

**NEVER rewrite history in this repo.** Specifically, never:

- `git commit --amend` — any commit may already be pushed
- `git rebase`, or `git reset --hard` to an earlier commit
- `git filter-branch` / `git filter-repo`
- `git push --force` / `--force-with-lease`

The daemon's auto-generated commit messages (e.g.
`2 file(s) in src [...] DELTA:+7/-2`) are **expected and fine**. Do not
"fix" them by rewriting: a rewritten commit races the already-pushed
original and creates a divergent branch. The daemon then merges it, the
next amend drops the merge, and the repo enters a permanent divergence
loop (observed 2026-07-25 in hegemon and browser-extensions-shared; see
`dracon-utilities/docs/design/incident-amend-race-and-trust-2026-07-25.md`).

**RESOLVED INCIDENT (2026-08-09)**: a `git reset` at 10:07:47 discarded the
197-file commit `d60ec3a2` from local `main` after the daemon had already
published the pre-reset history to gitlab/codeberg, forking the mirrors. That
fork was reconciled afterwards — as of 2026-10-24 local `main`, `origin/main`
and `gitlab/main` all sit at `0e149aecb` (0 ahead / 0 behind) and the daemon
reports the repo `OK`. The rule is unchanged and is the part that mattered: the
loop must never reset or rewrite to reconcile a divergence. Reconciliation
requires operator authorization (`DRACON_ALLOW_REWRITE=1` + forge unprotect,
per `dracon-utilities/docs/design/junk-runner-history-rewrite-2026-07-28.md`).
If a fork ever reappears, do NOT reset again — merge (`git pull --no-rebase`).
Full analysis:
`dracon-utilities/docs/design/pi-goal-loop-audit-divergence-2026-08-09.md`.

### What to do instead

- **Checkpoint with your own message**: just `git commit` normally.
  First committer wins; if you commit before the daemon's debounce your
  message lands.
- **Daemon already committed your WIP?** Leave it. Carry the
  descriptive message in your NEXT commit (e.g.
  `docs: <what the previous auto-commits contained>`).
- **Diverged (↑N ↓M)?** `git pull --no-rebase` (merge), never rebase
  or force-push. Identical trees are common (amend races) and merge
  cleanly. If a pull introduces a merge commit, the daemon pushes it —
  that is fine and expected.
- **Working tree dirty mid-iteration?** That's normal. The daemon only
  commits; it never discards worktree content.

## The audit loop

This repo hosts the pi-goal-loop audit machinery (`.pi-glla/`). The loop:

- Reads `active.jsonl` / `list.jsonl` for the current goal contract.
- Validates releases with `npm run release:check`; the tagged GitHub Release
  workflow at `.github/workflows/publish.yml` publishes the package.
- Writes audit evidence to `audit/` and `.pi-glla/audit-jobs/`.

Rules:

- Persist every goal-state change through GLLA's journal; never let live
  state drift from its durable projection. `.pi-glla/` is intentionally
  ignored machine-local runtime state (the v0.34.115 release contract), so
  do not force-add it or expect the sync daemon to checkpoint it in git.
  Keep reviewable audit contracts, implementation registers, and selected
  verification evidence in tracked `audit/` files instead.
- Archive terminal goals to `.pi-glla/archive/` rather than deleting.
- The daemon owns source/evidence commits. If it is paused, checkpoint
  tracked changes with the repo-local `<repo>-dev` identity. Runtime
  journals and archives still stay outside git.
