// pi-goal-list-loop-audit — v0.39.23 summary-agent-text hardening.
//
// Field 2026-10-10 (Clean-Web terminal screenshots): the posted card
// showed raw `###`/`####` chrome (that tab runs pre-0.39.19 render code —
// a reload picks up the plain-chrome fix), a headline cut inside a code
// span ("lands on `sendThreshold…"), a `- , - with` husk bullet, and the
// same popup-screenshot fact under both Unresolved and Left out. This
// file pins the renderer-side hardenings so no agent text can produce
// those shapes again: chat content demotes markdown headings to bold,
// outcomes strip stranded leading punctuation like reasons already do,
// and the clipper never strands an unmatched backtick.

import { test } from "node:test";
import * as assert from "node:assert/strict";

import {
  buildRichTerminalParts,
  composeRichTerminalLines,
  clipSummaryValue,
} from "../extensions/completion-summary.ts";

function chatOf(overrides: Record<string, unknown> = {}): Parameters<typeof composeRichTerminalLines>[0] {
  return {
    banner: "Done",
    headline: "Done — test",
    durationLine: null,
    summaryLines: [],
    findingLines: [],
    tableLines: [],
    nextLines: [],
    remainingLines: [],
    verificationSummaryLine: undefined,
    repoLines: [],
    chat: true,
    ...overrides,
  } as never;
}

test("chat demotes agent-written markdown headings to bold", () => {
  const lines = composeRichTerminalLines(chatOf({
    findingLines: ["#### 1. Strict by default", "### What Changed", "## Notes", "- plain bullet stays"],
    remainingLines: ["### Caveats"],
  }));
  const text = lines.join("\n");
  assert.ok(!text.split("\n").some((l) => /^\s*#{1,6}\s/.test(l)), `no raw heading reaches chat:\n${text}`);
  assert.ok(text.includes("**1. Strict by default**"), "group-style heading becomes bold");
  assert.ok(text.includes("**Caveats**"), "remaining heading becomes bold");
  assert.ok(text.includes("- plain bullet stays"), "bullets untouched");
});

test("archive keeps agent-written markdown headings", () => {
  const lines = composeRichTerminalLines(chatOf({
    findingLines: ["#### 1. Strict by default"],
    chat: false,
  }));
  assert.ok(lines.some((l) => l.includes("#### 1. Strict by default")), "a .md file renders headings natively");
});

test("outcome strips stranded leading punctuation like the reason husk", () => {
  const parts = buildRichTerminalParts({
    outcome: "test outcome",
    details: [],
    countsLine: "",
    groups: [{ title: "Area", findings: [", doubled punctuation outcome — real reason here"] }],
    chat: true,
  });
  const text = composeRichTerminalLines({ ...parts, chat: true }).join("\n");
  assert.ok(!/\*\*,/.test(text), `no comma husk bullet:\n${text}`);
  assert.ok(text.includes("doubled punctuation outcome"), "outcome words survive the strip");
});

test('chat removes redundant section labels without erasing archive evidence or deliberate scope cuts', () => {
  const args = { outcome: 'Readable completion summary', countsLine: '', details: [
    'Unresolved: Saved journals cannot prove a live session.',
    'Left out: Background crawling was deliberately excluded.',
    'Next: Use /glla fleet for a read-only health observation.',
  ] };
  const chat = composeRichTerminalLines(buildRichTerminalParts({ ...args, chat: true })).join('\n');
  const archive = composeRichTerminalLines(buildRichTerminalParts({ ...args, chat: false })).join('\n');
  assert.ok(!chat.includes('**Unresolved**'));
  assert.ok(!chat.includes('**Next**'));
  assert.ok(chat.includes('**Left out**'), 'intentional omission stays distinguishable from an open risk');
  assert.ok(archive.includes('**Unresolved**'));
  assert.ok(archive.includes('**Next**'));
  for (const value of ['Saved journals cannot prove a live session.', 'Background crawling was deliberately excluded.', 'Use /glla fleet for a read-only health observation.']) {
    assert.equal(chat.split(value).length - 1, 1, 'one human instance of each fact');
    assert.ok(archive.includes(value), 'archive retains every fact');
  }
});

test("clip never strands an unmatched backtick", () => {
  const clipped = clipSummaryValue("A fresh install lands on `sendThreshold:` low for every kid", 44);
  const opens = (clipped.match(/`/g) ?? []).length;
  assert.equal(opens % 2, 0, `balanced code span: ${clipped}`);
  assert.ok(clipped.includes("`sendThreshold:`"), `span completes: ${clipped}`);
});

test("clip without code spans keeps its clause behavior", () => {
  assert.equal(clipSummaryValue("short value", 40), "short value");
  const clipped = clipSummaryValue("first clause here, second clause carries onward past the limit", 40);
  assert.ok(!clipped.includes("second"), `clause cut: ${clipped}`);
});
