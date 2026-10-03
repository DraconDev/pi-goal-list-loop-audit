import { test } from "node:test";
import assert from "node:assert/strict";
import { registerSummaryRenderer, summaryHeadingTone, summaryMarkdownBlocks, summaryVerificationTone } from "../extensions/summary-renderer.js";
import { MockPi } from "./harness/mock-pi.js";
import { loadThemeFromPath } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import * as path from "node:path";
import { visibleWidth, stripTerminalSequences } from "@earendil-works/pi-tui";

const content = "## Done — The audit card is readable\n\nTook 8m.\n\n### What Changed\n1. **Audit activity stays visible**\n   - Keeps the latest observation above the cutoff.\n\n### Remaining\n- **Unresolved** — The owner still needs confirmation.\n  → Next: Confirm the named owner.\n- **Left out** — Live production changes.\n\n### Verification\n190 passed, 0 failures.\n\n### Next\n- **Next** — Reload after the active audit ends.\n";

test("semantic colors distinguish outcomes, actions, unresolved work and neutral evidence", () => {
  for (const [heading, tone] of [["Done — fixed", "success"], ["Aborted — user stopped", "warning"], ["Failed — check", "error"], ["Remaining", "warning"], ["Next", "accent"], ["Verification", "accent"], ["Final Repository State", "dim"], ["Done — without a recorded review", "warning"]]) assert.equal(summaryHeadingTone(heading!), tone);
  for (const [text, tone] of [["190 passed, 0 failures", "success"], ["10 passed, 2 failed", "error"], ["0 passed, 0 failed; not run", "warning"], ["3 passed, 1 reported", "warning"], ["Verification reported", "dim"], ["Clean exit 0", "text"]]) assert.equal(summaryVerificationTone(text!), tone);
});

test("code fences and canonical Markdown survive semantic section splitting", () => {
  const source = "## Done\n\n### What Changed\n```md\n### Next\n```\n\n### Next\nReload.\n";
  const blocks = summaryMarkdownBlocks(source);
  assert.equal(blocks.length, 3);
  assert.equal(blocks.join("\n"), source);
  assert.ok(blocks[1]!.includes("```md\n### Next\n```"));
});

test("real dark/light renderers preserve content, fit narrow widths and color semantic labels", () => {
  for (const appearance of ["dark", "light"]) {
    const theme = loadThemeFromPath(path.resolve(import.meta.dirname, `../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/${appearance}.json`), "truecolor");
    const pi = new MockPi(); registerSummaryRenderer(pi.api);
    const message = { content, details: { terminalApprovalGoalId: "approved-goal" } };
    const render = pi.messageRenderers.get("goal-event")!(message as never, { outputPad: 1 } as never, theme)!;
    for (const width of [0, 1, 20, 40, 80, 120]) {
      const lines = render.render(width);
      assert.ok(lines.every(line => visibleWidth(line) <= width));
      if (width >= 40) {
        const plain = stripTerminalSequences(lines.join("\n")).replace(/\s+/g, " ");
        for (const phrase of ["Done", "Unresolved", "Left out", "190 passed", "Reload after"]) assert.ok(plain.includes(phrase), plain);
        assert.ok(lines.join("\n").includes(theme.fg("warning", "Unresolved")));
        assert.ok(lines.join("\n").includes(theme.fg("accent", "Next")));
      }
    }
    assert.equal(message.content, content, "saved/transcript content receives no ANSI or rewriting");
  }
});

test("continuations retain Pi's default renderer and unsafe terminal sequences never execute", () => {
  const theme = loadThemeFromPath(path.resolve(import.meta.dirname, "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/dark.json"), "truecolor");
  const pi = new MockPi(); registerSummaryRenderer(pi.api); const factory = pi.messageRenderers.get("goal-event")!;
  assert.equal(factory({ content: "Continue the goal." } as never, { outputPad: 1 } as never, theme), undefined);
  const rendered = factory({ content: content + "\x1b]52;c;bad\x07\x1b[2J", details: { terminalApprovalGoalId: "approved-goal" } } as never, { outputPad: 1 } as never, theme)!.render(80).join("\n");
  assert.doesNotMatch(rendered, /\x1b\]52|\x1b\[2J/);
});
