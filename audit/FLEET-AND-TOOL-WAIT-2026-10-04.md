# Fleet survey and audit-tool wait clarity — 2026-10-04

Read-only survey covers 24 project roots selected from terminal panes and all
live `pi` process working directories, plus the previously reported SEO root.
Project source, owners, live settings, journals and processes are not modified.
The snapshots are point-in-time evidence, not a promise of eventual completion.

## Survey disposition

- **SEO:** original orphan remains. Goal `20260924180311-jok0tk` is auditing;
  saved job has a disapproval, recorded owner and worker are dead. Current
  GLLA accepts the saved verdict, but no host is present to reconcile it.
- **Studio:** goal `20261004180240-oefk7d` subsequently approved and archived,
  visible completion receipt in the pane. Its earlier whole-filesystem search
  delayed the auditor; that observation did not prove a lost verdict.
- **Platform root and Eve:** live detached auditors, fresh tool activity,
  unfinished calls within their published timeouts. No orphan is observed.
  In the follow-up, platform root had moved on to a new goal; its original
  audit was no longer the active claim.
- **Darklord, Endless TD, Hellhunter:** live main hosts blocked in visible
  `ask_user_question` dialogs. They require an operator answer; no background
  task should be inferred from the age of their last tool-start message.
- **AI Auto Writer:** also awaiting `ask_user_question`; no active GLLA goal
  in the observed journal. AI Auto Video and convos have ended turns/no active
  GLLA goal. These are idle/waiting sessions rather than stuck final audits.
- **Capture Anime Girls:** a long `verify:ci` run, with a declared 3000-second
  shell timeout and newly appearing Chromium child processes. It pipes output
  through `tail`, which hides intermediate output. It is not confirmed stuck.
- **Other game sessions:** recent main-session tools; no stranded completion
  audit observed. Doomtap retains an old stopped-loop compaction reason but
  has a new active goal and fresh commands; do not call the old reason its
  current state.
- **GLLA repository:** historical paused provider-recovery state with a dead
  recorded owner is additional dormant runtime debt, separate from an active
  live final audit. Other inactive roots do not acquire imaginary live work
  merely because an old owner marker exists.

## Confirmed UI defect

The 15-second freshness gate correctly stopped claiming fresh worker activity,
but it also made an unfinished, in-budget tool historical (`last tool` /
`last observed tool`). That removed the current tool's clock and timeout from
the compact card. A five-minute search consequently looked like a frozen audit
with generic "No action needed" text.

Repair in 0.39.1: distinguish a wait for tool completion from fresh activity.
Within a valid observed tool window, retain the current tool and ticking
elapsed/timeout row, say **Waiting on bash**, and explain that no tool completion
has arrived yet and timeout handling is automatic. The compact footer puts
that clock first. Future/invalid telemetry, cancelled calls and expired windows
cannot claim a healthy wait. This changes presentation, not the watchdog.
Both manual and automatic progress publishers now use the same effective
worker-granted budget as the parent watchdog.

## Verification

- Studio regression failed before the change: 6 passed, 1 failed.
- Focused card/status/lifecycle/timeout/host/package contract checks:
  **52 passed, 0 failed**, six files.
- TypeScript passed against current host 0.99.1 and oldest host 0.84.2.
- The initial full release gate ran 3,227 tests in 349 files: **3,224 passed,
  1 skipped, 2 failed**. One failure was a stale source assertion for the old
  budget expression; it was corrected while retaining generation/goal/attempt
  fencing. The corrected lifecycle and tool-wait files passed: **25 passed,
  0 failed**.
- The other failure concerned descendant cleanup on a mechanical-check
  timeout. It did not reproduce in isolation or two runs of the entire
  regression-shield file (**76 passed, 0 failed**). Its first-run cause remains
  unproven; no cleanup code or test timing was weakened. The full release gate
  has **not** subsequently been rerun clean.
- Remaining release stages passed separately: current TypeScript, Jiti state
  binding, offline auditor extension loading, inventory, npm dry-run packing,
  and installation/import of the **0.39.1 tarball**, including the bounded
  launcher/worker RPC probe and delegate skill loading.
- 24 production-renderer frames across dark/light and widths 40/80/190 fit
  their terminal width. Actual waiting frames were inspected as terminal text.
- Evidence: `audit/tool-wait-2026-10-04/`.

0.39.1 is prepared, not published. Existing Pi hosts retain their loaded version
until modules are reloaded; this survey did not restart any host.
