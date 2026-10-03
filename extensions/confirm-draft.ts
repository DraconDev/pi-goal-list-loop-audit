// pi-goal-list-loop-audit — v0.2.0
// extensions/confirm-draft.ts
//
// v0.34.78 (GitHub #4): the draft-class confirm dialog as a real TUI
// component. ctx.ui.select renders plain text with no wrapping; this
// component renders the SAME title/body as Markdown (objective + contract
// readable at full width) with a SelectList for the Yes / Yes-and-always /
// No choices. Kept in its own file so tests can construct and render it
// without dragging in the whole goal loop.

import {
  type Component,
  Markdown,
  type MarkdownTheme,
  type SelectItem,
  SelectList,
  type SelectListTheme,
  Text,
  truncateToWidth,
  wrapTextWithAnsi,
  stripTerminalSequences,
} from "@earendil-works/pi-tui";
import { DynamicBorder, type Theme } from "@earendil-works/pi-coding-agent";

export interface ConfirmDraftFactoryDeps {
  title: string;
  body: string;
  options: string[];
  getHeight?: () => number;
}

/** Structural type for the KeybindingsManager — mirrors settings-menu.ts. */
export interface KeybindingsManagerLike {
  matches(data: string, key: string): boolean;
}

/** Pure: the markdown rendered in the dialog. The title is the H1, the
 * body (objective + verification contract) is the content. */
export function buildConfirmDraftMarkdown(title: string, body: string): string {
  const safeTitle = stripTerminalSequences(title).replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
  const safeBody = stripTerminalSequences(body).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, " ");
  return `# ${safeTitle}\n\n${safeBody}`;
}

/** Build a MarkdownTheme from the runtime Theme's fg()/bold() primitives.
 * Uses the theme's own md* colors so the dialog follows the active theme. */
function markdownTheme(theme: Theme): MarkdownTheme {
  const fg = (color: Parameters<Theme["fg"]>[0]) => (t: string) => theme.fg(color, t);
  return {
    heading: (t) => theme.bold(fg("mdHeading")(t)),
    link: (t) => fg("mdLink")(t),
    linkUrl: (t) => fg("mdLinkUrl")(t),
    code: (t) => fg("mdCode")(t),
    codeBlock: (t) => fg("mdCodeBlock")(t),
    codeBlockBorder: (t) => fg("mdCodeBlockBorder")(t),
    quote: (t) => fg("mdQuote")(t),
    quoteBorder: (t) => fg("mdQuoteBorder")(t),
    hr: (t) => fg("mdHr")(t),
    listBullet: (t) => fg("mdListBullet")(t),
    bold: (t) => theme.bold(t),
    italic: (t) => t,
    strikethrough: (t) => t,
    underline: (t) => t,
    codeBlockIndent: "  ",
  };
}

function selectListTheme(theme: Theme): SelectListTheme {
  return {
    selectedPrefix: (t) => theme.fg("accent", t),
    selectedText: (t) => theme.fg("accent", t),
    description: (t) => theme.fg("muted", t),
    scrollInfo: (t) => theme.fg("dim", t),
    noMatch: (t) => theme.fg("warning", t),
  };
}

/**
 * The confirm dialog: DynamicBorder frame, markdown title+body, spacer, the
 * three-choice SelectList, and a help line. Exported so tests can construct
 * it with a fake theme and assert the rendered lines.
 */
export class ConfirmDraftComponent implements Component {
  private readonly md: Markdown;
  private readonly selectList: SelectList;
  private readonly requestRender: () => void;
  private readonly theme: Theme;
  private readonly keybindings: KeybindingsManagerLike;
  private readonly getHeight: (() => number) | undefined;
  private scrollOffset = 0;
  private pageSize = 8;
  private readonly options: string[];
  private readonly done: (value: string | undefined) => void;

  constructor(
    deps: ConfirmDraftFactoryDeps,
    requestRender: () => void,
    theme: Theme,
    keybindings: KeybindingsManagerLike,
    done: (value: string | undefined) => void,
  ) {
    this.requestRender = requestRender;
    this.getHeight = deps.getHeight;
    this.options = deps.options;
    this.done = done;
    this.theme = theme;
    this.keybindings = keybindings;
    this.md = new Markdown(buildConfirmDraftMarkdown(deps.title, deps.body), 1, 1, markdownTheme(theme));
    const items: SelectItem[] = deps.options.map((o) => ({ value: o, label: o }));
    this.selectList = new SelectList(items, Math.min(items.length, 10), selectListTheme(theme));
    this.selectList.onSelect = (item) => done(item.value);
    this.selectList.onCancel = () => done(undefined);
  }

  render(width: number): string[] {
    const border = new DynamicBorder((text: string) => this.theme.fg("borderAccent", text)).render(width);
    const body = this.md.render(width);
    const decisions = this.selectList.render(width);
    const height = this.getHeight ? Math.max(8, Math.floor(this.getHeight())) : Number.POSITIVE_INFINITY;
    const help = new Text(this.theme.fg("dim", "↑↓ choose · enter select · esc cancel"), 1, 0).render(width);
    const selected = this.getSelectedItem() ?? "";
    const notes = selected.length > Math.max(0, width - 4)
      ? wrapTextWithAnsi(selected, Math.max(1, width - 2)).map((line) => this.theme.fg("muted", line)) : [];
    const gaps = height < 14 ? [] : [""];
    const contentBudget = Math.max(0, height - border.length * 2 - decisions.length - help.length - gaps.length * 2 - notes.length);
    const bodyRows = body.length > contentBudget ? Math.max(0, contentBudget - 1) : contentBudget;
    this.pageSize = Math.max(1, bodyRows);
    this.scrollOffset = Math.min(this.scrollOffset, Math.max(0, body.length - bodyRows));
    const scrollInfo = body.length > bodyRows && contentBudget > 0
      ? [this.theme.fg("dim", `Review ${this.scrollOffset + 1}–${Math.min(body.length, this.scrollOffset + bodyRows)}/${body.length} · PgUp/PgDn scroll`)] : [];
    return [...border, ...body.slice(this.scrollOffset, this.scrollOffset + bodyRows), ...scrollInfo, ...gaps, ...decisions, ...notes, ...gaps, ...help, ...border]
      .map((line) => truncateToWidth(line, Math.max(0, width), "…"));
  }

  invalidate(): void {
    this.md.invalidate();
    this.selectList.invalidate();
    this.requestRender();
  }

  handleInput(data: string): void {
    if (this.keybindings.matches(data, "tui.select.pageUp") || data === "\x1b[5~") this.scrollOffset = Math.max(0, this.scrollOffset - this.pageSize);
    else if (this.keybindings.matches(data, "tui.select.pageDown") || data === "\x1b[6~") this.scrollOffset += this.pageSize;
    else if (this.keybindings.matches(data, "tui.select.confirm")) this.done(this.getSelectedItem() ?? undefined);
    else if (this.keybindings.matches(data, "tui.select.cancel")) this.done(undefined);
    else if (this.keybindings.matches(data, "tui.select.up") || this.keybindings.matches(data, "tui.select.down")) {
      const delta = this.keybindings.matches(data, "tui.select.up") ? -1 : 1;
      const index = this.options.indexOf(this.getSelectedItem() ?? "");
      this.selectList.setSelectedIndex((index + delta + this.options.length) % this.options.length);
    } else this.selectList.handleInput(data);
    this.requestRender();
  }

  /** Exposed for tests. */
  getSelectedItem(): string | null {
    return this.selectList.getSelectedItem()?.value ?? null;
  }
}
