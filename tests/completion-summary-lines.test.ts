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
  clipSummaryValue,
  compactCompletionSummary,
  completionSummaryLines,
  humanCompletionBrief,
  terminalCompletionSummaryLines,
  terminalHumanBrief,
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
  assert.equal(lines.length, 6);
  assert.equal(lines[0], "Outcome: shipped the thing");
  assert.equal(lines[5], "Next: follow-ups below");
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
  assert.ok(brief.details.some((d) => d.startsWith("Tests:")), "informing labels stay");
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
  assert.match(hooks, /terminalHumanBrief\(/);
  // v0.38.20: the approval voice moved into buildApprovalChatLines — the
  // stale pre-verdict Next: never reaches the chat on any approval path.
  assert.match(hooks, /buildApprovalChatLines\(\{/);
  assert.match(hooks, /withoutStaleNext\(brief\.details\)/);
  assert.match(hooks, /— auditor \$\{result\.model\} approved/);
  const brief = fs.readFileSync("extensions/completion-summary.ts", "utf8");
  assert.match(brief, /✓ done — \$\{notice\.outcome\}/);
  const tools = fs.readFileSync("extensions/loops/goal-tools.ts", "utf8");
  assert.equal(tools.match(/terminalHumanBrief\(/g)?.length ?? 0, 2, "both tool ✓ done paths use the briefing");
  assert.equal(tools.match(/buildApprovalChatLines\(\{/g)?.length ?? 0, 2, "both tool ✓ done notifies use the approval voice");
  assert.match(tools, /notifyExternal\(ctx, `Goal complete \(auditor approved\): \$\{recap\}`\)/, "external notify keeps the compact line");
});
