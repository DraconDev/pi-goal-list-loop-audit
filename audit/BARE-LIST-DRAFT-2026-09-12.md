# Bare /list drafts from context — 2026-09-12 (v0.38.51)

## User note

> Empty `/list` can't be used but empty `/goal` can — that triggers the draft
> from context.

Decision (user chose): **always draft like /goal** — bare `/list` starts a
context draft; `/list show` remains the way to view items.

## Change

- `extensions/goal-commands.ts` (`cmdList`): the `if (!sub || sub === "show")`
  branch is split. Bare `/list` calls `startDrafting(ctx, "list")` with no
  seed; `show` keeps the existing viewer untouched. The stale guard mirrors
  `cmdSet`'s empty-goal path (`if (staleEntry) return`) — a draft seed on a
  doomed handle would latch the drafting gate with no live turn to deliver
  it, the exact orphan the behavioral-orchestrator stale test guards.
- `extensions/loops/goal-activation.ts`: `/list` command description names
  the new entry (`Bare /list drafts from context like bare /goal does`).
- `extensions/loops/goal-tools.ts`: the `propose_goal_draft` idle hint now
  reads "starts drafting with bare /goal, bare /list, or /list add (no args)".

## Evidence

- `tests/list-bare-draft.test.ts` (3 pins, all pass):
  - bare `/list` latches the list gate (`list_add` → `LIST DRAFTING IN
    PROGRESS`); explicit `/goal start … done when: …` clears it and the item
    queues behind the active goal (honest user-path cleanup);
  - `/list show` still renders `List (1)` with the queued item and mutates
    nothing;
  - stale bare `/list` latches nothing — the post-replacement session's
    `list_add` lands.
- Negative control: with the `cmdList` branch reverted to `HEAD~1`, the
  drafting pin fails while the show/stale pins pass — the test pins the new
  behavior, not the preserved surface.
- Neighbors green: list-settings-route + list-stale-context + confirm-draft
  + plan-mode + drafting-questionnaire (40 pass), behavioral-orchestrator
  (131 pass, incl. the pre-existing stale bare-`/list` no-latch test), `tsc`
  clean.
- Full gate (`/var/tmp/glla-gate-0.38.51.log`): **2132 pass / 2 skip / 1 fail**.
  The one failure is `v0.34.22: complete_goal returns while a detached
  auditor finishes and archives approval` — a detached-auditor timing test
  (spawns a real 350ms fake-auditor child, asserts `elapsed < 300` and
  widget-repaint races) with zero shared path with the bare-`/list` entry
  (it uses `/goal start` + `complete_goal`, never touches drafting). It is
  green in isolation 2/2 (131/0 twice standalone, incl. once before and
  once after the gate). Load flake under full-gate pressure; left
  untouched per the timing-flake policy.
- Two same-gate failures WERE mine and are fixed in-tree: the docs-index
  version trail (`v0.35.14–v0.38.51`) and the lifecycle-recovery source pin
  for the split `!sub` / `show` branches (deliberate re-baseline, intent
  preserved: show stays ungated, bare refuses stale without a gate).

## Preserved

`/list show`, `/list start`, `/list add`, dump routing, read-only verbs on
stale handles, and the propose/confirm/audit machinery are unchanged.
