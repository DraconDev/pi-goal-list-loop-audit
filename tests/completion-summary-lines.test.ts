// pi-goal-list-loop-audit — v0.38.13 (good completion summary)
//
// Field complaint (note.md Next, Screenshot_20260903_204003/204005): the
// `✓ done:` notify mashed all six labels into one line with each value
// hard-sliced mid-word (`0 o…`, `qu…`, `belo…`) — and repeated the agent's
// prose paragraph above it. The chat notify now carries one `Label: value`
// line per label with word-boundary cuts; the single-line projection stays
// for width-bound surfaces (TUI widget, external notifies) but also cuts
// at word boundaries from here on.

import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import {
  briefValueContent,
  chatSafeDetailValue,
  clipSummaryValue,
  compactCompletionSummary,
  completionSummaryLines,
  humanCompletionBrief,
  terminalCompletionSummaryLines,
  terminalHumanBrief,
  withoutStaleNext,
} from "../extensions/completion-summary.js";
import { seedGoal } from "./harness/mock-pi.js";

const SIX = [
  "Outcome: shipped the thing",
  "Changed: extensions/example.ts",
  "Evidence: commit abc123",
  "Tests: bun test — pass",
  "Unresolved: none",
  "Next: follow-ups below",
].join("\n");

test("clip cuts at a word boundary, never mid-word", () => {
  assert.equal(clipSummaryValue("alpha beta gamma delta", 12), "alpha beta…");
  assert.equal(clipSummaryValue("alpha beta gamma delta", 11), "alpha beta…");
  assert.equal(clipSummaryValue("short", 24), "short", "short values pass through with no ellipsis");
  assert.equal(clipSummaryValue("  padded   value  ", 24), "padded value", "whitespace collapses first");
});

test("clip hard-cuts only long tokens without spaces", () => {
  const hash = "f5466da30d1c59ff1af1234567890abcdef12345678";
  const clipped = clipSummaryValue(`evidence ${hash} on main`, 24);
  assert.ok(clipped.endsWith("…"), "still bounded");
  assert.ok(clipped.length <= 24, "still within budget");
});

test("clip cuts at a clause boundary and never strands punctuation (field 2026-09-08)", () => {
  const field = "settings schema + v3 migration, settings UI, source-gated generation, append/replace Apply, playlist auto-add, docs sweep";
  const cut = clipSummaryValue(field, 115);
  assert.ok(cut.endsWith("playlist auto-add…"), `clause cut reads intentional, not clipped: ${cut}`);
  assert.doesNotMatch(cut, /[,;:\s]\s*…$/, "no dangling punctuation before the ellipsis");
  // Word-path fallback strips a stranded comma too.
  assert.equal(clipSummaryValue("aaaa bbbb, cccc", 14), "aaaa bbbb…");
});

test("lines project one label per line, in order, word-bounded", () => {
  const lines = completionSummaryLines(SIX);
  assert.equal(lines.length, 6);
  for (const label of ["Outcome:", "Changed:", "Evidence:", "Tests:", "Unresolved:", "Next:"]) {
    assert.ok(lines.some((l) => l.startsWith(label)), `${label} heads its own line`);
  }
  assert.equal(lines[0], "Outcome: shipped the thing");
  assert.doesNotMatch(lines.join("\n"), / · /, "no single-line mash separator");
});

test("lines keep missing labels as not recorded and never mid-word cut", () => {
  const lines = completionSummaryLines("Outcome: did the work with many words beyond the small budget here");
  assert.equal(lines[1], "Changed: not recorded");
  assert.ok(lines[0]!.endsWith("…") || lines[0] === "Outcome: did the work with many words beyond the small budget here");
  if (lines[0]!.endsWith("…")) {
    assert.doesNotMatch(lines[0]!, /\S…$/, "ellipsis follows a word break, not a fragment");
  }
  const empty = completionSummaryLines(undefined);
  assert.equal(empty.length, 6);
  assert.ok(empty.every((l) => l.endsWith("not recorded")), "empty source keeps every label");
});

test("compact stays one line but cuts at word boundaries now", () => {
  const compact = compactCompletionSummary([
    "Outcome: alpha beta gamma delta epsilon",
    "Changed: extensions/example.ts",
    "Evidence: commit abc123",
    "Tests: bun test — pass",
    "Unresolved: none",
    "Next: none",
  ].join("\n"), 24);
  assert.ok(!compact.includes("\n"), "single-line contract holds for the widget/external surfaces");
  assert.ok(compact.includes("alpha beta gamma delta…"), "cut fills the budget then lands on the word break");
  assert.ok(!compact.includes("epsilon…") && !compact.includes("epsi…"), "the tail is cut, never mid-word");
});

test("terminal lines resolve through the same facts as the compact recap", () => {
  const lines = terminalCompletionSummaryLines({
    goal: seedGoal({
      status: "active",
      objective: "terminal lines projection",
      completionSummary: SIX,
    }) as any,
    status: "complete",
    stopReason: "auditor approved",
    archivePath: ".pi-glla/archive/terminal-lines.md",
  });
  assert.equal(lines.length, 5);
  assert.equal(lines[0], "Outcome: shipped the thing");
  assert.equal(lines[4], "Next: follow-ups below");
  assert.ok(!lines.some((line) => line.startsWith("Tests:")), "terminal lines hide Tests by default");
});

test("v0.38.14: filler values inform nobody and are dropped", () => {
  for (const filler of ["", "  ", "none", "None.", "not recorded", "none for this objective", "none for this audit", "N/A", "nothing"]) {
    assert.equal(briefValueContent(filler), null, JSON.stringify(filler));
  }
  assert.equal(briefValueContent("none — queued follow-ups (analytics cache)"), "queued follow-ups (analytics cache)");
  assert.equal(briefValueContent("not recorded — no file-write signal was captured"), null, "system placeholder stays filler with its explanation");
  assert.equal(briefValueContent("shipped the thing"), "shipped the thing");
});

test("v0.38.14: the briefing leads with the outcome and keeps only informing labels", () => {
  const brief = humanCompletionBrief([
    "Outcome: Full-sweep UI/UX pass with bolder dark+red restyle across shell, all 5 views.",
    "Changed: theme tokens/gradients/glows, hero SetupBanner with step progress.",
    "Evidence: commits f5466da30 on main.",
    "Tests: tsc clean; vitest 1179 passed.",
    "Unresolved: none for this objective.",
    "Next: none — queued follow-ups (analytics SWR cache, new-tab extraction).",
  ].join("\n"));
  assert.equal(brief.outcome, "Full-sweep UI/UX pass with bolder dark+red restyle across shell, all 5 views.");
  assert.ok(brief.details.some((d) => d.startsWith("Changed:")), "informing labels stay");
  assert.ok(!brief.details.some((d) => d.startsWith("Tests:")), "technical Tests stay out of the default human brief");
  assert.ok(brief.details.some((d) => d === "Next: queued follow-ups (analytics SWR cache, new-tab extraction)."), "none-prefix content is kept, prefix stripped");
  assert.ok(!brief.details.some((d) => d.startsWith("Unresolved:")), "filler labels are gone");
  assert.ok(!brief.details.join("\n").includes("not recorded"), "no placeholders leak through");
});

test("v0.38.14: terminal brief resolves through the same facts as the compact recap", () => {
  const brief = terminalHumanBrief({
    goal: seedGoal({ status: "active", objective: "terminal brief", completionSummary: SIX }) as any,
    status: "complete",
    stopReason: "auditor approved",
    archivePath: ".pi-glla/archive/terminal-brief.md",
  });
  assert.equal(brief.outcome, "shipped the thing");
  assert.ok(brief.details.length >= 2, "informing labels survive the terminal path");
});

test("the ✓ done chat notifies use the line block; external keeps the single line", () => {
  const hooks = fs.readFileSync("extensions/loops/goal-auditor-hooks.ts", "utf8");
  // v0.38.25: the approval voice moved into ONE canonical builder — the
  // detached path builds the render, persists it at archive time, and
  // replays it on the next live contact when the verdict lands with no
  // live turn (field 2026-09-07: record perfect, delivery silent).
  assert.match(hooks, /buildTerminalApprovalRender\(\{/);
  assert.match(hooks, /persistApprovalRender\(/);
  assert.match(hooks, /replayUndeliveredApprovalRenders\(/);
  assert.doesNotMatch(hooks, /isApprovalContextIdle\(/);
  assert.match(hooks, /— auditor \$\{result\.model\} approved/);
  const brief = fs.readFileSync("extensions/completion-summary.ts", "utf8");
  assert.match(brief, /✓ done — \$\{notice\.outcome\}/);
  const tools = fs.readFileSync("extensions/loops/goal-tools.ts", "utf8");
  assert.equal(tools.match(/buildTerminalApprovalRender\(\{/g)?.length ?? 0, 2, "both tool ✓ done paths use the canonical render");
  assert.equal(tools.match(/persistApprovalRender\(/g)?.length ?? 0, 2, "both tool paths persist the render");
  assert.match(tools, /notifyExternal\(ctx, `Goal complete \(auditor approved\): \$\{manualRender\.recap\}`\)/, "external notify keeps the compact line");
});

test("audit-2026-09-06: completionSummaryLines honors the optional line-width budget", async () => {
  const { completionSummaryLines } = await import("../extensions/completion-summary.ts");
  const { visibleWidth } = await import("@earendil-works/pi-tui");
  const text = "Outcome: did the thing. Changed: " + "x".repeat(300) + ". Evidence: y. Tests: z. Unresolved: none. Next: none.";
  const wide = completionSummaryLines(text);
  const narrow = completionSummaryLines(text, 240, 40);
  assert.ok(wide.some((l) => visibleWidth(l) > 40), "default lines can exceed 40 cells");
  for (const line of narrow) assert.ok(visibleWidth(line) <= 40, `budgeted line fits 40 cells: ${line.slice(0, 60)}`);
});

test("recorded-facts fallback Next survives the stale-Next filter", () => {
  const kept = withoutStaleNext([
    "Evidence: commit abc",
    "Next: review the durable record at .pi-glla/archive/g.md",
    "Next: awaiting auditor verdict on the claim",
  ]);
  assert.ok(
    kept.some((l) => /review the durable record/.test(l)),
    "the concrete record pointer is a real next action, not self-reference",
  );
  assert.ok(!kept.some((l) => /awaiting auditor verdict/.test(l)), "self-referential Next still drops");
});

test("machine-path strip converges on nested groups, leaves no husk", () => {
  const out = chatSafeDetailValue("shipped (log (/tmp/glla-x/build.log)) clean");
  assert.ok(!/\(\s*\)/.test(out), `no empty-paren husk survives, got: ${out}`);
  assert.ok(!/tmp/.test(out), "the machine path is gone at every depth");
});

test("clip never splits a surrogate pair", () => {
  const out = clipSummaryValue(`aaaaaaaaaa ${"😀".repeat(6)} tail here`, 16);
  assert.ok(!/\uFFFD/.test(out), "no replacement char from a split pair");
  assert.ok(out.endsWith("…"), "still clause-capped");
  for (const ch of out) assert.ok(ch !== "\uD83D" && ch !== "\uDE00", "no lone surrogate halves");
});

test("label named inside a value does not steal later segmentation", () => {
  const compacted = compactCompletionSummary(
    ["Outcome: fixed the retry path", "Changed: x.ts", "Evidence: c1", "Tests: 5 pass", "Unresolved: none", "Next: n/a"].join("\n"),
    72,
  );
  assert.match(compacted, /Outcome: fixed the retry path/, "Outcome keeps its full value");
  const restated = compactCompletionSummary("Outcome: see Tests: x. Tests: 5 pass", 72);
  assert.match(restated, /Tests: 5 pass/, "the last restatement of a label wins");
});
