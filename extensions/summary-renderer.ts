import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { Box, Markdown, stripTerminalSequences, truncateToWidth, type MarkdownTheme } from "@earendil-works/pi-tui";
import { compactHumanSummary } from "./human-handoff.js";
import { CARD_SECTION, NARROW_TABLE_COLUMNS, cardSectionName, tableAsBullets } from "./card-sections.js";

export type SummaryTone = "success" | "warning" | "error" | "accent" | "dim" | "text";

/** Color describes a stated result; neutral evidence must never look passed. */
export function summaryHeadingTone(text: string): SummaryTone {
  const heading = stripTerminalSequences(text).replace(/^#+\s*/, "").trim();
  if (/^(?:Aborted|Paused|Remaining|Unresolved|Follow-up items)\b/i.test(heading)) return "warning";
  if (/^(?:Failed|Disapproved|Error)\b/i.test(heading)) return "error";
  if (/^Done\b/i.test(heading)) return /without.*review|no review|impossible|skipped/i.test(heading) ? "warning" : "success";
  if (/^(?:Next steps|Next|What changed|What Changed|Verification|Evidence)\b/i.test(heading)) return "accent";
  if (/^(?:Final Repository State|Left out)\b/i.test(heading)) return "dim";
  return "text";
}

function structuralHeading(line: string): string | undefined {
  if (/^#{2,4}\s/.test(line)) return line;
  const plain = line.trim().replace(/^\*\*(.*?)\*\*$/, '$1');
  // Report shape (field 2026-11-11): `<section> · <area>` is a card section
  // too, so a collapsed receipt keeps its per-area labels instead of showing
  // the grouped `What changed` chrome as prose.
  return cardSectionName(plain) ? `### ${plain}` : undefined;
}

function labelTone(text: string): SummaryTone | undefined {
  text = stripTerminalSequences(text);
  if (/^(?:Unresolved|Remaining|Follow-up items)$/i.test(text)) return "warning";
  if (/^(?:Failed|Error|Disapproved)$/i.test(text)) return "error";
  if (/^(?:Next|Next steps)$/i.test(text)) return "accent";
  if (/^(?:Left out|Evidence|Note)$/i.test(text)) return "dim";
  return undefined;
}

export function summaryVerificationTone(text: string): SummaryTone {
  const counts = [...text.matchAll(/\b(\d+)\s+(?:failed|failures|errors)\b/gi)];
  if (counts.some(match => Number(match[1]) > 0) || /^\s*(?:FAIL|FAILED|ERROR)\b/im.test(text)) return "error";
  if (/\b(?:skipped|not run|inconclusive)\b/i.test(text) || /\b[1-9]\d*\s+reported\b/i.test(text)) return "warning";
  if (/\b(?:reported|not recorded|unknown)\b/i.test(text)) return "dim";
  if (/\b[1-9]\d*\s+passed\b/i.test(text) || /^\s*PASS\b/im.test(text)) return "success";
  return "text";
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
    } else if (!fence && structuralHeading(line) && lines.length) {
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
    heading: text => theme.bold(theme.fg(summaryHeadingTone(text), stripTerminalSequences(text))),
    bold: text => {
      const tone = labelTone(text);
      return theme.bold(tone ? theme.fg(tone, stripTerminalSequences(text)) : text);
    },
    link: fg("mdLink"), linkUrl: fg("mdLinkUrl"), code: fg("mdCode"),
    codeBlock: fg("mdCodeBlock"), codeBlockBorder: fg("mdCodeBlockBorder"),
    quote: fg("mdQuote"), quoteBorder: fg("mdQuoteBorder"), hr: fg("mdHr"),
    listBullet: fg(sectionTone === "warning" ? "warning" : sectionTone === "accent" ? "accent" : "mdListBullet"),
    italic: text => theme.bold(text), strikethrough: text => theme.strikethrough(text), underline: text => theme.underline(text),
  };
}

export function registerSummaryRenderer(pi: Pick<ExtensionAPI, "registerMessageRenderer">): void {
  pi.registerMessageRenderer("goal-event", (message, { outputPad, expanded }, theme) => {
    // Continuations share this custom type. Only durable terminal receipts
    // receive summary styling; the default host renderer handles other events.
    if (!(message.details as { terminalApprovalGoalId?: string } | undefined)?.terminalApprovalGoalId || typeof message.content !== "string") return undefined;
    const content = expanded ? message.content : compactHumanSummary(message.content).content;
    // The box is rebuilt per rendered width: the narrow-table decision lives
    // below, and a cached box would keep the shape chosen for an earlier
    // width. Widths are capped by the caller, so a resize simply re-renders.
    const boxFor = (width: number): Box => {
      const box = new Box(outputPad, 1, text => theme.bg("customMessageBg", text));
      for (const block of summaryMarkdownBlocks(content)) {
        const firstLine = block.split("\n")[0] ?? "";
        const heading = structuralHeading(firstLine) ?? "";
        const sectionName = heading ? cardSectionName(heading.replace(/^#+\s+/, "")) : null;
        const tone = summaryHeadingTone(heading);
        const verification = sectionName === CARD_SECTION.verification;
        // Narrow receipts (field 2026-11-11): Pi prints a Markdown table's RAW
        // pipe rows when the width cannot fit it, which a reader sees as
        // broken output. A verification table becomes
        // `- Gate — command — result` bullets when the card cannot hold it;
        // both shapes state the same derived facts.
        const sourceBlock = verification && width < NARROW_TABLE_COLUMNS
          ? tableAsBullets(block).join("\n")
          : block;
        // Current receipts use plain section labels for host compatibility.
        // Promote them only in the display layer so Markdown can style them;
        // durable content and archive text remain unchanged.
        // Pi renders depth >=3 prefixes literally. Depth 2 preserves the
        // semantic heading style without exposing Markdown hashes.
        const displayBlock = heading ? heading.replace(/^#{2,4}\s+/, '## ') + sourceBlock.slice(firstLine.length) : sourceBlock;
        box.addChild(new Markdown(displayBlock, 0, 0, summaryTheme(theme, tone), {
          color: text => theme.fg(verification ? summaryVerificationTone(stripTerminalSequences(text)) : tone === "dim" ? "dim" : "text", text),
        }));
      }
      return box;
    };
    let renderedAt = -1;
    let rendered: Box | undefined;
    return {
      render: width => {
        if (width <= 0) return [];
        if (!rendered || renderedAt !== width) {
          rendered = boxFor(width);
          renderedAt = width;
        }
        return rendered.render(width).map(line => truncateToWidth(line, width, "…"));
      },
      invalidate: () => { rendered?.invalidate(); rendered = undefined; renderedAt = -1; },
    };
  });
}
