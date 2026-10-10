# Cohesive UI capture checkpoint

This is renderer/visual evidence, **not** a live worker, lifecycle, release or completion claim.

## Reproduction

```sh
timeout 30 bun scripts/ui-status-capture.ts
timeout 60 python3 scripts/capture-ui-status.py
```

The TypeScript generator is checked by `npm run check` and calls the production `buildWidgetLines`/`buildStatusText` functions with explicit fixed-clock fixtures. The completed-summary fixture uses `composeRichTerminalLines` and the actual Pi TUI `Markdown` component. The Python script displays the ANSI output in real xterm on a private Xvfb display, screenshots it through Pillow/X11, and closes both processes. It does not access the user's terminal/display or reload any session. Dependencies: Bun, Python/Pillow, Xvfb, xterm, xdotool, Hack font. It refuses framebuffer clipping and bounds every child/readiness wait.

- [40-column capture](ui-captures/40.png), [renderer stream](ui-captures/40.ansi), [metadata](ui-captures/40.json).
- [120-column capture](ui-captures/120.png), [renderer stream](ui-captures/120.ansi), [metadata](ui-captures/120.json).

Matrix: observed running, armed quota recovery, workflow rejection/replanning, missing user prerequisite, confirmed dormant audit, unconfirmed saved audit, approved settlement owed, completed project, outcome-first completion-summary body. These are deterministic fixtures, not observations of those sessions running. Summary publication/approval trailer remains covered by `rich-terminal-summary.test.ts` rather than fabricated by the screenshot script.

## Native inspection and changes

The user's `Screenshot_20261010_121627.png` and `Screenshot_20261010_121639.png` were inspected natively using cropped originals after oversized attachments hit the payload guard. The older card has a unified rail, primary/fallback model context, task meter and useful supporting information. The newer completed card was a loose dump of labeled lines, repeated “complete”, and unnecessarily said “no worker activity confirmed” on terminal work.

The shared renderer now preserves the rail and semantic color, objective, task meter, useful saved age/token/role facts and model provenance. Blocker actions lead the body; automatic actions close the rail. Extra model/history facts give way to prerequisites on compact cards and remain in detailed status. Terminal cards omit irrelevant worker uncertainty and duplicate terminal-phase labels.

Native inspection of wide capture crops confirmed readable grouping, shared card/footer execution terms, distinct workflow rejection versus execution, visible actual version prerequisite, closure without a death-by-silence claim, explicit owed settlement after approval, and a compact completed-project card with verified requirements. The completed-summary body has plain section headings, readable spacing, one limitation and one follow-up without redundant Unresolved/Next bullet labels; archives retain those labels.

The first narrow styled capture exposed ANSI-unaware truncation: `truncateCells` must receive plain text, not a painted string. The root fix uses Pi's ANSI-aware `truncateToWidth` for styled rows. A new styled narrow regression asserts visible-cell bounds and a complete uncertainty label. At narrow widths execution health comes before workflow/progress so clipping cannot hide uncertainty; the actual version action remains visible. The shared footer no longer appends the older independent lifecycle/activity interpretation.

## Verification status

`timeout 240 npm test -- tests/ui-status-surfaces.test.ts tests/summary-agent-text.test.ts tests/rich-terminal-summary.test.ts`: 41 pass, 0 fail within the combined six-file gate. Types pass, including the capture generator. Combined six-file UI/fleet gate: 66 pass, 0 fail, including chat/archive label and limitation-integrity coverage. Broader runtime/mode integration, independent review and the full release gate remain open in `UI-REDESIGN.md`.
