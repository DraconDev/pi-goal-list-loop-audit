// The end-of-task card restates what was asked, reads in sentence case, and
// keeps its meta on one block (field 2026-11-18: "a much better human usable
// summary after the objective").
import { test } from "node:test";
import * as assert from "node:assert/strict";
import type { Goal } from "../extensions/goal-loop-core.js";
import {
  buildRichTerminalParts,
  buildTerminalApprovalRender,
  composeRichTerminalLines,
  objectiveReminder,
  sentenceCase,
} from "../extensions/completion-summary.js";

test("sentenceCase capitalizes a plain lower-case lead word and nothing else", () => {
  assert.equal(sentenceCase("all six complaints are fixed"), "All six complaints are fixed");
  assert.equal(sentenceCase("an in-dialog toggle is not possible"), "An in-dialog toggle is not possible");
  // Code, paths and identifiers keep their exact spelling.
  for (const kept of [
    "npm run release:check exits 0",
    "note.md lists six complaints",
    "handleClick now debounces",
    "iOS keeps its spelling",
    "v0.40 ships the card",
    "git status reads clean",
    "Already capitalized",
    "",
  ]) assert.equal(sentenceCase(kept), kept, kept);
});

test("objectiveReminder includes subsequent requirements and preserves identifiers", () => {
  assert.equal(
    objectiveReminder("> ## Fix duplicate saves. Also preserve pending edits.\n\nVerify save_queue.ts on restart."),
    "Fix duplicate saves. Also preserve pending edits. Verify save_queue.ts on restart.",
  );
  assert.equal(objectiveReminder("fix it"), "fix it", "a short ask stays whole");
  assert.equal(objectiveReminder("   \n  "), undefined);
  assert.equal(objectiveReminder(undefined), undefined);
  const long = objectiveReminder("x".repeat(400));
  assert.ok(long && [...long].length <= 200 && long.endsWith("…"), `bounded excerpt: ${long?.length}`);
});

test("the chat card restates the ask above the meta line, and the diff stat joins the meta", () => {
  const lines = composeRichTerminalLines(buildRichTerminalParts({
    chat: true,
    outcome: "the recovery card no longer lingers — it rendered for a goal that was gone",
    objective: "Fix the six open operator-surface complaints. Each one with a test.",
    durationLine: "*3h 00m elapsed · 1 audit*",
    changeLine: "14 files changed, +620 −88",
    countsLine: "",
    details: [],
  }));
  assert.equal(lines[0], "## Done — The recovery card no longer lingers", "headline is sentence-cased");
  const goalIdx = lines.findIndex((l) => l.startsWith("*Goal: "));
  assert.ok(goalIdx > 0, lines.join("\n"));
  assert.equal(lines[goalIdx], "*Goal: Fix the six open operator-surface complaints. Each one with a test.*  ", "hard break keeps ask + meta in one block");
  assert.equal(lines[goalIdx + 1], "*3h 00m elapsed · 1 audit · 14 files changed, +620 −88*");
  assert.ok(!lines.includes("14 files changed, +620 −88"), "the stat is not repeated as its own block");
});

test("the archive has its own Objective section, so it carries no Goal reminder", () => {
  const lines = composeRichTerminalLines(buildRichTerminalParts({
    outcome: "Done thing", objective: "Do the thing", durationLine: "*1m elapsed*", countsLine: "", details: [],
  }));
  assert.ok(!lines.some((l) => l.includes("Goal: ")), lines.join("\n"));
});

test("a changed-file list keeps the stat as its heading instead of folding it", () => {
  const lines = composeRichTerminalLines(buildRichTerminalParts({
    chat: true, outcome: "Done thing", objective: "Do the thing", durationLine: "*1m elapsed*",
    changeLine: "2 files changed, +5 −1", changeFiles: ["a.ts +4 −1", "b.ts +1 −0"], countsLine: "", details: [],
  }));
  const stat = lines.indexOf("2 files changed, +5 −1");
  assert.ok(stat > 0, lines.join("\n"));
  assert.equal(lines[stat + 1], "- `a.ts +4 −1`");
});

test("an evidence pointer moved out of a sentence never leaves a doubled separator", () => {
  const lines = composeRichTerminalLines(buildRichTerminalParts({
    chat: true, outcome: "Done thing", countsLine: "", details: [],
    groups: [{ title: "Recovery", findings: ["The stale card is gone — it rendered for a goal that no longer existed · extensions/goal-recovery.ts:120"] }],
  }));
  const bullet = lines.find((l) => l.startsWith("- **The stale card is gone**")) ?? "";
  assert.ok(!/·\s*·/.test(bullet), bullet);
  assert.ok(bullet.includes("extensions/goal-recovery.ts:120"), bullet);
});

test("a non-complete render never wears a Done headline", () => {
  const goal = { id: "g", objective: "Ship it", createdAt: new Date().toISOString(), status: "aborted" } as unknown as Goal;
  const render = buildTerminalApprovalRender({
    goal, status: "aborted", archivePath: "a.md", approval: "— stopped.", record: "— record: a.md",
    completionSummary: "Outcome: half of it landed\nChanged: a\nEvidence: b\nTests: c\nUnresolved: d\nNext: e",
  } as never);
  assert.match(render.chatLines[0] ?? "", /^## Aborted — /, render.chatLines.join("\n"));
});
