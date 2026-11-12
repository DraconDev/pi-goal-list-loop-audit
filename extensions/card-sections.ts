// pi-goal-list-loop-audit — the end-of-task report vocabulary.
//
// Field 2026-11-11 ("i am not loving the goal completion summary, that should
// be more like how opencode does the summary upon task completion"): the card
// grew one section per internal contract (Summary / What Changed / Remaining /
// Verification Evidence / Next / Final Repository State) and closed with four
// `•` trailer bullets, so a finished goal read as an audit log rather than a
// report of what was done.
//
// The section names live here, in a LEAF module with no imports, because every
// surface that has to agree about them already sits on a different branch of
// the import graph: the composer (extensions/completion-summary.ts), the
// collapsed chat receipt (extensions/human-handoff.ts, which
// goal-loop-display.ts already imports) and the terminal renderer
// (extensions/summary-renderer.ts). Putting them in completion-summary.ts
// instead would close the cycle
// human-handoff → completion-summary → goal-loop-display → human-handoff,
// which breaks at module init.

/** Section headings the report card composes. `<name> · <area>` is the
 * grouped-change shape used for multi-area work. */
export const CARD_SECTION = {
  summary: "Summary",
  whatChanged: "What changed",
  verification: "Verification",
  followUp: "Follow-up items",
  nextSteps: "Next steps",
  repo: "Final Repository State",
} as const;

/** Section names that must stay recognized after an upgrade: a terminal
 * render queued by an older build lives in the durable outbox and may be
 * replayed months later. Its text is never rewritten, so the recognizer
 * accepts both vocabularies forever. */
export const LEGACY_CARD_SECTIONS = [
  "What Changed",
  "Remaining",
  "Next",
  "Verification Evidence",
  "Verification Summary",
] as const;

/** The pre-report chat trailer shape (`• completion audit approved …`,
 * `• record: …`). A receipt persisted by an older build collapses and colors
 * on those lines too, so the collapsed projection can still tell them apart
 * from body prose. */
export const LEGACY_TRAILER_PREFIX = "\u2022 " as const;

/** Width at which the Markdown gate table is abandoned for bullets. Pi's
 * Markdown renders a table only when the border overhead (3n + 1 for n
 * columns) leaves room for one character per cell; below this a three-column
 * table prints its raw pipe rows instead, which reads as broken output. */
export const NARROW_TABLE_COLUMNS = 50;

const KNOWN_SECTIONS: readonly string[] = [...Object.values(CARD_SECTION), ...LEGACY_CARD_SECTIONS];

/** The canonical section a heading belongs to, or null when the heading is
 * authored prose rather than a card section. Accepts `###` prefixes, bold
 * wrappers and the `· <area>` suffix the grouped shape adds. */
export function cardSectionName(heading: string): string | null {
  const bare = heading
    .replace(/^\s*#{1,6}\s+/, "")
    .replace(/^\*\*(.*?)\*\*$/, "$1");
  const name = bare.split(/\s*\u00b7\s*/)[0]?.trim() ?? "";
  const canonical = CANONICAL_ALIASES[name];
  if (canonical) return canonical;
  return KNOWN_SECTIONS.includes(name) ? name : null;
}

/** Legacy names map onto the section they now stand for, so one recognizer
 * answers for both vocabularies (e.g. a queued `Remaining` block still reads
 * as the follow-up section it became). */
const CANONICAL_ALIASES: Record<string, string> = {
  "What Changed": CARD_SECTION.whatChanged,
  Remaining: CARD_SECTION.followUp,
  Next: CARD_SECTION.nextSteps,
  "Verification Evidence": CARD_SECTION.verification,
  "Verification Summary": CARD_SECTION.verification,
};
