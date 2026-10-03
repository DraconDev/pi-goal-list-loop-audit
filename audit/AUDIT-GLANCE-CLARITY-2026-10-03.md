# Background audit clarity — 0.38.113

The user's Doomtap screenshot showed a completion claim waiting for its
detached auditor. The transcript ended at `complete_goal`, the host still
showed “Thinking…”, and the widget displayed historical model/judgment rows
until Pi truncated it. The worker was making progress, but the screen did
not make that answer clear.

GLLA owns the persistent widget, footer and audit phase wording. The host's
transcript thinking indicator belongs to Pi; this change does not modify it.

The production UI now requests a compact audit card: audit state, finished
tool-call count, actual activity age, audit elapsed time, current/last tool,
user action and `/goal status` for full details. Normal audit cards use at
most seven rows before host clipping. Historical model provenance, judgment
plaques and report detail remain available in the status command.

The footer begins with audit state and observed freshness so a narrow terminal
does not lose those facts behind the main-host label. Model thinking is called
“thinking”; a tool call still retains its observed elapsed time and timeout
budget. No tool progress is inferred from a timer tick. Quiet, blocked,
recovery and approved-settlement states keep their action; only normal
background audits say “No action needed — review applies automatically”.

`tests/audit-glance-clarity.test.ts` reproduces the screenshot's 70-minute
list item, eight-minute audit, 11 finished calls and 17-second activity age at
40/60/80/120/190 columns. It also checks quiet/blocked/recovery/settlement,
startup without activity, and a current tool's timeout budget.

`tests/evidence/render-audit-glance.ts` produces 18 real production frames,
with Pi's installed dark/light themes, running/quiet/tool states and three
widths. [Preview](audit-glance-2026-10-03/audit-glance.png) is a rasterization
of those ANSI frames, rather than a hand-written mockup. The preview was
inspected; the quiet warning and short-terminal core facts remain visible.

Verification results are recorded in `audit-glance-2026-10-03/`. Initial
exploratory multi-file runs omitted the repository's `--parallel=1` flag and
exposed shared-test isolation failures; final checks use the repository runner.
A new budget assertion also initially expected the wrong separator and was
corrected to the existing elapsed/budget format. These red runs are retained
and are not claimed as passing gates.

Final verification: pending. Package and both lock versions are 0.38.113;
changelog and generated runtime inventory are synchronized. No Doomtap live
journal was changed, no process was restarted, and no package was published.
