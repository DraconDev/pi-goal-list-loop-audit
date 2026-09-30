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

## dracon-sync daemon: git-history rules for agent loops

This repo is watched by the **dracon-sync daemon**, which auto-commits
working-tree changes within ~3-10 seconds and pushes them to all
remotes (github/gitlab/codeberg) immediately after.

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

**LIVE INCIDENT (2026-08-09)**: a `git reset` at 10:07:47 discarded the
197-file commit `d60ec3a2` from local `main` after the daemon had already
published the pre-reset history to gitlab/codeberg. The mirrors now hold
59 commits that github/local don't have, and local has 13 commits the
mirrors don't have — a genuine fork. The daemon correctly refuses to
force-push; the repo shows `🛑 STUCK`. The mirrors CANNOT be reconciled
by the loop: reconciling requires operator authorization
(`DRACON_ALLOW_REWRITE=1` + forge unprotect, per
`dracon-utilities/docs/design/junk-runner-history-rewrite-2026-07-28.md`).
Do NOT attempt to "fix" the divergence by resetting again. Full
analysis: `dracon-utilities/docs/design/pi-goal-loop-audit-divergence-2026-08-09.md`.

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
