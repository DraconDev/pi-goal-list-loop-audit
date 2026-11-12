# Report-card captures and what was inspected (2026-11-11)

> **Status**: the completion card became one end-of-task report in the change
> recorded under `CHANGELOG.md` → `## Unreleased` → "The completion summary is
> an end-of-task report, not an audit log". These captures were regenerated
> from the **production** composer and the **registered** `goal-event`
> renderer, not from a hand-written fixture.

## Reproduction

```bash
# ANSI rows + JSON metadata from the registered renderer
timeout 120 bun scripts/summary-readability-capture.ts

# the same rows rasterized in a real xterm on a private Xvfb display
timeout 180 python3 scripts/capture-ui-status.py --summaries
```

Both exited 0. `audit/summary-captures/fixture.md` is the durable content the
renderer was given; it contains the new sections and carries no ANSI.

## What the four captures show

| Capture | Observed |
|---|---|
| `dark-40` | 40 columns, 33 rows, `maxVisibleWidth` 40. The verification section renders **bullets** (`- Release gate — npm run release:check — PASS: …`); no raw `|` row appears. Headline wraps to two lines, each area label starts its own bullet group. |
| `light-40` | Same layout and dimensions on the light theme; the narrow fallback is identical, so it is a renderer decision rather than a theme artifact. |
| `dark-120` | 120 columns, 28 rows. The verification section renders as a real bordered table (`Gate | Command | Result`). Sections appear in report order: headline → lede/meta → `Summary` (with `What changed · <area>`) → `Verification` → `Follow-up items` → `Next steps`. |
| `light-120` | Same order and table shape on the light theme. |

Both JSON files record `narrowTableFallback: "bullets"` at 40 columns and
`"table"` at 120, so the fallback claim is mechanical rather than asserted in
prose.

## Inspection honesty

The narrow (40-column) and the 120-column dark captures were inspected
directly with native vision. The model reported, verbatim in substance:

- the narrow card lists the same sections, with the gate inventory as bullets
  and **no** table or pipe rows;
- a long `path:line` token wraps mid-number at 40 columns (the Pi wrapping
  engine breaks the token, not this renderer — the durable content is
  unchanged and the expanded message carries the whole token);
- at 120 columns the gate inventory is a real box-drawn table with the
  derived `PASS:` label on the proven row and the honest `exited 0` wording on
  the unpoven one.

`light-40` and `light-120` were **not** visually inspected here: the external
vision provider that was used for the two dark captures returned a plan
usage-limit error on the follow-up call. Their ANSI rows are in the repository
and match the dark captures row-for-row apart from color, which
`tests/summary-renderer.test.ts` covers for both themes at widths 0–120.
Treat the light captures as rendered-but-unaudited-by-eye.

PNG rasterization is static evidence of the renderer output; it is not proof
of a live session, a live provider, or an auditor round.

## Update (2026-11-12) — spacing, area labels, dangling pointer words

`scripts/summary-readability-capture.ts` was re-run after the v0.39.70 card
changes (`CHANGELOG.md` → `## Unreleased` → "The final audit stops re-running
gates GLLA already ran, and the card reads like a report"). The `.ansi`,
`.json` and `fixture.md` files now show: one blank row between sections and
none under a heading's body; `What changed · <area>` displayed as the bold
area name directly above its bullets (the durable `fixture.md` keeps the full
label); and `…not an audit log · path:line` without the stranded `for`.

The `.png` rasterizations were **not** regenerated in this pass (no Xvfb run);
they still show the 2026-11-11 layout. Treat the ANSI rows as current.
