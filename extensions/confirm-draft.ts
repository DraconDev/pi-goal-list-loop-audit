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

/**
 * v0.39.61 (note.md 2026-10-31, tweak wall of text): the completion scope
 * amendment confirm printed five labelled sections and both full contracts,
 * which wrapped into a wall that hid the decision. The consent record must stay
 * EXACT — the user is approving a specific old→new objective pair — but the
 * default body does not need to reprint an unchanged contract twice.
 *
 * The rule: always show the exact old and new objective. Show a contract only
 * when it actually changes, because an unchanged contract is not part of the
 * decision. Long objectives are clipped to a readable length with an explicit
 * marker, never silently truncated.
 */
export function buildAmendmentConfirmBody(input: {
  oldObjective: string;
  newObjective: string;
  oldContract?: string;
  newContract?: string;
  maxContractChars?: number;
}): string {
  // Consent EXACTNESS beats brevity for the objective: the user approves a
  // specific old→new pair, so neither side is ever clipped. The wall was
  // dominated by the two reprinted contracts and five labelled sections, which
  // is what this removes. A contract is secondary detail and may be shortened
  // with an explicit marker.
  const contractMax = input.maxContractChars ?? 280;
  const clipContract = (text: string): string => {
    const clean = text.trim();
    if (!clean) return "(none)";
    if (clean.length <= contractMax) return clean;
    const head = clean.slice(0, Math.max(40, contractMax - 80)).trimEnd();
    const tail = clean.slice(-60).trimStart();
    return `${head} … ${tail}`;
  };
  const lines: string[] = [
    `From: ${input.oldObjective.trim() || "(none)"}`,
    `To:   ${input.newObjective.trim() || "(none)"}`,
  ];
  const oldContract = (input.oldContract ?? "").trim();
  const newContract = (input.newContract ?? "").trim();
  if (newContract !== oldContract) {
    lines.push("", `Contract: ${clipContract(oldContract)} → ${clipContract(newContract)}`);
  } else if (newContract) {
    // An UNCHANGED contract is not part of the decision — printing it twice was
    // most of the wall. Say it is untouched instead of echoing it.
    lines.push("", "Contract: unchanged");
  }
  lines.push("", "This changes what the independent auditor will judge.");
  return lines.join("\n");
}

/**
 * note.md item 2 (Screenshot_20261029_165336, Screenshot_20261029_112819): the
 * `/goal tweak` and `/list tweak` confirmation printed a four-section wall —
 * CURRENT, the whole old objective, NEW, the whole new objective, plus contract
 * caveats. The consent itself is only the objective pair; everything else is
 * rationale the user needs ON DEMAND, not by default.
 *
 * These two builders split exactly that way. The compact body carries the exact
 * old→new text (consent fidelity is non-negotiable) and one consequence line.
 * The rationale body carries the contract semantics, the inference caveat and
 * the reference labels, and is reachable from the same dialog through a real
 * `Show full rationale` action.
 */
export interface TweakConfirmInput {
  mode: 'goal' | 'list';
  currentObjective: string;
  newObjective: string;
  /** Human note about where the replacement text came from, if inferred. */
  inferredNote?: string;
  hasNewContract: boolean;
  /** Open the card already expanded (`--rationale`). The in-dialog affordance
   * exists regardless; this only changes the initial state. */
  showRationale?: boolean;
  clearsContract: boolean;
  newContract?: string;
  /** Optional: the dialog title (defaults to the standard tweak title). */
  title?: string;
  getHeight?: () => number;
}

/**
 * The consent pair. BOTH objectives are printed in full, always — this is the
 * record the user is agreeing to, and an elided diff is not a consent record.
 *
 * Compactness comes from what is NOT here, plus a bounded viewport:
 *   - the reprinted contract body, the reference labels and the caveat
 *     paragraph live behind the toggle, so the default body is the pair and one
 *     consequence line and nothing else;
 *   - the card is rendered inside a terminal-height window (`getHeight`) that
 *     the user pages through with PgUp/PgDn, so a long objective occupies a
 *     scrollable region instead of pushing Confirm off the screen.
 *
 * An earlier revision replaced the pair with a prefix/suffix diff above 180
 * characters. The auditor correctly rejected it: the contract requires the
 * default card body to carry the exact old AND new objective text, and a diff
 * shows only the changed region. Length is handled by the viewport, never by
 * dropping consent text.
 */
export function tweakObjectiveLines(current: string, next: string): string[] {
  return [
    `From: ${current.trim() || '(none)'}`,
    `To:   ${next.trim() || '(none)'}`,
  ];
}

/** The default card: exact consent text, nothing else. */
export function buildTweakConfirmBody(input: TweakConfirmInput): string {
  // The inference caveat STAYS on the default card: it is consent context
  // ("this text was inferred — cancel and re-run with exact wording"), not
  // rationale. Only the reference labels, the contract body and the caveat
  // paragraph move behind the expand.
  const inferred = input.inferredNote?.trim();
  const lines = [
    ...tweakObjectiveLines(input.currentObjective, input.newObjective),
    ...(inferred ? ['', `This replacement was ${inferred}.`] : []),
    '',
    tweakConsequenceLine(input),
  ];
  return lines.join('\n');
}

/* ------------------------------------------------------------------ */
/* Styled card for AMENDMENT confirmations                             */
/* ------------------------------------------------------------------ */

/**
 * note.md 2026-10-29 ("but this question looks fine, except unstyled"): the
 * task-amendment and scope-amendment dialogs rendered through plain
 * `ctx.ui.confirm` — flat body text, no border, no title treatment, and the
 * host's raw `↑↓ navigate enter select escape/ctrl+c cancel` footer. The copy
 * had already been made compact; only the chrome was missing.
 *
 * This is the SAME card shape the tweak confirmation uses, reduced to a
 * two-choice decision. It deliberately does NOT add a third option: these are
 * yes/no consent records and auto-accept must never apply to them.
 */
export const CARD_CONFIRM_YES = 'Yes — apply this amendment';
export const CARD_CONFIRM_NO = 'No — change nothing';

export class CardConfirmComponent implements Component {
  private readonly title: string;
  private readonly body: string;
  private md: Markdown;
  private selectList: SelectList;
  private readonly requestRender: () => void;
  private readonly theme: Theme;
  private readonly getHeight: (() => number) | undefined;
  private readonly keybindings: KeybindingsManagerLike;
  private readonly done: (value: boolean) => void;
  private scrollOffset = 0;
  private pageSize = 8;

  constructor(
    input: { title: string; body: string; getHeight?: () => number },
    requestRender: () => void,
    theme: Theme,
    keybindings: KeybindingsManagerLike,
    done: (value: boolean) => void,
  ) {
    this.title = input.title;
    this.body = input.body;
    this.keybindings = keybindings;
    this.requestRender = requestRender;
    this.theme = theme;
    this.getHeight = input.getHeight;
    this.done = done;
    this.md = new Markdown(buildConfirmDraftMarkdown(this.title, this.body), 1, 1, markdownTheme(theme));
    this.selectList = new SelectList(this.items(), 2, selectListTheme(theme));
    this.selectList.onSelect = (item) => this.done(item.value === CARD_CONFIRM_YES);
    this.selectList.onCancel = () => this.done(false);
  }

  /** What this card is showing. Public so tests assert what the user saw. */
  get dialogDeps(): ConfirmDraftFactoryDeps {
    return { title: this.title, body: this.body, options: this.items().map((i) => i.value) };
  }

  private items(): SelectItem[] {
    return [
      { value: CARD_CONFIRM_YES, label: CARD_CONFIRM_YES },
      { value: CARD_CONFIRM_NO, label: CARD_CONFIRM_NO },
    ];
  }

  render(width: number): string[] {
    const border = new DynamicBorder((text: string) => this.theme.fg('borderAccent', text)).render(width);
    const body = this.md.render(width);
    const decisions = this.selectList.render(width);
    const height = this.getHeight ? Math.max(8, Math.floor(this.getHeight())) : Number.POSITIVE_INFINITY;
    const help = new Text(this.theme.fg('dim', '↑↓ choose · enter select · PgUp/PgDn scroll · esc cancel'), 1, 0).render(width);
    const gaps = height < 14 ? [] : [''];
    const contentBudget = Math.max(0, height - border.length * 2 - decisions.length - help.length - gaps.length * 2);
    const bodyRows = body.length > contentBudget ? Math.max(0, contentBudget - 1) : contentBudget;
    this.pageSize = Math.max(1, bodyRows);
    this.scrollOffset = Math.min(this.scrollOffset, Math.max(0, body.length - bodyRows));
    const scrollInfo = body.length > bodyRows && contentBudget > 0
      ? [this.theme.fg('dim', `Review ${this.scrollOffset + 1}–${Math.min(body.length, this.scrollOffset + bodyRows)}/${body.length} · PgUp/PgDn scroll`)] : [];
    return [...border, ...body.slice(this.scrollOffset, this.scrollOffset + bodyRows), ...scrollInfo, ...gaps, ...decisions, ...gaps, ...help, ...border]
      .map((line) => truncateToWidth(line, Math.max(0, width), '…'));
  }

  handleInput(data: string): void {
    // Paging is ours so a long amendment body is readable without leaving the
    // decision; everything else belongs to the SelectList, which keeps the
    // ↑↓/enter/esc semantics the host had before this card existed.
    if (this.keybindings.matches(data, 'tui.select.pageUp') || data === '\x1b[5~') {
      this.scrollOffset = Math.max(0, this.scrollOffset - this.pageSize);
    } else if (this.keybindings.matches(data, 'tui.select.pageDown') || data === '\x1b[6~') {
      this.scrollOffset += this.pageSize;
    } else if (this.keybindings.matches(data, 'tui.select.confirm')) {
      const selected = this.selectList.getSelectedItem()?.value;
      if (selected) this.done(selected === CARD_CONFIRM_YES);
    } else if (this.keybindings.matches(data, 'tui.select.cancel')) {
      this.done(false);
    } else {
      this.selectList.handleInput(data);
    }
    this.requestRender();
  }

  invalidate(): void {
    this.md.invalidate?.();
  }
}

/** Minimal slice of ExtensionContext this helper needs, so callers stay free
 * of a hard dependency on the host type. */
export interface CardConfirmCtx {
  ui: {
    confirm: (title: string, body: string) => Promise<boolean>;
    custom?: unknown;
  };
}

/**
 * Show an amendment confirmation in the styled card, degrading to the host's
 * plain confirm when `custom` is unavailable. Mirrors `confirmTweak`: a stubbed
 * or RPC `custom` resolves WITHOUT invoking the factory, so that case falls
 * through to the plain confirm instead of being read as "No".
 */
export async function confirmCard(ctx: CardConfirmCtx, title: string, body: string): Promise<boolean> {
  const custom = (ctx.ui as { custom?: unknown }).custom;
  if (typeof custom === "function") {
    let factoryInvoked = false;
    try {
      const choice = await (ctx.ui as { custom: <T>(f: unknown) => Promise<boolean | string | undefined> }).custom<boolean | string | undefined>((tui: { terminal?: { rows?: number }; requestRender: () => void }, theme: Theme, keybindings: KeybindingsManagerLike, done: (value: boolean) => void) => {
        factoryInvoked = true;
        return new CardConfirmComponent(
          { title, body, getHeight: () => (tui.terminal?.rows ?? 24) - 4 },
          () => tui.requestRender(), theme, keybindings, done,
        );
      });
      // A host may resolve the card's boolean done() value, or the chosen
      // action label (some custom-UI hosts map the selection instead of the
      // callback). Both are affirmative ONLY for the yes action — anything else,
      // including undefined and the no label, is a refusal.
      if (factoryInvoked) return choice === true || choice === CARD_CONFIRM_YES;
    } catch (err) {
      // A stale host API is a real failure, not something to paper over with a
      // plain confirm that could silently answer for a dead session.
      if (err instanceof Error && err.message.includes("stale after session replacement")) throw err;
    }
  }
  return ctx.ui.confirm(title, body);
}

/** One line: the single most important consequence of this tweak. */
export function tweakConsequenceLine(input: TweakConfirmInput): string {
  const target = input.mode === 'list' ? 'list item' : 'goal';
  if (input.hasNewContract) return `Replaces the ${target} objective and its verification contract.`;
  if (input.clearsContract) return `Replaces the ${target} objective and CLEARS its verification contract.`;
  return `Replaces the ${target} objective; its verification contract is kept.`;
}

/** The full rationale, reachable from the compact card by explicit request. */
export function buildTweakRationaleBody(input: TweakConfirmInput): string {
  const lines = [
    `CURRENT:\n${input.currentObjective.trim() || '(none)'}`,
    '',
    `NEW${input.inferredNote ? ` (inferred)` : ''}:\n${input.newObjective.trim() || '(none)'}`,
    '',
    tweakConsequenceLine(input),
  ];
  if (input.inferredNote) lines.push('', `Where the new text came from: ${input.inferredNote.trim()}`);
  if (input.hasNewContract) {
    lines.push('', `New verification contract:\n${(input.newContract ?? '').trim() || '(none)'}`);
  } else if (input.clearsContract) {
    lines.push('', "Empty 'Done when:' — the verification contract is cleared.");
  } else {
    lines.push('', 'The new text carries no contract clause, so the old contract is kept.');
  }
  lines.push('', 'This changes what the independent auditor will judge.');
  return lines.join('\n');
}

/** Dialog actions for the tweak confirmation. Confirm/Cancel semantics are
 * unchanged; the rationale action is the in-dialog expand affordance. */
export const TWEAK_CONFIRM_ACTION = 'Confirm — apply this tweak';
export const TWEAK_RATIONALE_ACTION = 'Show the full rationale';
export const TWEAK_COLLAPSE_ACTION = 'Hide the full rationale';
export const TWEAK_CANCEL_ACTION = 'Cancel — change nothing';

/**
 * note.md 2026-10-31 item 2, audit round 2: the compact card must keep the full
 * rationale *reachable from that same card*. A `--rationale` flag that requires
 * cancelling and re-typing the command is not reachable — it is a re-run.
 *
 * This is the same dialog with the same Confirm/Cancel semantics; the only
 * addition is a `Show the full rationale` action that expands the body in place
 * and offers to collapse it again. Consent text is unchanged: the compact body
 * always carries the exact old and new objective, and the expanded body is the
 * pre-existing rationale text.
 */
export class TweakConfirmComponent implements Component {
  private readonly input: TweakConfirmInput;
  private md: Markdown;
  private selectList: SelectList;
  private readonly requestRender: () => void;
  private readonly theme: Theme;
  private readonly keybindings: KeybindingsManagerLike;
  private readonly getHeight: (() => number) | undefined;
  private readonly done: (value: string | undefined) => void;
  private expanded: boolean;
  private scrollOffset = 0;
  private pageSize = 8;

  constructor(
    input: TweakConfirmInput,
    requestRender: () => void,
    theme: Theme,
    keybindings: KeybindingsManagerLike,
    done: (value: string | undefined) => void,
  ) {
    this.input = input;
    this.requestRender = requestRender;
    this.getHeight = input.getHeight;
    this.done = done;
    this.theme = theme;
    this.keybindings = keybindings;
    this.expanded = input.showRationale === true;
    this.md = new Markdown(buildConfirmDraftMarkdown(input.title ?? 'Tweak objective?', this.bodyText()), 1, 1, markdownTheme(theme));
    this.selectList = new SelectList(this.items(), 3, selectListTheme(theme));
    this.selectList.onSelect = (item) => this.choose(item.value);
    this.selectList.onCancel = () => done(undefined);
  }

  /** The body currently on screen. Public so tests assert what the user saw. */
  bodyText(): string {
    return this.expanded ? buildTweakRationaleBody(this.input) : buildTweakConfirmBody(this.input);
  }

  /** What this card is showing right now — title, body and the actions on offer.
   * A live getter (not a snapshot) because the toggle changes all three in
   * place, and a host/test reading it after an expand must see the expanded
   * state rather than the opening one. */
  get dialogDeps(): ConfirmDraftFactoryDeps {
    return {
      title: this.input.title ?? 'Tweak objective?',
      body: this.bodyText(),
      options: this.items().map((item) => item.value),
    };
  }

  isExpanded(): boolean {
    return this.expanded;
  }

  private items(): SelectItem[] {
    return [
      { value: TWEAK_CONFIRM_ACTION, label: TWEAK_CONFIRM_ACTION },
      { value: this.expanded ? TWEAK_COLLAPSE_ACTION : TWEAK_RATIONALE_ACTION, label: this.expanded ? TWEAK_COLLAPSE_ACTION : TWEAK_RATIONALE_ACTION },
      { value: TWEAK_CANCEL_ACTION, label: TWEAK_CANCEL_ACTION },
    ];
  }

  /** Toggle in place — the dialog stays open, nothing is applied. */
  toggleRationale(): void {
    this.expanded = !this.expanded;
    this.md = new Markdown(buildConfirmDraftMarkdown(this.input.title ?? 'Tweak objective?', this.bodyText()), 1, 1, markdownTheme(this.theme));
    // The action list changes label in place (expand ↔ collapse), so the
    // SelectList is rebuilt; nothing is applied and the dialog stays open.
    this.selectList = new SelectList(this.items(), 3, selectListTheme(this.theme));
    this.selectList.onSelect = (item) => this.choose(item.value);
    this.selectList.onCancel = () => this.done(undefined);
    this.selectList.setSelectedIndex(1);
    this.scrollOffset = 0;
    this.requestRender();
  }

  private choose(value: string): void {
    if (value === TWEAK_CONFIRM_ACTION) this.done(TWEAK_CONFIRM_ACTION);
    else if (value === TWEAK_CANCEL_ACTION) this.done(undefined);
    else this.toggleRationale();
  }

  render(width: number): string[] {
    const border = new DynamicBorder((text: string) => this.theme.fg("borderAccent", text)).render(width);
    const body = this.md.render(width);
    const decisions = this.selectList.render(width);
    const height = this.getHeight ? Math.max(8, Math.floor(this.getHeight())) : Number.POSITIVE_INFINITY;
    // The affordance is stated in the help line so the expand is discoverable
    // without selecting it first.
    const help = new Text(this.theme.fg("dim", this.expanded
      ? "↑↓ choose · enter select · PgUp/PgDn scroll · esc cancel"
      : `↑↓ choose · enter select · esc cancel · "${TWEAK_RATIONALE_ACTION}" expands without applying`), 1, 0).render(width);
    const gaps = height < 14 ? [] : [""];
    const contentBudget = Math.max(0, height - border.length * 2 - decisions.length - help.length - gaps.length * 2);
    const bodyRows = body.length > contentBudget ? Math.max(0, contentBudget - 1) : contentBudget;
    this.pageSize = Math.max(1, bodyRows);
    this.scrollOffset = Math.min(this.scrollOffset, Math.max(0, body.length - bodyRows));
    const scrollInfo = body.length > bodyRows && contentBudget > 0
      ? [this.theme.fg("dim", `Review ${this.scrollOffset + 1}–${Math.min(body.length, this.scrollOffset + bodyRows)}/${body.length} · PgUp/PgDn scroll`)] : [];
    return [...border, ...body.slice(this.scrollOffset, this.scrollOffset + bodyRows), ...scrollInfo, ...gaps, ...decisions, ...gaps, ...help, ...border]
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
    else if (this.keybindings.matches(data, "tui.select.confirm")) {
      const selected = this.selectList.getSelectedItem()?.value;
      if (selected) this.choose(selected);
    } else if (this.keybindings.matches(data, "tui.select.cancel")) this.done(undefined);
    else this.selectList.handleInput(data);
    this.requestRender();
  }

  getSelectedItem(): string | null {
    return this.selectList.getSelectedItem()?.value ?? null;
  }
}
