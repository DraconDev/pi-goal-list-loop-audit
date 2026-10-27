# Consent-by-typing gap: truncation detection, approval execution, and decision options

Date: 2026-10-27
Goal: `fix the systematic consent-by-typing gap in GLLA decision pauses`

## The defect, as observed in the field

A pause card carried this suggested action (a real genre edit, cut off by an
upstream preview limit):

```
Run /goal tweak replacing this objective line "- Lane 1 Vera Vantel: genre
darksynth, 15 tracks (~42 min)." with "- Lane 1 Vera Vantel: genres
darksynth + darkw
```

Two things were wrong, and they were independent:

1. **Presentation.** The card presented `darkw` as part of a command the user
   was asked to type. The missing characters are gone — no renderer can
   restore them, and no user can type them.
2. **Execution.** Answering "we can do it" had no executable path. There was
   no agent tool that applied a tweak, so the only route was the user typing a
   complete `/goal tweak "<new text>"` by hand. The objective stayed stale and
   the turn resumed past it.

A third gap compounded both: a pause that could not produce a complete command
carried no `options`, so the decision picker had nothing to offer — only raw
text to type.

## Root cause

`tweakSuggestionTruncated` used the wrong discriminator. It reported
truncation only when a quoted span had **closed earlier**
(`quote !== null && closedSpan`). The canonical single-span form the project's
own prompt vocabulary mandates — `/goal tweak "<new text>"` — has exactly one
quoted span, so a cut inside it leaves no closed span and the case was
invisible:

```
Run /goal tweak "Replace the objective with the full darkwave preset text for lane one
  → pauseKind: blocked, pauseOptions: undefined
  → the card asked the user to type an untypeable command
```

Quote **kind** is the correct discriminator, not span count.

## The fix

| Seam | Change | File |
| --- | --- | --- |
| Detection | An unclosed **double** quote is truncation on its own. An unclosed **apostrophe** still needs a closed span, so prose like "tweak the user's objective" stays a plain pause. Strict superset of the old rule — every previously-detected case still detects. | `extensions/goal-loop-core.ts` |
| Transcript card | A truncated tweak renders the interactive-flow fallback instead of the fragment; a complete tweak keeps its exact command verbatim. | `extensions/action-reminder.ts` |
| Widget card | Routes a truncated tweak to the same interactive flow. Previously it printed the raw `pauseSuggestedAction`, so `…+ darkw` appeared next to the new options. | `extensions/goal-loop-display.ts` |
| Promotion | A truncated tweak promotes to a `kind=decision` pause whose recommended option opens the tweak editor. The unattended auto-default still declines rather than adopting. | `extensions/goal-loop-core.ts` |
| Picker | The bare-tweak editor option executes `cmdTweak` — the same adoption path a typed tweak uses. | `extensions/goal-commands.ts` |
| Approval | New `propose_tweak` agent tool funnels explicitly approved text through `cmdTweak`: resolution, Confirm gate showing the exact old→new text, race rechecks. Confirm applies; Cancel changes nothing. Covers goal and list, preserving list's paused-only rule. | `extensions/loops/goal-tools.ts` |
| Availability | `propose_tweak` joins `GLLA_TOOL_NAMES`, so the session-start self-heal restores it if an external tool allowlist strips agent tools. | `extensions/goal-loop-core.ts` |
| Agent guidance | The continuation prompt and the `resume_goal` description direct the agent to call `propose_tweak` before resuming when the answer approved a specific tweak. | `prompts/goal-loop-continuation.md`, `extensions/loops/goal-tools.ts` |

Consent is unchanged: the Confirm gate remains the consent record, vague
replies apply nothing, and the unattended default declines.

## Evidence

### Contract items

```
npm run check                      → exit 0 (tsc --noEmit, zero errors)
npm run check:inventory            → exit 0
```

The three behavioural contract items:

```
tests/propose-tweak.test.ts        → 5 pass, 0 fail
  propose_tweak: confirmed approval applies the exact text
  propose_tweak: declining the Confirm changes nothing
  propose_tweak: list mode applies to a paused list item
  propose_tweak: defaults to the active goal policy, refuses without a goal
  propose_tweak: the approval tool survives an external tool allowlist

tests/action-reminder.test.ts      → 18 pass, 0 fail
  a truncated tweak proposal is never presented as a command to type
  the canonical single-span tweak form is detected as truncated
  a complete tweak proposal keeps its exact command verbatim

tests/suggestion-acceptance.test.ts → 26 pass, 0 fail
  suggestionAcceptancePromotion: a truncated tweak promotes to the interactive editor
  suggestionAcceptancePromotion: the canonical single-span tweak form promotes to the editor decision
  pause_goal: truncated tweak suggestion becomes an editor decision, not raw text to type
  pause_goal: the canonical single-span tweak becomes a decision with the editor option
  pause_goal: kind=decision with a tweak carries selectable options, not just commands
  decide picker: the bare-tweak editor option opens the interactive tweak flow

tests/display.test.ts              → 121 pass, 0 fail
  v0.39.55: the widget card never prints a truncated tweak's broken fragment
```

Affected suites named by the contract:

```
behavioral-orchestrator 159 pass / 0 fail
confirm-draft            18 pass / 0 fail
amendment-summary         9 pass / 0 fail
footer-fold              13 pass / 0 fail
```

### Negative controls

Each control reverts exactly one seam on the live tree, runs the suites, then
restores it.

| Reverted seam | Result |
| --- | --- |
| Predicate only (back to `quote !== null && closedSpan`) | 161 pass / **4 fail** — exactly the four new canonical-form tests |
| Widget-card route only (predicate stays fixed) | 120 pass / **1 fail** — exactly the widget-card test |

The first control proves the tests detect the canonical-form defect the
auditor reproduced. The second proves the widget-card test is not passing
merely because the predicate is fixed — it detects the second, independent
renderer gap.

### Context-growth pins (refreshed deliberately)

The agent-guidance sentence grows the continuation template by **+358 chars /
+362 UTF-8 bytes** per payload. Two pinned fixtures name exact template bytes,
and both carry standing instructions to refresh them when the template
changes. They were re-measured, not hand-adjusted:

```
before: payload 28_773 chars / 28_885 bytes
after:  payload 29_131 chars / 29_247 bytes   (+358 / +362)

growth fixture   one row:     gllaTextChars 28_773 → 29_131
                 twelve row:  gllaTextChars 345_276 → 349_572  (+358 × 12)
checkpoint pin:  serializedBytes 32_335 → 32_697  (+362)
```

Shape and every multiplier are unchanged — only the per-payload constant
moved, which is what the fixtures are designed to survive. The cardinality and
flat-growth invariants they really protect (messageCount, one checkpoint,
`removed == count - 1`, byte-identical across probe sizes) are untouched, and
the same-payload byte equality assertions still pass.

Receipt: `verification/context-measurements.json`, produced by
`scripts/measure-context-growth.mjs` (the script the fixtures were built
against).

## What was not changed

- What requires consent. The Confirm gate still gates every objective change.
- Audit and settlement logic.
- Settings.

## Reproduce

```bash
node scripts/run-tests.mjs tests/action-reminder.test.ts \
  tests/suggestion-acceptance.test.ts tests/propose-tweak.test.ts \
  tests/display.test.ts
bun run scripts/measure-context-growth.mjs
```
