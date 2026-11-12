// Report shape contract (field 2026-11-11 — "i am not loving the goal
// completion summary, that should be more like how opencode does the summary
// upon task completion").
//
// This file pins the SHAPE, not the wording: the order of the report sections,
// the always-on verification inventory on both surfaces, the narrow-width
// bullet fallback, the legacy-vocabulary replay path, and the single module
// that owns the section names. Each test names the user-visible property it
// protects so a later refactor cannot quietly restore the audit-log shape.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { stripTerminalSequences, type Component } from "@earendil-works/pi-tui";
import { loadThemeFromPath } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import {
  CARD_SECTION,
  LEGACY_CARD_SECTIONS,
  NARROW_TABLE_COLUMNS,
  buildRichArchiveSection,
  buildRichTerminalParts,
  buildTerminalApprovalRender,
  composeRichTerminalLines,
  splitReportTitle,
  tableAsBullets,
} from "../extensions/completion-summary.js";
import { cardSectionName, tableAsBullets as leafTableAsBullets } from "../extensions/card-sections.js";
import { registerSummaryRenderer } from "../extensions/summary-renderer.js";
import { compactHumanSummary } from "../extensions/human-handoff.js";
import type { Goal, FindingGroup, GateRow } from "../extensions/goal-loop-core.js";
import { HUMAN_HANDOFF_GUIDANCE } from "../extensions/human-handoff.js";
import { MockPi, seedGoal } from "./harness/mock-pi.js";

const GATES: GateRow[] = [
  { gate: "Release gate", command: "npm run release:check", scope: "full suite", notes: "4552 passed, 0 failed; exit 0" },
  { gate: "Typecheck", command: "npm run check", scope: "all sources", notes: "tsc --noEmit exited 0" },
];
const GROUPS: FindingGroup[] = [
  { title: "Login responses", findings: ["Same failure copy: the message is chosen by outcome (extensions/login.ts:88)"] },
  { title: "Locked accounts", findings: ["Unlock path: the copy names the unlock route without confirming existence (extensions/login.ts:112)"] },
];

function goalWith(summary: string, history: Goal["auditHistory"] = [{ at: "t", approved: true, disapproved: false, model: "m" }]): Goal {
  return seedGoal({
    id: "20261111-report-shape",
    objective: "make login failures safe to read",
    completionSummary: summary,
    createdAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    telemetry: { turns: 9, fileWrites: 4, bashCalls: 12 },
    auditHistory: history,
  }) as unknown as Goal;
}

const SUMMARY = [
  "Outcome: Login failures now read the same for every account state, and a locked account is told how to unlock without leaking whether it exists.",
  "Changed: the copy is gated on outcome instead of the account lookup.",
  "Evidence: audit/login-copy-2026-11-11/README.md records the before/after copy.",
  "Tests: npm run release:check exited 0.",
  "Unresolved: Rate-limit copy still differs between the web and API paths.",
  "Next: Audit the remaining login templates for the same leak.",
].join("\n");

function render(extra: Record<string, unknown> = {}) {
  return buildTerminalApprovalRender({
    goal: goalWith(SUMMARY),
    status: "complete",
    archivePath: ".pi-glla/archive/20261111-report-shape.md",
    approval: "— completion audit approved.",
    record: "— record: .pi-glla/archive/20261111-report-shape.md",
    findingGroups: GROUPS,
    gateRows: GATES,
    ...extra,
  });
}

test("the chat card is ONE report: headline, lede, Summary, Verification, Follow-up items, Next steps, receipt", () => {
  const lines = render().chatLines;
  const sections = lines
    .filter((line) => line.startsWith("## ") && !line.startsWith("## Done") && !line.startsWith("## Aborted"))
    .map((line) => line.replace(/^## /, ""));
  assert.deepEqual(
    sections,
    [CARD_SECTION.summary, CARD_SECTION.verification, CARD_SECTION.followUp, CARD_SECTION.nextSteps],
    `the report carries exactly these sections in this order:\n${lines.join("\n")}`,
  );
  // Headline first, then the prose lede: the operator-chosen title shape.
  assert.equal(lines[0], "## Done — Login failures now read the same for every account state");
  assert.equal(lines[1], "", "blank line after the headline");
  assert.equal(
    lines[2],
    "And a locked account is told how to unlock without leaking whether it exists.",
    "the sentence remainder rides the lede, capitalized, word-for-word",
  );
  // One meta footnote, then the sections.
  assert.match(lines[4] ?? "", /^\*9 turns · .+ elapsed · 1 audit\*$/, `meta footnote: ${lines[4]}`);
  // Every work area is its own subsection under the body.
  assert.ok(lines.includes(`**${CARD_SECTION.whatChanged} · Login responses**`), "first area names its subsection");
  assert.ok(lines.includes(`**${CARD_SECTION.whatChanged} · Locked accounts**`), "second area names its subsection");
  // One compact receipt closes the report, no bullet trailer.
  const last = lines[lines.length - 1] ?? "";
  assert.match(last, /^completion audit approved \(1 review\) · record: .pi-glla\/archive\/20261111-report-shape\.md\.$/, last);
  assert.ok(!lines.some((line) => line.startsWith("\u2022 ")), `no legacy bullet trailer:\n${lines.join("\n")}`);
});

test("the archive carries the same report with its wide inventory and repository state", () => {
  const archive = buildRichArchiveSection(goalWith(SUMMARY), "complete", ".pi-glla/archive/20261111-report-shape.md", GROUPS, GATES);
  // Report order (field 2026-11-11): what changed → what was checked → what is
  // still open → what comes next → repository bookkeeping (archive only).
  const archiveWithRepo = buildRichArchiveSection(goalWith(SUMMARY), "complete", "a.md", GROUPS, GATES);
  assert.deepEqual(
    archiveWithRepo.filter((line) => line.startsWith("### ")).map((line) => line.replace(/^### /, "")),
    [CARD_SECTION.summary, CARD_SECTION.verification, CARD_SECTION.followUp, CARD_SECTION.nextSteps],
    `archive sections in report order:\n${archiveWithRepo.join("\n")}`,
  );
  assert.ok(archive.includes(`#### ${CARD_SECTION.whatChanged} · Login responses`), "areas keep their subsection as a real heading");
  assert.ok(archive.includes("| Quality Gate | Command | Scope | Status | Notes |"), "the archive keeps the wide gate inventory");
  assert.ok(archive.some((line) => /^\| Completion review \| — \| review status \| approved \(1 review\) \|/.test(line)), "the archive keeps its review row");
  assert.ok(archive.at(-1)?.includes("record: .pi-glla/archive/20261111-report-shape.md"), "one receipt line closes the record");
  const aborted = buildRichArchiveSection(goalWith(SUMMARY), "aborted", ".pi-glla/archive/aborted.md", GROUPS, GATES);
  assert.ok(aborted[0]?.startsWith("## Aborted — "), "an aborted record never wears a Done headline");
});

test("verification is always reported, derives its status, and escapes table pipes", () => {
  const lines = render().chatLines;
  assert.ok(lines.includes(`## ${CARD_SECTION.verification}`), "chat carries verification without any opt-in");
  assert.ok(lines.includes("| Gate | Command | Result |"), "chat uses its compact three-column shape");
  // Unproven wording keeps its own words: `… ; exit 0` carries an unknown
  // clause, so the row is REPORTED-shaped rather than borrowing a PASS label.
  assert.ok(lines.includes("| Release gate | npm run release:check | 4552 passed, 0 failed; exit 0 |"), lines.join("\n"));
  // A complete-parse pass IS labeled PASS: with the real counts beside it.
  const proven = composeRichTerminalLines({
    ...buildTerminalPartsFor({ outcome: "x", gates: [{ gate: "Release gate", command: "npm run release:check", notes: "4552 passed, 0 failed" }] }),
    chat: true,
  });
  assert.ok(proven.includes("| Release gate | npm run release:check | PASS: 4552 passed, 0 failed |"), proven.join("\n"));
  // Unproven wording keeps its own words rather than borrowing a status word.
  const bare = composeRichTerminalLines({
    ...buildTerminalPartsFor({
      outcome: "x",
      gates: [{ gate: "Typecheck", command: "npm run check", notes: "tsc --noEmit exited 0" }],
    }),
    chat: true,
  });
  assert.ok(bare.includes("| Typecheck | npm run check | exited 0 |"), `the row keeps the honest wording (its own command is already in the Command column):\n${bare.join("\n")}`);
  // A failing gate is visible and never softened.
  const failing = composeRichTerminalLines({
    ...buildTerminalPartsFor({ outcome: "x", gates: [{ gate: "Unit", command: "bun test", notes: "3 failed, 9 passed" }] }),
    chat: true,
  });
  assert.ok(failing.join("\n").includes("3 failed, 9 passed"), "the failure text survives");
  assert.ok(!failing.some((line) => line.startsWith("| Unit |") && line.includes("PASS: ")), "a failing gate never wears a PASS label");
  // Pipes in any cell cannot break the table.
  const escaped = composeRichTerminalLines({
    ...buildTerminalPartsFor({ outcome: "x", gates: [{ gate: "Unit", command: "bun test | tee log", notes: "9 passed, 0 failed" }] }),
    chat: true,
  });
  assert.ok(escaped.some((line) => line.includes("bun test \\| tee log")), `cell pipes are escaped:\n${escaped.join("\n")}`);
  assert.ok(escaped.filter((line) => line.startsWith("| Unit |")).length === 1, "the escaped row stays one row");
});

/** Minimal parts builder, so a test can drive the verification section alone
 * without the claim pipeline (which synthesizes its own rows). */
function buildTerminalPartsFor(args: { outcome: string; gates?: GateRow[] }) {
  return buildRichTerminalParts({ chat: true, outcome: args.outcome, details: [], countsLine: "", gates: args.gates });
}

test("a narrow receipt states the gate inventory as bullets, never raw pipe rows", () => {
  const content = render().chatLines.join("\n");
  const theme = loadThemeFromPath(path.resolve(import.meta.dirname, "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/dark.json"), "truecolor");
  const pi = new MockPi(); registerSummaryRenderer(pi.api);
  const renderer = pi.messageRenderers.get("goal-event")!({ content, details: { terminalApprovalGoalId: "g" } } as never, { outputPad: 1 } as never, theme) as Component;
  const at = (width: number) => stripTerminalSequences(renderer.render(width).join("\n"));
  const narrow = at(NARROW_TABLE_COLUMNS - 1);
  assert.doesNotMatch(narrow, /^\s*\|/m, `no raw pipe row below the fallback width:\n${narrow}`);
  // Wrapping is the renderer's job, so the assertion reads the bullets with
  // whitespace folded: gate, command and result on one logical line.
  const folded = narrow.replace(/\s+/g, " ");
  assert.match(folded, /- Release gate — npm run release:check — 4552 passed, 0 failed; exit 0/, "the bullet states gate, command and result");
  assert.match(folded, /- Typecheck — npm run check — exited 0/, "every gate becomes a bullet");
  const wide = at(NARROW_TABLE_COLUMNS);
  // At the threshold the markdown table renders as a real bordered table
  // rather than falling back to bullets or printing raw pipes.
  assert.match(wide, /\u250c[-\u2500\u252c]+\u2510/, `a real table renders at the threshold:\n${wide}`);
  assert.match(wide.replace(/\s+/g, " "), /Gate .* Command .* Result/, "the column vocabulary survives");
  assert.doesNotMatch(wide, /^- Release gate/, "no bullet fallback at the threshold");
  assert.equal(tableAsBullets(["## Verification", "| Gate | Command | Result |", "| --- | --- | --- |", "| Unit | bun test | PASS: 9 passed |"].join("\n")).join("\n"),
    ["## Verification", "- Unit — bun test — PASS: 9 passed"].join("\n"), "the fallback keeps the heading and drops header/separator rows");
});

test("the legacy vocabulary still collapses, colors and keeps its review qualification and record link", () => {
  // A receipt persisted by an older build must replay after an upgrade: the
  // collapsed projection recognizes its sections and its durable content is
  // forwarded untouched.
  const legacyReceipt = [
    "## Done — Fixed routing",
    "",
    "### What Changed",
    "1. **Router**",
    "   - Keeps the route pinned.",
    "",
    "### Remaining",
    "- **Unresolved** — Owner still needs confirmation.",
    "  → Next: Confirm the named owner.",
    "",
    "### Verification Evidence",
    "| Verification | Status | Details |",
    "| --- | --- | --- |",
    "| Verification | PASS | 9 passed, 0 failed |",
    "",
    "### Next",
    "- Reload after the active audit ends.",
    "",
    "\u2022 completion audit approved (1 review).",
    "\u2022 record: .pi-glla/archive/legacy.md",
  ].join("\n");
  const collapsed = compactHumanSummary(legacyReceipt);
  assert.ok(collapsed.content.includes("Fixed routing"), "the collapsed receipt keeps its headline");
  assert.match(collapsed.content, /completion audit approved \(1 review\)/, `review qualification preserved:\n${collapsed.content}`);
  assert.match(collapsed.content, /record: .pi-glla\/archive\/legacy\.md/, "the record link survives collapsing");
  assert.equal(collapsed.content.includes("### Verification Evidence"), true, "a legacy evidence section is kept, not invented away");
  // The renderer recognizes both vocabularies, so both color correctly.
  const legacy2 = "Done \u2014 legacy\n\nWhat Changed\n- **A change**\n\nRemaining\n- Still open.\n\nVerification\n1 failed.\n";
  const theme = loadThemeFromPath(path.resolve(import.meta.dirname, "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/dark.json"), "truecolor");
  const pi = new MockPi(); registerSummaryRenderer(pi.api);
  const ansi = (pi.messageRenderers.get("goal-event")!({ content: legacy2, details: { terminalApprovalGoalId: "g" } } as never, { outputPad: 1 } as never, theme) as Component).render(120).join("\n");
  assert.ok(ansi.includes(theme.fg("accent", "What Changed")), "legacy What Changed keeps its accent");
  assert.ok(ansi.includes(theme.fg("warning", "Remaining")), "legacy Remaining keeps its warning tone");
  assert.ok(ansi.includes(theme.fg("error", "1 failed.")), "legacy verification evidence keeps evidence-derived coloring");
  // The recognizer reports the canonical section each legacy name became.
  for (const legacy of LEGACY_CARD_SECTIONS) assert.ok(cardSectionName(legacy), `${legacy} stays recognized`);
  assert.equal(cardSectionName("What Changed"), CARD_SECTION.whatChanged);
  assert.equal(cardSectionName("Remaining"), CARD_SECTION.followUp);
  assert.equal(cardSectionName("Next"), CARD_SECTION.nextSteps);
  assert.equal(cardSectionName("Verification Evidence"), CARD_SECTION.verification);
  assert.equal(cardSectionName("Random prose"), null, "authored prose is not a card section");
});

test("one leaf module owns the section vocabulary and keeps the import graph acyclic", () => {
  const leaf = fs.readFileSync(path.resolve("extensions/card-sections.ts"), "utf-8");
  assert.equal((leaf.match(/^import /gm) ?? []).length, 0, "the vocabulary module imports nothing (no cycle)");
  for (const surface of ["extensions/completion-summary.ts", "extensions/human-handoff.ts", "extensions/summary-renderer.ts"]) {
    const source = fs.readFileSync(path.resolve(surface), "utf-8");
    assert.match(source, /from "\.\/card-sections\.js"/, `${surface} reads the shared vocabulary`);
  }
  // The human-handoff module must not reach back into the composer, which is
  // the cycle this leaf module exists to prevent.
  const handoff = fs.readFileSync(path.resolve("extensions/human-handoff.ts"), "utf-8");
  assert.doesNotMatch(handoff, /from "\.\/completion-summary\.js"/, "no human-handoff → completion-summary edge");
  assert.deepEqual(Object.values(CARD_SECTION), ["Summary", "What changed", "Verification", "Follow-up items", "Next steps", "Final Repository State"]);
  assert.equal(leafTableAsBullets, tableAsBullets, "the table fallback is the same implementation the renderer uses");
});

test("splitReportTitle prefers a natural boundary and never truncates mid-thought", () => {
  assert.deepEqual(
    splitReportTitle("Login failures now read the same for every account state, and a locked account is told how to unlock without leaking whether it exists."),
    {
      title: "Login failures now read the same for every account state",
      lede: "And a locked account is told how to unlock without leaking whether it exists.",
    },
  );
  assert.deepEqual(splitReportTitle("Audit pass closed \u2014 all 5 findings fixed and the ledger checked."), {
    title: "Audit pass closed",
    lede: "All 5 findings fixed and the ledger checked.",
  });
  assert.deepEqual(splitReportTitle("shipped the rich terminal voice"), { title: "shipped the rich terminal voice", lede: "" }, "one clause keeps its whole sentence");
  assert.deepEqual(splitReportTitle("Done. The rest continues here."), { title: "Done. The rest continues here.", lede: "" }, "a too-short opener never becomes the title");
  assert.equal(splitReportTitle("").title, "", "empty stays empty");
});

test("the agent guidance asks for the report material, not for a shape the renderer must rescue", () => {
  // The card is built from what the agent claims; guidance that asks for a
  // compact recap and leaves the report to the renderer is what produced the
  // audit-log shape the operator rejected.
  for (const phrase of ["Outcome is the lede", "findingGroups", "gateRows", "real counts", "limitations in Unresolved", "follow-up in Next"]) {
    assert.ok(HUMAN_HANDOFF_GUIDANCE.includes(phrase), `guidance asks for ${phrase}`);
  }
  const journal = fs.readFileSync(path.resolve("extensions/loops/goal-tools.ts"), "utf-8");
  assert.match(journal, /REPORT SHAPE:/, "complete_goal's own description names the report the claim feeds");
  assert.match(journal, /findingGroups becomes one `What changed · <area>` subsection per area/, "it names the subsection shape");
  assert.match(journal, /gateRows becomes the always-visible Verification table/, "it says verification is always visible");
});

test("the stored chat lines and the source message stay free of ANSI and controls", () => {
  const hostile = render({ leftOut: "the walkthrough surface \u001b[31mRED\u001b[0m\u202Ehidden" });
  const joined = hostile.chatLines.join("\n");
  assert.ok(!joined.includes("\u001b"), "no terminal escape survives the trust boundary");
  assert.ok(!joined.includes("\u202E"), "no bidi override survives");
  assert.ok(joined.includes("the walkthrough surface"), "the human words remain");
});
