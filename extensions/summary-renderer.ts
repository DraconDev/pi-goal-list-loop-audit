import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { Box, Markdown, stripTerminalSequences, truncateToWidth, type MarkdownTheme } from "@earendil-works/pi-tui";

export type SummaryTone = "success" | "warning" | "error" | "accent" | "dim" | "text";

/** Color describes a stated result; neutral evidence must never look passed. */
export function summaryHeadingTone(text: string): SummaryTone {
  const heading = text.replace(/^#+\s*/, "").trim();
  if (/^(?:Aborted|Paused|Remaining|Unresolved)\b/i.test(heading)) return "warning";
  if (/^(?:Failed|Disapproved|Error)\b/i.test(heading)) return "error";
  if (/^Done\b/i.test(heading)) return /without.*review|no review|impossible|skipped/i.test(heading) ? "warning" : "success";
  if (/^(?:Next|What Changed|Verification|Evidence)\b/i.test(heading)) return "accent";
  if (/^(?:Final Repository State|Left out)\b/i.test(heading)) return "dim";
  return "text";
}

function labelTone(text: string): SummaryTone | undefined {
  if (/^(?:Unresolved|Remaining)$/i.test(text)) return "warning";
  if (/^(?:Failed|Error|Disapproved)$/i.test(text)) return "error";
  if (/^Next$/i.test(text)) return "accent";
  if (/^(?:Left out|Evidence|Note)$/i.test(text)) return "dim";
  return undefined;
}

/** Split only structural section headings, never heading-like code samples. */
export function summaryMarkdownBlocks(content: string): string[] {
  const safe = stripTerminalSequences(content).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, " ");
  const blocks: string[] = [];
  let lines: string[] = [];
  let fence: { char: string; size: number } | undefined;
  for (const line of safe.split("\n")) {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      if (!fence) fence = { char: marker[0]!, size: marker.length };
      else if (marker[0] === fence.char && marker.length >= fence.size && /^\s{0,3}(?:`+|~+)\s*$/.test(line)) fence = undefined;
    } else if (!fence && /^#{2,4}\s/.test(line) && lines.length) {
      blocks.push(lines.join("\n")); lines = [];
    }
    lines.push(line);
  }
  if (lines.length) blocks.push(lines.join("\n"));
  return blocks;
}

function summaryTheme(theme: Theme, sectionTone: SummaryTone): MarkdownTheme {
  const fg = (color: Parameters<Theme["fg"]>[0]) => (text: string) => theme.fg(color, text);
  return {
    heading: text => theme.bold(theme.fg(summaryHeadingTone(text), text)),
    bold: text => theme.bold(theme.fg(labelTone(text) ?? (sectionTone === "accent" ? "accent" : "text"), text)),
    link: fg("mdLink"), linkUrl: fg("mdLinkUrl"), code: fg("mdCode"),
    codeBlock: fg("mdCodeBlock"), codeBlockBorder: fg("mdCodeBlockBorder"),
    quote: fg("mdQuote"), quoteBorder: fg("mdQuoteBorder"), hr: fg("mdHr"),
    listBullet: fg(sectionTone === "warning" ? "warning" : sectionTone === "accent" ? "accent" : "mdListBullet"),
    italic: text => theme.italic(text), strikethrough: text => theme.strikethrough(text), underline: text => theme.underline(text),
  };
}

export function registerSummaryRenderer(pi: Pick<ExtensionAPI, "registerMessageRenderer">): void {
  pi.registerMessageRenderer("goal-event", (message, { outputPad }, theme) => {
    // Continuations share this custom type. Only durable terminal receipts
    // receive summary styling; the default host renderer handles other events.
    if (!(message.details as { terminalApprovalGoalId?: string } | undefined)?.terminalApprovalGoalId || typeof message.content !== "string") return undefined;
    const box = new Box(outputPad, 1, text => theme.bg("customMessageBg", text));
    for (const block of summaryMarkdownBlocks(message.content)) {
      const heading = block.split("\n").find(line => /^#{2,4}\s/.test(line)) ?? "";
      const tone = summaryHeadingTone(heading);
      box.addChild(new Markdown(block, 0, 0, summaryTheme(theme, tone), {
        color: text => theme.fg(tone === "dim" ? "dim" : "text", text),
      }));
    }
    return {
      render: width => width <= 0 ? [] : box.render(width).map(line => truncateToWidth(line, width, "…")),
      invalidate: () => box.invalidate(),
    };
  });
}
