# Durable install (g-auto edge)

Authoritative statement of how `/g auto` is installed here, why it survives
reload, and what happens on rollback and on future GLLA updates. This file is
repository material and the single source of truth for the closure contract.

## Why this clone is not an npm install

```bash
pi install npm:pi-goal-list-loop-audit
```

installs a **published npm tarball** into pi's node_modules. That copy is
authoritative on npm only. Editing, forking, or patching the npm copy does not
affect this production install and, more importantly, a future `npm install`
replaces it wholesale.

This production install is instead a **local directory** wired into
`~/.pi/agent/settings.json`:

```json
"/c/Users/bmarc/.pi/src/pi-goal-list-loop-audit"
```

That entry (the local path, line 23) makes the installed Pi extension load
from this checkout on disk, not from a node_modules tarball. There is no
`npm:pi-goal-list-loop-audit` entry anywhere in that settings file, so nothing
npm can shadow this source.

## The g-auto edge, pinned in a local branch

Because the production install is a git clone, the g-auto edge is protected by
branch topology:

```text
origin (main, pin = current)                         1e771c0d   0.38.24 base
└── main                                        1e771c0d  [origin/main]
    └── gauto (this edge)                  383f93f..d875b9ed  local branch
```

The production install's base is the *current* commit `1e771c0d` on local
`main`, tracking `origin/main`. The g-auto edge lives on local branch
`gauto` (HEAD ~`e3319281`), a **local branch with no upstream tracking branch**,
so it cannot be removed by a future `git pull` of the base (origin/main stays at
the pinned 0.38.24 base). `e3319281` (the initial g-auto feature commit) is an
ancestor of `d875b9ed`.

## g-auto, wired

`/g auto <text>` is a first-class command registered alongside `/goal`:

```text
pi.registerCommand(\"gauto\", {
  description: \"Create a goal with an objective and no interview, no Confirm
                gate, no drafting. /g auto <objective> activates instantly like
                /goal start but always treats everything after the word as pure
                objective — no verb subcommands; use /goal <anything> for
                status|pause|resume|cancel|tweak|archive.\",
  getArgumentCompletions: completions([]),
  handler: (args, ctx) => {
    rememberCtx(ctx);
    if (refuseForeignCommand(ctx)) return Promise.resolve();
    return cmdGauto(args, ctx);
  },
});
```

`cmdGauto` (`extensions/goal-commands.ts`, line 381) is:

```typescript
export async function cmdGauto(
  args: string,
  ctx: ExtensionContext,
): Promise<void> {
  return cmdSet(args, ctx, true, true);
}
```

i.e. `/g auto <objective>` is the bare, questionless goal that reuses the same
skip-draft path as `/goal start <objective>` but with an explicit replacement —
no interview, no Confirm, no `startDrafting`. Reachability is asserted by the
focused regression test `tests/gauto-command-registration.test.ts`, run in a
source-mode harness that imports only the feature:

```bash
bun test tests/gauto-command-registration.test.ts
```

## Reload survival (why it persists)

A Pi reload re-reads exactly what the install points at. That point is the local
directory on disk; the feature lives in committed files. There is nothing to
restore, nothing to reinstall. The install survives reload because it *is* the
source tree.

## Rollback (reverting to the npm install)

Reverting is a two-line settings change, atomic:

```bash
# from ~/.pi/agent
# 1. Replace the local install with the published npm copy
pi uninstall goal-list-loop-audit   # if it was installed via pi; otherwise
#     edit ~/.pi/agent/settings.json: drop the local-path entries, set
#     packages to npm:pi-goal-list-loop-audit
# 2. Restart Pi so the npm copy loads
reload
```

Concretely, the durable install is the local path entry at line 23 of
`~/.pi/agent/settings.json`; the rollback is: remove that local-path entry and
add `npm:pi-goal-list-loop-audit` in its place, then restart. The local clone on
disk stays on `gauto`; the rollback only changes what the running Pi loads.

## What future GLLA updates do and do not affect

- **Future npm releases (published tarball).** Do not affect the running Pi.
  The npm copy is not installed; nothing to replace.
- **Future local edits to the g‑auto files.** Not applied by any update flow;
  they are just committed source in this checkout. They persist across reloads
  and are only reset by a rollback.
- **Future upstream pulls of the base (origin/main).** Keep the base pinned at
  `1e771c0d`. The g‑auto edge is on the local `gauto` branch, so the top of the
  edge is unaffected by base changes.
- **Future `git pull` / fetch.** Cannot remove the base commit, the g‑auto edge,
  or anything below it.

## Closure

- Feature present and reachable (source grep): `cmdGauto` at
  `extensions/goal-commands.ts:381`.
- Registration present and readable:
  `extensions/loops/goal-activation.ts:789`.
- Rollback procedure present (this document).
- What future GLLA updates do/do not affect (this document).
