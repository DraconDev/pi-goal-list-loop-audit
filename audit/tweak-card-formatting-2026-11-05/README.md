# Tweak / amendment Confirm cards: labelled quote blocks instead of a wall

**Trigger.** `Screenshot_20261105_163146.png` — the `/goal tweak` confirm, with a
~700-character objective on each side, described by the operator as *"this tweak
text is pretty bad lets make sure it is formatted niely"*.

## Observed

The card body was built as:

```
From: <objective>
To:   <objective>

Replaces the goal objective; its verification contract is kept.
```

Measured from the screenshot and reproduced through the real `Markdown` renderer
(`verification/card-render.txt`, BEFORE frame): a single `\n` is a Markdown
**soft break**, so `From:` and `To:` are one paragraph. The consequences are
visible in the screenshot:

- `To:` does not start a line. It appears mid-line wherever the wrap happens
  (`operators decision use Agnes as a temporary substitute; (4) build …` on the
  old side runs straight into `To: Finish Winifred Hale's …`).
- Every continuation line is flush-left, so there is nothing on screen that says
  which text belongs to the old objective and which to the new one.
- Two near-identical 700-character blobs are stacked with no delimiter, so the
  pair reads as one run-on paragraph — the reader has to diff it in their head.

This is a *formatting* defect, not a length one: the earlier rounds already made
the body compact (one pair + one consequence line). The pair is still unreadable
because the consent text is a long prose paragraph and Markdown collapses it.

## Fix

Structural, in `extensions/confirm-draft.ts` — the consent text itself is
unchanged.

```ts
export function quoteBlock(text: string): string   // `> ` on every source line
```

`tweakObjectiveLines`, `buildAmendmentConfirmBody`, and
`buildTweakRationaleBody` now emit:

```
**From:**

> <objective>

**To:**

> <objective>

Replaces the goal objective; its verification contract is kept.
```

- a label on its own line, then a blank line, so the label is its own paragraph;
- the objective in a quote block, so the card's left bar repeats on **every
  wrapped line** — ownership of each line is visible at a glance;
- `**bold**` labels so `From:` / `To:` are visually separated from prose
  (the mock theme render in the tests shows them plain; the real theme bolds
  `bold(t)` via `theme.bold`);
- a changed contract becomes `**Contract — before:**` / `**Contract — after:**`
  with two quote blocks. The old form quoted `old → new` on one line, which for
  multi-line contracts joined them at the arrow and made it impossible to tell
  which `Done when:` line came from which side;
- multi-line objectives keep their paragraph breaks *inside* the quote (a blank
  source line becomes a bare `>`), so a pasted multi-paragraph objective does not
  escape the block;
- the rationale expand uses the same chrome (`**CURRENT:**` / `**NEW:**` /
  `**New verification contract:**`).

**Plain-text hosts.** `ctx.ui.confirm` renders no Markdown — it is
`${title}\n${message}` inside a selector — so `**From:**` and `> ` would reach an
RPC/headless user literally. `plainCardBody(body)` strips exactly those two
markers and is applied at every `ctx.ui.confirm` fallback
(`confirmTweak`, the `complete_goal` completion-scope amendment, and
`confirmCard`'s own caller-supplied body is left untouched because its callers
pass already-rendered text). Consent text is byte-identical either way.

**Help line.** The old hint was 90 columns and wrapped its tail
(`without applying`) onto a second line at ordinary widths, hiding the one part
that says the expand is safe. It is now 65 columns and never wraps:
`↑↓ choose · enter select · esc cancel · the expand is read-only`.

## What did NOT change

- The default body still carries **both** objectives verbatim, always. Nothing is
  clipped, elided, diffed or summarised: the tests assert the full text of a
  2,000+ character objective is present on the default card.
- `Confirm` / `Cancel` semantics, the in-dialog `Show the full rationale` toggle,
  the height-bounded viewport and `PgUp/PgDn` paging are unchanged.
- An unchanged contract is still not reprinted (`Contract: unchanged`).
- Amendment consent stays a two-way yes/no card.

## Verification

`verification/card-render.txt` — real `render()` output for the default card at
100 and 72 columns, the expanded in-place rationale, the amendment card, and the
plain-text downgrade. Regenerate by running the same components; no replica
markup is involved.

```
npm run check                                   # tsc --noEmit, clean
npm test -- tests/amendment-confirm-compact.test.ts \
            tests/amendment-confirm-styling.test.ts \
            tests/list-tweak-proposal.test.ts \
            tests/contract-text-semantics.test.ts \
            tests/confirm-draft.test.ts \
            tests/propose-tweak.test.ts          # 69 pass, 0 fail
npm test                                         # full fast suite, 4239 pass / 1 skip / 0 fail
```

New cases in `tests/amendment-confirm-compact.test.ts`:

- `the tweak card separates From/To into labelled quote blocks (no wall)` — the
  exact body shape, and that `To:` never shares a rendered row with `From:`.
- `quoteBlock quotes every line and keeps paragraph breaks inside the quote`.
- `the plain-text fallback carries the same body with no Markdown markers` — no
  `*` or `>` survives, both consent sides still verbatim.
- `a multi-line objective is quoted line by line, still verbatim in the render`.
- `the rendered card shows From/To on separate rows with the quoted text
  indented` — from the component's own `render()`.
- `the expanded rationale uses the same label + quote chrome`.

Existing assertions that pinned `^From: ` / `^To:   ` were updated to the new
labels (`**From:**`, `**To:**`); the consent-text assertions were not weakened.
